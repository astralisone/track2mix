import * as React from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Download,
  FolderOpen,
  GripVertical,
  ListOrdered,
  Pause,
  Play,
  Plus,
  Sparkles,
  TrendingUp,
  Wand2,
  X,
} from "lucide-react";
import { compat, exportPlaylist, type ExportFormat, type UiTrack } from "@/lib/tauri";
import { usePlayer } from "@/lib/player";
import { isCompatible, keyColor, parseCamelot, type KeyRelation } from "@/lib/camelot";
import {
  moveItem,
  proposeOrder,
  sortBpmUp,
  sortEnergyUp,
  transition,
  type Transition,
} from "@/lib/mix";
import { cn, formatBpm } from "@/lib/utils";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Badge } from "./ui/Badge";
import { KeyChip } from "./KeyChip";
import { EnergyMeter } from "./EnergyMeter";
import { PlayerBar } from "./PlayerBar";

export type PlaylistBuilderProps = {
  /** Lookup source for every id in `order` (any order; extra tracks are ignored). */
  tracks: UiTrack[];
  /** The set, in play order. Ids missing from `tracks` are not rendered. */
  order: string[];
  onOrderChange: (order: string[]) => void;
  /** Remove from the set (the caller should also deselect it). */
  onRemove: (id: string) => void;
  /** Add to the set (the caller selects them; reconcileOrder appends them). */
  onAdd: (ids: string[]) => void;
  /** Selection in insertion order, for the "Selection order" arrangement. */
  selectionOrder: string[];
  anchorId: string | null;
  defaultName: string;
  onBack: () => void;
};

const ROW_H = 52;
const EDGE = 48; // px from the list edge where drag auto-scroll kicks in
const MAX_SCROLL_STEP = 14; // px per frame at the very edge

type FormatMeta = { label: string; ext: string; filter: string; note: string };

const FORMATS: Record<ExportFormat, FormatMeta> = {
  m3u8: {
    label: "Rekordbox M3U8",
    ext: "m3u8",
    filter: "M3U8 playlist",
    note: "Extended M3U with artist and title. In Rekordbox: File → Import Playlist.",
  },
  m3u: {
    label: "Plain M3U (paths only, UTF-8)",
    ext: "m3u",
    filter: "M3U playlist",
    note: "One file path per line, UTF-8. Some Windows players read .m3u as the system codepage.",
  },
  txt: {
    label: "Text tracklist",
    ext: "txt",
    filter: "Text file",
    note: "Numbered “Artist - Title” list for sharing. Includes every track; no paths.",
  },
};

const RELATION_BADGE: Record<KeyRelation, { label: string; cls: string; title: string }> = {
  same: {
    label: "Perfect",
    cls: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
    title: "Same key",
  },
  relative: {
    label: "Relative",
    cls: "bg-sky-500/15 text-sky-300 border-sky-400/30",
    title: "Relative major/minor",
  },
  adjacent: {
    label: "±1",
    cls: "bg-iris-500/15 text-iris-200 border-iris-500/30",
    title: "One step around the wheel",
  },
  boost: {
    label: "+2 Boost",
    cls: "bg-gold-300/15 text-gold-200 border-gold-300/30",
    title: "Two steps up: energy boost",
  },
  drop: {
    label: "−2 Drop",
    cls: "bg-amber-500/10 text-amber-300 border-amber-400/25",
    title: "Two steps down: energy drop",
  },
  clash: {
    label: "Clash",
    cls: "bg-red-500/15 text-red-300 border-red-400/30",
    title: "Keys clash",
  },
  unknown: {
    label: "?",
    cls: "bg-white/[0.03] text-muted-foreground border-white/10",
    title: "Key unknown",
  },
};

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-z0-9\-_ ]/gi, "").trim() || "Track2Mix set";
}

/** Swap a known playlist extension for `ext`, or append it. */
function withExtension(path: string, ext: string): string {
  if (/\.(m3u8|m3u|txt)$/i.test(path)) return path.replace(/\.(m3u8|m3u|txt)$/i, `.${ext}`);
  return `${path}.${ext}`;
}

