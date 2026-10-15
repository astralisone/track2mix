import * as React from "react";
import {
  analyzeXml,
  defaultDbPath,
  importLibrary,
  listPlaylists,
  onAnalyzeProgress,
  openLibrary,
  playlistTrackIds,
  scanFolders,
  type AnalyzeSummary,
  type ImportKind,
  type LibrarySummary,
  type PlaylistInfo,
  type ProgressEvent,
  type UiTrack,
} from "@/lib/tauri";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { FilterBar, emptyFilters, type FilterState } from "./components/FilterBar";
import { Logo } from "./components/Logo";
import { TrackTable, type SortKey } from "./components/TrackTable";
import { CompatPanel } from "./components/CompatPanel";
import { ExportDialog } from "./components/ExportDialog";
import { Button } from "./components/ui/Button";
import { Badge } from "./components/ui/Badge";
import {
  ChevronDown,
  Database,
  Download,
  FileUp,
  FolderSearch,
  ListMusic,
  Sparkles,
  X,
} from "lucide-react";

function App() {
  const [dbPath, setDbPath] = React.useState<string>("");
  const [summary, setSummary] = React.useState<LibrarySummary | null>(null);
  const [tracks, setTracks] = React.useState<UiTrack[]>([]);
  const [loadErr, setLoadErr] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const [filters, setFilters] = React.useState<FilterState>(emptyFilters);
  const [sortBy, setSortBy] = React.useState<SortKey>("energy");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = React.useState<string | null>(null);
  const [showExport, setShowExport] = React.useState(false);

  const [playlists, setPlaylists] = React.useState<PlaylistInfo[]>([]);
  const [activePlaylist, setActivePlaylist] = React.useState<string>("");
  const [playlistIds, setPlaylistIds] = React.useState<Set<string> | null>(null);

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
      setActivePlaylist("");
      setPlaylistIds(null);
      setPlaylists(await listPlaylists().catch(() => []));
    } catch (e) {
      setLoadErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function choosePlaylist(name: string) {
    setActivePlaylist(name);
    if (!name) {
      setPlaylistIds(null);
      return;
    }
    try {
      setPlaylistIds(new Set(await playlistTrackIds(name)));
    } catch (e) {
      setLoadErr(String(e));
      setActivePlaylist("");
      setPlaylistIds(null);
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

  async function runJob(start: () => Promise<AnalyzeSummary>) {
    setAnalyzing(true);
    setProgress(null);
    setAnalyzeErr(null);
    setAnalyzeFailures([]);
    setAnalyzeSummary(null);
    try {
      const summary = await start();
      setAnalyzeSummary(summary);
      setDbPath(summary.db_path);
      await loadDb(summary.db_path);
    } catch (e) {
      setAnalyzeErr(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  /** Scans and imports from other apps add to the library that's open now. */
  async function targetDb(): Promise<string> {
    return dbPath || (await defaultDbPath());
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
    const derived = picked.replace(/\.xml$/i, ".db");
    const finalDb = derived === picked ? dbPath || `${picked}.db` : derived;

    await runJob(() =>
      analyzeXml({
        xml_path: picked,
        db_path: finalDb,
        skip_analyzed: skipAnalyzed,
      }),
    );
  }

  async function pickFolders() {
    setAnalyzeErr(null);
    const picked = await openFile({
      directory: true,
      multiple: true,
      title: "Choose folders to scan for tracks",
    }).catch((e) => {
      setAnalyzeErr(String(e));
      return null;
    });
    const dirs = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (dirs.length === 0) return;
    const db = await targetDb();
    await runJob(() =>
      scanFolders({ dirs, db_path: db, skip_analyzed: skipAnalyzed }),
    );
  }

  async function pickLibrary(
    kind: ImportKind,
    what: "nml" | "serato-folder" | "serato-crate",
  ) {
    setAnalyzeErr(null);
    const picked = await (what === "nml"
      ? openFile({
          title: "Choose your Traktor collection.nml",
          filters: [{ name: "Traktor collection", extensions: ["nml"] }],
        })
      : what === "serato-crate"
        ? openFile({
            title: "Choose a Serato .crate file",
            filters: [{ name: "Serato crate", extensions: ["crate"] }],
          })
        : openFile({
            directory: true,
            title: "Choose your _Serato_ folder",
          })
    ).catch((e) => {
      setAnalyzeErr(String(e));
      return null;
    });
    if (typeof picked !== "string") return;
    const db = await targetDb();
    await runJob(() =>
      importLibrary({
        kind,
        path: picked,
        db_path: db,
        skip_analyzed: skipAnalyzed,
      }),
    );
  }

  const anchor = React.useMemo(
    () => tracks.find((t) => t.track_id === anchorId) ?? null,
    [tracks, anchorId],
  );

  const filtered = React.useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const g = filters.genre.trim().toLowerCase();
    const sg = filters.subGenre.trim().toLowerCase();
    const k = filters.key.trim().toLowerCase();
    const bmin = filters.bpmMin === "" ? -Infinity : Number(filters.bpmMin);
    const bmax = filters.bpmMax === "" ? Infinity : Number(filters.bpmMax);
    return tracks.filter((t) => {
      if (playlistIds && !playlistIds.has(t.track_id)) return false;
      if (q) {
        const hay = `${t.name} ${t.artist}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (g && !(t.genre || "").toLowerCase().includes(g)) return false;
      if (sg && !(t.sub_genre || "").toLowerCase().includes(sg)) return false;
      if (k) {
        const keyHay = `${t.camelot ?? ""} ${t.tonality ?? ""}`.toLowerCase();
        if (!keyHay.includes(k)) return false;
      }
      const bpm = t.bpm ?? -1;
      if (bpm < bmin || bpm > bmax) return false;
      return true;
    });
  }, [tracks, filters, playlistIds]);

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

  const hasAnyFilter =
    !!(
      filters.search ||
      filters.genre ||
      filters.subGenre ||
      filters.key ||
      filters.bpmMin !== "" ||
      filters.bpmMax !== ""
    );

  return (
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
            title="When scanning or importing, skip tracks that are already in the database"
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
            onClick={pickFolders}
            disabled={analyzing}
          >
            <FolderSearch className="h-3.5 w-3.5" />
            Scan folder
          </Button>
          <ImportMenu
            disabled={analyzing}
            onRekordbox={pickXml}
            onTraktor={() => pickLibrary("traktor", "nml")}
            onSeratoFolder={() => pickLibrary("serato", "serato-folder")}
            onSeratoCrate={() => pickLibrary("serato", "serato-crate")}
          />
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
      <main className="flex-1 flex flex-col min-h-0 p-3 gap-3">
        {playlists.length > 0 && (
          <div className="glass rounded-lg px-3 py-2 flex items-center gap-2 text-xs">
            <ListMusic className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Playlist</span>
            <select
              value={activePlaylist}
              onChange={(e) => choosePlaylist(e.target.value)}
              className="h-7 rounded-md bg-bg-deep border border-white/10 px-2 text-xs text-foreground max-w-[360px] [color-scheme:dark]"
            >
              <option value="">All tracks</option>
              {playlists.map((p) => (
                <option key={`${p.source}:${p.name}`} value={p.name}>
                  {p.name} · {p.source} · {p.count}
                </option>
              ))}
            </select>
          </div>
        )}
        <FilterBar
          filters={filters}
          onChange={setFilters}
          onReset={() => setFilters(emptyFilters)}
          hasAny={hasAnyFilter}
          counts={{ shown: sorted.length, total: tracks.length }}
        />

        <div className="flex-1 flex gap-3 min-h-0">
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
                    Scan a folder of music, or bring in a library from
                    Rekordbox (<span className="text-foreground">File →
                    Export Collection in xml format</span>), Traktor or Serato
                    from the Import menu above.
                  </div>
                  <div className="flex items-center justify-center gap-2">
                    <Button variant="primary" onClick={pickFolders}>
                      <FolderSearch className="h-3.5 w-3.5" />
                      Scan a folder
                    </Button>
                    <Button variant="secondary" onClick={pickXml}>
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
            ) : (
              <TrackTable
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

            {/* Bottom action bar */}
            <div className="glass rounded-lg px-4 py-2.5 flex items-center gap-3">
              <Badge variant={selected.size > 0 ? "iris" : "muted"}>
                {selected.size} selected
              </Badge>
              {selected.size > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                >
                  Clear
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
                  onClick={() => setShowExport(true)}
                >
                  <Download className="h-3.5 w-3.5" />
                  Export…
                </Button>
              </div>
            </div>
          </div>

          {anchor && (
            <CompatPanel
              anchor={anchor}
              onClose={() => setAnchorId(null)}
              onAddToSelection={addToSelection}
              onSetAnchor={setAnchorId}
            />
          )}
        </div>
      </main>

      <ExportDialog
        open={showExport}
        onOpenChange={setShowExport}
        selectedIds={Array.from(selected)}
        defaultName={anchor ? `${anchor.name} — Track2Mix` : "Track2Mix set"}
      />

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
              {analyzeSummary.estimated_bpm + analyzeSummary.estimated_key > 0 && (
                <div className="text-xs text-muted-foreground">
                  Estimated from audio: {analyzeSummary.estimated_bpm} BPM,{" "}
                  {analyzeSummary.estimated_key} key (tags had none)
                </div>
              )}
              {analyzeSummary.playlists > 0 && (
                <div className="text-xs text-muted-foreground">
                  {analyzeSummary.playlists} playlist
                  {analyzeSummary.playlists === 1 ? "" : "s"} imported
                </div>
              )}
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
              Import failed
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
  );
}

function ImportMenu({
  disabled,
  onRekordbox,
  onTraktor,
  onSeratoFolder,
  onSeratoCrate,
}: {
  disabled: boolean;
  onRekordbox: () => void;
  onTraktor: () => void;
  onSeratoFolder: () => void;
  onSeratoCrate: () => void;
}) {
  const item =
    "px-3 py-2 text-xs rounded cursor-pointer outline-none text-foreground data-[highlighted]:bg-white/[0.08]";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          <FileUp className="h-3.5 w-3.5" />
          Import
          <ChevronDown className="h-3 w-3 opacity-70" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="glass rounded-lg border border-white/10 p-1 min-w-[230px] z-50 animate-fade-in"
        >
          <DropdownMenu.Item className={item} onSelect={onRekordbox}>
            Rekordbox XML…
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={onTraktor}>
            Traktor collection (.nml)…
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={onSeratoFolder}>
            Serato library (_Serato_ folder)…
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={onSeratoCrate}>
            Serato crate (.crate)…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
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
        ? `Found ${progress.total_in_xml.toLocaleString()} tracks…`
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
            <div className="text-sm font-medium">Analyzing tracks…</div>
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
