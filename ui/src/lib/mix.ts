// Pure set-building helpers for the playlist builder: how one track flows into
// the next, a greedy harmonic ordering, simple sorts, and order bookkeeping.
import { isCompatible, keyRelation, type KeyRelation } from "./camelot";

/** The fields mix logic reads. `UiTrack` satisfies it. */
export type MixTrack = {
  track_id: string;
  bpm: number | null;
  camelot: string | null;
  energy: number | null;
};

export type Transition = {
  relation: KeyRelation;
  /** Signed % change from a's tempo (at 1×, ½× or 2×, whichever is closest) to b's. */
  bpmDeltaPct: number | null;
  /** b.energy − a.energy, or null if either is unknown. */
  energyDelta: number | null;
  /** 0–100, higher mixes better. */
  score: number;
};

const KEY_RANK: Record<KeyRelation, number> = {
  same: 0,
  adjacent: 1,
  relative: 2,
  boost: 3,
  drop: 4,
  unknown: 5,
  clash: 6,
};

const KEY_SCORE: Record<KeyRelation, number> = {
  same: 50,
  adjacent: 45,
  relative: 40,
  boost: 30,
  drop: 25,
  unknown: 15,
  clash: 0,
};

function validBpm(b: number | null | undefined): b is number {
  return b != null && Number.isFinite(b) && b > 0;
}

/**
 * Signed tempo change in percent from `a` to `b`, comparing `b` against
 * `a`'s tempo at 1×, ½× and 2× and keeping the closest. Null if either is
 * missing.
 */
export function bpmDeltaPct(a: number | null, b: number | null): number | null {
  if (!validBpm(a) || !validBpm(b)) return null;
  let best: number | null = null;
  for (const m of [1, 0.5, 2]) {
    const ref = a * m;
    const pct = ((b - ref) / ref) * 100;
    if (best === null || Math.abs(pct) < Math.abs(best) - 1e-9) best = pct;
  }
  return best;
}

function energyCost(delta: number | null): number {
  if (delta === null) return 2;
  if (delta === 1) return 0;
  if (delta === 0) return 0.5;
  if (delta === 2) return 1;
  if (delta === -1) return 1.5;
  return 2 + Math.abs(delta);
}

export function transition(a: MixTrack, b: MixTrack): Transition {
  const relation = keyRelation(a.camelot, b.camelot);
  const bpm = bpmDeltaPct(a.bpm, b.bpm);
  const energyDelta =
    a.energy != null && b.energy != null ? b.energy - a.energy : null;
  const bpmScore = bpm === null ? 15 : Math.max(0, 30 - Math.abs(bpm) * 5);
  const energyScore = Math.max(0, 20 - energyCost(energyDelta) * 5);
  const score = Math.round(KEY_SCORE[relation] + bpmScore + energyScore);
  return { relation, bpmDeltaPct: bpm, energyDelta, score };
}

/** True when the move is key-compatible (same, relative or ±1). */
export function isHarmonic(t: Transition): boolean {
  return isCompatible(t.relation);
}

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Greedy harmonic flow. Starts at `startId` when it is in the set, otherwise
 * at the lowest-energy track. Each next track is the best by key relation,
 * then BPM closeness (to the nearest whole percent), then a gentle energy
 * rise, then track id. Duplicate ids are kept once.
 */
export function proposeOrder<T extends MixTrack>(
  tracks: T[],
  startId?: string | null,
): string[] {
  const seen = new Set<string>();
  const pool: T[] = [];
  for (const t of tracks) {
    if (seen.has(t.track_id)) continue;
    seen.add(t.track_id);
    pool.push(t);
  }
  if (pool.length === 0) return [];

  let startIdx = startId ? pool.findIndex((t) => t.track_id === startId) : -1;
  if (startIdx < 0) {
    startIdx = 0;
    for (let i = 1; i < pool.length; i++) {
      if (lowerStart(pool[i], pool[startIdx])) startIdx = i;
    }
  }

  const out: string[] = [];
  let cur = pool.splice(startIdx, 1)[0];
  out.push(cur.track_id);
  while (pool.length > 0) {
    let bestIdx = 0;
    let bestKey = candidateKey(cur, pool[0]);
    for (let i = 1; i < pool.length; i++) {
      const k = candidateKey(cur, pool[i]);
      if (lexLess(k, bestKey, pool[i].track_id, pool[bestIdx].track_id)) {
        bestIdx = i;
        bestKey = k;
      }
    }
    cur = pool.splice(bestIdx, 1)[0];
    out.push(cur.track_id);
  }
  return out;
}

function lowerStart(a: MixTrack, b: MixTrack): boolean {
  const ea = a.energy ?? Infinity;
  const eb = b.energy ?? Infinity;
  if (ea !== eb) return ea < eb;
  const ba = validBpm(a.bpm) ? a.bpm : Infinity;
  const bb = validBpm(b.bpm) ? b.bpm : Infinity;
  if (ba !== bb) return ba < bb;
  return cmpId(a.track_id, b.track_id) < 0;
}

function candidateKey(a: MixTrack, b: MixTrack): number[] {
  const t = transition(a, b);
  const bpm = t.bpmDeltaPct === null ? 1000 : Math.round(Math.abs(t.bpmDeltaPct));
  return [KEY_RANK[t.relation], bpm, energyCost(t.energyDelta)];
}

function lexLess(a: number[], b: number[], idA: string, idB: string): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return cmpId(idA, idB) < 0;
}

function stableSortBy<T extends MixTrack>(
  tracks: T[],
  value: (t: T) => number | null,
): string[] {
  return tracks
    .map((t, i) => ({ t, i, v: value(t) }))
    .sort((x, y) => {
      if (x.v === null && y.v === null) return x.i - y.i;
      if (x.v === null) return 1;
      if (y.v === null) return -1;
      return x.v - y.v || x.i - y.i;
    })
    .map((x) => x.t.track_id);
}

/** Lowest energy first; unknown energy last; ties keep their input order. */
export function sortEnergyUp<T extends MixTrack>(tracks: T[]): string[] {
  return stableSortBy(tracks, (t) => t.energy);
}

/** Slowest first; unknown BPM last; ties keep their input order. */
export function sortBpmUp<T extends MixTrack>(tracks: T[]): string[] {
  return stableSortBy(tracks, (t) => (validBpm(t.bpm) ? t.bpm : null));
}

/**
 * Keep `prev`'s arrangement for ids that are still selected, then append
 * newly selected ids in `selectedIds` order. Removed ids drop out and
 * duplicates are kept once.
 */
export function reconcileOrder(prev: string[], selectedIds: string[]): string[] {
  const selected = new Set(selectedIds);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of prev) {
    if (selected.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of selectedIds) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Move the item at `from` to `to`, clamping `to` into range. Returns a new array. */
export function moveItem<T>(order: T[], from: number, to: number): T[] {
  const out = order.slice();
  if (!Number.isInteger(from) || from < 0 || from >= out.length) return out;
  if (Number.isNaN(to)) return out;
  const target = Math.max(0, Math.min(out.length - 1, Math.trunc(to)));
  if (target === from) return out;
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item);
  return out;
}
