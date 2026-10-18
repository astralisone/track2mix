import { describe, expect, it } from "vitest";
import {
  formatCamelot,
  hourDelta,
  isCompatible,
  keyRelation,
  parseCamelot,
} from "@/audio/camelot";

describe("parseCamelot", () => {
  it("parses canonical and lowercase forms", () => {
    expect(parseCamelot("8A")).toEqual({ hour: 8, major: false });
    expect(parseCamelot("11B")).toEqual({ hour: 11, major: true });
    expect(parseCamelot(" 3b ")).toEqual({ hour: 3, major: true });
    expect(parseCamelot("12a")).toEqual({ hour: 12, major: false });
  });

  it("rejects out-of-range hours and junk", () => {
    expect(parseCamelot("0A")).toBeNull();
    expect(parseCamelot("13B")).toBeNull();
    expect(parseCamelot("Am")).toBeNull();
    expect(parseCamelot("8")).toBeNull();
    expect(parseCamelot("")).toBeNull();
    expect(parseCamelot(null)).toBeNull();
    expect(parseCamelot(undefined)).toBeNull();
  });

  it("round-trips through formatCamelot", () => {
    expect(formatCamelot(parseCamelot("7B")!)).toBe("7B");
    expect(formatCamelot(parseCamelot("1a")!)).toBe("1A");
  });
});

describe("hourDelta", () => {
  it("wraps around the wheel", () => {
    expect(hourDelta(12, 1)).toBe(1);
    expect(hourDelta(1, 12)).toBe(-1);
    expect(hourDelta(1, 7)).toBe(6);
    expect(hourDelta(7, 1)).toBe(6);
    expect(hourDelta(5, 5)).toBe(0);
    expect(hourDelta(3, 5)).toBe(2);
    expect(hourDelta(5, 3)).toBe(-2);
  });
});

describe("keyRelation", () => {
  it("classifies every relation", () => {
    expect(keyRelation("8A", "8A")).toBe("same");
    expect(keyRelation("8A", "8B")).toBe("relative");
    expect(keyRelation("8A", "9A")).toBe("neighbour");
    expect(keyRelation("8A", "7A")).toBe("neighbour");
    expect(keyRelation("12A", "1A")).toBe("neighbour");
    expect(keyRelation("8A", "10A")).toBe("boost");
    expect(keyRelation("11B", "1B")).toBe("boost");
    expect(keyRelation("8A", "6A")).toBe("clash");
    expect(keyRelation("8A", "9B")).toBe("diagonal");
    expect(keyRelation("8A", "7B")).toBe("diagonal");
    expect(keyRelation("8A", "2A")).toBe("clash");
    expect(keyRelation("8A", "10B")).toBe("clash");
  });

  it("is unknown when either side is unparsable", () => {
    expect(keyRelation(null, "8A")).toBe("unknown");
    expect(keyRelation("8A", "")).toBe("unknown");
    expect(keyRelation("Am", "8A")).toBe("unknown");
  });
});

describe("isCompatible (strict Rust rule)", () => {
  it("accepts same, relative and neighbour only", () => {
    expect(isCompatible("8A", "8A")).toBe(true);
    expect(isCompatible("8A", "8B")).toBe(true);
    expect(isCompatible("8A", "9A")).toBe(true);
    expect(isCompatible("8A", "7A")).toBe(true);
    expect(isCompatible("8A", "10A")).toBe(false); // boost is creative, not strict
    expect(isCompatible("8A", "9B")).toBe(false);
    expect(isCompatible("8A", "2A")).toBe(false);
    expect(isCompatible(null, "8A")).toBe(false);
  });
});
