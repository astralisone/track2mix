import * as React from "react";
import type { UiTrack } from "@/lib/tauri";
import type { CompositionEngine } from "@/audio/engine";
import { describeAudioError } from "@/audio/errors";
import { formatTime } from "@/audio/model";
import { cn, formatBpm } from "@/lib/utils";
import { Button } from "./ui/Button";
import { KeyChip } from "./KeyChip";
import { Pause, Play, SlidersHorizontal, Volume2, X } from "lucide-react";

type Props = {
  engine: CompositionEngine;
  track: UiTrack | null;
  onClose: () => void;
  onAddToCompose?: (t: UiTrack) => void;
};

const PEAK_BUCKETS = 1200;

/**
 * Bottom mini-player for the library view. Shares the app's AudioContext and
 * decode cache but plays through its own source → gain → destination chain,
 * so previews never leak into a composition recording.
 */
export function PreviewPlayer({ engine, track, onClose, onAddToCompose }: Props) {
  const ctx = engine.ctx;
  const [status, setStatus] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [err, setErr] = React.useState<string | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [position, setPosition] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [volume, setVolume] = React.useState(() => {
    const stored = localStorage.getItem("track2mix.previewVolume");
    return stored === null ? 0.9 : Number(stored);
  });

  const sourceRef = React.useRef<AudioBufferSourceNode | null>(null);
  const gainRef = React.useRef<GainNode | null>(null);
  const bufferRef = React.useRef<AudioBuffer | null>(null);
  // Playback clock: timeline position when the source started, and ctx time then.
  const startPosRef = React.useRef(0);
  const startCtxRef = React.useRef(0);
  const pausedPosRef = React.useRef(0);
  const playingRef = React.useRef(false);
  const rafRef = React.useRef(0);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const draggingRef = React.useRef(false);

  // One gain node for the lifetime of the player.
  React.useEffect(() => {
    const g = ctx.createGain();
    g.gain.value = volume;
    g.connect(ctx.destination);
    gainRef.current = g;
    return () => {
      stopSource();
      cancelAnimationFrame(rafRef.current);
      g.disconnect();
      gainRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  React.useEffect(() => {
    localStorage.setItem("track2mix.previewVolume", String(volume));
    const g = gainRef.current;
    if (g) g.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
  }, [volume, ctx]);

  function currentPosition(): number {
    if (!playingRef.current) return pausedPosRef.current;
    return startPosRef.current + (ctx.currentTime - startCtxRef.current);
  }

  function stopSource() {
    const s = sourceRef.current;
    if (s) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* not started */
      }
      s.disconnect();
    }
    sourceRef.current = null;
  }

  const tick = React.useCallback(() => {
    if (!playingRef.current) return;
    const pos = currentPosition();
    const buf = bufferRef.current;
    if (buf && pos >= buf.duration) {
      playingRef.current = false;
      pausedPosRef.current = 0;
      setPlaying(false);
      setPosition(0);
      stopSource();
      return;
    }
    setPosition(pos);
    rafRef.current = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startAt(pos: number) {
    const buf = bufferRef.current;
    const g = gainRef.current;
    if (!buf || !g) return;
    try {
      if (ctx.state === "suspended") await ctx.resume();
    } catch (e) {
      // WebKitGTK reports a missing audio sink here, not at construction.
      setErr(describeAudioError(e));
      return;
    }
    stopSource();
    pos = Math.max(0, Math.min(pos, buf.duration));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(g);
    const at = ctx.currentTime + 0.02;
    src.start(at, pos);
    sourceRef.current = src;
    startPosRef.current = pos;
    startCtxRef.current = at;
    playingRef.current = true;
    setPlaying(true);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }

  function pause() {
    if (!playingRef.current) return;
    pausedPosRef.current = currentPosition();
    playingRef.current = false;
    stopSource();
    cancelAnimationFrame(rafRef.current);
    setPlaying(false);
    setPosition(pausedPosRef.current);
  }

  function seek(pos: number) {
    const buf = bufferRef.current;
    if (!buf) return;
    pos = Math.max(0, Math.min(pos, buf.duration));
    if (playingRef.current) {
      void startAt(pos);
    } else {
      pausedPosRef.current = pos;
      setPosition(pos);
    }
  }

  // Load + auto-play whenever the track changes.
  React.useEffect(() => {
    let cancelled = false;
    pause();
    bufferRef.current = null;
    pausedPosRef.current = 0;
    setPosition(0);
    setDuration(0);
    setErr(null);
    if (!track) {
      setStatus("idle");
      return;
    }
    setStatus("loading");
    engine.loader
      .load(track.track_id)
      .then((buf) => {
        if (cancelled) return;
        bufferRef.current = buf;
        setDuration(buf.duration);
        setStatus("ready");
        void startAt(0);
      })
      .catch((e) => {
        if (cancelled) return;
        setStatus("error");
        setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.track_id]);

  // Waveform drawing.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const c = canvas.getContext("2d");
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    const peaks = track && status === "ready" ? engine.loader.peaks(track.track_id, PEAK_BUCKETS) : null;
    const frac = duration > 0 ? position / duration : 0;
    const playedX = frac * w;
    const mid = h / 2;

    if (peaks) {
      for (let x = 0; x < w; x++) {
        const b = Math.floor((x / w) * peaks.length);
        const p = Math.max(1, peaks[b] * (mid - 2));
        c.fillStyle = x <= playedX ? "rgba(158,160,231,0.95)" : "rgba(87,90,208,0.45)";
        c.fillRect(x, mid - p, 1, p * 2);
      }
    } else {
      c.fillStyle = "rgba(255,255,255,0.06)";
      c.fillRect(0, mid - 0.5, w, 1);
    }

    c.fillStyle = "#FFD156";
    c.fillRect(Math.round(playedX) - 0.5, 0, 1.5, h);
  }, [track, status, position, duration, engine.loader]);

  function seekFromEvent(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    seek(frac * duration);
  }

  if (!track) return null;

  return (
    <div className="glass rounded-lg px-3 py-2 flex items-center gap-3 animate-fade-in">
      <Button
        variant={playing ? "secondary" : "primary"}
        size="icon"
        className="h-8 w-8 shrink-0"
        disabled={status !== "ready"}
        onClick={() => (playing ? pause() : void startAt(pausedPosRef.current))}
        title={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>

      <div className="min-w-0 w-[220px] shrink-0">
        <div className="text-xs font-medium truncate" title={track.name}>
          {track.name}
        </div>
        <div className="text-[10px] text-muted-foreground truncate flex items-center gap-1.5">
          <span className="truncate">{track.artist}</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="tabular-nums">{formatBpm(track.bpm)}</span>
          <KeyChip camelot={track.camelot} raw={track.tonality} />
        </div>
      </div>

      <span className="font-mono tabular-nums text-xs text-foreground w-[52px] text-right shrink-0">
        {formatTime(position)}
      </span>

      <div className="relative flex-1 min-w-0 h-9">
        <canvas
          ref={canvasRef}
          className={cn(
            "w-full h-full rounded",
            status === "ready" ? "cursor-pointer" : "cursor-default",
          )}
          onMouseDown={(e) => {
            if (status !== "ready") return;
            draggingRef.current = true;
            seekFromEvent(e);
          }}
          onMouseMove={(e) => {
            if (draggingRef.current && e.buttons === 1) seekFromEvent(e);
          }}
          onMouseUp={() => (draggingRef.current = false)}
          onMouseLeave={() => (draggingRef.current = false)}
        />
        {status === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground animate-pulse pointer-events-none">
            Decoding…
          </div>
        )}
        {status === "error" && (
          <div
            className="absolute inset-0 flex items-center justify-center text-[11px] text-red-300 font-mono truncate px-2 pointer-events-none"
            title={err ?? undefined}
          >
            Couldn't decode: {err}
          </div>
        )}
      </div>

      <span className="font-mono tabular-nums text-xs text-muted-foreground w-[52px] shrink-0">
        {formatTime(duration)}
      </span>

      <label className="flex items-center gap-1.5 shrink-0" title="Preview volume">
        <Volume2 className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="range"
          className="h-1 w-20 accent-iris-500 cursor-ew-resize"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label="Preview volume"
        />
      </label>

      {onAddToCompose && (
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2 text-[11px] shrink-0"
          onClick={() => onAddToCompose(track)}
          title="Add this track as a lane in the composer"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Add to Compose
        </Button>
      )}

      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose} title="Close player">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
