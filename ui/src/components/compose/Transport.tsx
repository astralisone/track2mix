import * as React from "react";
import { Button } from "../ui/Button";
import { cn } from "@/lib/utils";
import { formatBar, formatTime } from "@/audio/model";
import type { CompositionEngine, EngineState } from "@/audio/engine";
import {
  Circle,
  Disc3,
  Grid3x3,
  Pause,
  Play,
  Square,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

type Props = {
  engine: CompositionEngine;
  state: EngineState;
  masterBpm: number;
  snap: boolean;
  pxPerSec: number;
  canPlay: boolean;
  bouncing: number | null; // progress 0..1 while bouncing
  onPlayPause: () => void;
  onStop: () => void;
  onBpm: (bpm: number) => void;
  onSnap: (snap: boolean) => void;
  onZoom: (pxPerSec: number) => void;
  onRecordToggle: () => void;
  onBounce: () => void;
};

export function Transport({
  engine,
  state,
  masterBpm,
  snap,
  pxPerSec,
  canPlay,
  bouncing,
  onPlayPause,
  onStop,
  onBpm,
  onSnap,
  onZoom,
  onRecordToggle,
  onBounce,
}: Props) {
  const [bpmText, setBpmText] = React.useState(String(masterBpm));
  React.useEffect(() => setBpmText(String(masterBpm)), [masterBpm]);

  function commitBpm() {
    const v = Number(bpmText);
    if (isFinite(v) && v >= 40 && v <= 300) onBpm(Math.round(v * 100) / 100);
    else setBpmText(String(masterBpm));
  }

  return (
    <div className="glass rounded-lg px-3 py-2 flex items-center gap-2">
      <Button
        variant={state.playing ? "secondary" : "primary"}
        size="icon"
        className="h-8 w-8"
        onClick={onPlayPause}
        disabled={!canPlay}
        title={state.playing ? "Pause (space)" : "Play (space)"}
      >
        {state.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onStop} title="Stop and return to start">
        <Square className="h-3.5 w-3.5" />
      </Button>

      <div className="font-mono tabular-nums text-sm text-foreground w-[76px]">
        {formatTime(state.position)}
      </div>
      <div className="font-mono tabular-nums text-xs text-muted-foreground w-[52px]">
        {formatBar(state.position, masterBpm)}
      </div>

      <Meter engine={engine} playing={state.playing} />

      <div className="h-5 w-px bg-white/10 mx-1" />

      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        Master
        <input
          className="w-[62px] h-7 rounded-md bg-white/[0.03] border border-white/10 px-2 text-sm font-mono tabular-nums text-foreground text-right focus-visible:outline-none focus-visible:border-iris-500/70"
          value={bpmText}
          onChange={(e) => setBpmText(e.target.value)}
          onBlur={commitBpm}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          inputMode="decimal"
          aria-label="Master BPM"
        />
        BPM
      </label>

      <Button
        variant="ghost"
        size="sm"
        className={cn("h-7 px-2 text-[11px]", snap && "text-iris-200 bg-iris-500/15")}
        onClick={() => onSnap(!snap)}
        title="Snap clips to the beat grid (hold Alt to bypass while dragging)"
      >
        <Grid3x3 className="h-3.5 w-3.5" />
        Snap
      </Button>

      <div className="flex items-center gap-0.5">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onZoom(pxPerSec / 1.4)} title="Zoom out (Ctrl+wheel)">
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onZoom(pxPerSec * 1.4)} title="Zoom in (Ctrl+wheel)">
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
      </div>

      <span className="flex-1" />

      <Button
        variant={state.recording ? "danger" : "ghost"}
        size="sm"
        className="h-7 px-2 text-[11px]"
        onClick={onRecordToggle}
        disabled={!canPlay && !state.recording}
        title={
          state.recording
            ? "Stop recording and save the live take"
            : "Record the master output live — your fader and EQ moves are captured"
        }
      >
        <Circle className={cn("h-3 w-3", state.recording ? "fill-red-400 text-red-400 animate-pulse" : "text-red-300")} />
        {state.recording ? `Rec ${formatTime(state.recordSeconds)}` : "Record live"}
      </Button>
      <Button
        variant="gold"
        size="sm"
        className="h-7 px-2.5 text-[11px]"
        onClick={onBounce}
        disabled={!canPlay || bouncing !== null}
        title="Render the arranged timeline to a WAV, faster than realtime"
      >
        <Disc3 className={cn("h-3.5 w-3.5", bouncing !== null && "animate-spin")} />
        {bouncing !== null ? `Bouncing ${Math.round(bouncing * 100)}%` : "Bounce to WAV"}
      </Button>
    </div>
  );
}

/** Peak meter driven by the engine's analyser, redrawn each frame while playing. */
function Meter({ engine, playing }: { engine: CompositionEngine; playing: boolean }) {
  const [level, setLevel] = React.useState(0);
  React.useEffect(() => {
    if (!playing) {
      setLevel(0);
      return;
    }
    let raf = 0;
    let smooth = 0;
    const loop = () => {
      const l = engine.level();
      smooth = l > smooth ? l : smooth * 0.92;
      setLevel(smooth);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine, playing]);
  const pct = Math.min(100, level * 100);
  const hot = level > 0.98;
  return (
    <div className="h-1.5 w-24 rounded-full bg-white/5 overflow-hidden" title="Master peak">
      <div
        className={cn("h-full rounded-full", hot ? "bg-red-400" : "energy-bar")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
