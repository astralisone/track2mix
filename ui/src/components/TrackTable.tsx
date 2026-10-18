import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, formatBpm } from "@/lib/utils";
import type { UiTrack } from "@/lib/tauri";
import { EnergyMeter } from "./EnergyMeter";
import { KeyChip } from "./KeyChip";
import { Play, Volume2 } from "lucide-react";

type Props = {
  rows: UiTrack[];
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  anchorId: string | null;
  onAnchor: (id: string) => void;
  sortBy: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  previewId: string | null;
  onPreview: (id: string) => void;
};

export type SortKey =
  | "name"
  | "artist"
  | "genre"
  | "bpm"
  | "key"
  | "energy";

const ROW_HEIGHT = 44;

export function TrackTable(props: Props) {
  const parentRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const allSelected =
    props.rows.length > 0 &&
    props.rows.every((r) => props.selected.has(r.track_id));

  return (
    <div className="flex h-full flex-col rounded-lg glass overflow-hidden">
      <div className="grid grid-cols-[32px_minmax(220px,2.2fr)_minmax(160px,1.6fr)_minmax(150px,1.4fr)_70px_60px_120px_32px] items-center gap-3 px-4 py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground/80 border-b border-white/5 bg-white/[0.015]">
        <input
          type="checkbox"
          aria-label="Select all"
          className="accent-iris-500 cursor-pointer"
          checked={allSelected}
          onChange={props.onToggleSelectAll}
        />
        <HeaderCell label="Title" sort="name" {...props} />
        <HeaderCell label="Artist" sort="artist" {...props} />
        <HeaderCell label="Genre" sort="genre" {...props} />
        <HeaderCell label="BPM" sort="bpm" align="right" {...props} />
        <HeaderCell label="Key" sort="key" {...props} />
        <HeaderCell label="Energy" sort="energy" {...props} />
        <span />
      </div>

      <div ref={parentRef} className="flex-1 overflow-auto">
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const t = props.rows[vi.index];
            const isSelected = props.selected.has(t.track_id);
            const isAnchor = props.anchorId === t.track_id;
            return (
              <div
                key={t.track_id}
                className={cn(
                  "absolute left-0 right-0 grid grid-cols-[32px_minmax(220px,2.2fr)_minmax(160px,1.6fr)_minmax(150px,1.4fr)_70px_60px_120px_32px] items-center gap-3 px-4 text-sm border-b border-white/[0.04] cursor-default transition-colors",
                  isAnchor
                    ? "bg-iris-500/10 hover:bg-iris-500/15"
                    : vi.index % 2 === 0
                      ? "hover:bg-white/[0.025]"
                      : "bg-white/[0.012] hover:bg-white/[0.035]",
                )}
                style={{
                  height: ROW_HEIGHT,
                  transform: `translateY(${vi.start}px)`,
                }}
                onClick={() => props.onAnchor(t.track_id)}
                onDoubleClick={() => props.onToggleSelect(t.track_id)}
              >
                <input
                  type="checkbox"
                  className="accent-iris-500 cursor-pointer"
                  checked={isSelected}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => props.onToggleSelect(t.track_id)}
                />
                <div className="truncate">
                  <span
                    className={cn(
                      "truncate",
                      isAnchor ? "text-white font-medium" : "text-foreground",
                    )}
                  >
                    {t.name || <em className="text-muted-foreground">untitled</em>}
                  </span>
                </div>
                <div className="truncate text-muted-foreground">
                  {t.artist}
                </div>
                <div className="truncate text-xs text-muted-foreground/90">
                  {t.sub_genre &&
                  t.sub_genre.toLowerCase() !== t.genre.toLowerCase() ? (
                    <>
                      <span className="text-muted-foreground/70">
                        {t.genre}
                      </span>
                      <span className="mx-1 text-muted-foreground/40">›</span>
                      <span>{t.sub_genre}</span>
                    </>
                  ) : (
                    <span>{t.genre || "—"}</span>
                  )}
                </div>
                <div className="text-right tabular-nums text-muted-foreground">
                  {formatBpm(t.bpm)}
                </div>
                <div>
                  <KeyChip camelot={t.camelot} raw={t.tonality} />
                </div>
                <EnergyMeter value={t.energy} />
                <button
                  type="button"
                  className={cn(
                    "h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors disabled:opacity-30 disabled:pointer-events-none",
                    props.previewId === t.track_id
                      ? "text-iris-200 bg-iris-500/20"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/[0.06]",
                  )}
                  title={
                    !t.file_path
                      ? "No audio file for this track"
                      : props.previewId === t.track_id
                        ? "Stop preview"
                        : "Preview"
                  }
                  aria-label={props.previewId === t.track_id ? "Stop preview" : "Preview"}
                  disabled={!t.file_path}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onPreview(t.track_id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  {props.previewId === t.track_id ? (
                    <Volume2 className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HeaderCell({
  label,
  sort,
  sortBy,
  sortDir,
  onSort,
  align = "left",
}: {
  label: string;
  sort: SortKey;
  sortBy: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sortBy === sort;
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-1 select-none hover:text-white transition-colors",
        active ? "text-iris-200" : "",
        align === "right" ? "justify-end" : "justify-start",
      )}
      onClick={() => onSort(sort)}
    >
      <span>{label}</span>
      {active && (
        <span className="text-[9px] opacity-80">
          {sortDir === "asc" ? "▲" : "▼"}
        </span>
      )}
    </button>
  );
}
