/**
 * Answers Tauri IPC in a plain browser, for Flute capture only.
 *
 * Flute drives the app through a normal Vite dev server, where the Tauri
 * runtime does not exist and every `invoke` rejects. Rather than fake the UI,
 * this installs the transport Tauri itself uses — `window.__TAURI_INTERNALS__`
 * — and answers the four commands from a fixture exported out of a real
 * analysed library.
 *
 * The consequence is that every component, every hook and the real
 * ui/src/lib/tauri.ts code path run exactly as they do in the shipped app.
 * Only the wire underneath is local. Nothing here is imported by the
 * production bundle: it is reached solely from a scene module, which itself
 * only loads in a dev build.
 */
import library from "./fixtures/library.json";

type Handler = (args: Record<string, unknown>) => unknown;

function camelotNeighbours(key: string): Set<string> {
  const m = /^(\d{1,2})([AB])$/.exec(key);
  if (!m) return new Set([key]);
  const n = Number(m[1]);
  const letter = m[2];
  const wrap = (v: number) => ((v - 1 + 12) % 12) + 1;
  return new Set([
    `${n}${letter}`,
    `${wrap(n - 1)}${letter}`,
    `${wrap(n + 1)}${letter}`,
    `${n}${letter === "A" ? "B" : "A"}`,
  ]);
}

const handlers: Record<string, Handler> = {
  default_db_path: () => library.summary.db_path,

  open_library: () => library,

  /**
   * Mirrors the Rust `compat` rules: harmonic neighbours on the Camelot wheel
   * within the BPM tolerance, optionally half/double time, ranked by energy.
   */
  compat: (payload) => {
    const args = (payload.args ?? payload) as {
      track_id: string;
      bpm_tol: number;
      any_key: boolean;
      half_double_ok: boolean;
      limit: number;
    };
    const anchor = library.tracks.find((t) => t.track_id === args.track_id);
    if (!anchor?.bpm) return [];

    const ok = anchor.camelot ? camelotNeighbours(anchor.camelot) : null;
    const tempoMatches = (bpm: number) => {
      const candidates = args.half_double_ok
        ? [bpm, bpm * 2, bpm / 2]
        : [bpm];
      return candidates.some((c) => Math.abs(c - anchor.bpm!) <= args.bpm_tol);
    };

    return library.tracks
      .filter((t) => t.track_id !== anchor.track_id)
      .filter((t) => t.bpm != null && tempoMatches(t.bpm))
      .filter((t) => args.any_key || !ok || (t.camelot ? ok.has(t.camelot) : false))
      .sort((a, b) => (b.energy ?? 0) - (a.energy ?? 0))
      .slice(0, args.limit);
  },

  // Capture never writes a file; returning the count keeps the UI's success
  // path honest rather than throwing mid-shot.
  export_playlist: (payload) => {
    const args = (payload.args ?? payload) as { track_ids: string[] };
    return args.track_ids.length;
  },
};

export function installTauriStub() {
  const w = window as unknown as Record<string, unknown>;
  if (w.__TAURI_INTERNALS__) return; // a real Tauri runtime always wins

  w.__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => cb,
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      const handler = handlers[cmd];
      if (!handler) {
        // Loud, not silent: an unhandled command means the fixture has fallen
        // behind the Rust command surface.
        throw new Error(
          `Flute Tauri stub has no handler for "${cmd}". Add one in ui/src/flute/tauri-stub.ts.`,
        );
      }
      return handler(args);
    },
  };
}
