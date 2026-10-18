import * as React from "react";
import * as Slider from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

export type RangeSliderProps = {
  /** Visible label, also used for the thumbs' aria-labels. */
  label: string;
  min: number;
  max: number;
  step?: number;
  /** Committed range; null = no constraint (thumbs at the bounds). */
  value: [number, number] | null;
  /** Fired on commit (pointer up / key press). null when both thumbs sit at the bounds. */
  onChange: (range: [number, number] | null) => void;
  /** Histogram of the whole library (faint layer), bins evenly spaced over [min, max]. */
  histAll?: number[];
  /** Histogram of the faceted matches (bright layer), same bins. */
  histFacet?: number[];
  /** Formats readout values. */
  format?: (n: number) => string;
  unit?: string;
  className?: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function RangeSlider({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  histAll,
  histFacet,
  format = (n) => String(n),
  unit,
  className,
}: RangeSliderProps) {
  // A committed range wholly outside new bounds would clamp to lo > hi:
  // show it as unconstrained instead.
  const lo1 = value ? clamp(value[0], min, max) : min;
  const hi1 = value ? clamp(value[1], min, max) : max;
  const valid = lo1 <= hi1;
  const lo0 = valid ? lo1 : min;
  const hi0 = valid ? hi1 : max;

  // Local thumb state so dragging stays smooth; parent only hears commits.
  // Keyed on primitives so a parent re-render mid-drag doesn't reset it.
  const [draft, setDraft] = React.useState<[number, number]>([lo0, hi0]);
  // Don't leave an invisible constraint applied: clear it in the parent.
  React.useEffect(() => {
    if (value && !valid) onChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid]);
  React.useEffect(() => setDraft([lo0, hi0]), [lo0, hi0]);

  const commit = (v: number[]) => {
    const lo = v[0];
    const hi = v[1];
    const next: [number, number] | null = lo <= min && hi >= max ? null : [lo, hi];
    if (
      (next === null && value === null) ||
      (next && value && next[0] === value[0] && next[1] === value[1])
    )
      return;
    onChange(next);
  };

  const active = !(draft[0] <= min && draft[1] >= max);
  const bins = histAll?.length ?? histFacet?.length ?? 0;
  const peak = Math.max(1, ...(histAll ?? []), ...(histFacet ?? []));
  const span = max - min || 1;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            "font-mono text-[11px] tabular-nums",
            active ? "text-iris-200" : "text-muted-foreground/70",
          )}
          aria-live="polite"
        >
          {active ? `${format(draft[0])}–${format(draft[1])}` : "Any"}
          {active && unit ? ` ${unit}` : ""}
        </span>
      </div>

      {bins > 0 && (
        <div className="relative h-10 flex items-end gap-px px-2" aria-hidden>
          {Array.from({ length: bins }, (_, i) => {
            const all = histAll?.[i] ?? 0;
            const fac = histFacet?.[i] ?? 0;
            const binLo = min + (i / bins) * span;
            const binHi = min + ((i + 1) / bins) * span;
            const inside = binHi > draft[0] && binLo <= draft[1];
            return (
              <div key={i} className="relative flex-1 h-full">
                <div
                  className="absolute bottom-0 inset-x-0 rounded-t-[2px] bg-white/[0.07]"
                  style={{ height: `${(all / peak) * 100}%` }}
                />
                <div
                  className={cn(
                    "absolute bottom-0 inset-x-0 rounded-t-[2px] transition-colors",
                    inside ? "bg-iris-400/80" : "bg-iris-400/25",
                  )}
                  style={{ height: `${(fac / peak) * 100}%` }}
                />
              </div>
            );
          })}
        </div>
      )}

      <Slider.Root
        className="relative flex h-5 w-full touch-none select-none items-center px-2"
        min={min}
        max={max}
        step={step}
        minStepsBetweenThumbs={0}
        value={draft}
        onValueChange={(v) => setDraft([v[0], v[1]])}
        onValueCommit={commit}
        aria-label={label}
      >
        <Slider.Track className="relative h-1 grow overflow-hidden rounded-full bg-white/10">
          <Slider.Range
            className={cn("absolute h-full", active ? "bg-iris-500" : "bg-white/20")}
          />
        </Slider.Track>
        {[0, 1].map((i) => (
          <Slider.Thumb
            key={i}
            aria-label={`${label} ${i === 0 ? "minimum" : "maximum"}`}
            className={cn(
              "block h-3.5 w-3.5 rounded-full border border-white/70 bg-bg-elevated shadow-glow-iris-sm transition-transform",
              "hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-iris-400/70",
              active && "bg-iris-500 border-white",
            )}
          />
        ))}
      </Slider.Root>
    </div>
  );
}
