// Library filtering and faceted counts for the filter pane.
//
// Every facet (search, genre, sub-genre, key, BPM, energy) is an AND
// constraint. `facetCounts` counts each facet as if its own constraint were
// lifted, so the pane can show "what you would get if you picked this too".

import type { UiTrack } from "./tauri";
import { ALL_KEYS } from "./camelot";

export type Range = [number, number];

export type FilterState = {
  search: string;
  genres: string[];
  subGenres: string[];
  keys: string[]; // canonical Camelot, e.g. "8A"
  bpm: Range | null; // inclusive; null = no constraint
  energy: Range | null; // inclusive, 0–10; null = no constraint
};

export const emptyFilters: FilterState = {
  search: "",
  genres: [],
  subGenres: [],
  keys: [],
  bpm: null,
  energy: null,
};

export function hasAnyFilter(f: FilterState): boolean {
  return (
    f.search.trim() !== "" ||
    f.genres.length > 0 ||
    f.subGenres.length > 0 ||
    f.keys.length > 0 ||
    f.bpm != null ||
    f.energy != null
  );
}

/** Number of active facets (search counts as one). */
export function activeFilterCount(f: FilterState): number {
  return (
    (f.search.trim() !== "" ? 1 : 0) +
    (f.genres.length > 0 ? 1 : 0) +
    (f.subGenres.length > 0 ? 1 : 0) +
    (f.keys.length > 0 ? 1 : 0) +
    (f.bpm != null ? 1 : 0) +
    (f.energy != null ? 1 : 0)
  );
}

export const ENERGY_BOUNDS: Range = [0, 10];
const DEFAULT_BPM_BOUNDS: Range = [60, 200];
const DEFAULT_BPM_BINS = 36;

/** Whole-number BPM bounds of the library, for the slider. */
export function libraryBpmBounds(tracks: UiTrack[]): Range {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of tracks) {
    if (t.bpm == null || !(t.bpm > 0)) continue;
    if (t.bpm < lo) lo = t.bpm;
    if (t.bpm > hi) hi = t.bpm;
  }
  if (lo === Infinity) return DEFAULT_BPM_BOUNDS;
  const a = Math.floor(lo);
  const b = Math.ceil(hi);
  return a === b ? [a, a + 1] : [a, b];
}

// ---------------------------------------------------------------------------
// Predicates (one per facet), shared by applyFilters and facetCounts.

type Compiled = {
  tokens: string[];
  genres: Set<string> | null;
  subGenres: Set<string> | null;
  keys: Set<string> | null;
  bpm: Range | null;
  energy: Range | null;
};

const lc = (s: string) => s.trim().toLowerCase();

function compile(f: FilterState): Compiled {
  const set = (xs: string[], norm: (s: string) => string) =>
    xs.length ? new Set(xs.map(norm)) : null;
  return {
    tokens: lc(f.search).split(/\s+/).filter(Boolean),
    genres: set(f.genres, lc),
    subGenres: set(f.subGenres, lc),
    keys: set(f.keys, (k) => k.trim().toUpperCase()),
    bpm: f.bpm,
    energy: f.energy,
  };
}

// Search text per track, cached so typing doesn't rebuild it for the whole
// library on every keystroke. Track objects are replaced (not mutated) on reload.
const haystacks = new WeakMap<UiTrack, string>();
function haystack(t: UiTrack): string {
  let h = haystacks.get(t);
  if (h === undefined) {
    h = [t.name, t.artist, t.genre, t.sub_genre ?? "", t.tonality, t.camelot ?? ""]
      .join("\u0001")
      .toLowerCase();
    haystacks.set(t, h);
  }
  return h;
}

/**
 * BPM as the filter and histogram see it: rounded to a whole number, since the
 * slider steps in whole BPM. So 127.5 falls in a [120, 128] range and the 128
 * bin, consistently. Null for missing / non-positive BPM.
 */
export function filterBpm(bpm: number | null): number | null {
  return bpm != null && bpm > 0 ? Math.round(bpm) : null;
}

function inRange(v: number | null, r: Range | null): boolean {
  if (!r) return true;
  if (v == null) return false;
  return v >= r[0] && v <= r[1];
}

const passSearch = (c: Compiled, t: UiTrack) => {
  if (!c.tokens.length) return true;
  const h = haystack(t);
  return c.tokens.every((tok) => h.includes(tok));
};
const passGenre = (c: Compiled, t: UiTrack) => !c.genres || c.genres.has(lc(t.genre));
const passSub = (c: Compiled, t: UiTrack) =>
  !c.subGenres || (t.sub_genre != null && c.subGenres.has(lc(t.sub_genre)));
const passKey = (c: Compiled, t: UiTrack) =>
  !c.keys || (t.camelot != null && c.keys.has(t.camelot.toUpperCase()));
const passBpm = (c: Compiled, t: UiTrack) => inRange(filterBpm(t.bpm), c.bpm);
const passEnergy = (c: Compiled, t: UiTrack) => inRange(t.energy, c.energy);

