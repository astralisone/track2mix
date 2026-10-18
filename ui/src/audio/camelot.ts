/**
 * Camelot-wheel relations between two keys, mirroring `keys.rs` on the Rust
 * side but extended with the "creative" moves DJs use beyond the strict
 * compatible set.
 */
export type Camelot = { hour: number; major: boolean };

export type KeyRelation =
  | "same" // identical key
  | "relative" // same hour, other ring (A↔B): relative major/minor
  | "neighbour" // ±1 hour, same ring: perfect fifth / fourth
  | "boost" // +2 hours, same ring: the classic "energy boost" move
  | "diagonal" // ±1 hour and ring swap: works with care
  | "clash" // everything else
  | "unknown"; // one side has no parsable key

export function parseCamelot(s: string | null | undefined): Camelot | null {
  if (!s) return null;
  const m = /^\s*(\d{1,2})\s*([AaBb])\s*$/.exec(s);
  if (!m) return null;
  const hour = Number(m[1]);
  if (hour < 1 || hour > 12) return null;
  return { hour, major: m[2].toUpperCase() === "B" };
}

export function formatCamelot(c: Camelot): string {
  return `${c.hour}${c.major ? "B" : "A"}`;
}

/** Signed distance b − a around the wheel, in (−6, 6]. */
export function hourDelta(a: number, b: number): number {
  let d = (b - a) % 12;
  if (d > 6) d -= 12;
  if (d <= -6) d += 12;
  return d;
}

export function keyRelation(
  a: string | null | undefined,
  b: string | null | undefined,
): KeyRelation {
  const ka = parseCamelot(a);
  const kb = parseCamelot(b);
  if (!ka || !kb) return "unknown";
  const d = hourDelta(ka.hour, kb.hour);
  const sameRing = ka.major === kb.major;
  if (d === 0) return sameRing ? "same" : "relative";
  if (sameRing) {
    if (Math.abs(d) === 1) return "neighbour";
    if (d === 2) return "boost";
    return "clash";
  }
  if (Math.abs(d) === 1) return "diagonal";
  return "clash";
}

/** Strict rule used by the compat engine: same, relative or neighbour. */
export function isCompatible(a: string | null, b: string | null): boolean {
  const r = keyRelation(a, b);
  return r === "same" || r === "relative" || r === "neighbour";
}

export const RELATION_LABEL: Record<KeyRelation, string> = {
  same: "Same key",
  relative: "Relative",
  neighbour: "Neighbour",
  boost: "Energy boost",
  diagonal: "Diagonal",
  clash: "Clash",
  unknown: "No key",
};

/** Tailwind classes used to colour clips/lanes by relation to the reference key. */
export const RELATION_TONE: Record<
  KeyRelation,
  { text: string; bg: string; border: string; stroke: string }
> = {
  same: {
    text: "text-emerald-200",
    bg: "bg-emerald-500/15",
    border: "border-emerald-400/30",
    stroke: "#34d399",
  },
  relative: {
    text: "text-emerald-200",
    bg: "bg-emerald-500/15",
    border: "border-emerald-400/30",
    stroke: "#6ee7b7",
  },
  neighbour: {
    text: "text-iris-200",
    bg: "bg-iris-500/15",
    border: "border-iris-500/30",
    stroke: "#9EA0E7",
  },
  boost: {
    text: "text-gold-200",
    bg: "bg-gold-300/15",
    border: "border-gold-300/25",
    stroke: "#F5B71C",
  },
  diagonal: {
    text: "text-amber-200",
    bg: "bg-amber-500/15",
    border: "border-amber-400/30",
    stroke: "#fbbf24",
  },
  clash: {
    text: "text-red-200",
    bg: "bg-red-500/15",
    border: "border-red-400/30",
    stroke: "#f87171",
  },
  unknown: {
    text: "text-muted-foreground",
    bg: "bg-white/[0.04]",
    border: "border-white/10",
    stroke: "#9EA4B2",
  },
};