function formatPct(p: number | null): string {
  if (p === null) return "";
  const r = Math.round(p * 10) / 10;
  if (Math.abs(r) < 0.05) return "±0%";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}%`;
}

export function PlaylistBuilder({
  tracks,
  order,
  onOrderChange,
  onRemove,
  onAdd,
  selectionOrder,
  anchorId,
  defaultName,
  onBack,
}: PlaylistBuilderProps) {
  const player = usePlayer();

  const byId = React.useMemo(() => {
    const m = new Map<string, UiTrack>();
    for (const t of tracks) m.set(t.track_id, t);
    return m;
  }, [tracks]);

  // Only ids we can resolve, de-duplicated, form the working order.
  const baseOrder = React.useMemo(() => {
    const seen = new Set<string>();
    return order.filter((id) => {
      if (seen.has(id) || !byId.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [order, byId]);

  // ---- drag state -------------------------------------------------------
  const listRef = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<{ id: string; from: number; to: number } | null>(
    null,
  );
  const dragRef = React.useRef(drag);
  dragRef.current = drag;
  const pointerY = React.useRef(0);
  const rafRef = React.useRef<number | null>(null);

  const viewOrder = React.useMemo(
    () => (drag ? moveItem(baseOrder, drag.from, drag.to) : baseOrder),
    [baseOrder, drag],
  );
  const rows = React.useMemo(
    () => viewOrder.map((id) => byId.get(id)!).filter(Boolean),
    [viewOrder, byId],
  );
  const viewPos = React.useMemo(() => {
    const m = new Map<string, number>();
    viewOrder.forEach((id, i) => m.set(id, i));
    return m;
  }, [viewOrder]);
  const transitions = React.useMemo<(Transition | null)[]>(
    () => rows.map((t, i) => (i === 0 ? null : transition(rows[i - 1], t))),
    [rows],
  );

  const stats = React.useMemo(() => {
    const bpms = rows.map((r) => r.bpm).filter((b): b is number => b != null && b > 0);
    const avgBpm = bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : null;
    let harmonic = 0;
    let clashes = 0;
    for (const t of transitions) {
      if (!t) continue;
      if (isCompatible(t.relation)) harmonic++;
      if (t.relation === "clash") clashes++;
    }
    return { avgBpm, harmonic, total: Math.max(0, rows.length - 1), clashes };
  }, [rows, transitions]);

  const [hoverIdx, setHoverIdx] = React.useState<number | null>(null);

  // Target index from pointer position: content offset / row height.
  const targetIndexAt = React.useCallback(
    (clientY: number) => {
      const el = listRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const y = clientY - rect.top + el.scrollTop;
      return Math.max(0, Math.min(baseOrder.length - 1, Math.floor(y / ROW_H)));
    },
    [baseOrder.length],
  );

  const stopAutoScroll = React.useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const autoScrollTick = React.useCallback(() => {
    const el = listRef.current;
    const d = dragRef.current;
    if (!el || !d) {
      rafRef.current = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    const y = pointerY.current;
    let step = 0;
    if (y < rect.top + EDGE) step = -MAX_SCROLL_STEP * Math.min(1, (rect.top + EDGE - y) / EDGE);
    else if (y > rect.bottom - EDGE)
      step = MAX_SCROLL_STEP * Math.min(1, (y - (rect.bottom - EDGE)) / EDGE);
    if (step !== 0) {
      const before = el.scrollTop;
      el.scrollTop = before + step;
      if (el.scrollTop !== before) {
        const to = targetIndexAt(y);
        if (to !== d.to) setDrag({ ...d, to });
      }
    }
    rafRef.current = requestAnimationFrame(autoScrollTick);
  }, [targetIndexAt]);

  React.useEffect(() => stopAutoScroll, [stopAutoScroll]);

  // If the order changes underneath an active drag (e.g. a track is removed
  // elsewhere), abandon the drag rather than move the wrong item.
  React.useEffect(() => {
    const d = dragRef.current;
    if (d && baseOrder[d.from] !== d.id) {
      stopAutoScroll();
      setDrag(null);
    }
  }, [baseOrder, stopAutoScroll]);

  function onHandlePointerDown(e: React.PointerEvent<HTMLElement>, index: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerY.current = e.clientY;
    setDrag({ id: baseOrder[index], from: index, to: index });
    stopAutoScroll();
    rafRef.current = requestAnimationFrame(autoScrollTick);
  }

  function onHandlePointerMove(e: React.PointerEvent<HTMLElement>) {
    const d = dragRef.current;
    if (!d) return;
    pointerY.current = e.clientY;
    const to = targetIndexAt(e.clientY);
    if (to !== d.to) setDrag({ ...d, to });
  }

  function endDrag(e: React.PointerEvent<HTMLElement>, commit: boolean) {
    const d = dragRef.current;
    stopAutoScroll();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!d) return;
    dragRef.current = null;
    setDrag(null);
    if (commit && d.from !== d.to && baseOrder[d.from] === d.id) {
      onOrderChange(moveItem(baseOrder, d.from, d.to));
      focusAfterMove.current = d.id;
    }
  }

  // ---- keyboard / buttons reorder ---------------------------------------
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const focusAfterMove = React.useRef<string | null>(null);
  React.useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    focusAfterMove.current = null;
    const el = rowRefs.current.get(id);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
    }
  }, [baseOrder]);

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= baseOrder.length) return;
    focusAfterMove.current = baseOrder[index];
    onOrderChange(moveItem(baseOrder, index, to));
  }

  function onRowKeyDown(e: React.KeyboardEvent<HTMLDivElement>, index: number) {
    if (e.target !== e.currentTarget) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      move(index, e.key === "ArrowUp" ? -1 : 1);
    } else if (!e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const next = baseOrder[index + (e.key === "ArrowUp" ? -1 : 1)];
      if (next) rowRefs.current.get(next)?.focus();
    } else if (e.key === "Delete") {
      e.preventDefault();
      onRemove(baseOrder[index]);
    }
  }

  // ---- arrangements -----------------------------------------------------
  const ordered = React.useCallback(
    () => baseOrder.map((id) => byId.get(id)!),
    [baseOrder, byId],
  );
  const arrange = {
    flow: () => onOrderChange(proposeOrder(ordered(), anchorId)),
    energy: () => onOrderChange(sortEnergyUp(ordered())),
    bpm: () => onOrderChange(sortBpmUp(ordered())),
    selection: () => {
      const inSet = new Set(baseOrder);
      const seen = new Set<string>();
      const out: string[] = [];
      for (const id of [...selectionOrder, ...baseOrder]) {
        if (inSet.has(id) && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      }
      onOrderChange(out);
    },
  };

  // ---- suggest next -----------------------------------------------------
  const [suggestOpen, setSuggestOpen] = React.useState(false);
  const [suggestions, setSuggestions] = React.useState<UiTrack[]>([]);
  const [suggestLoading, setSuggestLoading] = React.useState(false);
  const [suggestErr, setSuggestErr] = React.useState<string | null>(null);
  const lastId = baseOrder.length ? baseOrder[baseOrder.length - 1] : null;
  const lastTrack = lastId ? byId.get(lastId) ?? null : null;
  const lastHasBpm = lastTrack?.bpm != null && lastTrack.bpm > 0;

  React.useEffect(() => {
    if (!suggestOpen || !lastId || !lastHasBpm) {
      setSuggestions([]);
      setSuggestErr(null);
      setSuggestLoading(false);
      return;
    }
    let cancelled = false;
    setSuggestLoading(true);
    setSuggestErr(null);
    compat({
      track_id: lastId,
      bpm_tol: 3,
      half_double_ok: true,
      any_key: false,
      // Over-fetch so up to 10 remain after excluding tracks already in the set.
      limit: 10 + Math.min(baseOrder.length, 90),
    })
      .then((r) => {
        if (!cancelled) setSuggestions(r);
      })
      .catch((e) => {
        if (!cancelled) setSuggestErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setSuggestLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-query only when the tail track changes, not on every reorder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestOpen, lastId, lastHasBpm]);

  const visibleSuggestions = React.useMemo(() => {
    const inSet = new Set(baseOrder);
    return suggestions.filter((s) => !inSet.has(s.track_id)).slice(0, 10);
  }, [suggestions, baseOrder]);

  // ---- export -----------------------------------------------------------
  const [nameEdited, setNameEdited] = React.useState(false);
  const [name, setName] = React.useState(defaultName);
  React.useEffect(() => {
    if (!nameEdited) setName(defaultName);
  }, [defaultName, nameEdited]);
  const [format, setFormat] = React.useState<ExportFormat>("m3u8");
  const [path, setPath] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [ok, setOk] = React.useState<string | null>(null);

  function changeFormat(f: ExportFormat) {
    setFormat(f);
    if (path) setPath(withExtension(path, FORMATS[f].ext));
    setOk(null);
  }

  async function pickPath() {
    const meta = FORMATS[format];
    try {
      const picked = await save({
        defaultPath: path ? withExtension(path, meta.ext) : `${sanitizeFileName(name)}.${meta.ext}`,
        filters: [{ name: meta.filter, extensions: [meta.ext] }],
      });
      if (picked) setPath(withExtension(picked, meta.ext));
    } catch (e) {
      setErr(String(e));
    }
  }

  async function doExport() {
    if (baseOrder.length === 0) return;
    if (!path) {
      setErr("Pick a destination file first.");
      return;
    }
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const r = await exportPlaylist({
        path,
        playlist_name: name.trim() || defaultName,
        track_ids: baseOrder,
        format,
      });
      let msg = `Wrote ${r.written} of ${r.requested} track${r.requested === 1 ? "" : "s"} to ${path}`;
      const short = r.requested - r.written;
      if (short > 0) {
        msg += `. ${short} skipped: no file path in the library, or no longer found.`;
      }
      setOk(msg);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const pathlessCount = React.useMemo(
    () => (format === "txt" ? 0 : rows.filter((r) => !r.file_path).length),
    [rows, format],
  );

  // ---- render -----------------------------------------------------------
  const empty = baseOrder.length === 0;

  return (
    <section className="flex-1 min-w-0 min-h-0 flex flex-col glass rounded-lg overflow-hidden animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to library">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
          aria-label="Playlist name"
          className="h-8 max-w-[320px] text-sm font-medium"
        />
        <div className="flex flex-wrap items-center gap-1.5 ml-auto">
          <Badge variant="iris">
            {baseOrder.length} track{baseOrder.length === 1 ? "" : "s"}
          </Badge>
          <Badge variant="muted">avg {formatBpm(stats.avgBpm)} BPM</Badge>
          <Badge variant="muted" title="Same key, relative or ±1 on the wheel">
            {stats.harmonic}/{stats.total} harmonic
          </Badge>
          <Badge
            variant="outline"
            className={cn(stats.clashes > 0 && "border-red-400/30 text-red-300")}
          >
            {stats.clashes} clash{stats.clashes === 1 ? "" : "es"}
          </Badge>
        </div>
      </div>

      {empty ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center">
          <ListOrdered className="h-8 w-8 text-muted-foreground/50" />
          <div className="text-sm text-foreground">No tracks in this set yet</div>
          <div className="text-xs text-muted-foreground max-w-sm">
            Select tracks in the library, or add matches from the compat panel, then come back
            here to arrange and export them.
          </div>
          <Button variant="outline" size="sm" className="mt-2" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to library
          </Button>
        </div>
      ) : (
        <>
          {/* Set curve */}
          <div className="px-4 pt-3">
            <SetCurve
              rows={rows}
              transitions={transitions}
              hoverIdx={hoverIdx}
              dragIdx={drag ? drag.to : null}
              onHover={setHoverIdx}
              onSelect={(i) => {
                const id = rows[i]?.track_id;
                if (id) rowRefs.current.get(id)?.scrollIntoView({ block: "nearest" });
              }}
            />
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-white/5">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground mr-1">
              Arrange
            </span>
            <Button variant="secondary" size="sm" onClick={arrange.flow} title="Greedy harmonic path from the anchor (or lowest energy)">
              <Wand2 className="h-3.5 w-3.5" />
              Harmonic flow
            </Button>
            <Button variant="secondary" size="sm" onClick={arrange.energy}>
              <TrendingUp className="h-3.5 w-3.5" />
              Energy ramp
            </Button>
            <Button variant="secondary" size="sm" onClick={arrange.bpm}>
              <BarChart3 className="h-3.5 w-3.5" />
              BPM ascending
            </Button>
            <Button variant="secondary" size="sm" onClick={arrange.selection}>
              <ListOrdered className="h-3.5 w-3.5" />
              Selection order
            </Button>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant={suggestOpen ? "outline" : "secondary"}
                size="sm"
                onClick={() => setSuggestOpen((o) => !o)}
                aria-expanded={suggestOpen}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Suggest next
              </Button>
              <Button variant="primary" size="sm" onClick={() => player.playTracks(baseOrder, 0)}>
                <Play className="h-3.5 w-3.5" />
                Play set
              </Button>
            </div>
          </div>

          {suggestOpen && (
            <div className="px-4 py-2 border-b border-white/5 bg-white/[0.015]">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-xs text-muted-foreground truncate">
                  Compatible after{" "}
                  <span className="text-foreground">{lastTrack?.name ?? "—"}</span> (±3 BPM,
                  half/double ok)
                </div>
                <div className="flex items-center gap-1">
                  {visibleSuggestions.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onAdd(visibleSuggestions.map((s) => s.track_id))}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add all
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setSuggestOpen(false)}
                    aria-label="Close suggestions"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {suggestLoading && (
                <div className="text-xs text-muted-foreground animate-pulse py-1">
                  Finding matches…
                </div>
              )}
              {suggestErr && <div className="text-xs text-red-300 py-1">{suggestErr}</div>}
              {!lastHasBpm && (
                <div className="text-xs text-gold-200/90 py-1">
                  Last track has no BPM — suggestions need one.
                </div>
              )}
              {lastHasBpm && !suggestLoading && !suggestErr && visibleSuggestions.length === 0 && (
                <div className="text-xs text-muted-foreground py-1">
                  No compatible tracks outside the set.
                </div>
              )}
              {!suggestLoading && visibleSuggestions.length > 0 && (
                <ul className="max-h-40 overflow-auto divide-y divide-white/[0.04]">
                  {visibleSuggestions.map((s) => {
                    const tr = lastTrack ? transition(lastTrack, s) : null;
                    return (
                      <li key={s.track_id} className="flex items-center gap-2 py-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-foreground truncate">{s.name}</div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {s.artist}
                          </div>
                        </div>
                        <span className="text-[11px] tabular-nums text-muted-foreground w-12 text-right">
                          {formatBpm(s.bpm)}
                        </span>
                        <KeyChip camelot={s.camelot} raw={s.tonality} />
                        <EnergyMeter value={s.energy} />
                        {tr && <TransitionBadge t={tr} />}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => onAdd([s.track_id])}
                          title="Add to the end of the set"
                          aria-label={`Add ${s.name}`}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* List */}
          <div
            ref={listRef}
            className={cn("flex-1 min-h-0 overflow-auto", drag && "select-none")}
            role="list"
            aria-label="Playlist order"
          >
            <div style={{ height: rows.length * ROW_H }} className="relative">
              {/* DOM order stays = baseOrder so the dragged handle keeps its node (and
                  pointer capture); rows are placed at their preview slot by transform. */}
              {baseOrder.map((id, bi) => {
                const i = viewPos.get(id) ?? bi;
                const t = rows[i];
                if (!t) return null;
                const tr = transitions[i];
                const dragging = drag?.id === t.track_id;
                const current = player.isCurrent(t.track_id);
                const playing = current && player.state.playing;
                return (
                  <div
                    key={t.track_id}
                    ref={(el) => {
                      if (el) rowRefs.current.set(t.track_id, el);
                      else rowRefs.current.delete(t.track_id);
                    }}
                    role="listitem"
                    tabIndex={0}
                    aria-label={`${i + 1}. ${t.artist} - ${t.name}. Alt+Up or Alt+Down to move.`}
                    onKeyDown={(e) => onRowKeyDown(e, bi)}
                    onMouseEnter={() => setHoverIdx(i)}
                    onMouseLeave={() => setHoverIdx((h) => (h === i ? null : h))}
                    style={{ height: ROW_H, transform: `translateY(${i * ROW_H}px)` }}
                    className={cn(
                      "group absolute inset-x-0 top-0 flex items-center gap-2 px-3 border-b border-white/[0.04] outline-none",
                      drag && !dragging && "transition-transform duration-150 ease-out",
                      dragging && "z-10",
                      "focus-visible:bg-iris-500/10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-iris-500/50",
                      hoverIdx === i && !drag && "bg-white/[0.03]",
                      dragging && "bg-iris-500/15 ring-1 ring-inset ring-iris-500/50",
                      current && !dragging && "bg-iris-500/[0.07]",
                    )}
                  >
                    <span
                      onPointerDown={(e) => onHandlePointerDown(e, bi)}
                      onPointerMove={onHandlePointerMove}
                      onPointerUp={(e) => endDrag(e, true)}
                      onPointerCancel={(e) => endDrag(e, false)}
                      onLostPointerCapture={() => {
                        if (dragRef.current) {
                          // Capture lost without pointerup (e.g. window blur): drop the drag.
                          stopAutoScroll();
                          setDrag(null);
                        }
                      }}
                      className={cn(
                        "touch-none shrink-0 p-1 rounded text-muted-foreground/60 hover:text-foreground",
                        drag ? "cursor-grabbing" : "cursor-grab",
                      )}
                      title="Drag to reorder"
                      aria-hidden
                    >
                      <GripVertical className="h-4 w-4" />
                    </span>
                    <span className="w-6 text-right text-[11px] tabular-nums text-muted-foreground shrink-0">
                      {i + 1}
                    </span>
                    <button
                      onClick={() =>
                        current ? player.toggle() : player.playTracks(baseOrder, bi)
                      }
                      className={cn(
                        "shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-full transition-colors",
                        current
                          ? "text-iris-200 bg-iris-500/20"
                          : "text-muted-foreground hover:text-foreground hover:bg-white/[0.06]",
                      )}
                      title={playing ? "Pause" : "Play from here"}
                      aria-label={playing ? "Pause" : `Play from ${t.name}`}
                    >
                      {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-foreground truncate">{t.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{t.artist}</div>
                    </div>
                    <span className="w-12 text-right text-xs tabular-nums text-muted-foreground shrink-0">
                      {formatBpm(t.bpm)}
                    </span>
                    <span className="w-10 shrink-0 flex justify-center">
                      <KeyChip camelot={t.camelot} raw={t.tonality} />
                    </span>
                    <span className="shrink-0">
                      <EnergyMeter value={t.energy} />
                    </span>
                    <span className="w-[132px] shrink-0 flex justify-end">
                      {tr ? <TransitionBadge t={tr} /> : <span className="text-[11px] text-muted-foreground/60">Opener</span>}
                    </span>
                    <div className="flex items-center shrink-0 opacity-40 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      <button
                        onClick={() => move(i, -1)}
                        disabled={i === 0}
                        className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                        title="Move up (Alt+↑)"
                        aria-label="Move up"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => move(i, 1)}
                        disabled={i === rows.length - 1}
                        className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                        title="Move down (Alt+↓)"
                        aria-label="Move down"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => onRemove(t.track_id)}
                        className="h-6 w-6 inline-flex items-center justify-center rounded text-muted-foreground hover:text-red-300"
                        title="Remove from set"
                        aria-label={`Remove ${t.name}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Inline player */}
      <div className="border-t border-white/5">
        <PlayerBar variant="inline" />
      </div>

      {/* Export footer */}
      <div className="px-4 py-3 border-t border-white/5 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-white/10 overflow-hidden" role="radiogroup" aria-label="Export format">
            {(Object.keys(FORMATS) as ExportFormat[]).map((f) => (
              <button
                key={f}
                role="radio"
                aria-checked={format === f}
                onClick={() => changeFormat(f)}
                className={cn(
                  "px-2.5 h-8 text-xs transition-colors",
                  format === f
                    ? "bg-iris-500/25 text-iris-100"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]",
                )}
              >
                {FORMATS[f].label}
              </button>
            ))}
          </div>
          <Input
            value={path}
            readOnly
            placeholder="Pick a destination…"
            className="flex-1 min-w-[180px] h-8 text-xs"
            title={path}
          />
          <Button variant="outline" size="sm" onClick={pickPath}>
            <FolderOpen className="h-3.5 w-3.5" />
            Browse
          </Button>
          <Button variant="primary" size="sm" onClick={doExport} disabled={busy || empty}>
            <Download className="h-3.5 w-3.5" />
            {busy ? "Exporting…" : "Export"}
          </Button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {FORMATS[format].note}
          {pathlessCount > 0 && (
            <span className="text-gold-200/90">
              {" "}
              {pathlessCount} track{pathlessCount === 1 ? " has" : "s have"} no file path and will
              be skipped.
            </span>
          )}
        </div>
        {err && (
          <div className="text-xs text-red-300 bg-red-500/10 border border-red-400/20 rounded-md p-2">
            {err}
          </div>
        )}
        {ok && (
          <div className="text-xs text-iris-200 bg-iris-500/10 border border-iris-500/25 rounded-md p-2 break-all">
            {ok}
          </div>
        )}
      </div>
    </section>
  );
}

