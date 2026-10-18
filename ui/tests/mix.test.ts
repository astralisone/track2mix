import { describe, expect, test } from "bun:test";
import {
  bpmDeltaPct,
  moveItem,
  proposeOrder,
  reconcileOrder,
  sortBpmUp,
  sortEnergyUp,
  transition,
  type MixTrack,
} from "../src/lib/mix";

const t = (
  track_id: string,
  bpm: number | null,
  camelot: string | null,
  energy: number | null,
): MixTrack => ({ track_id, bpm, camelot, energy });

describe("transition", () => {
  test("bpm delta picks the closest of 1×, ½× and 2×", () => {
    expect(bpmDeltaPct(128, 128)).toBe(0);
    expect(bpmDeltaPct(128, 64)).toBeCloseTo(0);
    expect(bpmDeltaPct(70, 140)).toBeCloseTo(0);
    expect(bpmDeltaPct(100, 102)).toBeCloseTo(2);
    expect(bpmDeltaPct(100, 98)).toBeCloseTo(-2);
    // 174 vs 2×86 = 172 → +1.16%, not +102%
    expect(bpmDeltaPct(86, 174)).toBeCloseTo((174 - 172) / 172 * 100);
    // 128 vs ½×128 = 64 → 66 is +3.1%
    expect(bpmDeltaPct(128, 66)).toBeCloseTo((66 - 64) / 64 * 100);
  });

  test("null bpm, energy or key", () => {
    const tr = transition(t("a", null, null, null), t("b", 128, "8A", 5));
    expect(tr.relation).toBe("unknown");
    expect(tr.bpmDeltaPct).toBeNull();
    expect(tr.energyDelta).toBeNull();
    expect(Number.isFinite(tr.score)).toBe(true);
    expect(bpmDeltaPct(0, 128)).toBeNull();
  });

  test("relation, energy delta and score ordering", () => {
    const a = t("a", 124, "8A", 5);
    const perfect = transition(a, t("b", 124, "8A", 6));
    const clash = transition(a, t("c", 124, "3B", 6));
    expect(perfect.relation).toBe("same");
    expect(perfect.energyDelta).toBe(1);
    expect(clash.relation).toBe("clash");
    expect(perfect.score).toBeGreaterThan(clash.score);
  });
});

describe("proposeOrder", () => {
  const set = [
    t("d", 126, "10A", 7),
    t("a", 124, "8A", 4),
    t("c", 125, "9A", 6),
    t("x", 140, "3B", 8),
    t("b", 124, "8B", 5),
  ];

  test("starts at the lowest energy and is deterministic", () => {
    const one = proposeOrder(set);
    const two = proposeOrder(set.slice().reverse());
    expect(one[0]).toBe("a");
    expect(one).toEqual(two);
    expect(one.slice().sort()).toEqual(["a", "b", "c", "d", "x"]);
    // the clashing outlier goes last
    expect(one[one.length - 1]).toBe("x");
  });

  test("starts at the anchor when it is in the set", () => {
    expect(proposeOrder(set, "c")[0]).toBe("c");
    expect(proposeOrder(set, "missing")[0]).toBe("a");
  });

  test("handles empty, duplicates and null fields", () => {
    expect(proposeOrder([])).toEqual([]);
    const out = proposeOrder([t("n", null, null, null), t("a", 120, "1A", 3), t("a", 120, "1A", 3)]);
    expect(out).toEqual(["a", "n"]);
  });
});

describe("sorts", () => {
  const set = [t("a", null, null, 5), t("b", 120, null, null), t("c", 110, null, 5), t("d", 130, null, 2)];
  test("energy up, nulls last, stable", () => {
    expect(sortEnergyUp(set)).toEqual(["d", "a", "c", "b"]);
  });
  test("bpm up, nulls last", () => {
    expect(sortBpmUp(set)).toEqual(["c", "b", "d", "a"]);
  });
});

describe("reconcileOrder", () => {
  test("keeps arrangement, drops removed, appends new in selection order", () => {
    expect(reconcileOrder(["c", "a", "b"], ["a", "b", "c", "d"])).toEqual(["c", "a", "b", "d"]);
    expect(reconcileOrder(["c", "a", "b"], ["a", "b"])).toEqual(["a", "b"]);
    expect(reconcileOrder(["c", "a"], ["e", "a", "d"])).toEqual(["a", "e", "d"]);
    expect(reconcileOrder([], ["x", "y"])).toEqual(["x", "y"]);
  });
  test("de-duplicates", () => {
    expect(reconcileOrder(["a", "a", "b"], ["b", "a", "b", "c", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("moveItem", () => {
  const o = ["a", "b", "c", "d"];
  test("moves and clamps", () => {
    expect(moveItem(o, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(o, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(o, 1, 99)).toEqual(["a", "c", "d", "b"]);
    expect(moveItem(o, 2, -5)).toEqual(["c", "a", "b", "d"]);
  });
  test("ignores bad source indices and does not mutate", () => {
    expect(moveItem(o, -1, 2)).toEqual(o);
    expect(moveItem(o, 4, 0)).toEqual(o);
    expect(moveItem(o, 1, Number.NaN)).toEqual(o);
    expect(moveItem([], 0, 0)).toEqual([]);
    expect(o).toEqual(["a", "b", "c", "d"]);
  });
});
