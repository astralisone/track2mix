import * as React from "react";
import { Target, X } from "lucide-react";
import {
  compatibleKeys,
  KEY_NAMES,
  keyColor,
  parseCamelot,
} from "@/lib/camelot";
import { Button } from "./ui/Button";
import { cn } from "@/lib/utils";

export type HarmonicWheelProps = {
  /** Track count per Camelot key ("8A" → 123). Missing keys count as 0. */
  counts: Record<string, number>;
  /** Selected keys, canonical form. */
  selected: string[];
  onChange: (keys: string[]) => void;
  /** Anchor track's key: gold ring, its compatible keys get dashed outlines. */
  anchorKey?: string | null;
  className?: string;
};

// Geometry (viewBox units). Clock layout: 12 at the top, hours clockwise.
const SIZE = 240;
const C = SIZE / 2;
const R_OUT = 116; // B ring outer
const R_MID = 82; // B inner / A outer
const R_IN = 48; // A inner
const R_HUB = 44; // clickable centre
const GAP = 0.012; // radians trimmed off each side of a segment

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);

function polar(r: number, a: number): [number, number] {
  // a = 0 at 12 o'clock, clockwise.
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
}

function sector(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  const f = (n: number) => n.toFixed(2);
  return [
    `M${f(x0)},${f(y0)}`,
    `A${r1},${r1} 0 0 1 ${f(x1)},${f(y1)}`,
    `L${f(x2)},${f(y2)}`,
    `A${r0},${r0} 0 0 0 ${f(x3)},${f(y3)}`,
    "Z",
  ].join(" ");
}

type Seg = {
  key: string;
  hour: number;
  major: boolean;
  path: string;
  label: [number, number];
};

const SEGMENTS: Seg[] = HOURS.flatMap((hour) => {
  const mid = (hour % 12) * (Math.PI / 6);
  const a0 = mid - Math.PI / 12 + GAP;
  const a1 = mid + Math.PI / 12 - GAP;
  return [true, false].map((major) => {
    const [r0, r1] = major ? [R_MID + 1, R_OUT] : [R_IN, R_MID - 1];
    return {
      key: `${hour}${major ? "B" : "A"}`,
      hour,
      major,
      path: sector(r0, r1, a0, a1),
      label: polar((r0 + r1) / 2, mid),
    };
  });
});

