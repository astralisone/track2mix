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
  format: ExportFormat;
};

/** `written` can be below `requested`: playlist formats skip tracks with no file path. */
export type ExportResult = { written: number; requested: number };

export async function exportPlaylist(args: ExportArgs): Promise<ExportResult> {
  return invoke<ExportResult>("export_playlist", { args });
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
