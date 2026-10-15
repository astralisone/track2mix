use track2mix_core::analyze::{self, lock, AnalyzeOptions, AnalyzeSummary, RunOptions};
use track2mix_core::export::{
    energy_score as energy_score_fn, write_playlist, ExportFormat, ExportOptions, ExportReport,
};
use track2mix_core::keys::Camelot;
use track2mix_core::scan::{scan_dirs, ScanOptions};
use track2mix_core::serato;
use track2mix_core::source::Imported;
use track2mix_core::store::{Store, TrackRow};
use track2mix_core::traktor::{self, TraktorOptions};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Emitter;

/// The data we ship to the frontend. `TrackRow` is already serde-friendly but
/// we add the 0–10 energy score and a parsed Camelot string so the UI doesn't
/// have to parse tonality itself.
#[derive(Debug, Clone, Serialize)]
pub struct UiTrack {
    pub track_id: String,
    pub name: String,
    pub artist: String,
    pub genre: String,
    pub sub_genre: Option<String>,
    pub bpm: Option<f32>,
    pub tonality: String,
    pub camelot: Option<String>,
    pub energy_raw: Option<f32>,
    pub energy: Option<u8>,
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibrarySummary {
    pub db_path: String,
    pub total: i64,
    pub analyzed: i64,
    pub distinct_genres: i64,
    pub avg_bpm: Option<f32>,
    pub min_energy: Option<f32>,
    pub max_energy: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryPayload {
    pub summary: LibrarySummary,
    pub tracks: Vec<UiTrack>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompatArgs {
    pub track_id: String,
    pub bpm_tol: f32,
    pub any_key: bool,
    pub half_double_ok: bool,
    pub limit: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportArgs {
    pub path: String,
    pub playlist_name: String,
    pub track_ids: Vec<String>,
    /// "m3u8" | "traktor" | "serato". Inferred from the file extension if absent.
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub traktor_volume: Option<String>,
    #[serde(default)]
    pub serato_root: Option<String>,
    /// `[old, new]` path prefix rewrites applied to the exported file.
    #[serde(default)]
    pub path_map: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlaylistInfo {
    pub name: String,
    pub source: String,
    pub count: i64,
}

/// App state: the open DB connection and the cached library min/max energy
/// (used to compute the 0–10 display score without a round-trip per track).
pub struct AppState {
    inner: Mutex<Option<StateInner>>,
}

struct StateInner {
    db_path: PathBuf,
    store: Store,
    min_energy: f32,
    max_energy: f32,
    cache: Vec<TrackRow>,
}

impl Default for AppState {
    fn default() -> Self {
        Self { inner: Mutex::new(None) }
    }
}

fn map_track(t: &TrackRow, emin: f32, emax: f32) -> UiTrack {
    let camelot = Camelot::parse(&t.tonality).map(|c| c.to_string());
    UiTrack {
        track_id: t.track_id.clone(),
        name: t.name.clone(),
        artist: t.artist.clone(),
        genre: t.genre.clone(),
        sub_genre: t.sub_genre.clone(),
        bpm: t.bpm.filter(|v| *v > 0.0),
        tonality: t.tonality.clone(),
        camelot,
        energy_raw: t.energy,
        energy: t.energy.map(|e| energy_score_fn(e, emin, emax)),
        file_path: t.file_path.clone(),
    }
}

#[tauri::command(async)]
fn open_library(state: tauri::State<'_, AppState>, db_path: String) -> Result<LibraryPayload, String> {
    let path = PathBuf::from(&db_path);
    let store = Store::open(&path).map_err(|e| format!("open {}: {:#}", db_path, e))?;
    let stats = store.stats().map_err(|e| format!("stats: {:#}", e))?;
    let tracks = store.list_all().map_err(|e| format!("list: {:#}", e))?;

    let emin = stats.min_energy.unwrap_or(0.0);
    let emax = stats.max_energy.unwrap_or(1.0);

    let ui_tracks: Vec<UiTrack> = tracks.iter().map(|t| map_track(t, emin, emax)).collect();

    let summary = LibrarySummary {
        db_path: path.display().to_string(),
        total: stats.total,
        analyzed: stats.analyzed,
        distinct_genres: stats.distinct_genres,
        avg_bpm: stats.avg_bpm,
        min_energy: stats.min_energy,
        max_energy: stats.max_energy,
    };

    *lock(&state.inner) = Some(StateInner {
        db_path: path,
        store,
        min_energy: emin,
        max_energy: emax,
        cache: tracks,
    });

    Ok(LibraryPayload {
        summary,
        tracks: ui_tracks,
    })
}

#[tauri::command(async)]
fn compat(state: tauri::State<'_, AppState>, args: CompatArgs) -> Result<Vec<UiTrack>, String> {
    let guard = lock(&state.inner);
    let s = guard.as_ref().ok_or_else(|| "no library open".to_string())?;
    let anchor = s
        .cache
        .iter()
        .find(|t| t.track_id == args.track_id)
        .ok_or_else(|| format!("track not found: {}", args.track_id))?
        .clone();
    let anchor_bpm = anchor.bpm.ok_or_else(|| "anchor has no BPM".to_string())?;
    let anchor_camelot = Camelot::parse(&anchor.tonality);

    let mut ranges = vec![(anchor_bpm - args.bpm_tol, anchor_bpm + args.bpm_tol)];
    if args.half_double_ok {
        let half = anchor_bpm / 2.0;
        let dbl = anchor_bpm * 2.0;
        ranges.push((half - args.bpm_tol, half + args.bpm_tol));
        ranges.push((dbl - args.bpm_tol, dbl + args.bpm_tol));
    }

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut pool: Vec<TrackRow> = Vec::new();
    for (lo, hi) in ranges {
        let rows = s
            .store
            .in_bpm_range(lo, hi, &anchor.track_id)
            .map_err(|e| format!("bpm query: {:#}", e))?;
        for t in rows {
            if seen.insert(t.track_id.clone()) {
                pool.push(t);
            }
        }
    }

    let apply_key_filter = !args.any_key && anchor_camelot.is_some();
    let mut compatible: Vec<TrackRow> = pool
        .into_iter()
        .filter(|t| {
            if !apply_key_filter {
                return true;
            }
            let anchor_c = anchor_camelot.unwrap();
            match Camelot::parse(&t.tonality) {
                Some(c) => anchor_c.compatible(&c),
                None => false,
            }
        })
        .collect();

    compatible.sort_by(|a, b| {
        let ae = a.energy.unwrap_or(0.0);
        let be = b.energy.unwrap_or(0.0);
        be.partial_cmp(&ae).unwrap_or(std::cmp::Ordering::Equal)
    });
    compatible.truncate(args.limit);

    Ok(compatible
        .iter()
        .map(|t| map_track(t, s.min_energy, s.max_energy))
        .collect())
}

#[tauri::command(async)]
fn export_playlist(
    state: tauri::State<'_, AppState>,
    args: ExportArgs,
) -> Result<ExportReport, String> {
    let guard = lock(&state.inner);
    let s = guard.as_ref().ok_or_else(|| "no library open".to_string())?;
    let by_id: std::collections::HashMap<&str, &TrackRow> =
        s.cache.iter().map(|t| (t.track_id.as_str(), t)).collect();
    let selected: Vec<TrackRow> = args
        .track_ids
        .iter()
        .filter_map(|id| by_id.get(id.as_str()).map(|t| (*t).clone()))
        .collect();
    if selected.is_empty() {
        return Err("no tracks selected".to_string());
    }
    let out = std::path::Path::new(&args.path);
    let format = match args.format.as_deref() {
        Some(f) => ExportFormat::parse(f).ok_or_else(|| format!("unknown export format `{}`", f))?,
        None => ExportFormat::from_extension(out).unwrap_or(ExportFormat::M3u8),
    };
    let opts = ExportOptions {
        traktor_volume: args.traktor_volume.filter(|v| !v.trim().is_empty()),
        serato_root: args
            .serato_root
            .filter(|v| !v.trim().is_empty())
            .map(PathBuf::from),
        path_map: args.path_map,
    };
    write_playlist(format, out, &args.playlist_name, &selected, &opts)
        .map_err(|e| format!("export: {:#}", e))
}

#[tauri::command(async)]
fn list_playlists(state: tauri::State<'_, AppState>) -> Result<Vec<PlaylistInfo>, String> {
    let guard = lock(&state.inner);
    let s = guard.as_ref().ok_or_else(|| "no library open".to_string())?;
    let lists = s
        .store
        .list_playlists()
        .map_err(|e| format!("playlists: {:#}", e))?;
    Ok(lists
        .into_iter()
        .map(|(name, source, count)| PlaylistInfo { name, source, count })
        .collect())
}

#[tauri::command(async)]
fn playlist_track_ids(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<Vec<String>, String> {
    let guard = lock(&state.inner);
    let s = guard.as_ref().ok_or_else(|| "no library open".to_string())?;
    let rows = s
        .store
        .playlist_rows(&name)
        .map_err(|e| format!("playlist: {:#}", e))?;
    Ok(rows.into_iter().map(|r| r.track_id).collect())
}

#[derive(Debug, Clone, Deserialize)]
pub struct AnalyzeArgs {
    pub xml_path: String,
    pub db_path: String,
    pub limit: Option<usize>,
    #[serde(default)]
    pub skip_analyzed: bool,
    #[serde(default)]
    pub dry_run: bool,
}

#[tauri::command]
async fn analyze_xml(
    app: tauri::AppHandle,
    args: AnalyzeArgs,
) -> Result<AnalyzeSummary, String> {
    let opts = AnalyzeOptions {
        xml_path: PathBuf::from(&args.xml_path),
        db_path: PathBuf::from(&args.db_path),
        limit: args.limit,
        skip_analyzed: args.skip_analyzed,
        dry_run: args.dry_run,
        path_map: Vec::new(),
    };

    tauri::async_runtime::spawn_blocking(move || {
        analyze::run(opts, move |ev| {
            let _ = app.emit("analyze:progress", ev);
        })
        .map_err(|e| format!("{:#}", e))
    })
    .await
    .map_err(|e| format!("analyze task join failed: {}", e))?
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScanArgs {
    pub dirs: Vec<String>,
    pub db_path: String,
    #[serde(default)]
    pub skip_analyzed: bool,
    /// Fill in missing BPM / key from the audio. On by default.
    #[serde(default = "yes")]
    pub estimate_missing: bool,
    #[serde(default)]
    pub max_depth: Option<usize>,
}

fn yes() -> bool {
    true
}

#[tauri::command]
async fn scan_folders(app: tauri::AppHandle, args: ScanArgs) -> Result<AnalyzeSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dirs: Vec<PathBuf> = args.dirs.iter().map(PathBuf::from).collect();
        let scanned = scan_dirs(
            &dirs,
            &ScanOptions {
                max_depth: args.max_depth,
            },
        );
        if scanned.tracks.is_empty() {
            return Err(if scanned.bad_roots.is_empty() {
                "No audio files found in the chosen folder(s).".to_string()
            } else {
                format!("Not a folder: {}", scanned.bad_roots.join(", "))
            });
        }
        let total = scanned.tracks.len();
        let imported = Imported {
            tracks: scanned.tracks,
            ..Default::default()
        };
        let opts = RunOptions {
            db_path: PathBuf::from(&args.db_path),
            limit: None,
            skip_analyzed: args.skip_analyzed,
            dry_run: false,
            path_map: Vec::new(),
            estimate_missing: args.estimate_missing,
            threads: None,
        };
        analyze::run_imported(imported, total, &opts, move |ev| {
            let _ = app.emit("analyze:progress", ev);
        })
        .map_err(|e| format!("{:#}", e))
    })
    .await
    .map_err(|e| format!("scan task join failed: {}", e))?
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportArgs {
    /// "traktor" | "serato"
    pub kind: String,
    /// collection.nml, or a `_Serato_` folder / `.crate` / `database V2`.
    pub path: String,
    pub db_path: String,
    #[serde(default)]
    pub skip_analyzed: bool,
    #[serde(default = "yes")]
    pub estimate_missing: bool,
    /// Serato: drive root the stored relative paths are anchored at.
    #[serde(default)]
    pub root: Option<String>,
    /// Traktor: macOS boot volume name in the NML.
    #[serde(default)]
    pub boot_volume: Option<String>,
    #[serde(default)]
    pub path_map: Vec<(String, String)>,
}

#[tauri::command]
async fn import_library(app: tauri::AppHandle, args: ImportArgs) -> Result<AnalyzeSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&args.path);
        let imported = match args.kind.as_str() {
            "traktor" => {
                let mut o = TraktorOptions::default();
                if let Some(v) = args.boot_volume.as_deref().filter(|v| !v.trim().is_empty()) {
                    o.boot_volume = v.to_string();
                }
                traktor::read_nml(&path, &o)
            }
            "serato" => {
                let root = args.root.as_deref().filter(|v| !v.trim().is_empty()).map(PathBuf::from);
                serato::read_serato(&path, root.as_deref())
            }
            other => Err(anyhow::anyhow!("unknown library type `{}`", other)),
        }
        .map_err(|e| format!("{:#}", e))?;
        let total = imported.tracks.len() + imported.no_location + imported.unparseable_uri;
        let opts = RunOptions {
            db_path: PathBuf::from(&args.db_path),
            limit: None,
            skip_analyzed: args.skip_analyzed,
            dry_run: false,
            path_map: args.path_map,
            estimate_missing: args.estimate_missing,
            threads: None,
        };
        analyze::run_imported(imported, total, &opts, move |ev| {
            let _ = app.emit("analyze:progress", ev);
        })
        .map_err(|e| format!("{:#}", e))
    })
    .await
    .map_err(|e| format!("import task join failed: {}", e))?
}

#[tauri::command]
fn default_db_path() -> String {
    // Heuristic: cwd/library.db. Falls back to ~/library.db.
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("library.db");
        if p.exists() {
            return p.display().to_string();
        }
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        return PathBuf::from(home).join("library.db").display().to_string();
    }
    "library.db".to_string()
}

/// WebKitGTK's DMA-BUF renderer is the usual cause of blank, frozen or
/// crashing windows on Wayland compositors (Hyprland, Sway) and NVIDIA GPUs.
/// Opt out of it unless the user has chosen otherwise.
#[cfg(target_os = "linux")]
fn linux_webkit_defaults() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn linux_webkit_defaults() {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    linux_webkit_defaults();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_library,
            compat,
            export_playlist,
            default_db_path,
            analyze_xml,
            scan_folders,
            import_library,
            list_playlists,
            playlist_track_ids
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