export function applyFilters(tracks: UiTrack[], f: FilterState): UiTrack[] {
  if (!hasAnyFilter(f)) return tracks;
  const c = compile(f);
  return tracks.filter(
    (t) =>
      passGenre(c, t) &&
      passSub(c, t) &&
      passKey(c, t) &&
      passBpm(c, t) &&
      passEnergy(c, t) &&
      passSearch(c, t),
  );
}

// ---------------------------------------------------------------------------
// Faceted counts

export type FacetValue = { value: string; count: number };

export type Facets = {
  /** All 24 Camelot keys → matches with every filter except the key filter. */
  keys: Record<string, number>;
  /** Every library genre, count excludes the genre filter. Sorted by count desc, then name. */
  genres: FacetValue[];
  /** Sub-genres of tracks passing the genre filter; count excludes the sub-genre filter. Sorted likewise. */
  subGenres: FacetValue[];
  /** BPM histogram over bpmBounds (bins evenly spaced), excluding the BPM filter. */
  bpm: number[];
  /** BPM histogram of the whole library, same bins. */
  bpmAll: number[];
  /** Energy histogram, 11 bins (0..10), excluding the energy filter. */
  energy: number[];
  /** Energy histogram of the whole library. */
  energyAll: number[];
};

/** Bin index for a value in [lo, hi] split into n equal bins; -1 if outside. */
export function binIndex(v: number, bounds: Range, n: number): number {
  const [lo, hi] = bounds;
  if (v < lo || v > hi || n <= 0) return -1;
  if (hi <= lo) return 0;
  return Math.min(n - 1, Math.floor(((v - lo) / (hi - lo)) * n));
}

export function bpmBinCount(bounds: Range, max = DEFAULT_BPM_BINS): number {
  return Math.max(1, Math.min(max, Math.round(bounds[1] - bounds[0])));
}

/**
 * Single pass over the library. Each facet's counts apply every filter except
 * its own. Genre labels keep the casing first seen in the library.
 */
export function facetCounts(
  tracks: UiTrack[],
  f: FilterState,
  bpmBounds: Range,
  bpmBins: number = bpmBinCount(bpmBounds),
): Facets {
  const c = compile(f);
  const keys: Record<string, number> = {};
  for (const k of ALL_KEYS) keys[k] = 0;
  const genres = new Map<string, FacetValue>();
  const subGenres = new Map<string, FacetValue>();
  const bpm = new Array<number>(bpmBins).fill(0);
  const bpmAll = new Array<number>(bpmBins).fill(0);
  const energy = new Array<number>(11).fill(0);
  const energyAll = new Array<number>(11).fill(0);

  for (const t of tracks) {
    const s = passSearch(c, t);
    const g = passGenre(c, t);
    const sg = passSub(c, t);
    const k = passKey(c, t);
    const b = passBpm(c, t);
    const e = passEnergy(c, t);

    // Key
    if (t.camelot) {
      const kk = t.camelot.toUpperCase();
      if (kk in keys && s && g && sg && b && e) keys[kk]++;
    }

    // Genre (every library genre listed, even at 0)
    const gl = t.genre.trim();
    if (gl) {
      const id = gl.toLowerCase();
      let v = genres.get(id);
      if (!v) genres.set(id, (v = { value: gl, count: 0 }));
      if (s && sg && k && b && e) v.count++;
    }

    // Sub-genre, scoped to the selected genres
    const sgl = t.sub_genre?.trim();
    if (sgl && g) {
      const id = sgl.toLowerCase();
      let v = subGenres.get(id);
      if (!v) subGenres.set(id, (v = { value: sgl, count: 0 }));
      if (s && k && b && e) v.count++;
    }

    // BPM
    const tb = filterBpm(t.bpm);
    if (tb != null) {
      const i = binIndex(tb, bpmBounds, bpmBins);
      if (i >= 0) {
        bpmAll[i]++;
        if (s && g && sg && k && e) bpm[i]++;
      }
    }

    // Energy
    if (t.energy != null) {
      const i = Math.max(0, Math.min(10, Math.round(t.energy)));
      energyAll[i]++;
      if (s && g && sg && k && b) energy[i]++;
    }
  }

  const sorted = (m: Map<string, FacetValue>) =>
    [...m.values()].sort(
      (a, b) => b.count - a.count || a.value.localeCompare(b.value),
    );

  return {
    keys,
    genres: sorted(genres),
    subGenres: sorted(subGenres),
    bpm,
    bpmAll,
    energy,
    energyAll,
  };
}

/** Toggle membership (case-insensitive) in a string list. */
export function toggleIn(list: string[], v: string): string[] {
  const id = v.toLowerCase();
  return list.some((x) => x.toLowerCase() === id)
    ? list.filter((x) => x.toLowerCase() !== id)
    : [...list, v];
}
