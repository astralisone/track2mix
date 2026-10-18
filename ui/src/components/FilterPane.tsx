import * as React from "react";
import {
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Input } from "./ui/Input";
import { Button } from "./ui/Button";
import { HarmonicWheel } from "./HarmonicWheel";
import { RangeSlider } from "./RangeSlider";
import {
  activeFilterCount,
  ENERGY_BOUNDS,
  toggleIn,
  type FacetValue,
  type Facets,
  type FilterState,
} from "@/lib/filters";
import { cn } from "@/lib/utils";

export type FilterPaneProps = {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  onReset: () => void;
  /** From facetCounts(tracks, filters, bpmBounds). */
  facets: Facets;
  /** Library BPM min/max (whole numbers), e.g. libraryBpmBounds(tracks). */
  bpmBounds: [number, number];
  counts: { shown: number; total: number };
  anchorKey?: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  className?: string;
};

const TOP_N = 8;

export function FilterPane(p: FilterPaneProps) {
  const { filters: f } = p;
  const set = <K extends keyof FilterState>(k: K, v: FilterState[K]) =>
    p.onChange({ ...f, [k]: v });
  const active = activeFilterCount(f);

  if (p.collapsed) {
    return (
      <aside
        className={cn(
          "w-12 shrink-0 glass rounded-lg flex flex-col items-center gap-3 py-3",
          p.className,
        )}
        aria-label="Filters (collapsed)"
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={p.onToggleCollapsed}
          aria-label="Expand filters"
          title="Expand filters"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <div className="relative text-muted-foreground" title={`${active} active filters`}>
          <SlidersHorizontal className="h-4 w-4" />
          {active > 0 && (
            <span className="absolute -top-2 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-iris-500 text-[10px] leading-4 text-white text-center font-medium">
              {active}
            </span>
          )}
        </div>
        {active > 0 && (
          <Button
            variant="ghost"
            size="icon"
            onClick={p.onReset}
            aria-label="Reset filters"
            title="Reset filters"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        )}
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "w-[300px] shrink-0 glass rounded-lg flex flex-col overflow-hidden animate-fade-in",
        p.className,
      )}
      aria-label="Filters"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-iris-200/80">
          <SlidersHorizontal className="h-3 w-3" />
          Filters
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground tabular-nums mr-1">
            <span className="text-foreground font-medium">
              {p.counts.shown.toLocaleString()}
            </span>{" "}
            / {p.counts.total.toLocaleString()}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={p.onToggleCollapsed}
            aria-label="Collapse filters"
            title="Collapse filters"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
          <Input
            value={f.search}
            onChange={(e) => set("search", e.target.value)}
            placeholder="Title, artist, genre, key"
            className="pl-9 pr-8"
            aria-label="Search tracks"
          />
          {f.search && (
            <button
              type="button"
              onClick={() => set("search", "")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <ChipSection
          title="Genre"
          values={p.facets.genres}
          selected={f.genres}
          onToggle={(v) => set("genres", toggleIn(f.genres, v))}
          onClear={() => set("genres", [])}
        />

        <ChipSection
          title="Sub-genre"
          hint={f.genres.length ? "in selected genres" : undefined}
          values={p.facets.subGenres}
          selected={f.subGenres}
          onToggle={(v) => set("subGenres", toggleIn(f.subGenres, v))}
          onClear={() => set("subGenres", [])}
        />

        <Section title="Key">
          <HarmonicWheel
            counts={p.facets.keys}
            selected={f.keys}
            onChange={(keys) => set("keys", keys)}
            anchorKey={p.anchorKey}
          />
        </Section>

        <RangeSlider
          label="BPM"
          min={p.bpmBounds[0]}
          max={p.bpmBounds[1]}
          step={1}
          value={f.bpm}
          onChange={(r) => set("bpm", r)}
          histAll={p.facets.bpmAll}
          histFacet={p.facets.bpm}
        />

        <RangeSlider
          label="Energy"
          min={ENERGY_BOUNDS[0]}
          max={ENERGY_BOUNDS[1]}
          step={1}
          value={f.energy}
          onChange={(r) => set("energy", r)}
          histAll={p.facets.energyAll}
          histFacet={p.facets.energy}
        />
      </div>

      <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-white/5">
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground font-medium">
            {p.counts.shown.toLocaleString()}
          </span>{" "}
          / {p.counts.total.toLocaleString()} tracks
        </span>
        <Button variant="ghost" size="sm" onClick={p.onReset} disabled={active === 0}>
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </Button>
      </div>
    </aside>
  );
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground">
          {title}
          {hint && (
            <span className="ml-1.5 normal-case tracking-normal text-muted-foreground/60">
              {hint}
            </span>
          )}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function ChipSection({
  title,
  hint,
  values,
  selected,
  onToggle,
  onClear,
}: {
  title: string;
  hint?: string;
  values: FacetValue[];
  selected: string[];
  onToggle: (v: string) => void;
  onClear: () => void;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const sel = new Set(selected.map((s) => s.toLowerCase()));

  // Selected values always appear, even if out of scope / zero.
  const list = React.useMemo(() => {
    const known = new Set(values.map((v) => v.value.toLowerCase()));
    const missing = selected
      .filter((s) => !known.has(s.toLowerCase()))
      .map((s) => ({ value: s, count: 0 }));
    return [...missing, ...values];
  }, [values, selected]);

  const visible = showAll
    ? list
    : list.filter((v, i) => i < TOP_N || sel.has(v.value.toLowerCase()));
  const hidden = list.length - visible.length;

  if (list.length === 0) {
    return (
      <Section title={title} hint={hint}>
        <div className="text-xs text-muted-foreground/60">None</div>
      </Section>
    );
  }

  return (
    <Section
      title={title}
      hint={hint}
      action={
        selected.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {visible.map((v) => {
          const on = sel.has(v.value.toLowerCase());
          return (
            <button
              key={v.value.toLowerCase()}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(v.value)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-iris-500/60",
                on
                  ? "bg-iris-500/25 border-iris-400/60 text-white"
                  : "bg-white/[0.03] border-white/10 text-foreground/85 hover:border-iris-500/50 hover:bg-iris-500/10",
                !on && v.count === 0 && "opacity-45",
              )}
            >
              <span className="truncate max-w-[160px]">{v.value}</span>
              <span
                className={cn(
                  "font-mono tabular-nums text-[10px]",
                  on ? "text-iris-100" : "text-muted-foreground",
                )}
              >
                {v.count.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
      {(hidden > 0 || showAll) && list.length > TOP_N && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="text-[11px] text-iris-200/80 hover:text-iris-100"
        >
          {showAll ? "Show fewer" : `Show all (${hidden} more)`}
        </button>
      )}
    </Section>
  );
}
