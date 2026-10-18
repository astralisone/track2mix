// Thin UI controller for the Rust-side audio player. Playback, decoding and
// the queue live in Rust; this module mirrors the `player:state` snapshots,
// applies optimistic updates so controls feel instant, and exposes the
// commands through React context.
//
// Two contexts:
//  - PlayerContext (usePlayer): actions + "slow" state (queue/index/playing/
//    error). Its identity does NOT change on position-only ticks, so table
//    rows and the builder don't re-render 4x a second.
//  - PlayerProgressContext (usePlayerProgress / usePlayerPosition): live
//    position, duration and volume. Only the PlayerBar reads it.
import * as React from "react";
import {
  onPlayerState,
  playerNext,
  playerPlay,
  playerPrev,
  playerSeek,
  playerStatus,
  playerStop,
  playerToggle,
  playerVolume,
  type PlayerState,
  type UiTrack,
} from "@/lib/tauri";

export const idlePlayerState: PlayerState = {
  queue: [],
  index: -1,
  playing: false,
  position: 0,
  duration: null,
  volume: 0.8,
  error: null,
  seq: 0,
};

export type PlayerApi = {
  /**
   * Slow-changing player state. `queue`, `index`, `playing` and `error` are
   * live. `position`, `duration`, `volume` and `seq` are snapshots taken when
   * one of the live fields last changed — NOT updated on progress ticks. Use
   * `usePlayerProgress()` / `usePlayerPosition()` for live values.
   * `error` is already a human-readable message (see describePlayerError).
   */
  state: PlayerState;
  /**
   * The track at `state.queue[state.index]`, resolved against the loaded
   * library. The queue may contain duplicate ids, so "current" is always
   * defined by the playing *slot*, never by searching the queue for an id.
   */
  current: UiTrack | null;
  /** `state.index >= 0 && state.queue[state.index] === trackId`. */
  isCurrent: (trackId: string) => boolean;
  /** Replace the queue with these ids and start at `startIndex` (default 0). */
  playTracks: (trackIds: string[], startIndex?: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (secs: number) => void;
  setVolume: (v: number) => void;
  stop: () => void;
};

export type PlayerProgress = {
  /** Seconds, exact as of `syncedAt`. Prefer usePlayerPosition() for display. */
  position: number;
  duration: number | null;
  volume: number;
  playing: boolean;
  /** `performance.now()` when `position` was last known exactly. */
  syncedAt: number;
};

const noop = () => {};

const PlayerContext = React.createContext<PlayerApi>({
  state: idlePlayerState,
  current: null,
  isCurrent: () => false,
  playTracks: noop,
  toggle: noop,
  next: noop,
  prev: noop,
  seek: noop,
  setVolume: noop,
  stop: noop,
});

const PlayerProgressContext = React.createContext<PlayerProgress>({
  position: 0,
  duration: null,
  volume: idlePlayerState.volume,
  playing: false,
  syncedAt: 0,
});

// ---- errors ---------------------------------------------------------------

const ERROR_CODES = ["nofile", "nopath", "decode", "device", "seek", "skipped"] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

function splitCode(msg: string): { code: ErrorCode; detail: string } | null {
  const i = msg.indexOf(":");
  const head = (i >= 0 ? msg.slice(0, i) : msg).trim().toLowerCase();
  if (!(ERROR_CODES as readonly string[]).includes(head)) return null;
  return { code: head as ErrorCode, detail: i >= 0 ? msg.slice(i + 1).trim() : "" };
}

function withDetail(base: string, detail: string): string {
  if (!detail) return base;
  const short = detail.length > 120 ? `${detail.slice(0, 117)}…` : detail;
  return `${base} (${short})`;
}

/**
 * Map a backend `<code>: <detail>` error to a human-readable message.
 * Strings without a known code are returned unchanged.
 */
export function describePlayerError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? "");
  const parsed = splitCode(msg);
  if (!parsed) return msg || "Playback failed.";
  const { code, detail } = parsed;
  switch (code) {
    case "nofile":
      return withDetail(
        "Audio file not found — it may have been moved, renamed or deleted",
        fileName(detail),
      );
    case "nopath":
      return "This track has no audio file linked in the library.";
    case "decode":
      return withDetail(
        "Couldn't decode this file — the format is unsupported or the file is damaged",
        detail,
      );
    case "device":
      return withDetail("No audio output device available", detail);
    case "seek":
      return "Couldn't seek in this file.";
    case "skipped": {
      const n = Number.parseInt(detail, 10);
      if (Number.isFinite(n)) {
        return `Skipped ${n} unplayable track${n === 1 ? "" : "s"}.`;
      }
      return "Skipped unplayable tracks.";
    }
  }
}

