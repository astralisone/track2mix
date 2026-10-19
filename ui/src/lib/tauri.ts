import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type UiTrack = {
  track_id: string;
  name: string;
  artist: string;
  genre: string;
  sub_genre: string | null;
  bpm: number | null;
  tonality: string;
  camelot: string | null;
  energy_raw: number | null;
  energy: number | null; // 0–10
  file_path: string | null;
};

export type LibrarySummary = {
  db_path: string;
  total: number;
  analyzed: number;
  distinct_genres: number;
  avg_bpm: number | null;
  min_energy: number | null;
  max_energy: number | null;
};

export type LibraryPayload = {
  summary: LibrarySummary;
  tracks: UiTrack[];
};

export async function defaultDbPath(): Promise<string> {
  return invoke<string>("default_db_path");
}

export async function openLibrary(dbPath: string): Promise<LibraryPayload> {
  return invoke<LibraryPayload>("open_library", { dbPath });
}

export type CompatArgs = {
  track_id: string;
  bpm_tol: number;
  any_key: boolean;
  half_double_ok: boolean;
  limit: number;
};

export async function compat(args: CompatArgs): Promise<UiTrack[]> {
  return invoke<UiTrack[]>("compat", { args });
}

/** m3u8 = Rekordbox-ready with #EXTINF, m3u = plain paths only, txt = numbered tracklist. */
export type ExportFormat = "m3u8" | "m3u" | "txt";

export type ExportArgs = {
  path: string;
  playlist_name: string;
  track_ids: string[];
  /** Accepted for forward compatibility; the current backend always writes m3u8. */
  format?: ExportFormat;
};

/** Resolves to the number of tracks written. */
export async function exportPlaylist(args: ExportArgs): Promise<number> {
  return invoke<number>("export_playlist", { args });
}

/** Snapshot of the Rust-side player, emitted as `player:state`. */
export type PlayerState = {
  queue: string[]; // track ids
  index: number; // position in queue, -1 when idle
  playing: boolean;
  position: number; // seconds
  duration: number | null; // seconds
  volume: number; // 0..1
  /**
   * `<code>: <detail>` where code is one of nofile | nopath | decode |
   * device | seek | skipped. The UI maps on the code only.
   */
  error: string | null;
  /** Bumped once per processed command; ticks repeat the current value. */
  seq: number;
};

export async function playerPlay(trackIds: string[], startIndex = 0): Promise<void> {
  return invoke("player_play", { trackIds, startIndex });
}
export async function playerToggle(): Promise<void> {
  return invoke("player_toggle");
}
export async function playerNext(): Promise<void> {
  return invoke("player_next");
}
export async function playerPrev(): Promise<void> {
  return invoke("player_prev");
}
export async function playerSeek(secs: number): Promise<void> {
  return invoke("player_seek", { secs });
}
export async function playerVolume(v: number): Promise<void> {
  return invoke("player_volume", { v });
}
export async function playerStop(): Promise<void> {
  return invoke("player_stop");
}
export async function playerStatus(): Promise<PlayerState> {
  return invoke<PlayerState>("player_status");
}

export async function onPlayerState(
  handler: (s: PlayerState) => void,
): Promise<UnlistenFn> {
  return listen<PlayerState>("player:state", (e) => handler(e.payload));
}

export type AnalyzeArgs = {
  xml_path: string;
  db_path: string;
  limit?: number | null;
  skip_analyzed?: boolean;
  dry_run?: boolean;
};

export type AnalyzeSummary = {
  ok: number;
  failed: number;
  skipped_already_analyzed: number;
  dropped: {
    no_location: number;
    unparseable_uri: number;
    missing_file: number;
    missing_examples: string[];
  };
  elapsed_secs: number;
  total_considered: number;
  db_path: string;
};

export type ProgressEvent =
  | { kind: "parsed"; total_in_xml: number }
  | {
      kind: "resolved";
      ready: number;
      no_location: number;
      unparseable_uri: number;
      missing_file: number;
      missing_examples: string[];
      already_analyzed: number;
    }
  | {
      kind: "track";
      done: number;
      total: number;
      name: string;
      artist: string;
    }
  | { kind: "failed"; name: string; error: string };

export async function analyzeXml(args: AnalyzeArgs): Promise<AnalyzeSummary> {
  return invoke<AnalyzeSummary>("analyze_xml", { args });
}

export async function onAnalyzeProgress(
  handler: (ev: ProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<ProgressEvent>("analyze:progress", (e) => handler(e.payload));
}

// ---- Playback / composition -------------------------------------------

/** Raw bytes of a library track's audio file, for `decodeAudioData`. */
export async function readTrackAudio(trackId: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_track_audio", { trackId });
}

/**
 * Fallback decode on the Rust side (Symphonia) when the webview's decoder
 * rejects a file. Payload: `u32 LE sample_rate` then f32 LE mono samples.
 */
export async function decodeTrackPcm(
  trackId: string,
  sampleRate = 44_100,
): Promise<{ sampleRate: number; samples: Float32Array }> {
  const buf = await invoke<ArrayBuffer>("decode_track_pcm", {
    trackId,
    sampleRate,
  });
  if (buf.byteLength < 4) {
    throw new Error(`decode_track_pcm returned ${buf.byteLength} bytes (expected a sample-rate header)`);
  }
  const view = new DataView(buf);
  const sr = view.getUint32(0, true);
  // Copy so the Float32Array is aligned regardless of how the buffer arrived.
  const samples = new Float32Array((buf.byteLength - 4) / 4);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getFloat32(4 + i * 4, true);
  }
  return { sampleRate: sr, samples };
}

export type RenderFormat = "wav" | "mp3";

export type RenderOptions = {
  /** MP3 only; rounded to the nearest LAME CBR rate. Default 320. */
  bitrate?: number;
  /** ID3 tags, MP3 only. */
  title?: string;
  artist?: string;
};

/**
 * Write a render (always handed over as WAV) to `path`, chosen through the
 * save dialog. A `.mp3` path is transcoded on the Rust side; a `.wav` path
 * gets the bytes as they are. Resolves to the bytes written.
 */
export async function writeRecording(
  path: string,
  wav: ArrayBuffer,
  opts: RenderOptions = {},
): Promise<number> {
  const headers: Record<string, string> = { "x-path": encodeURIComponent(path) };
  if (opts.bitrate) headers["x-bitrate"] = String(Math.round(opts.bitrate));
  if (opts.title) headers["x-title"] = encodeURIComponent(opts.title);
  if (opts.artist) headers["x-artist"] = encodeURIComponent(opts.artist);
  return invoke<number>("write_recording", new Uint8Array(wav), { headers });
}

// ---- Composition project files -----------------------------------------

/** Contents of a `.t2m` project; parse with `parseProject`. */
export async function readProject(path: string): Promise<string> {
  return invoke<string>("read_project", { path });
}

/** Write a serialized project to a `.t2m` path. Resolves to the bytes written. */
export async function writeProject(path: string, contents: string): Promise<number> {
  return invoke<number>("write_project", { path, contents });
}
