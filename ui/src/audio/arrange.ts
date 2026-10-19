/**
 * Auto-arrange: lay a composition's lanes out as one continuous mix.
 *
 * Order comes from the playlist builder's harmonic flow (key relation, then
 * tempo closeness, then a gentle energy rise) or a plain energy sort. The
 * master tempo becomes the median lane tempo so no track is stretched far.
 * Each lane gets one clip trimmed to start on its estimated downbeat and
 * dropped on a bar line, so beats line up under lane sync; each track comes
 * in on a phrase boundary of the one before it, overlapping by `overlapBars`
 * bars. `autoCrossfade` then writes the fades across the overlaps.
 */
import { proposeOrder, sortEnergyUp, transition, type Transition } from "@/lib/mix";
import type { BeatGrid } from "./beats";
import {
  autoCrossfade,
  barSeconds,
  clipEnd,
  laneRate,
  newId,
  type Clip,
  type Composition,
  type Lane,
} from "./model";

export type ArrangeOrder = "harmonic" | "energy" | "keep";

export type ArrangeOptions = {
  /** Bars of overlap between consecutive tracks, at the master tempo. */
  overlapBars: number;
  order: ArrangeOrder;
  /** Lane whose track opens the mix (harmonic order only); lowest energy when unset. */
  startLaneId?: string | null;
  /** Incoming tracks land on a multiple of this many bars from the outgoing clip's start. */
  phraseBars?: number;
};

export const DEFAULT_ARRANGE: ArrangeOptions = { overlapBars: 16, order: "harmonic", phraseBars: 8 };
export const OVERLAP_CHOICES = [4, 8, 16, 32] as const;

/** What the arranger needs to know about each lane's decoded audio. */
export type LaneAudio = {
  /** Source duration in seconds. */
  duration: number;
  grid: BeatGrid | null;
};

export type ArrangedTransition = Transition & {
  fromLaneId: string;
  toLaneId: string;
  /** Timeline second the incoming clip starts. */
  at: number;
  overlapBars: number;
};

export type ArrangeResult = {
  comp: Composition;
  transitions: ArrangedTransition[];
  /** Lanes skipped because their audio wasn't available. */
  skippedLaneIds: string[];
};

/** Fold `bpm` into the tempo octave of `ref` (87 → 174 when ref is 170). */
export function foldBpm(bpm: number, ref: number): number {
  let b = bpm;
  while (b / ref > 1.5) b /= 2;
  while (b / ref < 0.75) b *= 2;
  return b;
}

/**
 * Master tempo for a set of lanes: the median of their tempos, each folded
 * into the first lane's octave, rounded to two decimals. `fallback` when
 * no lane has a tempo.
 */
export function chooseMasterBpm(lanes: Lane[], fallback: number): number {
  const bpms = lanes
    .map((l) => l.track.bpm)
    .filter((b): b is number => b != null && Number.isFinite(b) && b > 0);
  if (bpms.length === 0) return fallback;
  const ref = bpms[0];
  const folded = bpms.map((b) => foldBpm(b, ref)).sort((a, b) => a - b);
  const mid = Math.floor(folded.length / 2);
  const median = folded.length % 2 === 1 ? folded[mid] : (folded[mid - 1] + folded[mid]) / 2;
  return Math.round(median * 100) / 100;
}

function orderLanes(lanes: Lane[], opts: ArrangeOptions): Lane[] {
  if (opts.order === "keep") return lanes.slice();
  const byTrack = new Map(lanes.map((l) => [l.track.track_id, l]));
  const tracks = lanes.map((l) => l.track);
  const startTrack = opts.startLaneId
    ? lanes.find((l) => l.id === opts.startLaneId)?.track.track_id
    : null;
  const ids = opts.order === "energy" ? sortEnergyUp(tracks) : proposeOrder(tracks, startTrack);
  const out: Lane[] = [];
  for (const id of ids) {
    const lane = byTrack.get(id);
    if (lane) out.push(lane);
  }
  return out;
}

const snapBar = (t: number, bar: number) => Math.round(t / bar) * bar;

/** Grids this confident, this close to the tag, correct the lane's tempo. */
const MIN_GRID_CONFIDENCE = 1.5;
const MAX_TEMPO_CORRECTION = 0.02;

/**
 * Tags are often whole numbers; the detected tempo is what the audio
 * actually does, and the lane syncs by its track's BPM. Only a clear grid
 * within 2% of the tag is trusted.
 */
function withRefinedBpm(lane: Lane, grid: BeatGrid | null): Lane {
  const tag = lane.track.bpm;
  if (!grid || grid.confidence < MIN_GRID_CONFIDENCE || !(grid.bpm > 0)) return lane;
  if (tag == null || !(tag > 0)) return lane;
  if (Math.abs(grid.bpm - tag) / tag > MAX_TEMPO_CORRECTION) return lane;
  if (grid.bpm === tag) return lane;
  return { ...lane, track: { ...lane.track, bpm: grid.bpm } };
}

