import type { UiTrack } from "@/lib/tauri";

/** A region of one source track placed on the composition timeline. */
export type Clip = {
  id: string;
  laneId: string;
  /** Timeline position, seconds. */
  start: number;
  /** Offset into the source, seconds of *source* time. */
  offset: number;
  /** Length in *source* seconds (independent of playback rate). */
  length: number;
  /** Fades, in timeline seconds. */
  fadeIn: number;
  fadeOut: number;
};

export type Lane = {
  id: string;
  track: UiTrack;
  /** Linear gain 0..1.5 */
  gain: number;
  /** 3-band EQ in dB, −26 (kill) .. +12 */
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  /** Filter cutoffs in Hz. `hp` at 20 and `lp` at 20000 are bypass. */
  hp: number;
  lp: number;
  /** Follow the master BPM by resampling (vinyl-style, pitch follows tempo). */
  sync: boolean;
  mute: boolean;
  solo: boolean;
};

export type Composition = {
  masterBpm: number;
  snap: boolean;
  lanes: Lane[];
  clips: Clip[];
};

export const HP_MIN = 20;
export const LP_MAX = 20_000;
export const EQ_KILL = -26;

export const DEFAULT_LANE: Omit<Lane, "id" | "track"> = {
  gain: 1,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  hp: HP_MIN,
  lp: LP_MAX,
  sync: true,
  mute: false,
  solo: false,
};

export function emptyComposition(): Composition {
  return { masterBpm: 174, snap: true, lanes: [], clips: [] };
}

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

/** Playback rate for a lane: masterBpm / trackBpm when synced, else 1. */
export function laneRate(lane: Lane, masterBpm: number): number {
  if (!lane.sync) return 1;
  const bpm = lane.track.bpm;
  if (!bpm || bpm <= 0 || masterBpm <= 0) return 1;
  // Tracks at half/double tempo (e.g. 87 vs 174) sync to the nearest octave.
  let rate = masterBpm / bpm;
  while (rate > 1.5) rate /= 2;
  while (rate < 0.75) rate *= 2;
  return rate;
}

/** Duration the clip occupies on the timeline, given its lane's rate. */
export function clipDuration(clip: Clip, rate: number): number {
  return clip.length / rate;
}

export function clipEnd(clip: Clip, rate: number): number {
  return clip.start + clipDuration(clip, rate);
}

export function barSeconds(masterBpm: number, beatsPerBar = 4): number {
  return (60 / masterBpm) * beatsPerBar;
}

export function beatSeconds(masterBpm: number): number {
  return 60 / masterBpm;
}

/** Snap a timeline position to the nearest grid line (bar, or beat when zoomed in). */
export function snapTime(t: number, masterBpm: number, gridSeconds: number): number {
  if (gridSeconds <= 0 || masterBpm <= 0) return Math.max(0, t);
  return Math.max(0, Math.round(t / gridSeconds) * gridSeconds);
}

/** Choose a grid size so lines stay at least `minPx` apart at `pxPerSec`. */
export function gridForZoom(masterBpm: number, pxPerSec: number, minPx = 24): number {
  const beat = beatSeconds(masterBpm);
  const candidates = [beat, beat * 4, beat * 8, beat * 16, beat * 32, beat * 64];
  for (const c of candidates) {
    if (c * pxPerSec >= minPx) return c;
  }
  return candidates[candidates.length - 1];
}

export function compositionLength(comp: Composition): number {
  let end = 0;
  for (const c of comp.clips) {
    const lane = comp.lanes.find((l) => l.id === c.laneId);
    if (!lane) continue;
    end = Math.max(end, clipEnd(c, laneRate(lane, comp.masterBpm)));
  }
  return end;
}

/** A lane is heard when not muted and either nothing is soloed or it is. */
export function laneAudible(lane: Lane, lanes: Lane[]): boolean {
  if (lane.mute) return false;
  const anySolo = lanes.some((l) => l.solo);
  return !anySolo || lane.solo;
}

/**
 * Gain envelope for a clip at timeline time `t` (fades only; lane gain is
 * applied separately). Used by both the realtime scheduler and tests.
 */
export function fadeGainAt(clip: Clip, rate: number, t: number): number {
  const dur = clipDuration(clip, rate);
  const rel = t - clip.start;
  if (rel < 0 || rel > dur) return 0;
  let g = 1;
  if (clip.fadeIn > 0 && rel < clip.fadeIn) g = Math.min(g, rel / clip.fadeIn);
  if (clip.fadeOut > 0 && rel > dur - clip.fadeOut) {
    g = Math.min(g, (dur - rel) / clip.fadeOut);
  }
  return Math.max(0, Math.min(1, g));
}

/** Clamp a clip's fades so they never exceed its timeline duration. */
export function normalizeFades(clip: Clip, rate: number): Clip {
  const dur = clipDuration(clip, rate);
  const fadeIn = Math.max(0, Math.min(clip.fadeIn, dur));
  const fadeOut = Math.max(0, Math.min(clip.fadeOut, dur - fadeIn));
  return { ...clip, fadeIn, fadeOut };
}

/**
 * When two clips on *different* lanes overlap, give the earlier one a fade
 * out and the later one a fade in spanning the overlap — the "auto
 * crossfade" a DJ expects when dragging the next track in under the current
 * one. Clips that already have fades keep the longer of the two.
 */
export function autoCrossfade(comp: Composition): Composition {
  const rates = new Map(comp.lanes.map((l) => [l.id, laneRate(l, comp.masterBpm)]));
  const clips = comp.clips.map((c) => ({ ...c }));
  for (let i = 0; i < clips.length; i++) {
    for (let j = 0; j < clips.length; j++) {
      if (i === j) continue;
      const a = clips[i];
      const b = clips[j];
      if (a.laneId === b.laneId) continue;
      const ra = rates.get(a.laneId) ?? 1;
      const rb = rates.get(b.laneId) ?? 1;
      const aEnd = clipEnd(a, ra);
      // a starts first and b starts inside a
      if (b.start > a.start && b.start < aEnd) {
        const overlap = Math.min(aEnd, clipEnd(b, rb)) - b.start;
        if (overlap <= 0) continue;
        a.fadeOut = Math.max(a.fadeOut, overlap);
        b.fadeIn = Math.max(b.fadeIn, overlap);
      }
    }
  }
  return {
    ...comp,
    clips: clips.map((c) => normalizeFades(c, rates.get(c.laneId) ?? 1)),
  };
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}

export function formatBar(sec: number, masterBpm: number): string {
  const bar = barSeconds(masterBpm);
  const b = Math.floor(sec / bar) + 1;
  const beat = Math.floor((sec % bar) / beatSeconds(masterBpm)) + 1;
  return `${b}.${beat}`;
}
