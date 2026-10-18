import * as React from "react";
import {
  analyzeXml,
  defaultDbPath,
  onAnalyzeProgress,
  openLibrary,
  type AnalyzeSummary,
  type LibrarySummary,
  type ProgressEvent,
  type UiTrack,
} from "@/lib/tauri";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import {
  applyFilters,
  emptyFilters,
  facetCounts,
  libraryBpmBounds,
  type FilterState,
} from "@/lib/filters";
import { proposeOrder, reconcileOrder } from "@/lib/mix";
import { PlayerProvider, usePlayer, type PlayerApi } from "@/lib/player";
import { FilterPane } from "./components/FilterPane";
import { Logo } from "./components/Logo";
import { TrackTable, type SortKey } from "./components/TrackTable";
import { CompatPanel } from "./components/CompatPanel";
import { PlaylistBuilder } from "./components/PlaylistBuilder";
import { PlayerBar } from "./components/PlayerBar";
import { Button } from "./components/ui/Button";
import { Badge } from "./components/ui/Badge";
import {
  Database,
  FileUp,
  ListMusic,
  Play,
  Sparkles,
  X,
} from "lucide-react";

const MAX_QUEUE = 500;

function App() {
  const [dbPath, setDbPath] = React.useState<string>("");
  const [summary, setSummary] = React.useState<LibrarySummary | null>(null);
  const [tracks, setTracks] = React.useState<UiTrack[]>([]);
  const [loadErr, setLoadErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const [filters, setFilters] = React.useState<FilterState>(emptyFilters);
  const [filtersCollapsed, setFiltersCollapsed] = React.useState(false);
  const [sortBy, setSortBy] = React.useState<SortKey>("energy");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = React.useState<string | null>(null);

  // Playlist order for the builder. `order` is the user's arrangement; it is
  // reconciled with the selection so new picks append and deselected drop.
  // `arranged` stays false until the set has been ordered (proposed or by
  // hand), so the first visit to the builder gets a harmonic proposal.
  const [view, setView] = React.useState<"library" | "builder">("library");
  const [order, setOrder] = React.useState<string[]>([]);
  const [arranged, setArranged] = React.useState(false);

  const [analyzing, setAnalyzing] = React.useState(false);
  const [progress, setProgress] = React.useState<ProgressEvent | null>(null);
  const [analyzeErr, setAnalyzeErr] = React.useState<string | null>(null);
  const [analyzeFailures, setAnalyzeFailures] = React.useState<
    Array<{ name: string; error: string }>
  >([]);
  const [analyzeSummary, setAnalyzeSummary] =
    React.useState<AnalyzeSummary | null>(null);

  const [skipAnalyzed, setSkipAnalyzed] = React.useState<boolean>(() => {
    const stored = localStorage.getItem("track2mix.skipAnalyzed");
    return stored === null ? true : stored === "true";
  });
  React.useEffect(() => {
    localStorage.setItem("track2mix.skipAnalyzed", String(skipAnalyzed));
  }, [skipAnalyzed]);

  // Bootstrap: fetch default path and open.
  React.useEffect(() => {
    (async () => {
      try {
        const p = await defaultDbPath();
        setDbPath(p);
        await loadDb(p);
      } catch (e) {
        setLoadErr(String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to analyze:progress events for the lifetime of the app.
  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await onAnalyzeProgress((ev) => {
        setProgress(ev);
        if (ev.kind === "failed") {
          setAnalyzeFailures((prev) =>
            prev.length >= 200
              ? prev
              : [...prev, { name: ev.name, error: ev.error }],
          );
        }
      });
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  async function loadDb(p: string) {
    setLoading(true);
    setLoadErr(null);
    try {
      const payload = await openLibrary(p);
      setSummary(payload.summary);
      setTracks(payload.tracks);
      setSelected(new Set());
      setAnchorId(null);
      setFilters(emptyFilters);
      setOrder([]);
      setArranged(false);
      setView("library");
    } catch (e) {
      setLoadErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function pickDb() {
    try {
      const picked = await openFile({
        filters: [{ name: "SQLite DB", extensions: ["db", "sqlite", "sqlite3"] }],
      });
      if (typeof picked === "string") {
        setDbPath(picked);
        await loadDb(picked);
      }
    } catch (e) {
      setLoadErr(String(e));
    }
  }

  async function pickXml() {
    setAnalyzeErr(null);
    const picked = await openFile({
      filters: [{ name: "Rekordbox XML", extensions: ["xml"] }],
    }).catch((e) => {
      setAnalyzeErr(String(e));
      return null;
    });
    if (typeof picked !== "string") return;

    // Target DB next to the XML (same dir, swap .xml → .db).
    // Falls back to the current dbPath if we can't derive one.
    const targetDb = picked.replace(/\.xml$/i, ".db");
    const finalDb = targetDb === picked ? dbPath || `${picked}.db` : targetDb;

    setAnalyzing(true);
    setProgress(null);
    setAnalyzeFailures([]);
    setAnalyzeSummary(null);

    try {
      const summary = await analyzeXml({
        xml_path: picked,
        db_path: finalDb,
        skip_analyzed: skipAnalyzed,
      });
      setAnalyzeSummary(summary);
      setDbPath(summary.db_path);
      await loadDb(summary.db_path);
    } catch (e) {
      setAnalyzeErr(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  const anchor = React.useMemo(
    () => tracks.find((t) => t.track_id === anchorId) ?? null,
    [tracks, anchorId],
  );

  const bpmBounds = React.useMemo(() => libraryBpmBounds(tracks), [tracks]);
  const filtered = React.useMemo(
    () => applyFilters(tracks, filters),
    [tracks, filters],
  );
  const facets = React.useMemo(
    () => facetCounts(tracks, filters, bpmBounds),
    [tracks, filters, bpmBounds],
  );

  const sorted = React.useMemo(() => {
    const rows = filtered.slice();
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      switch (sortBy) {
        case "name":
          return a.name.localeCompare(b.name) * dir;
        case "artist":
          return a.artist.localeCompare(b.artist) * dir;
        case "genre":
          return (
            (a.genre + (a.sub_genre ?? "")).localeCompare(
              b.genre + (b.sub_genre ?? ""),
            ) * dir
          );
        case "bpm":
          return ((a.bpm ?? 0) - (b.bpm ?? 0)) * dir;
        case "key":
          return (a.camelot ?? "zz").localeCompare(b.camelot ?? "zz") * dir;
        case "energy":
          return ((a.energy_raw ?? 0) - (b.energy_raw ?? 0)) * dir;
      }
    });
    return rows;
  }, [filtered, sortBy, sortDir]);

  function onSort(k: SortKey) {
    if (sortBy === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(k);
      setSortDir(k === "name" || k === "artist" || k === "genre" ? "asc" : "desc");
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelected((prev) => {
      const allSelected = sorted.every((r) => prev.has(r.track_id));
      const next = new Set(prev);
      if (allSelected) {
        sorted.forEach((r) => next.delete(r.track_id));
      } else {
        sorted.forEach((r) => next.add(r.track_id));
      }
      return next;
    });
  }

  function addToSelection(ids: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function removeFromSelection(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    // Drop it from the arrangement too, so re-selecting it appends.
    setOrder((o) => o.filter((x) => x !== id));
  }

  // An emptied selection (by any route) starts the next set fresh, with a
  // new harmonic proposal on the builder's first visit.
  React.useEffect(() => {
    if (selected.size === 0) {
      setOrder([]);
      setArranged(false);
    }
  }, [selected]);

  function clearSelection() {
    setSelected(new Set());
    setOrder([]);
    setArranged(false);
  }

  // Selection in insertion order (Set iteration order), and the playlist
  // order reconciled against it.
  const selectionOrder = React.useMemo(() => Array.from(selected), [selected]);
  const playlistOrder = React.useMemo(
    () => reconcileOrder(order, selectionOrder),
    [order, selectionOrder],
  );

  function openBuilder() {
    if (!arranged) {
      const set = selectionOrder
        .map((id) => tracks.find((t) => t.track_id === id))
        .filter((t): t is UiTrack => !!t);
      setOrder(proposeOrder(set, anchorId ?? undefined));
      setArranged(true);
    }
    setView("builder");
  }

  function onOrderChange(next: string[]) {
    setOrder(next);
    setArranged(true);
  }

  // Row play: inside the selection, queue the set in playlist order from this
  // track; otherwise play just this track.
  function playQueueFor(id: string): { ids: string[]; start: number } {
    const i = playlistOrder.indexOf(id);
    return i >= 0 ? { ids: playlistOrder, start: i } : { ids: [id], start: 0 };
  }

  const inBuilder = view === "builder" && tracks.length > 0;

  // The player API lives below this component (the provider needs `tracks`).
  // A ref keeps App from re-rendering on every position tick.
  const playerRef = React.useRef<PlayerApi | null>(null);
  // The full queue rides on every player:state tick, so cap it: a select-all
  // on a big library would otherwise ship megabytes of ids per second.
  const play = (ids: string[], start = 0) => {
    const window = ids.slice(start, start + MAX_QUEUE);
    playerRef.current?.playTracks(window, 0);
  };

  return (
    <PlayerProvider tracks={tracks}>
    <PlayerBridge target={playerRef} />
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      {/* Title bar */}
      <header className="drag-region h-10 flex items-center justify-between px-4 border-b border-white/5">
        <div className="flex items-center gap-2 pl-16">
          <Logo className="h-[18px] w-[18px]" />
          <span className="text-sm font-medium tracking-tight">
            Track2Mix
          </span>
          {summary && (
            <>
              <span className="text-muted-foreground/50 text-xs">·</span>
              <span className="text-xs text-muted-foreground">
                {summary.analyzed.toLocaleString()} analyzed
              </span>
              <span className="text-muted-foreground/50 text-xs">·</span>
              <span className="text-xs text-muted-foreground truncate max-w-[320px]">
                {summary.db_path}
              </span>
            </>
          )}
        </div>
        <div className="no-drag flex items-center gap-2">
          <label
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground select-none cursor-pointer pr-1"
            title="When importing XML, skip tracks that are already in the database"
          >
            <input
              type="checkbox"
              className="accent-iris-500"
              checked={skipAnalyzed}
              onChange={(e) => setSkipAnalyzed(e.target.checked)}
              disabled={analyzing}
            />
            skip analyzed
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={pickXml}
            disabled={analyzing}
          >
            <FileUp className="h-3.5 w-3.5" />
            Import Rekordbox XML
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={pickDb}
            disabled={analyzing}
          >
            <Database className="h-3.5 w-3.5" />
            Open DB
          </Button>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 flex min-h-0 p-3 gap-3">
        {!inBuilder && tracks.length > 0 && (
          <FilterPane
            filters={filters}
            onChange={setFilters}
            onReset={() => setFilters(emptyFilters)}
            facets={facets}
            bpmBounds={bpmBounds}
            counts={{ shown: sorted.length, total: tracks.length }}
            anchorKey={anchor?.camelot ?? null}
            collapsed={filtersCollapsed}
            onToggleCollapsed={() => setFiltersCollapsed((c) => !c)}
          />
        )}

        <div className="flex-1 flex gap-3 min-h-0 min-w-0">
          <div className="flex-1 flex flex-col min-w-0 gap-3">
            {loadErr && (
              <div className="glass rounded-lg p-4 border border-red-500/30 text-sm text-red-200">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium">Couldn't load the database</span>
                  <Button variant="ghost" size="icon" onClick={() => setLoadErr(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="text-xs text-red-300/90 font-mono">{loadErr}</div>
                <div className="text-xs text-muted-foreground mt-2">
                  Expected path: <span className="text-foreground">{dbPath}</span>
                </div>
              </div>
            )}
            {loading && tracks.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground animate-pulse">
                Loading library…
              </div>
            ) : tracks.length === 0 ? (
              <div className="flex-1 flex items-center justify-center glass rounded-lg">
                <div className="text-center max-w-sm">
                  <Sparkles className="h-8 w-8 text-iris-300 mx-auto mb-3" />
                  <div className="text-sm text-foreground mb-1">
                    No library loaded
                  </div>
                  <div className="text-xs text-muted-foreground mb-4">
                    In Rekordbox: <span className="text-foreground">File →
                    Export Collection in xml format</span>, then point Track2Mix
                    at the file.
                  </div>
                  <div className="flex items-center justify-center gap-2">
                    <Button variant="primary" onClick={pickXml}>
                      <FileUp className="h-3.5 w-3.5" />
                      Import Rekordbox XML
                    </Button>
                    <Button variant="secondary" onClick={pickDb}>
                      <Database className="h-3.5 w-3.5" />
                      Open existing .db
                    </Button>
                  </div>
                  <label className="flex items-center justify-center gap-2 mt-4 text-xs text-muted-foreground select-none cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-iris-500"
                      checked={skipAnalyzed}
                      onChange={(e) => setSkipAnalyzed(e.target.checked)}
                    />
                    Skip tracks already analyzed
                  </label>
                </div>
              </div>
            ) : inBuilder ? (
              <PlaylistBuilder
                tracks={tracks}
                order={playlistOrder}
                onOrderChange={onOrderChange}
                onRemove={removeFromSelection}
                onAdd={addToSelection}
                selectionOrder={selectionOrder}
                anchorId={anchorId}
                defaultName={anchor ? `${anchor.name} — Track2Mix` : "Track2Mix set"}
                onBack={() => setView("library")}
              />
            ) : (
              <TrackTable
                onPlay={(id) => {
                  const q = playQueueFor(id);
                  play(q.ids, q.start);
                }}
                rows={sorted}
                selected={selected}
                onToggleSelect={toggleSelect}
                onToggleSelectAll={toggleSelectAllVisible}
                anchorId={anchorId}
                onAnchor={setAnchorId}
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={onSort}
              />
            )}

            {!inBuilder && <PlayerBar />}

            {/* Bottom action bar */}
            {!inBuilder && (
            <div className="glass rounded-lg px-4 py-2.5 flex items-center gap-3">
              <Badge variant={selected.size > 0 ? "iris" : "muted"}>
                {selected.size} selected
              </Badge>
              {selected.size > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearSelection}
                >
                  Clear
                </Button>
              )}
              {selected.size > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => play(playlistOrder, 0)}
                >
                  <Play className="h-3.5 w-3.5" />
                  Play selected
                </Button>
              )}
              <div className="ml-auto flex items-center gap-2">
                {anchor ? (
                  <span className="text-xs text-muted-foreground truncate max-w-[260px]">
                    Anchor:{" "}
                    <span className="text-iris-200">
                      {anchor.name}
                    </span>
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Click a row to set an anchor for compat matching
                  </span>
                )}
                <Button
                  variant="gold"
                  size="sm"
                  disabled={selected.size === 0}
                  onClick={openBuilder}
                >
                  <ListMusic className="h-3.5 w-3.5" />
                  Build playlist
                </Button>
              </div>
            </div>
            )}
          </div>

          {anchor && !inBuilder && (
            <CompatPanel
              anchor={anchor}
              onClose={() => setAnchorId(null)}
              onAddToSelection={addToSelection}
              onSetAnchor={setAnchorId}
              onPlay={(id) => play([id], 0)}
            />
          )}
        </div>
      </main>

      {analyzing && (
        <AnalyzeOverlay
          progress={progress}
          failures={analyzeFailures}
          err={analyzeErr}
        />
      )}

      {!analyzing && analyzeSummary && (
        <div className="fixed bottom-4 right-4 z-40 glass rounded-lg p-4 border border-iris-500/30 text-sm max-w-sm shadow-glow-iris-sm">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <div className="font-medium text-foreground">
                Analysis complete
              </div>
              <div className="text-xs text-muted-foreground">
                {analyzeSummary.ok} ok · {analyzeSummary.failed} failed ·{" "}
                {analyzeSummary.elapsed_secs.toFixed(1)}s
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAnalyzeSummary(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate">
            {analyzeSummary.db_path}
          </div>
        </div>
      )}

      {!analyzing && analyzeErr && (
        <div className="fixed bottom-4 right-4 z-40 glass rounded-lg p-4 border border-red-500/30 text-sm max-w-md">
          <div className="flex items-start justify-between gap-3 mb-1">
            <div className="font-medium text-red-200">
              Couldn't analyze the XML
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAnalyzeErr(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="text-xs text-red-300/90 font-mono whitespace-pre-wrap">
            {analyzeErr}
          </div>
        </div>
      )}
    </div>
    </PlayerProvider>
  );
}

/** Publishes the player API into a ref owned by App. Renders nothing. */
function PlayerBridge({
  target,
}: {
  target: React.MutableRefObject<PlayerApi | null>;
}) {
  const api = usePlayer();
  React.useLayoutEffect(() => {
    target.current = api;
  }, [target, api]);
  return null;
}

function AnalyzeOverlay({
  progress,
  failures,
  err,
}: {
  progress: ProgressEvent | null;
  failures: Array<{ name: string; error: string }>;
  err: string | null;
}) {
  const phase =
    progress === null
      ? "Starting…"
      : progress.kind === "parsed"
        ? `Parsed ${progress.total_in_xml.toLocaleString()} tracks from XML…`
        : progress.kind === "resolved"
          ? `Resolved ${progress.ready.toLocaleString()} playable tracks${
              progress.already_analyzed > 0
                ? ` · skipping ${progress.already_analyzed.toLocaleString()} already analyzed`
                : ""
            }`
          : progress.kind === "track"
            ? `Analyzing ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
            : progress.kind === "failed"
              ? `Failed: ${progress.name}`
              : "Working…";

  const pct =
    progress?.kind === "track"
      ? Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)
      : progress?.kind === "resolved"
        ? 1
        : 0;

  const current =
    progress?.kind === "track"
      ? `${progress.artist} — ${progress.name}`
      : undefined;

  return (
    <div className="fixed inset-0 z-50 bg-bg-deep/80 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="glass rounded-xl p-6 border border-white/10 w-full max-w-lg">
        <div className="flex items-center gap-3 mb-4">
          <div className="h-8 w-8 rounded-md bg-iris-500/20 flex items-center justify-center">
            <FileUp className="h-4 w-4 text-iris-300" />
          </div>
          <div>
            <div className="text-sm font-medium">Importing library…</div>
            <div className="text-xs text-muted-foreground">{phase}</div>
          </div>
        </div>

        <div className="h-2 rounded-full bg-white/5 overflow-hidden mb-2">
          <div
            className="h-full bg-iris-500 transition-all duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>

        {current && (
          <div className="text-xs text-muted-foreground truncate font-mono mb-3">
            {current}
          </div>
        )}

        {failures.length > 0 && (
          <div className="mt-3 pt-3 border-t border-white/5">
            <div className="text-xs text-red-300/80 mb-1">
              {failures.length} failure{failures.length === 1 ? "" : "s"}
            </div>
            <div className="max-h-24 overflow-auto text-[11px] text-red-300/70 font-mono space-y-0.5">
              {failures.slice(-5).map((f, i) => (
                <div key={i} className="truncate">
                  {f.name}: {f.error}
                </div>
              ))}
            </div>
          </div>
        )}

        {err && (
          <div className="mt-3 text-xs text-red-300 font-mono">{err}</div>
        )}
      </div>
    </div>
  );
}

export default App;