/**
 * Arrange `comp`. Lanes without an entry in `audio` keep their place in
 * the lane list but get no clip and are reported in `skippedLaneIds`.
 * Existing clips are replaced.
 */
export function autoArrange(
  comp: Composition,
  audio: Map<string, LaneAudio>,
  opts: ArrangeOptions = DEFAULT_ARRANGE,
): ArrangeResult {
  const ready = comp.lanes
    .filter((l) => (audio.get(l.id)?.duration ?? 0) > 0)
    .map((l) => withRefinedBpm(l, audio.get(l.id)!.grid));
  const readyIds = new Set(ready.map((l) => l.id));
  const skippedLaneIds = comp.lanes.filter((l) => !readyIds.has(l.id)).map((l) => l.id);
  const ordered = orderLanes(ready, opts);
  const masterBpm = chooseMasterBpm(ordered, comp.masterBpm);
  const bar = barSeconds(masterBpm);
  const overlapBars = Math.max(1, Math.round(opts.overlapBars));
  const phraseBars = Math.max(1, Math.round(opts.phraseBars ?? DEFAULT_ARRANGE.phraseBars ?? 8));

  const clips: Clip[] = [];
  const transitions: ArrangedTransition[] = [];
  let prev: { lane: Lane; clip: Clip; rate: number } | null = null;

  for (const lane of ordered) {
    const info = audio.get(lane.id)!;
    const rate = laneRate(lane, masterBpm);
    const offset = Math.min(info.grid?.barOffset ?? 0, Math.max(0, info.duration - 1));
    const length = info.duration - offset;
    const tlDur = length / rate;

    let start = 0;
    let usedOverlapBars = 0;
    if (prev) {
      const prevEnd = clipEnd(prev.clip, prev.rate);
      const prevDur = prevEnd - prev.clip.start;
      // Never blend across more than a third of either track.
      const maxBars = Math.floor(Math.min(prevDur, tlDur) / 3 / bar);
      usedOverlapBars = Math.max(1, Math.min(overlapBars, maxBars));
      const want = prevEnd - usedOverlapBars * bar;
      // Land on a phrase of the outgoing clip when that keeps a sane overlap.
      const phrase = phraseBars * bar;
      const onPhrase = prev.clip.start + Math.round((want - prev.clip.start) / phrase) * phrase;
      const latest = prevEnd - bar;
      const earliest = Math.max(prev.clip.start + bar, prevEnd - 2 * usedOverlapBars * bar);
      start = onPhrase >= earliest && onPhrase <= latest ? onPhrase : snapBar(want, bar);
      start = Math.min(latest, Math.max(prev.clip.start + bar, start));
      usedOverlapBars = Math.round((prevEnd - start) / bar);
    }

    const clip: Clip = {
      id: newId("clip"),
      laneId: lane.id,
      start,
      offset,
      length,
      fadeIn: 0,
      fadeOut: 0,
      fadeInAuto: true,
      fadeOutAuto: true,
    };
    clips.push(clip);
    if (prev) {
      transitions.push({
        ...transition(prev.lane.track, lane.track),
        fromLaneId: prev.lane.id,
        toLaneId: lane.id,
        at: start,
        overlapBars: usedOverlapBars,
      });
    }
    prev = { lane, clip, rate };
  }

  const lanes = [...ordered, ...comp.lanes.filter((l) => !readyIds.has(l.id))];
  const arranged = autoCrossfade({ ...comp, masterBpm, lanes, clips });
  return { comp: arranged, transitions, skippedLaneIds };
}

/** One-line human summary of an arrangement for the toast. */
export function describeArrangement(r: ArrangeResult): string {
  const n = r.comp.lanes.length - r.skippedLaneIds.length;
  if (n === 0) return "Nothing to arrange — no lane has loaded audio yet.";
  const harmonic = r.transitions.filter(
    (t) => t.relation === "same" || t.relation === "adjacent" || t.relation === "relative",
  ).length;
  const bars = Array.from(new Set(r.transitions.map((t) => t.overlapBars))).sort((a, b) => a - b);
  const parts = [`Arranged ${n} track${n === 1 ? "" : "s"} at ${r.comp.masterBpm} BPM`];
  if (r.transitions.length > 0) {
    parts.push(`${harmonic}/${r.transitions.length} harmonic transitions`);
    parts.push(`${bars.join("–")}-bar blends`);
    const worst = r.transitions.reduce(
      (m, t) => Math.max(m, Math.abs(t.bpmDeltaPct ?? 0)),
      0,
    );
    if (worst > 0) parts.push(`max tempo stretch ${worst.toFixed(1)}%`);
  }
  if (r.skippedLaneIds.length > 0) {
    parts.push(`${r.skippedLaneIds.length} lane${r.skippedLaneIds.length === 1 ? "" : "s"} skipped (audio not loaded)`);
  }
  return parts.join(" · ");
}