export function HarmonicWheel({
  counts,
  selected,
  onChange,
  anchorKey,
  className,
}: HarmonicWheelProps) {
  const [hover, setHover] = React.useState<string | null>(null);
  const sel = React.useMemo(
    () => new Set(selected.map((k) => k.toUpperCase())),
    [selected],
  );
  const anchor = parseCamelot(anchorKey) ? anchorKey!.toUpperCase() : null;
  const compat = React.useMemo(
    () => new Set(compatibleKeys(anchor)),
    [anchor],
  );
  const peak = Math.max(1, ...Object.values(counts));

  const toggle = (k: string) =>
    onChange(sel.has(k) ? selected.filter((x) => x.toUpperCase() !== k) : [...selected, k]);

  const onKey = (e: React.KeyboardEvent, fn: () => void) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };

  const describe = (k: string) => {
    const n = counts[k] ?? 0;
    return `${k} · ${KEY_NAMES[k] ?? ""} · ${n.toLocaleString()} track${n === 1 ? "" : "s"}`;
  };

  return (
    <div className={cn("space-y-2", className)}>
      <div className="relative mx-auto w-full max-w-[240px]">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="w-full h-auto select-none"
          role="group"
          aria-label="Harmonic key filter (Camelot wheel)"
        >
          {SEGMENTS.map((s) => {
            const n = counts[s.key] ?? 0;
            const on = sel.has(s.key);
            const alpha = on ? 1 : n === 0 ? 0.07 : 0.2 + 0.55 * Math.sqrt(n / peak);
            const dim = sel.size > 0 && !on;
            return (
              <g
                key={s.key}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                aria-label={describe(s.key)}
                className="cursor-pointer outline-none [&:focus-visible>path]:stroke-iris-200"
                onClick={() => toggle(s.key)}
                onKeyDown={(e) => onKey(e, () => toggle(s.key))}
                onMouseEnter={() => setHover(s.key)}
                onMouseLeave={() => setHover((h) => (h === s.key ? null : h))}
                onFocus={() => setHover(s.key)}
                onBlur={() => setHover((h) => (h === s.key ? null : h))}
              >
                <title>{describe(s.key)}</title>
                <path
                  d={s.path}
                  fill={keyColor(s.hour, s.major, dim ? alpha * 0.6 : alpha)}
                  stroke={on ? "#fff" : hover === s.key ? "rgba(255,255,255,0.5)" : "transparent"}
                  strokeWidth={on ? 2 : 1.25}
                  className="transition-[fill] duration-150"
                />
                <text
                  x={s.label[0]}
                  y={s.label[1]}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="font-mono pointer-events-none"
                  fontSize={s.major ? 10.5 : 10}
                  fontWeight={on ? 700 : 500}
                  fill={on ? "#01020F" : n === 0 ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.88)"}
                >
                  {s.key}
                </text>
              </g>
            );
          })}

          {/* Anchor-compatible keys: dashed outline */}
          {SEGMENTS.filter((s) => compat.has(s.key) && s.key !== anchor).map((s) => (
            <path
              key={`c-${s.key}`}
              d={s.path}
              fill="none"
              stroke="#FFD156"
              strokeOpacity={0.8}
              strokeWidth={1.25}
              strokeDasharray="3 2.5"
              pointerEvents="none"
            />
          ))}
          {/* Anchor key: gold ring */}
          {SEGMENTS.filter((s) => s.key === anchor).map((s) => (
            <path
              key={`a-${s.key}`}
              d={s.path}
              fill="none"
              stroke="#F5B71C"
              strokeWidth={2.75}
              pointerEvents="none"
              style={{ filter: "drop-shadow(0 0 4px rgba(245,183,28,0.7))" }}
            />
          ))}

          {/* Centre: clears the selection */}
          <g
            role="button"
            tabIndex={sel.size ? 0 : -1}
            aria-label="Clear key selection"
            aria-disabled={sel.size === 0}
            className={cn("outline-none", sel.size ? "cursor-pointer" : "cursor-default")}
            onClick={() => sel.size && onChange([])}
            onKeyDown={(e) => onKey(e, () => sel.size && onChange([]))}
          >
            <circle
              cx={C}
              cy={C}
              r={R_HUB}
              fill="rgba(13,15,40,0.85)"
              stroke="rgba(255,255,255,0.08)"
            />
            <text
              x={C}
              y={C - 6}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={hover ? 15 : 11}
              fontWeight={600}
              className="font-mono pointer-events-none"
              fill="#E1E1E3"
            >
              {hover ?? (sel.size ? `${sel.size} key${sel.size === 1 ? "" : "s"}` : "Keys")}
            </text>
            <text
              x={C}
              y={C + 10}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={8.5}
              className="pointer-events-none"
              fill="#9EA4B2"
            >
              {hover
                ? `${(counts[hover] ?? 0).toLocaleString()} tracks`
                : sel.size
                  ? "click to clear"
                  : "any"}
            </text>
          </g>
        </svg>
      </div>

      <div
        className="h-4 text-center text-[11px] text-muted-foreground tabular-nums"
        aria-live="polite"
      >
        {hover ? describe(hover) : ""}
      </div>

      <div className="flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          disabled={!anchor}
          title={anchor ? `Select ${compatibleKeys(anchor).join(", ")}` : "Pick an anchor track first"}
          onClick={() => anchor && onChange(compatibleKeys(anchor))}
        >
          <Target className="h-3.5 w-3.5" />
          Match anchor
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={sel.size === 0}
          onClick={() => onChange([])}
        >
          <X className="h-3.5 w-3.5" />
          Clear
        </Button>
      </div>
    </div>
  );
}
