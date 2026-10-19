import { describe, expect, test } from "vitest";
import {
  applyFilters,
  binIndex,
  emptyFilters,
  facetCounts,
  hasAnyFilter,
  filterBpm,
  libraryBpmBounds,
  toggleIn,
  type FilterState,
} from "../src/lib/filters";
import type { UiTrack } from "../src/lib/tauri";

let n = 0;
function t(p: Partial<UiTrack>): UiTrack {
  n++;
  return {
    track_id: String(n),
    name: `Track ${n}`,
    artist: "Someone",
    genre: "House",
    sub_genre: null,
    bpm: 124,
    tonality: "Am",
    camelot: "8A",
    energy_raw: null,
    energy: 6,
    file_path: null,
    ...p,
  };
}

const lib: UiTrack[] = [
  t({ track_id: "a", name: "Strobe", artist: "deadmau5", genre: "Progressive House", sub_genre: "Melodic", bpm: 128, camelot: "10A", tonality: "Bm", energy: 7 }),
  t({ track_id: "b", name: "Opus", artist: "Eric Prydz", genre: "Progressive House", sub_genre: null, bpm: 126, camelot: "8A", energy: 8 }),
  t({ track_id: "c", name: "Rej", artist: "Âme", genre: "Deep House", sub_genre: "Melodic", bpm: 120, camelot: "8B", tonality: "C", energy: 5 }),
  t({ track_id: "d", name: "Untagged", artist: "Unknown", genre: "Techno", sub_genre: "Peak Time", bpm: null, camelot: null, tonality: "", energy: null }),
  t({ track_id: "e", name: "Fast One", artist: "X", genre: "techno", sub_genre: "peak time", bpm: 140, camelot: "9A", energy: 9 }),
];

const ids = (ts: UiTrack[]) => ts.map((x) => x.track_id).sort();
const F = (p: Partial<FilterState>): FilterState => ({ ...emptyFilters, ...p });

describe("applyFilters", () => {
  test("empty filters return everything", () => {
    expect(hasAnyFilter(emptyFilters)).toBe(false);
    expect(applyFilters(lib, emptyFilters)).toHaveLength(lib.length);
  });

  test("null range means no constraint, null values kept", () => {
    expect(ids(applyFilters(lib, F({ search: "" })))).toContain("d");
  });

  test("non-null BPM range excludes null BPM and is inclusive", () => {
    const r = applyFilters(lib, F({ bpm: [120, 128] }));
    expect(ids(r)).toEqual(["a", "b", "c"]);
  });

  test("non-null energy range excludes null energy", () => {
    const r = applyFilters(lib, F({ energy: [0, 10] }));
    expect(ids(r)).not.toContain("d");
    expect(r).toHaveLength(4);
  });

  test("key selection excludes tracks with no key", () => {
    expect(ids(applyFilters(lib, F({ keys: ["8A", "8B"] })))).toEqual(["b", "c"]);
    expect(ids(applyFilters(lib, F({ keys: ["8A", "8B"] })))).not.toContain("d");
  });

  test("genre match is exact and case-insensitive", () => {
    expect(ids(applyFilters(lib, F({ genres: ["TECHNO"] })))).toEqual(["d", "e"]);
    // exact, not substring
    expect(applyFilters(lib, F({ genres: ["House"] }))).toHaveLength(0);
  });

  test("sub-genre selection excludes null sub-genre", () => {
    expect(ids(applyFilters(lib, F({ subGenres: ["melodic"] })))).toEqual(["a", "c"]);
  });

  test("search covers name, artist, genre, sub_genre, tonality", () => {
    expect(ids(applyFilters(lib, F({ search: "strobe" })))).toEqual(["a"]);
    expect(ids(applyFilters(lib, F({ search: "PRYDZ" })))).toEqual(["b"]);
    expect(ids(applyFilters(lib, F({ search: "deep house" })))).toEqual(["c"]);
    expect(ids(applyFilters(lib, F({ search: "peak" })))).toEqual(["d", "e"]);
    expect(ids(applyFilters(lib, F({ search: "bm" })))).toEqual(["a"]);
    // multiple tokens AND across fields
    expect(ids(applyFilters(lib, F({ search: "melodic âme" })))).toEqual(["c"]);
  });

  test("facets combine with AND", () => {
    const r = applyFilters(lib, F({ genres: ["Progressive House"], bpm: [127, 130] }));
    expect(ids(r)).toEqual(["a"]);
  });
});

