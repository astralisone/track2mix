import { describe, expect, test } from "vitest";
import {
  compatibleKeys,
  hourDelta,
  keyRelation,
  parseCamelot,
} from "../src/lib/camelot";

describe("camelot", () => {
  test("parses canonical keys and rejects junk", () => {
    expect(parseCamelot("8A")).toEqual({ hour: 8, major: false });
    expect(parseCamelot("11B")).toEqual({ hour: 11, major: true });
    expect(parseCamelot("13A")).toBeNull();
    expect(parseCamelot("Am")).toBeNull();
    expect(parseCamelot(null)).toBeNull();
  });

  test("wheel wraps 12↔1", () => {
    expect(hourDelta(12, 1)).toBe(1);
    expect(hourDelta(1, 7)).toBe(6);
    expect(keyRelation("12A", "1A")).toBe("adjacent");
    expect(keyRelation("1B", "12B")).toBe("adjacent");
  });

  test("relations mirror Camelot::compatible plus ±2", () => {
    expect(keyRelation("8A", "8A")).toBe("same");
    expect(keyRelation("8A", "8B")).toBe("relative");
    expect(keyRelation("8A", "9A")).toBe("adjacent");
    expect(keyRelation("8A", "7A")).toBe("adjacent");
    expect(keyRelation("8A", "10A")).toBe("boost");
    expect(keyRelation("8A", "6A")).toBe("drop");
    expect(keyRelation("12A", "2A")).toBe("boost");
    expect(keyRelation("1A", "11A")).toBe("drop");
    expect(keyRelation("8A", "9B")).toBe("clash");
    expect(keyRelation("8A", "2A")).toBe("clash");
    expect(keyRelation("8A", null)).toBe("unknown");
  });

  test("compatible keys include wraparound neighbours", () => {
    expect(compatibleKeys("12B").sort()).toEqual(["11B", "12A", "12B", "1B"].sort());
    expect(compatibleKeys(null)).toEqual([]);
  });
});
