// TypeScript port of the Camelot rules in src/keys.rs. The backend's
// `map_track` always hands the UI the canonical form ("8A", "11B") or null,
// so only that form needs parsing here.

export type Camelot = { hour: number; major: boolean };

export type KeyRelation =
  | "same"
  | "relative"
  | "adjacent"
  | "boost"
  | "drop"
  | "clash"
  | "unknown";

export function parseCamelot(s: string | null | undefined): Camelot | null {
  if (!s) return null;
  const m = /^(\d{1,2})([AB])$/.exec(s.trim().toUpperCase());
  if (!m) return null;
  const hour = Number(m[1]);
  if (hour < 1 || hour > 12) return null;
  return { hour, major: m[2] === "B" };
}

export function formatCamelot(c: Camelot): string {
  return `${c.hour}${c.major ? "B" : "A"}`;
}

/** Shortest distance around the 12-hour wheel, so 12↔1 is 1. */
export function hourDelta(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 12 - d);
}

/** Signed step from a to b around the wheel, in -5..=6. */
function hourStep(a: number, b: number): number {
  let d = (b - a) % 12;
  if (d < 0) d += 12;
  return d > 6 ? d - 12 : d;
}

/**
 * How a mix from `a` into `b` relates harmonically. "same", "relative" and
 * "adjacent" are exactly `Camelot::compatible`. ±2 on the same ring is an
 * energy boost (+2) or drop (−2). Everything else, diagonals included, is a
 * clash.
 */
export function keyRelation(
  a: string | null | undefined,
  b: string | null | undefined,
): KeyRelation {
  const ca = parseCamelot(a);
  const cb = parseCamelot(b);
  if (!ca || !cb) return "unknown";
  if (ca.hour === cb.hour && ca.major === cb.major) return "same";
  if (ca.hour === cb.hour) return "relative";
  if (ca.major !== cb.major) return "clash";
  const d = hourDelta(ca.hour, cb.hour);
  if (d === 1) return "adjacent";
  if (d === 2) return hourStep(ca.hour, cb.hour) > 0 ? "boost" : "drop";
  return "clash";
}

/** True for the relations `Camelot::compatible` accepts. */
export function isCompatible(rel: KeyRelation): boolean {
  return rel === "same" || rel === "relative" || rel === "adjacent";
}

/** The key itself, its relative, and ±1 on the same ring. */
export function compatibleKeys(key: string | null | undefined): string[] {
  const c = parseCamelot(key);
  if (!c) return [];
  const wrap = (h: number) => ((h - 1 + 12) % 12) + 1;
  return [
    formatCamelot(c),
    formatCamelot({ hour: c.hour, major: !c.major }),
    formatCamelot({ hour: wrap(c.hour - 1), major: c.major }),
    formatCamelot({ hour: wrap(c.hour + 1), major: c.major }),
  ];
}

/** All 24 keys, minor (A) ring first. */
export const ALL_KEYS: string[] = [
  ...Array.from({ length: 12 }, (_, i) => `${i + 1}A`),
  ...Array.from({ length: 12 }, (_, i) => `${i + 1}B`),
];

/** Classical names, from the `parse_classical` table in src/keys.rs. */
export const KEY_NAMES: Record<string, string> = {
  "1A": "A♭ minor", "2A": "E♭ minor", "3A": "B♭ minor", "4A": "F minor",
  "5A": "C minor", "6A": "G minor", "7A": "D minor", "8A": "A minor",
  "9A": "E minor", "10A": "B minor", "11A": "F♯ minor", "12A": "D♭ minor",
  "1B": "B major", "2B": "F♯ major", "3B": "D♭ major", "4B": "A♭ major",
  "5B": "E♭ major", "6B": "B♭ major", "7B": "F major", "8B": "C major",
  "9B": "G major", "10B": "D major", "11B": "A major", "12B": "E major",
};

/** Wheel colour: hue by hour, major (outer ring) lighter than minor. */
export function keyColor(hour: number, major: boolean, alpha = 1): string {
  const hue = (((hour - 1) * 30 + 160) % 360 + 360) % 360;
  return major
    ? `hsla(${hue}, 70%, 66%, ${alpha})`
    : `hsla(${hue}, 62%, 52%, ${alpha})`;
}
