import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Pause, Play } from "lucide-react";
import { cn, formatBpm } from "@/lib/utils";
import type { UiTrack } from "@/lib/tauri";
import { usePlayer } from "@/lib/player";
import { EqualizerIcon } from "./PlayerBar";
import { EnergyMeter } from "./EnergyMeter";
import { KeyChip } from "./KeyChip";

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
  /** Start playback of this track (the caller decides the queue). */
  onPlay: (id: string) => void;
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
  const player = usePlayer();
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
      <div className="grid grid-cols-[32px_minmax(220px,2.2fr)_minmax(160px,1.6fr)_minmax(150px,1.4fr)_70px_60px_120px_24px] items-center gap-3 px-4 py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground/80 border-b border-white/5 bg-white/[0.015]">
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
            const isCurrent = player.isCurrent(t.track_id);
            return (
              <div
                key={t.track_id}
                className={cn(
                  "group absolute left-0 right-0 grid grid-cols-[32px_minmax(220px,2.2fr)_minmax(160px,1.6fr)_minmax(150px,1.4fr)_70px_60px_120px_24px] items-center gap-3 px-4 text-sm border-b border-white/[0.04] cursor-default transition-colors",
                  isAnchor
                    ? "bg-iris-500/10 hover:bg-iris-500/15"
                    : vi.index % 2 === 0
                      ? "hover:bg-white/[0.025]"
                      : "bg-white/[0.012] hover:bg-white/[0.035]",
                  isCurrent && "shadow-[inset_2px_0_0_0_#575AD0]",
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
                      isCurrent && "text-iris-200",
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
                <RowPlayButton
                  isCurrent={isCurrent}
                  playing={isCurrent && player.state.playing}
                  onClick={() =>
                    isCurrent ? player.toggle() : props.onPlay(t.track_id)
                  }
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RowPlayButton({
  isCurrent,
  playing,
  onClick,
}: {
  isCurrent: boolean;
  playing: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={playing ? "Pause" : "Play"}
      title={playing ? "Pause" : "Play"}
      className={cn(
        "relative inline-flex h-6 w-6 items-center justify-center rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-iris-500/60",
        isCurrent
          ? "text-iris-200 hover:bg-iris-500/20"
          : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-white hover:bg-white/[0.08]",
      )}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {playing ? (
        <>
          <EqualizerIcon
            playing
            className="h-3 w-3 group-hover:hidden"
          />
          <Pause
            className="hidden h-3.5 w-3.5 group-hover:block"
            fill="currentColor"
          />
        </>
      ) : (
        <Play className="h-3.5 w-3.5 translate-x-[1px]" fill="currentColor" />
      )}
    </button>
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
