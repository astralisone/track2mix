import * as React from "react";
import { compat, type UiTrack } from "@/lib/tauri";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { EnergyMeter } from "./EnergyMeter";
import { KeyChip } from "./KeyChip";
import { formatBpm } from "@/lib/utils";
import { Play, Plus, Sparkles, X } from "lucide-react";

type Props = {
  anchor: UiTrack | null;
  onClose: () => void;
  onAddToSelection: (ids: string[]) => void;
  onSetAnchor: (id: string) => void;
  onPlay?: (id: string) => void;
};

export function CompatPanel({ anchor, onClose, onAddToSelection, onSetAnchor, onPlay }: Props) {
  const [bpmTol, setBpmTol] = React.useState(3);
  const [anyKey, setAnyKey] = React.useState(false);
  const [halfDouble, setHalfDouble] = React.useState(true);
  const [limit, setLimit] = React.useState(25);
  const [results, setResults] = React.useState<UiTrack[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!anchor) {
      setResults([]);
      return;
    }
    setLoading(true);
    setErr(null);
    compat({
      track_id: anchor.track_id,
      bpm_tol: bpmTol,
      any_key: anyKey,
      half_double_ok: halfDouble,
      limit,
    })
      .then((r) => setResults(r))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [anchor?.track_id, bpmTol, anyKey, halfDouble, limit]);

  if (!anchor) return null;

  return (
    <aside className="w-[420px] shrink-0 flex flex-col glass rounded-lg animate-fade-in overflow-hidden">
      <div className="flex items-start justify-between p-4 border-b border-white/5">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-iris-200/80 mb-1 flex items-center gap-1.5">
            <Sparkles className="h-3 w-3" />
            Anchor
          </div>
          <div className="text-sm font-medium text-white truncate">
            {anchor.name}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {anchor.artist}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge variant="iris">
              {formatBpm(anchor.bpm)} BPM
            </Badge>
            {anchor.camelot && <Badge variant="gold">{anchor.camelot}</Badge>}
            {anchor.energy != null && (
              <Badge variant="muted">E {anchor.energy}</Badge>
            )}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close compat"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="p-4 border-b border-white/5 space-y-3">
        <div>
          <label className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
            <span>BPM tolerance</span>
            <span className="tabular-nums text-foreground">±{bpmTol}</span>
          </label>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={bpmTol}
            onChange={(e) => setBpmTol(Number(e.target.value))}
            className="w-full accent-iris-500"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={halfDouble}
              onChange={(e) => setHalfDouble(e.target.checked)}
              className="accent-iris-500"
            />
            <span>Half / double BPM</span>
          </label>
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={anyKey}
              onChange={(e) => setAnyKey(e.target.checked)}
              className="accent-iris-500"
            />
            <span>Ignore key</span>
          </label>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Results limit</span>
          <div className="flex gap-1">
            {[10, 25, 50, 100].map((n) => (
              <button
                key={n}
                onClick={() => setLimit(n)}
                className={
                  "px-2 py-0.5 rounded text-[11px] " +
                  (limit === n
                    ? "bg-iris-500/25 text-iris-200 border border-iris-500/40"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {loading && (
          <div className="p-6 text-center text-sm text-muted-foreground animate-pulse">
            Finding matches…
          </div>
        )}
        {err && (
          <div className="p-4 text-sm text-red-300">
            {err}
          </div>
        )}
        {!loading && !err && results.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No compatible tracks in this window.
          </div>
        )}
        {!loading && results.length > 0 && (
          <ul className="divide-y divide-white/[0.04]">
            {results.map((t) => (
              <li
                key={t.track_id}
                className="group px-4 py-2.5 hover:bg-white/[0.03] transition-colors cursor-pointer"
                onClick={() => onSetAnchor(t.track_id)}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-foreground truncate">
                      {t.name}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {t.artist}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-[11px] tabular-nums text-muted-foreground/80">
                        {formatBpm(t.bpm)} BPM
                      </span>
                      <KeyChip camelot={t.camelot} raw={t.tonality} />
                      <EnergyMeter value={t.energy} />
                    </div>
                  </div>
                  {onPlay && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlay(t.track_id);
                      }}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-iris-200 transition-opacity"
                      title="Preview this track"
                      aria-label={`Play ${t.name}`}
                    >
                      <Play className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddToSelection([t.track_id]);
                    }}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-iris-200 transition-opacity"
                    title="Add to export selection"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {results.length > 0 && (
        <div className="p-3 border-t border-white/5">
          <Button
            variant="primary"
            size="sm"
            className="w-full"
            onClick={() => onAddToSelection(results.map((r) => r.track_id))}
          >
            <Plus className="h-3.5 w-3.5" />
            Add all {results.length} to selection
          </Button>
        </div>
      )}
    </aside>
  );
}
