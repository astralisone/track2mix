import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, formatBpm } from "@/lib/utils";
import type { UiTrack } from "@/lib/tauri";
import {
  isCompatible,
  keyRelation,
  RELATION_LABEL,
  RELATION_TONE,
  type KeyRelation,
} from "@/audio/camelot";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { EnergyMeter } from "../EnergyMeter";
import { KeyChip } from "../KeyChip";
import { Plus, Search, X } from "lucide-react";

type Props = {
  tracks: UiTrack[];
  referenceKey: string | null;
  existingTrackIds: Set<string>;
  onAdd: (t: UiTrack) => void;
  onClose: () => void;
};

const ROW_HEIGHT = 48;

/** Best → worst mixing move, used to sort candidates under the reference key. */
const RELATION_RANK: Record<KeyRelation, number> = {
  same: 0,
  relative: 1,
  neighbour: 2,
  boost: 3,
  diagonal: 4,
  clash: 5,
  unknown: 6,
};

/** Library browser for the composer: pick tracks to drop onto new lanes. */
export function TrackPicker({
  tracks,
  referenceKey,
  existingTrackIds,
  onAdd,
  onClose,
}: Props) {
  const [query, setQuery] = React.useState("");
  const [compatOnly, setCompatOnly] = React.useState(!!referenceKey);
  const parentRef = React.useRef<HTMLDivElement>(null);

  const rows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = tracks.filter((t) => {
      if (q && !`${t.name} ${t.artist}`.toLowerCase().includes(q)) return false;
      if (compatOnly && referenceKey && !isCompatible(referenceKey, t.camelot)) {
        return false;
      }
      return true;
    });
    const withRel = list.map((t) => ({ t, rel: keyRelation(referenceKey, t.camelot) }));
    withRel.sort((a, b) => {
      const r = RELATION_RANK[a.rel] - RELATION_RANK[b.rel];
      if (r !== 0) return r;
      return (b.t.energy_raw ?? -Infinity) - (a.t.energy_raw ?? -Infinity);
    });
    return withRel;
  }, [tracks, query, compatOnly, referenceKey]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <aside className="w-[380px] shrink-0 flex flex-col glass rounded-lg animate-fade-in overflow-hidden">
      <div className="flex items-start justify-between p-3 border-b border-white/5">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-iris-200/80 mb-1">
            Add track
          </div>
          <div className="text-xs text-muted-foreground">
            {referenceKey ? (
              <>
                Relative to{" "}
                <span className="text-foreground font-mono">{referenceKey}</span>{" "}
                (first lane)
              </>
            ) : (
              "First lane sets the reference key and master BPM"
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} title="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="p-3 flex items-center gap-2 border-b border-white/5">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/70" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder="Search title or artist…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <label
          className={cn(
            "flex items-center gap-1.5 text-[11px] select-none whitespace-nowrap",
            referenceKey ? "cursor-pointer text-muted-foreground" : "opacity-40",
          )}
          title="Only show keys that mix cleanly with the first lane"
        >
          <input
            type="checkbox"
            className="accent-iris-500"
            checked={compatOnly && !!referenceKey}
            disabled={!referenceKey}
            onChange={(e) => setCompatOnly(e.target.checked)}
          />
          compatible only
        </label>
      </div>

      <div ref={parentRef} className="flex-1 overflow-auto">
        {rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground p-6 text-center">
            No tracks match.
          </div>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const { t, rel } = rows[vi.index];
              const tone = RELATION_TONE[rel];
              const already = existingTrackIds.has(t.track_id);
              const noFile = !t.file_path;
              return (
                <div
                  key={t.track_id}
                  className={cn(
                    "absolute left-0 right-0 flex items-center gap-2 px-3 text-sm border-b border-white/[0.04]",
                    vi.index % 2 === 0 ? "hover:bg-white/[0.025]" : "bg-white/[0.012] hover:bg-white/[0.035]",
                  )}
                  style={{ height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                >
                  <KeyChip camelot={t.camelot} raw={t.tonality} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate" title={t.name}>
                      {t.name || <em className="text-muted-foreground">untitled</em>}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
                      <span className="truncate">{t.artist}</span>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="tabular-nums">{formatBpm(t.bpm)}</span>
                    </div>
                  </div>
                  <span
                    className={cn(
                      "text-[9px] uppercase tracking-wider px-1 rounded whitespace-nowrap",
                      tone.text,
                      tone.bg,
                    )}
                  >
                    {RELATION_LABEL[rel]}
                  </span>
                  <EnergyMeter value={t.energy} />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 px-0"
                    disabled={already || noFile}
                    title={
                      already
                        ? "Already on a lane"
                        : noFile
                          ? "No audio file for this track"
                          : "Add as a new lane"
                    }
                    onClick={() => onAdd(t)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-white/5 text-[11px] text-muted-foreground">
        {rows.length.toLocaleString()} of {tracks.length.toLocaleString()} tracks
      </div>
    </aside>
  );
}
