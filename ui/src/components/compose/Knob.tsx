import { cn } from "@/lib/utils";

type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Value restored on double-click. */
  reset: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  /** Marks the knob visually when it's away from `reset`. */
  accent?: "iris" | "gold" | "red";
  disabled?: boolean;
  className?: string;
};

/**
 * Compact mixer control: a horizontal range with the live value printed next
 * to it. Double-click resets; the wheel nudges by `step`. Kept as a native
 * range input so keyboard and screen-reader users get it for free.
 */
export function Knob({
  label,
  value,
  min,
  max,
  step = 0.01,
  reset,
  onChange,
  format,
  accent = "iris",
  disabled,
  className,
}: Props) {
  const active = Math.abs(value - reset) > step / 2;
  const accentCls =
    accent === "gold"
      ? "accent-gold-300"
      : accent === "red"
        ? "accent-red-400"
        : "accent-iris-500";
  return (
    <label
      className={cn(
        "flex items-center gap-1.5 text-[10px] select-none",
        disabled && "opacity-40",
        className,
      )}
      title={`${label} — double-click to reset`}
    >
      <span
        className={cn(
          "w-7 uppercase tracking-wider",
          active ? "text-foreground" : "text-muted-foreground/70",
        )}
      >
        {label}
      </span>
      <input
        type="range"
        className={cn("h-1 flex-1 min-w-0 cursor-ew-resize", accentCls)}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(reset)}
        onWheel={(e) => {
          if (disabled) return;
          const dir = e.deltaY < 0 ? 1 : -1;
          const next = Math.min(max, Math.max(min, value + dir * step * 5));
          onChange(Number(next.toFixed(4)));
        }}
      />
      <span
        className={cn(
          "w-11 text-right tabular-nums font-mono",
          active ? "text-foreground" : "text-muted-foreground/70",
        )}
      >
        {format ? format(value) : value.toFixed(2)}
      </span>
    </label>
  );
}

export const fmtDb = (v: number) =>
  v <= -26 ? "kill" : `${v > 0 ? "+" : ""}${v.toFixed(0)}dB`;
export const fmtHz = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;
export const fmtGain = (v: number) =>
  v <= 0 ? "-∞" : `${(20 * Math.log10(v)).toFixed(1)}`;
