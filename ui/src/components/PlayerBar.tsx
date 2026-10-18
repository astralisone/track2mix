import * as React from "react";
import * as Slider from "@radix-ui/react-slider";
import {
  AlertTriangle,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { cn, formatBpm } from "@/lib/utils";
import { formatTime, usePlayer, usePlayerPosition, usePlayerProgress } from "@/lib/player";
import { playerVolume } from "@/lib/tauri";
import { KeyChip } from "./KeyChip";

type Props = {
  variant?: "dock" | "inline";
  onClose?: () => void;
};

export function PlayerBar({ variant = "dock", onClose }: Props) {
  const player = usePlayer();
  const { state, current } = player;
  const progress = usePlayerProgress();
  const position = usePlayerPosition();
  const inline = variant === "inline";

  // Local scrub state: the thumb follows the pointer, seek fires on release.
  const [scrub, setScrub] = React.useState<number | null>(null);

  if (state.queue.length === 0 || state.index < 0) {
    if (!inline) return null;
    return (
      <div className="flex items-center gap-2 rounded-md glass-subtle px-3 py-2 text-xs text-muted-foreground">
        <Play className="h-3.5 w-3.5 opacity-60" />
        Nothing playing — press play on a track to preview it.
      </div>
    );
  }

  const duration = progress.duration;
  const canSeek = duration != null && duration > 0;
  const shown = scrub ?? position;
  const queueLabel = `${state.index + 1} / ${state.queue.length}`;
  const title = current?.name || "Unknown track";
  const artist = current?.artist ?? "";

  const close = () => {
    player.stop();
    onClose?.();
  };

  const plus30 = () => {
    const target = position + 30;
    player.seek(canSeek ? Math.min(target, duration - 0.5) : target);
  };

  const transport = (
    <div className="flex items-center gap-1">
      <IconButton label="Previous track" onClick={player.prev} small={inline}>
        <SkipBack className={inline ? "h-3.5 w-3.5" : "h-4 w-4"} />
      </IconButton>
      <button
        type="button"
        aria-label={state.playing ? "Pause" : "Play"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={player.toggle}
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-iris-500/90 text-white shadow-glow-iris-sm hover:bg-iris-500 hover:shadow-glow-iris active:scale-95 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-iris-500/60",
          inline ? "h-8 w-8" : "h-10 w-10",
        )}
      >
        {state.playing ? (
          <Pause className={inline ? "h-3.5 w-3.5" : "h-4 w-4"} fill="currentColor" />
        ) : (
          <Play
            className={cn(inline ? "h-3.5 w-3.5" : "h-4 w-4", "translate-x-[1px]")}
            fill="currentColor"
          />
        )}
      </button>
      <IconButton label="Next track" onClick={player.next} small={inline}>
        <SkipForward className={inline ? "h-3.5 w-3.5" : "h-4 w-4"} />
      </IconButton>
    </div>
  );

  const scrubber = (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatTime(shown)}
      </span>
      <Slider.Root
        className="relative flex h-4 flex-1 touch-none select-none items-center data-[disabled]:opacity-40"
        min={0}
        max={canSeek ? duration : 1}
        step={0.1}
        value={[canSeek ? Math.min(shown, duration) : 0]}
        disabled={!canSeek}
        onValueChange={([v]) => setScrub(v)}
        onValueCommit={([v]) => {
          setScrub(null);
          player.seek(v);
        }}
        aria-label="Seek"
      >
        <Slider.Track className="relative h-1 grow overflow-hidden rounded-full bg-white/10">
          <Slider.Range className="absolute h-full rounded-full bg-gradient-to-r from-iris-500 to-iris-300" />
        </Slider.Track>
        <Slider.Thumb
          className="block h-3 w-3 rounded-full bg-white shadow-glow-iris-sm transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-iris-500/60"
          aria-label="Playback position"
        />
      </Slider.Root>
      <span className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatTime(duration)}
      </span>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={plus30}
        disabled={!canSeek}
        title="Skip ahead 30 seconds"
        className="shrink-0 rounded-sm border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-iris-500/60 hover:text-white disabled:opacity-40 disabled:pointer-events-none transition-colors"
      >
        +30s
      </button>
    </div>
  );

  const meta = (
    <div className="flex min-w-0 items-center gap-3">
      <EqualizerIcon playing={state.playing} className="shrink-0" />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-white" title={title}>
          {title}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{artist || "—"}</span>
        </div>
      </div>
      {current && (
        <div className="flex shrink-0 items-center gap-2">
          <KeyChip camelot={current.camelot} raw={current.tonality} />
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatBpm(current.bpm)}
            <span className="ml-0.5 text-muted-foreground/60">bpm</span>
          </span>
        </div>
      )}
    </div>
  );

  const errorLine = state.error ? (
    <div
      role="alert"
      className="flex items-center gap-1.5 text-xs text-red-300"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate" title={state.error}>
        {state.error}
      </span>
    </div>
  ) : null;

  if (inline) {
    return (
      <div className="flex flex-col gap-2 rounded-md glass-subtle px-3 py-2.5 animate-fade-in">
        <div className="flex items-center gap-3">
          {transport}
          <div className="min-w-0 flex-1">{meta}</div>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80">
            {queueLabel}
          </span>
          <IconButton label="Stop and close player" onClick={close} small>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
        <div className="flex items-center gap-3">
          {scrubber}
          <VolumeControl compact />
        </div>
        {errorLine}
      </div>
    );
  }

  return (
    <div className="glass rounded-lg px-4 py-3 animate-fade-in">
      <div className="grid grid-cols-[minmax(220px,1fr)_auto_minmax(260px,1.6fr)_auto] items-center gap-5">
        {meta}
        {transport}
        {scrubber}
        <div className="flex items-center gap-3">
          <VolumeControl />
          <span
            className="font-mono text-[11px] tabular-nums text-muted-foreground/80"
            title="Position in queue"
          >
            {queueLabel}
          </span>
          <IconButton label="Stop and close player" onClick={close}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      {errorLine && <div className="mt-2">{errorLine}</div>}
    </div>
  );
}

