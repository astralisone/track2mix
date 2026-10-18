import * as React from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeRecording, type UiTrack } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { CompositionEngine, EngineState } from "@/audio/engine";
import {
  autoCrossfade,
  DEFAULT_LANE,
  gridForZoom,
  newId,
  snapTime,
  type Clip,
  type Composition,
  type Lane,
} from "@/audio/model";
import { Button } from "../ui/Button";
import { LaneStrip, LANE_HEIGHT } from "./LaneStrip";
import { Timeline, RULER_HEIGHT } from "./Timeline";
import { TrackPicker } from "./TrackPicker";
import { Transport } from "./Transport";
import { Check, Plus, Save, Shuffle, X } from "lucide-react";

type Props = {
  engine: CompositionEngine;
  comp: Composition;
  onCompChange: (c: Composition) => void;
  tracks: UiTrack[];
};

const MIN_ZOOM = 2;
const MAX_ZOOM = 400;

/**
 * The composition workspace: transport, mixer strips, timeline and the
 * library picker. All composition state lives in the parent (`comp`) so it
 * survives switching back to the library view; the engine is told about
 * every change and decides whether it can apply it live.
 */
export function ComposeView({ engine, comp, onCompChange, tracks }: Props) {
  const [state, setState] = React.useState<EngineState>(() => engine.state());
  const [pxPerSec, setPxPerSec] = React.useState(12);
  const [selectedClipId, setSelectedClipId] = React.useState<string | null>(null);
  const [showPicker, setShowPicker] = React.useState(comp.lanes.length === 0);
  const [autoXfade, setAutoXfade] = React.useState(true);
  const [revision, setRevision] = React.useState(0);
  const [bouncing, setBouncing] = React.useState<number | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  // The most recent WAV (live take or bounce) that hasn't been written to
  // disk yet. A live take can't be re-performed, so a cancelled dialog or a
  // failed write must never be the last anyone sees of it.
  const [unsaved, setUnsaved] = React.useState<{ wav: ArrayBuffer; name: string; what: string } | null>(null);

  // Always-fresh handle on the composition for async callbacks (decode
  // completions, save flows) that outlive the render they started in.
  const compRef = React.useRef(comp);
  compRef.current = comp;
  const commit = React.useCallback(
    (next: Composition) => {
      compRef.current = next;
      onCompChange(next);
    },
    [onCompChange],
  );

  React.useEffect(() => engine.subscribe(setState), [engine]);
  React.useEffect(() => {
    engine.setComposition(comp);
  }, [engine, comp]);

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const referenceKey = comp.lanes[0]?.track.camelot ?? null;
  const canPlay = comp.clips.length > 0;

  // ---- transport -------------------------------------------------------
  const playPause = React.useCallback(() => {
    if (engine.state().playing) engine.pause();
    else engine.play().catch((e) => setErr(String(e)));
  }, [engine]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) {
        return;
      }
      e.preventDefault();
      if (compRef.current.clips.length > 0) playPause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playPause]);

  // Tell the engine a drag is in progress so it defers rescheduling until
  // the gesture ends instead of restarting on every mousemove.
  function gesture(phase: "begin" | "end") {
    if (phase === "begin") engine.beginGesture();
    else engine.endGesture();
  }

  function setZoom(v: number) {
    setPxPerSec(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v)));
  }

  function playheadSnapped(c: Composition): number {
    const pos = engine.position();
    if (!c.snap) return pos;
    return snapTime(pos, c.masterBpm, gridForZoom(c.masterBpm, pxPerSec));
  }

  // ---- lanes & clips ---------------------------------------------------
  function fullClip(laneId: string, start: number, duration: number): Clip {
    return {
      id: newId("clip"),
      laneId,
      start,
      offset: 0,
      length: duration,
      fadeIn: 0,
      fadeOut: 0,
    };
  }

  // `changed` names the clips this edit touched so auto-crossfade only
  // writes fades next to them and leaves the user's other fades alone.
  function finish(next: Composition, changed?: string[]): Composition {
    if (!autoXfade) return next;
    // The second argument lands with the model update; until then the
    // one-argument form is used.
    return (autoCrossfade as (c: Composition, changed?: string[]) => Composition)(next, changed);
  }

  function addLane(track: UiTrack) {
    const cur = compRef.current;
    if (cur.lanes.some((l) => l.track.track_id === track.track_id)) return;
    const lane: Lane = { id: newId("lane"), track, ...DEFAULT_LANE };
    const masterBpm =
      cur.lanes.length === 0 && track.bpm && track.bpm > 0 ? track.bpm : cur.masterBpm;
    commit({ ...cur, masterBpm, lanes: [...cur.lanes, lane] });
  }

  // Decode every lane's audio as soon as it appears — whether it was added
  // here or from the library view — and drop a full-length clip at the
  // playhead for lanes that arrive empty, so a freshly added track is
  // audible without an extra click.
  const requested = React.useRef(new Set<string>());
  React.useEffect(() => {
    for (const lane of comp.lanes) {
      if (requested.current.has(lane.id)) continue;
      requested.current.add(lane.id);
      engine.loader
        .load(lane.track.track_id)
        .then((buf) => {
          setRevision((r) => r + 1);
          const c = compRef.current;
          // Lane may have been removed while decoding.
          if (!c.lanes.some((l) => l.id === lane.id)) return;
          if (c.clips.some((cl) => cl.laneId === lane.id)) return;
          const clip = fullClip(lane.id, playheadSnapped(c), buf.duration);
          commit(finish({ ...c, clips: [...c.clips, clip] }, [clip.id]));
        })
        .catch((e) => {
          requested.current.delete(lane.id);
          setErr(`Couldn't load "${lane.track.name}": ${String(e)}`);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comp.lanes, engine]);

  function addClipAtPlayhead(lane: Lane) {
    const buf = engine.loader.get(lane.track.track_id);
    if (!buf) return;
    const c = compRef.current;
    const clip = fullClip(lane.id, playheadSnapped(c), buf.duration);
    commit(finish({ ...c, clips: [...c.clips, clip] }, [clip.id]));
  }

  function patchLane(laneId: string, patch: Partial<Lane>) {
    const c = compRef.current;
    commit({
      ...c,
      lanes: c.lanes.map((l) => (l.id === laneId ? { ...l, ...patch } : l)),
    });
  }

  function removeLane(laneId: string) {
    const c = compRef.current;
    commit({
      ...c,
      lanes: c.lanes.filter((l) => l.id !== laneId),
      clips: c.clips.filter((cl) => cl.laneId !== laneId),
    });
    if (selectedClipId && c.clips.some((cl) => cl.id === selectedClipId && cl.laneId === laneId)) {
      setSelectedClipId(null);
    }
  }

  function changeClip(clip: Clip) {
    const c = compRef.current;
    commit(
      finish({ ...c, clips: c.clips.map((cl) => (cl.id === clip.id ? clip : cl)) }, [clip.id]),
    );
  }

  function deleteClip(id: string) {
    const c = compRef.current;
    commit({ ...c, clips: c.clips.filter((cl) => cl.id !== id) });
    if (selectedClipId === id) setSelectedClipId(null);
  }

  // ---- recording / bounce ---------------------------------------------
  function stampedName(kind: string): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `track2mix-${kind}-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.wav`;
  }

  /**
   * Offer a save dialog for `wav`. Returns true once the file is on disk.
   * The GTK dialog does not append the filter's extension when the user
   * types a bare name, and the Rust side only writes `.wav`, so add it here.
   * On cancel or failure the take is parked in `unsaved` for another try.
   */
  async function saveWav(wav: ArrayBuffer, defaultName: string, what: string): Promise<boolean> {
    setUnsaved({ wav, name: defaultName, what });
    try {
      const picked = await save({
        defaultPath: defaultName,
        filters: [{ name: "WAV", extensions: ["wav"] }],
      });
      if (!picked) {
        setToast(`${what} kept in memory — use "Save last recording" to write it.`);
        return false;
      }
      const path = /\.wav$/i.test(picked) ? picked : `${picked}.wav`;
      const bytes = await writeRecording(path, wav);
      setUnsaved(null);
      setToast(`${what} saved — ${(bytes / 1_048_576).toFixed(1)} MB → ${path}`);
      return true;
    } catch (e) {
      setErr(`${what} is still in memory (use "Save last recording"). Save failed: ${String(e)}`);
      return false;
    }
  }

  async function toggleRecord() {
    setErr(null);
    try {
      if (state.recording) {
        const wav = engine.stopRecording();
        if (!wav) {
          setErr("Nothing was recorded.");
          return;
        }
        await saveWav(wav, stampedName("live"), "Live take");
      } else {
        await engine.startRecording();
        if (!engine.state().playing) await engine.play();
      }
    } catch (e) {
      setErr(String(e));
    }
  }

  async function bounce() {
    setErr(null);
    setBouncing(0);
    try {
      const wav = await engine.bounce((f) => setBouncing(f));
      await saveWav(wav, stampedName("bounce"), "Bounce");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBouncing(null);
    }
  }

  const existingIds = React.useMemo(
    () => new Set(comp.lanes.map((l) => l.track.track_id)),
    [comp.lanes],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 gap-3">
      <Transport
        engine={engine}
        state={state}
        masterBpm={comp.masterBpm}
        snap={comp.snap}
        pxPerSec={pxPerSec}
        canPlay={canPlay}
        bouncing={bouncing}
        onPlayPause={playPause}
        onStop={() => engine.stop()}
        onBpm={(masterBpm) => commit({ ...compRef.current, masterBpm })}
        onSnap={(snap) => commit({ ...compRef.current, snap })}
        onZoom={setZoom}
        onRecordToggle={toggleRecord}
        onBounce={bounce}
      />

      {err && (
        <div className="glass rounded-lg px-3 py-2 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <span className="flex-1 font-mono whitespace-pre-wrap break-all">{err}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setErr(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <div className="flex-1 flex gap-3 min-h-0">
        <div className="flex-1 flex flex-col min-w-0 glass rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/5">
            <Button
              variant={showPicker ? "secondary" : "primary"}
              size="sm"
              className="h-7 px-2.5 text-[11px]"
              onClick={() => setShowPicker((v) => !v)}
            >
              <Plus className="h-3.5 w-3.5" />
              Add track
            </Button>
            {unsaved && (
              <Button
                variant="gold"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                onClick={() => void saveWav(unsaved.wav, unsaved.name, unsaved.what)}
                title={`${unsaved.what} is in memory and not yet on disk`}
              >
                <Save className="h-3.5 w-3.5" />
                Save last recording
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className={cn("h-7 px-2 text-[11px]", autoXfade && "text-iris-200 bg-iris-500/15")}
              onClick={() => setAutoXfade((v) => !v)}
              title="When clips on different lanes overlap, fade the outgoing one out and the incoming one in across the overlap"
            >
              <Shuffle className="h-3.5 w-3.5" />
              Auto-crossfade
            </Button>
            <span className="flex-1" />
            <span className="text-[11px] text-muted-foreground">
              {comp.lanes.length} lane{comp.lanes.length === 1 ? "" : "s"} ·{" "}
              {comp.clips.length} clip{comp.clips.length === 1 ? "" : "s"}
              {selectedClipId && <span className="ml-2 text-muted-foreground/70">Del removes the selected clip</span>}
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            <div className="flex min-h-full">
              <div className="w-[300px] shrink-0 border-r border-white/[0.06]">
                <div style={{ height: RULER_HEIGHT }} className="border-b border-white/[0.06]" />
                {comp.lanes.map((lane) => (
                  <LaneStrip
                    key={lane.id}
                    lane={lane}
                    referenceKey={referenceKey}
                    masterBpm={comp.masterBpm}
                    loaded={engine.loader.has(lane.track.track_id)}
                    onChange={(patch) => patchLane(lane.id, patch)}
                    onAddClip={() => addClipAtPlayhead(lane)}
                    onRemove={() => removeLane(lane.id)}
                  />
                ))}
                {comp.lanes.length === 0 && (
                  <div style={{ height: LANE_HEIGHT }} className="flex items-center justify-center text-[11px] text-muted-foreground px-3 text-center">
                    No lanes yet
                  </div>
                )}
              </div>
              <Timeline
                comp={comp}
                loader={engine.loader}
                pxPerSec={pxPerSec}
                position={state.position}
                referenceKey={referenceKey}
                selectedClipId={selectedClipId}
                revision={revision}
                onSeek={(t) => engine.seek(t)}
                onClipChange={changeClip}
                onSelectClip={setSelectedClipId}
                onDeleteClip={deleteClip}
                onZoom={setZoom}
                onDragStart={() => gesture("begin")}
                onDragEnd={() => gesture("end")}
              />
            </div>
          </div>
        </div>

        {showPicker && (
          <TrackPicker
            tracks={tracks}
            referenceKey={referenceKey}
            existingTrackIds={existingIds}
            onAdd={addLane}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>

      {toast && (
        <div className="fixed bottom-4 right-4 z-40 glass rounded-lg px-4 py-3 border border-iris-500/30 text-xs max-w-md shadow-glow-iris-sm flex items-start gap-2">
          <Check className="h-4 w-4 text-emerald-300 shrink-0" />
          <span className="font-mono break-all">{toast}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6 -mr-1" onClick={() => setToast(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
