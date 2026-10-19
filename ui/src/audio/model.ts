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
  /** True while the fade was set by auto-crossfade rather than the user. */
  fadeInAuto?: boolean;
  fadeOutAuto?: boolean;
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
  /**
   * True for lanes restored from a project file. They arrive with their
   * clips, so the composer must not drop a starter clip on them the way it
   * does for a lane that was just added from the library.
   */
  seeded?: boolean;
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

/**
 * Clamp a clip's fades to its timeline duration. The two fades may still
 * overlap: the envelope is the lower of the two lines (see
 * `fadeBreakpoints`), so an overlap is a valid shape, not an error.
 */
export function normalizeFades(clip: Clip, rate: number): Clip {
  const dur = clipDuration(clip, rate);
  const fadeIn = Math.max(0, Math.min(clip.fadeIn, dur));
  const fadeOut = Math.max(0, Math.min(clip.fadeOut, dur));
  return { ...clip, fadeIn, fadeOut };
}

/**
 * Fade envelope breakpoints for a clip in absolute timeline seconds: the
 * piecewise-linear curve `fadeGainAt` evaluates. When the two fades overlap
 * (fadeIn + fadeOut > duration) the curve is the lower of the two lines, so
 * it rises to the crossing point and falls from there — never a jump. The
 * realtime and offline schedulers emit exactly these points, which keeps
 * what is heard identical to what the timeline draws.
 */
export function fadeBreakpoints(clip: Clip, rate: number): Array<{ t: number; g: number }> {
  const dur = clipDuration(clip, rate);
  const fi = Math.max(0, Math.min(clip.fadeIn, dur));
  const fo = Math.max(0, Math.min(clip.fadeOut, dur));
  const rel: number[] = [0, dur];
  if (fi + fo <= dur) {
    if (fi > 0) rel.push(fi);
    if (fo > 0) rel.push(dur - fo);
  } else {
    // Lines rel/fi and (dur-rel)/fo cross at rel = dur*fi/(fi+fo).
    rel.push((dur * fi) / (fi + fo));
  }
  const uniq = Array.from(new Set(rel)).sort((a, b) => a - b);
  return uniq.map((r) => ({ t: clip.start + r, g: fadeGainAt(clip, rate, r + clip.start) }));
}

/** May `autoCrossfade` write this side of the clip? */
function fadeSideIsAuto(flag: boolean | undefined, fade: number): boolean {
  return flag === true || (flag === undefined && fade === 0);
}

/**
 * Auto-crossfade: when a clip on another lane starts inside this one and
 * runs past its end — the DJ "bring the next track in under the current
 * one" move — the outgoing clip fades out and the incoming fades in across
 * the overlap. A clip dropped entirely *inside* another (a sample, a tool)
 * instead gets a short symmetric fade of its own, one bar at the master
 * tempo capped at half its length; the host clip is left alone, since its
 * fade-out would land at its end where nothing else is playing.
 *
 * Only sides the function owns are written (see `fadeInAuto`/`fadeOutAuto`
 * on `Clip`): a fade the user has set keeps its value. Auto sides are
 * recomputed from the current overlaps each call, so they shrink, grow and
 * clear as clips move. With `changedClipIds`, only those clips and the clips
 * they overlap are touched; an auto fade on an unrelated clip keeps its last
 * value until that clip is next edited.
 */
export function autoCrossfade(comp: Composition, changedClipIds?: string[]): Composition {
  const rates = new Map(comp.lanes.map((l) => [l.id, laneRate(l, comp.masterBpm)]));
  const rateOf = (c: Clip) => rates.get(c.laneId) ?? 1;
  const clips = comp.clips.map((c) => ({ ...c }));
  const bar = barSeconds(comp.masterBpm);

  const overlaps = (a: Clip, b: Clip) =>
    a.laneId !== b.laneId &&
    a.start < clipEnd(b, rateOf(b)) &&
    b.start < clipEnd(a, rateOf(a));

  let scope: Set<string> | null = null;
  if (changedClipIds) {
    scope = new Set(changedClipIds);
    for (const c of clips) {
      if (!scope.has(c.id)) continue;
      for (const o of clips) if (overlaps(c, o)) scope.add(o.id);
    }
  }

  // Desired auto fade per side, taking the longest demand from any partner.
  const wantIn = new Map<string, number>();
  const wantOut = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string, v: number) =>
    m.set(id, Math.max(m.get(id) ?? 0, v));

  for (const a of clips) {
    const aEnd = clipEnd(a, rateOf(a));
    for (const b of clips) {
      if (a === b || a.laneId === b.laneId) continue;
      // b starts inside a (strictly after a's start).
      if (!(b.start > a.start && b.start < aEnd)) continue;
      const bEnd = clipEnd(b, rateOf(b));
      if (bEnd >= aEnd) {
        const overlap = aEnd - b.start;
        bump(wantOut, a.id, overlap);
        bump(wantIn, b.id, overlap);
      } else {
        const inner = Math.min(bar, clipDuration(b, rateOf(b)) / 2);
        bump(wantIn, b.id, inner);
        bump(wantOut, b.id, inner);
      }
    }
  }

  for (const c of clips) {
    if (scope && !scope.has(c.id)) continue;
    if (fadeSideIsAuto(c.fadeInAuto, c.fadeIn)) {
      c.fadeIn = wantIn.get(c.id) ?? 0;
      c.fadeInAuto = true;
    }
    if (fadeSideIsAuto(c.fadeOutAuto, c.fadeOut)) {
      c.fadeOut = wantOut.get(c.id) ?? 0;
      c.fadeOutAuto = true;
    }
  }
  return { ...comp, clips: clips.map((c) => normalizeFades(c, rateOf(c))) };
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
