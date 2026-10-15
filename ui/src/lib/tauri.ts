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

export type ExportFormat = "m3u8" | "traktor" | "serato";

export type ExportArgs = {
  path: string;
  playlist_name: string;
  track_ids: string[];
  format?: ExportFormat;
  /** Traktor: volume name for paths not under /Volumes/<disk> or a drive letter. */
  traktor_volume?: string;
  /** Serato: drive root the crate's relative paths are anchored at. */
  serato_root?: string;
  /** [old, new] path-prefix rewrites applied to the exported file. */
  path_map?: Array<[string, string]>;
};

export type ExportReport = {
  written: number;
  /** Tracks left out: no file path, or outside the Serato root. */
  skipped: number;
};

export async function exportPlaylist(args: ExportArgs): Promise<ExportReport> {
  return invoke<ExportReport>("export_playlist", { args });
}

export type PlaylistInfo = {
  name: string;
  source: string;
  count: number;
};

export async function listPlaylists(): Promise<PlaylistInfo[]> {
  return invoke<PlaylistInfo[]>("list_playlists");
}

export async function playlistTrackIds(name: string): Promise<string[]> {
  return invoke<string[]>("playlist_track_ids", { name });
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
  /** BPM / key values filled in from the audio because tags had none. */
  estimated_bpm: number;
  estimated_key: number;
  /** Playlists / crates saved from Traktor or Serato. */
  playlists: number;
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

export type ScanArgs = {
  dirs: string[];
  db_path: string;
  skip_analyzed?: boolean;
  estimate_missing?: boolean;
  max_depth?: number | null;
};

export async function scanFolders(args: ScanArgs): Promise<AnalyzeSummary> {
  return invoke<AnalyzeSummary>("scan_folders", { args });
}

export type ImportKind = "traktor" | "serato";

export type ImportArgs = {
  kind: ImportKind;
  /** collection.nml, or a Serato `_Serato_` folder / .crate / `database V2`. */
  path: string;
  db_path: string;
  skip_analyzed?: boolean;
  estimate_missing?: boolean;
  /** Serato: drive root stored relative paths are anchored at. */
  root?: string;
  /** Traktor: macOS boot volume name in the NML. */
  boot_volume?: string;
  path_map?: Array<[string, string]>;
};

export async function importLibrary(args: ImportArgs): Promise<AnalyzeSummary> {
  return invoke<AnalyzeSummary>("import_library", { args });
}

export async function onAnalyzeProgress(
  handler: (ev: ProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<ProgressEvent>("analyze:progress", (e) => handler(e.payload));
}
