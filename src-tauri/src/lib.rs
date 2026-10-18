use track2mix_core::analyze::{self, AnalyzeOptions, AnalyzeSummary};
use track2mix_core::export::{energy_score as energy_score_fn, write_m3u8};
use track2mix_core::keys::Camelot;
use track2mix_core::store::{Store, TrackRow};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Emitter;

/// Playback / composition support. The webview decodes audio itself via
/// `decodeAudioData`; these commands only hand it bytes, and only for
/// tracks that exist in the open library (never arbitrary paths).
mod playback;

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

impl AppState {
    /// Resolve a library track id to its on-disk audio path. Used by the
    /// playback commands so the frontend can only ever request files the
    /// user already imported.
    pub(crate) fn file_path_for(&self, track_id: &str) -> Result<PathBuf, String> {
        let guard = self.inner.lock().unwrap();
        let s = guard.as_ref().ok_or_else(|| "no library open".to_string())?;
        let t = s
            .cache
            .iter()
            .find(|t| t.track_id == track_id)
            .ok_or_else(|| format!("track not found: {}", track_id))?;
        let p = t
            .file_path
            .as_deref()
            .ok_or_else(|| format!("track has no file path: {}", track_id))?;
        Ok(PathBuf::from(p))
    }
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

#[tauri::command]
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

    *state.inner.lock().unwrap() = Some(StateInner {
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

#[tauri::command]
fn compat(state: tauri::State<'_, AppState>, args: CompatArgs) -> Result<Vec<UiTrack>, String> {
    let guard = state.inner.lock().unwrap();
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

#[tauri::command]
fn export_playlist(state: tauri::State<'_, AppState>, args: ExportArgs) -> Result<usize, String> {
    let guard = state.inner.lock().unwrap();
    let s = guard.as_ref().ok_or_else(|| "no library open".to_string())?;
    let selected: Vec<TrackRow> = args
        .track_ids
        .iter()
        .filter_map(|id| s.cache.iter().find(|t| &t.track_id == id).cloned())
        .collect();
    if selected.is_empty() {
        return Err("no tracks selected".to_string());
    }
    write_m3u8(
        std::path::Path::new(&args.path),
        &args.playlist_name,
        &selected,
    )
    .map_err(|e| format!("export: {:#}", e))
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

#[tauri::command]
fn default_db_path() -> String {
    // Heuristic: cwd/library.db. Falls back to ~/library.db.
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("library.db");
        if p.exists() {
            return p.display().to_string();
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join("library.db").display().to_string();
    }
    "library.db".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK 2.52 crashes its web process at exit while tearing down the
    // GBM/DMA-BUF display (WebKit bug 305909, fixed upstream after 2.52.6).
    // Disabling the DMA-BUF renderer avoids that teardown path on Linux.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_library,
            compat,
            export_playlist,
            default_db_path,
            analyze_xml,
            playback::read_track_audio,
            playback::decode_track_pcm,
            playback::write_recording
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