function TransitionBadge({ t }: { t: Transition }) {
  const b = RELATION_BADGE[t.relation];
  const pct = formatPct(t.bpmDeltaPct);
  const big = t.bpmDeltaPct !== null && Math.abs(t.bpmDeltaPct) > 6;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn("inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium", b.cls)}
        title={b.title}
      >
        {b.label}
      </span>
      {pct && (
        <span
          className={cn(
            "text-[10px] tabular-nums w-11 text-right",
            big ? "text-red-300" : "text-muted-foreground",
          )}
          title="Tempo change vs previous track (half/double-time aware)"
        >
          {pct}
        </span>
      )}
    </span>
  );
}

// ---- Set curve ------------------------------------------------------------

const CURVE_H = 88;
const PAD_TOP = 10;
const PAD_BOTTOM = 4;

function SetCurve({
  rows,
  transitions,
  hoverIdx,
  dragIdx,
  onHover,
  onSelect,
}: {
  rows: UiTrack[];
  transitions: (Transition | null)[];
  hoverIdx: number | null;
  dragIdx: number | null;
  onHover: (i: number | null) => void;
  onSelect: (i: number) => void;
}) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(600);
  React.useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth || 600);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = rows.length;
  const slot = n > 0 ? width / n : width;
  const plotH = CURVE_H - PAD_TOP - PAD_BOTTOM;
  const barW = Math.max(2, Math.min(28, slot * 0.7));

  const bpms = rows.map((r) => (r.bpm != null && r.bpm > 0 ? r.bpm : null));
  const known = bpms.filter((b): b is number => b !== null);
  const lo = known.length ? Math.min(...known) : 0;
  const hi = known.length ? Math.max(...known) : 1;
  const span = Math.max(4, hi - lo); // avoid a flat line exploding tiny differences
  const mid = (lo + hi) / 2;
  const bpmY = (b: number) => PAD_TOP + plotH * (1 - ((b - (mid - span / 2)) / span) * 0.8 - 0.1);

  // Polyline segments, broken at unknown BPM.
  const segments: string[] = [];
  let cur: string[] = [];
  bpms.forEach((b, i) => {
    if (b === null) {
      if (cur.length) segments.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${(i + 0.5) * slot},${bpmY(b)}`);
  });
  if (cur.length) segments.push(cur.join(" "));

  return (
    <div ref={wrapRef} className="relative w-full" onMouseLeave={() => onHover(null)}>
      <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
        <span>Set curve</span>
        <span className="flex items-center gap-3 normal-case tracking-normal">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-sm bg-iris-400/80" /> energy (key colour)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 bg-gold-200" /> BPM
            {known.length > 0 && (
              <span className="tabular-nums">
                {" "}
                {lo.toFixed(0)}–{hi.toFixed(0)}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1 text-red-300">
            <span className="inline-block h-1.5 w-1.5 rotate-45 bg-red-400" /> clash
          </span>
        </span>
      </div>
      <svg
        width={width}
        height={CURVE_H}
        className="block rounded-md bg-white/[0.02] border border-white/5"
        role="img"
        aria-label="Energy and BPM across the set"
      >
        {[2.5, 5, 7.5].map((e) => (
          <line
            key={e}
            x1={0}
            x2={width}
            y1={PAD_TOP + plotH * (1 - e / 10)}
            y2={PAD_TOP + plotH * (1 - e / 10)}
            stroke="rgba(255,255,255,0.05)"
          />
        ))}
        {rows.map((t, i) => {
          const c = parseCamelot(t.camelot);
          const e = t.energy ?? 0;
          const h = Math.max(t.energy == null ? 2 : 3, (plotH * Math.max(0, Math.min(10, e))) / 10);
          const x = (i + 0.5) * slot - barW / 2;
          const active = hoverIdx === i || dragIdx === i;
          return (
            <rect
              key={t.track_id}
              x={x}
              y={PAD_TOP + plotH - h}
              width={barW}
              height={h}
              rx={Math.min(3, barW / 3)}
              fill={c ? keyColor(c.hour, c.major, active ? 1 : 0.7) : "rgba(158,164,178,0.35)"}
              stroke={active ? "white" : "none"}
              strokeWidth={active ? 1.5 : 0}
            />
          );
        })}
        {segments.map((pts, i) =>
          pts.includes(" ") ? (
            <polyline
              key={i}
              points={pts}
              fill="none"
              stroke="#FFD156"
              strokeOpacity={0.85}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
          ) : null,
        )}
        {bpms.map((b, i) =>
          b === null ? null : (
            <circle
              key={i}
              cx={(i + 0.5) * slot}
              cy={bpmY(b)}
              r={hoverIdx === i ? 3 : 1.75}
              fill="#FFD156"
            />
          ),
        )}
        {transitions.map((t, i) =>
          t && t.relation === "clash" ? (
            <rect
              key={`clash-${i}`}
              x={i * slot - 3.5}
              y={3}
              width={7}
              height={7}
              transform={`rotate(45 ${i * slot} 6.5)`}
              fill="#f87171"
            >
              <title>
                Clash: {rows[i - 1]?.camelot ?? "?"} → {rows[i]?.camelot ?? "?"}
              </title>
            </rect>
          ) : null,
        )}
        {rows.map((t, i) => (
          <rect
            key={`hit-${t.track_id}`}
            x={i * slot}
            y={0}
            width={slot}
            height={CURVE_H}
            fill="transparent"
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(i)}
            style={{ cursor: "pointer" }}
          >
            <title>
              {`${i + 1}. ${t.artist} - ${t.name}\n${formatBpm(t.bpm)} BPM · ${t.camelot ?? "no key"} · E ${t.energy ?? "—"}`}
            </title>
          </rect>
        ))}
      </svg>
    </div>
  );
}