function VolumeControl({ compact = false }: { compact?: boolean }) {
  const { setVolume } = usePlayer();
  const { volume: liveVolume } = usePlayerProgress();
  // Local draft while dragging; live updates go straight to Rust, throttled
  // to one per animation frame (~20-60 Hz), and the final value is committed
  // through setVolume (optimistic + seq-tracked).
  const [draft, setDraft] = React.useState<number | null>(null);
  const volume = draft ?? liveVolume;
  const pendingVol = React.useRef<number | null>(null);
  const raf = React.useRef<number | null>(null);
  const lastSent = React.useRef(0);
  const lastNonZero = React.useRef(liveVolume || 0.8);
  if (volume > 0) lastNonZero.current = volume;

  React.useEffect(
    () => () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const flush = () => {
    raf.current = null;
    const v = pendingVol.current;
    if (v == null) return;
    const t = performance.now();
    if (t - lastSent.current < 50) {
      raf.current = requestAnimationFrame(flush);
      return;
    }
    pendingVol.current = null;
    lastSent.current = t;
    playerVolume(v).catch(() => {});
  };

  const onDrag = (v: number) => {
    setDraft(v);
    pendingVol.current = v;
    if (raf.current == null) raf.current = requestAnimationFrame(flush);
  };

  const onCommit = (v: number) => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    raf.current = null;
    pendingVol.current = null;
    setDraft(null);
    setVolume(v);
  };

  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        aria-label={volume === 0 ? "Unmute" : "Mute"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setVolume(volume === 0 ? lastNonZero.current : 0)}
        className="text-muted-foreground hover:text-white transition-colors"
      >
        <Icon className="h-4 w-4" />
      </button>
      <Slider.Root
        className={cn(
          "relative flex h-4 touch-none select-none items-center",
          compact ? "w-16" : "w-24",
        )}
        min={0}
        max={1}
        step={0.01}
        value={[volume]}
        onValueChange={([v]) => onDrag(v)}
        onValueCommit={([v]) => onCommit(v)}
        aria-label="Volume"
      >
        <Slider.Track className="relative h-1 grow overflow-hidden rounded-full bg-white/10">
          <Slider.Range className="absolute h-full rounded-full bg-white/60" />
        </Slider.Track>
        <Slider.Thumb
          className="block h-2.5 w-2.5 rounded-full bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-iris-500/60"
          aria-label="Volume"
        />
      </Slider.Root>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  small = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-white hover:bg-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-iris-500/60",
        small ? "h-7 w-7" : "h-8 w-8",
      )}
    >
      {children}
    </button>
  );
}

const EQ_KEYFRAMES = `@keyframes t2m-eq{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}`;

/** Small animated equalizer, used as a "now playing" indicator. */
export function EqualizerIcon({
  playing,
  className,
}: {
  playing: boolean;
  className?: string;
}) {
  const bars = [0, 0.25, 0.5];
  return (
    <span
      aria-hidden
      className={cn("inline-flex h-3.5 w-3.5 items-end gap-[2px]", className)}
    >
      <style>{EQ_KEYFRAMES}</style>
      {bars.map((delay, i) => (
        <span
          key={i}
          className="w-[3px] h-full origin-bottom rounded-[1px] bg-iris-300"
          style={
            playing
              ? { animation: `t2m-eq 0.9s ease-in-out ${-delay}s infinite` }
              : { transform: `scaleY(${[0.45, 0.8, 0.6][i]})` }
          }
        />
      ))}
    </span>
  );
}