/** Errors from a rejected invoke: same codes, plus "command not found". */
function describeInvokeError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? "");
  if (/command\b.*\bnot found/i.test(msg)) {
    return "Playback is only available in the desktop app.";
  }
  return describePlayerError(msg);
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// ---- provider ---------------------------------------------------------------

/** How long optimistic state wins over stale ticks while awaiting a command's event. */
const PENDING_TIMEOUT_MS = 1000;

export function PlayerProvider({
  tracks,
  children,
}: {
  tracks: UiTrack[];
  children: React.ReactNode;
}) {
  const [backend, setBackend] = React.useState<PlayerState>(idlePlayerState);
  const [syncedAt, setSyncedAt] = React.useState<number>(() => now());
  const [localError, setLocalError] = React.useState<string | null>(null);

  // seq bookkeeping: highest seq applied, and the seq we're waiting for after
  // issuing commands (events below it are stale ticks and must not clobber
  // optimistic state).
  const lastSeq = React.useRef(-1);
  const pending = React.useRef<{ expect: number; until: number } | null>(null);

  const apply = React.useCallback((s: PlayerState) => {
    lastSeq.current = Math.max(lastSeq.current, s.seq);
    setBackend(s);
    setSyncedAt(now());
  }, []);

  const onEvent = React.useCallback(
    (s: PlayerState) => {
      const p = pending.current;
      if (p) {
        if (s.seq < p.expect && now() < p.until) return; // stale tick
        pending.current = null;
      }
      apply(s);
    },
    [apply],
  );

  // Initial snapshot + live subscription. Both may be unavailable when the UI
  // runs in a plain browser (vite dev), so failures are swallowed.
  React.useEffect(() => {
    let cancelled = false;
    let gotEvent = false;
    let unlisten: (() => void) | null = null;

    onPlayerState((s) => {
      gotEvent = true;
      if (!cancelled) onEvent(s);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    playerStatus()
      .then((s) => {
        // An event that already arrived is at least as fresh as this reply.
        if (!cancelled && !gotEvent) onEvent(s);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onEvent]);

  /** Register an outgoing command: wait for one more seq bump. */
  const expectEvent = React.useCallback(() => {
    const base = pending.current ? pending.current.expect : lastSeq.current;
    pending.current = { expect: base + 1, until: now() + PENDING_TIMEOUT_MS };
  }, []);

  // Wrap a command: clear the previous command error, surface a new one.
  const run = React.useCallback(
    (p: () => Promise<void>) => {
      setLocalError(null);
      expectEvent();
      const fail = (e: unknown) => {
        // A rejected command may not bump seq; stop shielding optimistic state.
        pending.current = null;
        setLocalError(describeInvokeError(e));
      };
      try {
        p().catch(fail);
      } catch (e) {
        fail(e);
      }
    },
    [expectEvent],
  );

  /** Optimistically patch the mirrored state; the command's event overwrites it. */
  const patch = React.useCallback((fn: (s: PlayerState) => PlayerState) => {
    setBackend((s) => fn(s));
    setSyncedAt(now());
  }, []);

  // Latest backend state + clock, so callbacks keep a stable identity.
  const live = React.useRef({ backend, syncedAt });
  live.current = { backend, syncedAt };

  const playTracks = React.useCallback(
    (trackIds: string[], startIndex = 0) => {
      if (trackIds.length === 0) return;
      const index = Math.max(0, Math.min(startIndex, trackIds.length - 1));
      patch((s) => ({
        ...s,
        queue: trackIds,
        index,
        playing: true,
        position: 0,
        duration: null,
        error: null,
      }));
      run(() => playerPlay(trackIds, index));
    },
    [patch, run],
  );

  const toggle = React.useCallback(() => {
    const { backend: s, syncedAt: at } = live.current;
    if (s.queue.length === 0) return;
    const position = interpolate(s.position, s.playing, s.duration, at);
    patch((cur) => ({ ...cur, playing: !cur.playing, position }));
    run(playerToggle);
  }, [patch, run]);

  const next = React.useCallback(() => run(playerNext), [run]);
  const prev = React.useCallback(() => run(playerPrev), [run]);

  const seek = React.useCallback(
    (secs: number) => {
      const s = live.current.backend;
      const max = s.duration ?? Number.POSITIVE_INFINITY;
      const target = Math.max(0, Math.min(secs, max));
      patch((cur) => ({ ...cur, position: target }));
      run(() => playerSeek(target));
    },
    [patch, run],
  );

  const setVolume = React.useCallback(
    (v: number) => {
      const vol = Math.max(0, Math.min(1, v));
      patch((cur) => ({ ...cur, volume: vol }));
      run(() => playerVolume(vol));
    },
    [patch, run],
  );

  const stop = React.useCallback(() => {
    patch((cur) => ({ ...idlePlayerState, volume: cur.volume, seq: cur.seq }));
    run(playerStop);
  }, [patch, run]);

  const byId = React.useMemo(() => {
    const m = new Map<string, UiTrack>();
    for (const t of tracks) m.set(t.track_id, t);
    return m;
  }, [tracks]);

  // Keep the queue array identity stable across ticks with equal contents.
  const queueRef = React.useRef<string[]>(backend.queue);
  if (!sameIds(queueRef.current, backend.queue)) queueRef.current = backend.queue;
  const queue = queueRef.current;
  const { index, playing } = backend;

  const error = localError ?? (backend.error ? describePlayerError(backend.error) : null);

  // Snapshot fields read via ref so they don't invalidate the memo.
  const state = React.useMemo<PlayerState>(() => {
    const b = live.current.backend;
    return {
      queue,
      index,
      playing,
      error,
      position: b.position,
      duration: b.duration,
      volume: b.volume,
      seq: b.seq,
    };
  }, [queue, index, playing, error]);

  const currentId = index >= 0 && index < queue.length ? queue[index] : null;
  const current = currentId ? (byId.get(currentId) ?? null) : null;

  // Duplicates allowed in the queue: compare against the slot at `index` only.
  const isCurrent = React.useCallback(
    (trackId: string) => index >= 0 && queue[index] === trackId,
    [index, queue],
  );

  const api = React.useMemo<PlayerApi>(
    () => ({
      state,
      current,
      isCurrent,
      playTracks,
      toggle,
      next,
      prev,
      seek,
      setVolume,
      stop,
    }),
    [state, current, isCurrent, playTracks, toggle, next, prev, seek, setVolume, stop],
  );

  const progress = React.useMemo<PlayerProgress>(
    () => ({
      position: backend.position,
      duration: backend.duration,
      volume: backend.volume,
      playing: backend.playing,
      syncedAt,
    }),
    [backend.position, backend.duration, backend.volume, backend.playing, syncedAt],
  );

  // Global Space-to-toggle.
  useSpaceToggle(api);

  return (
    <PlayerContext.Provider value={api}>
      <PlayerProgressContext.Provider value={progress}>
        {children}
      </PlayerProgressContext.Provider>
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerApi {
  return React.useContext(PlayerContext);
}

/** Live position/duration/volume. Re-renders on every backend tick. */
export function usePlayerProgress(): PlayerProgress {
  return React.useContext(PlayerProgressContext);
}

/**
 * Smoothly advancing playback position (seconds). The backend snapshot is
 * extrapolated locally while playing so the scrub bar moves between events.
 */
export function usePlayerPosition(): number {
  const p = usePlayerProgress();
  const [, force] = React.useReducer((x: number) => x + 1, 0);

  React.useEffect(() => {
    if (!p.playing) return;
    const id = window.setInterval(force, 250);
    return () => window.clearInterval(id);
  }, [p.playing]);

  return interpolate(p.position, p.playing, p.duration, p.syncedAt);
}

const IGNORE_SPACE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "[role=slider]",
  "[role=checkbox]",
  "[contenteditable]:not([contenteditable=false])",
].join(",");

/**
 * Register the global Space shortcut that toggles playback. Already called by
 * PlayerProvider; exported for completeness/testing.
 */
export function useSpaceToggle(api: Pick<PlayerApi, "state" | "toggle">) {
  const ref = React.useRef(api);
  ref.current = api;

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (e.defaultPrevented || e.repeat) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target;
      if (target instanceof Element && target.closest(IGNORE_SPACE_SELECTOR)) {
        return;
      }
      if (
        document.querySelector(
          "[role=dialog]:not([aria-hidden=true]),[role=alertdialog]:not([aria-hidden=true])",
        )
      ) {
        return;
      }
      const { state, toggle } = ref.current;
      if (state.queue.length === 0) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** Format seconds as m:ss (or h:mm:ss). */
export function formatTime(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs) || secs < 0) return "–:––";
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function interpolate(
  position: number,
  playing: boolean,
  duration: number | null,
  syncedAt: number,
): number {
  if (!playing) return position;
  const p = position + (now() - syncedAt) / 1000;
  return duration != null ? Math.min(p, duration) : p;
}

function sameIds(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export { PlayerContext };