describe("facetCounts", () => {
  const bounds = libraryBpmBounds(lib);

  test("bpm bounds are whole numbers from the library", () => {
    expect(bounds).toEqual([120, 140]);
  });

  test("key counts exclude the key filter but apply the others", () => {
    const f = F({ keys: ["8A"], genres: ["Progressive House"] });
    const fc = facetCounts(lib, f, bounds);
    expect(fc.keys["8A"]).toBe(1);
    expect(fc.keys["10A"]).toBe(1); // still counted though not selected
    expect(fc.keys["8B"]).toBe(0); // excluded by genre
    expect(Object.keys(fc.keys)).toHaveLength(24);
  });

  test("genre counts exclude the genre filter", () => {
    const fc = facetCounts(lib, F({ genres: ["Deep House"] }), bounds);
    const get = (g: string) => fc.genres.find((x) => x.value.toLowerCase() === g)?.count;
    expect(get("progressive house")).toBe(2);
    expect(get("techno")).toBe(2); // merged case-insensitively
    expect(get("deep house")).toBe(1);
    expect(fc.genres[0].count).toBe(2);
  });

  test("genre list keeps zero-count genres", () => {
    const fc = facetCounts(lib, F({ keys: ["10A"] }), bounds);
    expect(fc.genres.find((x) => x.value === "Deep House")?.count).toBe(0);
  });

  test("sub-genres are scoped to the selected genres", () => {
    const fc = facetCounts(lib, F({ genres: ["Techno"], subGenres: ["Peak Time"] }), bounds);
    expect(fc.subGenres.map((x) => x.value)).toEqual(["Peak Time"]);
    expect(fc.subGenres[0].count).toBe(2);
  });

  test("bpm histogram excludes the bpm filter; all-track histogram is unfiltered", () => {
    const f = F({ bpm: [120, 121], energy: [8, 10] });
    const fc = facetCounts(lib, f, bounds);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(sum(fc.bpmAll)).toBe(4); // null BPM not binned
    expect(sum(fc.bpm)).toBe(2); // b (8), e (9) despite bpm filter
    expect(fc.bpm[binIndex(140, bounds, fc.bpm.length)]).toBe(1);
  });

  test("energy histogram excludes the energy filter", () => {
    const fc = facetCounts(lib, F({ energy: [9, 9], genres: ["Progressive House"] }), bounds);
    expect(fc.energy[7]).toBe(1);
    expect(fc.energy[8]).toBe(1);
    expect(fc.energy[9]).toBe(0);
    expect(fc.energyAll.reduce((a, b) => a + b, 0)).toBe(4);
    expect(fc.energyAll).toHaveLength(11);
  });
});

describe("fractional BPM", () => {
  const frac = [
    t({ track_id: "x", bpm: 127.5 }),
    t({ track_id: "y", bpm: 127.4 }),
    t({ track_id: "z", bpm: 120 }),
  ];

  test("filter and histogram agree on whole-BPM rounding", () => {
    expect(filterBpm(127.5)).toBe(128);
    expect(filterBpm(0)).toBeNull();
    expect(ids(applyFilters(frac, F({ bpm: [120, 127] })))).toEqual(["y", "z"]);
    expect(ids(applyFilters(frac, F({ bpm: [128, 128] })))).toEqual(["x"]);

    const bounds = libraryBpmBounds(frac); // [120, 128]
    expect(bounds).toEqual([120, 128]);
    // 16 half-BPM-wide bins: 127 → bin 14, 128 → bin 15 (top edge)
    const fc = facetCounts(frac, emptyFilters, bounds, 16);
    expect(fc.bpmAll[binIndex(128, bounds, 16)]).toBe(1); // 127.5 → 128
    expect(fc.bpmAll[binIndex(127, bounds, 16)]).toBe(1); // 127.4 → 127
    expect(fc.bpmAll[0]).toBe(1);
  });
});

describe("search cache", () => {
  test("repeated searches give the same results", () => {
    const a = ids(applyFilters(lib, F({ search: "house" })));
    expect(ids(applyFilters(lib, F({ search: "house" })))).toEqual(a);
    expect(a).toEqual(["a", "b", "c"]);
  });
});

describe("helpers", () => {
  test("toggleIn is case-insensitive", () => {
    expect(toggleIn(["House"], "house")).toEqual([]);
    expect(toggleIn(["House"], "Techno")).toEqual(["House", "Techno"]);
  });

  test("binIndex clamps the top edge into the last bin", () => {
    expect(binIndex(140, [120, 140], 20)).toBe(19);
    expect(binIndex(120, [120, 140], 20)).toBe(0);
    expect(binIndex(119, [120, 140], 20)).toBe(-1);
  });
});
