use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use track2mix_core::analyze::{self, AnalyzeOptions, AnalyzeSummary};
use track2mix_core::export::{
    energy_score as energy_score_fn, write_m3u8, write_m3u_plain, write_tracklist_txt,
};
use track2mix_core::keys::Camelot;
use track2mix_core::store::{Store, TrackRow};

/// Playback / composition support. The webview decodes audio itself via
/// `decodeAudioData`; these commands only hand it bytes, and only for
/// tracks that exist in the open library (never arbitrary paths).
mod playback;

/// MP3 encoding (LAME) for composition exports.
mod mp3;

/// `.t2m` composition project files.
mod project;

/// Native queue player (rodio). Drives the player bar and the playlist
/// builder; works even when the webview has no audio output.
mod player;

use player::{PlayerHandle, PlayerState, QueueItem};

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
    #[serde(default)]
    pub format: ExportFormat,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    #[default]
    M3u8,
    M3u,
    Txt,
}

/// Lock that survives poisoning: the guarded data is plain state, so a panic
/// elsewhere shouldn't take every later command down with it.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
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
        let guard = lock(&self.inner);
        let s = guard
            .as_ref()
            .ok_or_else(|| "no library open".to_string())?;
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
        Self {
            inner: Mutex::new(None),
        }
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
fn open_library(
    state: tauri::State<'_, AppState>,
    player: tauri::State<'_, PlayerHandle>,
    db_path: String,
) -> Result<LibraryPayload, String> {
    open_library_at(&state, &player, PathBuf::from(&db_path))
}

/// Where the tablet builds keep the library: the app's own data directory.
/// Nothing else on iPadOS or Android is a stable, writable, plain file path.
fn app_library_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir.join("library.db"))
}

/// Copy a library the user picked in the system file picker into the app's
/// data directory and open it. On iPadOS the picker returns a security-scoped
/// copy and on Android a `content://` URI; neither is a path SQLite can open
/// directly, so the bytes are pulled through the fs plugin, which resolves
/// both, and written to a real file. The copy is atomic (temp file + rename)
/// so a failed import never leaves a half-written database behind.
#[tauri::command]
fn import_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    player: tauri::State<'_, PlayerHandle>,
    source: FilePath,
) -> Result<LibraryPayload, String> {
    let dest = app_library_path(&app)?;
    let tmp = dest.with_extension("db.importing");

    let mut opts = OpenOptions::new();
    opts.read(true);
    let mut from = app
        .fs()
        .open(source.clone(), opts)
        .map_err(|e| format!("open {}: {e}", source))?;
    let mut to =
        std::fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
    let copied = std::io::copy(&mut from, &mut to)
        .map_err(|e| format!("copy {} → {}: {e}", source, tmp.display()))?;
    drop(to);
    if copied < 100 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "{} is {} bytes — not a Track2Mix library (expected a SQLite file produced by the desktop app or the CLI)",
            source, copied
        ));
    }
    // The library may be the one currently open; drop it before replacing the file.
    {
        let mut guard = lock(&state.inner);
        if guard.as_ref().is_some_and(|s| s.db_path == dest) {
            let _ = player.stop();
            *guard = None;
        }
    }
    std::fs::rename(&tmp, &dest).map_err(|e| format!("replace {}: {e}", dest.display()))?;

    open_library_at(&state, &player, dest)
}

fn open_library_at(
    state: &tauri::State<'_, AppState>,
    player: &tauri::State<'_, PlayerHandle>,
    path: PathBuf,
) -> Result<LibraryPayload, String> {
    let db_path = path.display().to_string();
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

    let mut guard = lock(&state.inner);
    let switched = guard.as_ref().is_some_and(|s| s.db_path != path);
    if switched {
        // The queue holds paths from the old library; don't keep playing it.
        let _ = player.stop();
    }
    *guard = Some(StateInner {
        db_path: path,
        store,
        min_energy: emin,
        max_energy: emax,
        cache: tracks,
    });
    drop(guard);

    Ok(LibraryPayload {
        summary,
        tracks: ui_tracks,
    })
}

#[tauri::command]
fn compat(state: tauri::State<'_, AppState>, args: CompatArgs) -> Result<Vec<UiTrack>, String> {
    let guard = lock(&state.inner);
    let s = guard
        .as_ref()
        .ok_or_else(|| "no library open".to_string())?;
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

/// Write the playlist in the requested format; resolves to the number of
/// rows actually written (playlist formats skip tracks with no path).
#[tauri::command]
fn export_playlist(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    args: ExportArgs,
) -> Result<usize, String> {
    let guard = lock(&state.inner);
    let s = guard
        .as_ref()
        .ok_or_else(|| "no library open".to_string())?;
    // Keep the caller's order; ids not in the library are dropped here.
    let selected: Vec<TrackRow> = args
        .track_ids
        .iter()
        .filter_map(|id| s.cache.iter().find(|t| &t.track_id == id).cloned())
        .collect();
    if selected.is_empty() {
        return Err("no tracks selected".to_string());
    }
    // The save dialog returns a plain path on the desktop. On iPadOS and
    // Android it returns a location std::fs cannot write (a security-scoped
    // URL, a content:// URI), so the playlist is written to a temp file and
    // the bytes are copied through the fs plugin, which resolves both.
    let dest: FilePath = args
        .path
        .parse()
        .map_err(|e| format!("export destination {:?}: {e}", args.path))?;
    let direct = dest.as_path().map(|p| p.to_path_buf());

    let (out, staged): (PathBuf, bool) = match direct {
        Some(p) if !cfg!(mobile) => (p, false),
        _ => {
            let dir = app
                .path()
                .app_cache_dir()
                .map_err(|e| format!("app cache dir: {e}"))?;
            std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
            let ext = match args.format {
                ExportFormat::M3u8 => "m3u8",
                ExportFormat::M3u => "m3u",
                ExportFormat::Txt => "txt",
            };
            (dir.join(format!("export.{ext}")), true)
        }
    };

    let written = match args.format {
        ExportFormat::M3u8 => write_m3u8(&out, &args.playlist_name, &selected),
        ExportFormat::M3u => write_m3u_plain(&out, &selected),
        ExportFormat::Txt => write_tracklist_txt(&out, &args.playlist_name, &selected),
    }
    .map_err(|e| format!("export: {:#}", e))?;

    if staged {
        let bytes = std::fs::read(&out).map_err(|e| format!("read {}: {e}", out.display()))?;
        let mut opts = OpenOptions::new();
        opts.read(false).write(true).create(true).truncate(true);
        let mut file = app
            .fs()
            .open(dest.clone(), opts)
            .map_err(|e| format!("open {} for writing: {e}", dest))?;
        std::io::Write::write_all(&mut file, &bytes).map_err(|e| format!("write {}: {e}", dest))?;
        let _ = std::fs::remove_file(&out);
    }
    Ok(written)
}

// --- Player commands -------------------------------------------------------
// Flat params: the frontend sends `{ trackIds, startIndex }`, `{ secs }`,
// `{ v }`, which Tauri maps to these snake_case names.

#[tauri::command]
fn player_play(
    state: tauri::State<'_, AppState>,
    player: tauri::State<'_, PlayerHandle>,
    track_ids: Vec<String>,
    start_index: usize,
) -> Result<(), String> {
    let items: Vec<QueueItem> = {
        let guard = lock(&state.inner);
        let s = guard
            .as_ref()
            .ok_or_else(|| "no library open".to_string())?;
        // Index-based queue: duplicates are kept, unknown ids stay as pathless
        // entries so the UI's indices line up and the player skips them.
        track_ids
            .into_iter()
            .map(|id| {
                let path = s
                    .cache
                    .iter()
                    .find(|t| t.track_id == id)
                    .and_then(|t| t.file_path.as_ref())
                    .map(PathBuf::from);
                QueueItem { track_id: id, path }
            })
            .collect()
    };
    player.play(items, start_index)
}

#[tauri::command]
fn player_toggle(player: tauri::State<'_, PlayerHandle>) -> Result<(), String> {
    player.toggle()
}

#[tauri::command]
fn player_next(player: tauri::State<'_, PlayerHandle>) -> Result<(), String> {
    player.next()
}

#[tauri::command]
fn player_prev(player: tauri::State<'_, PlayerHandle>) -> Result<(), String> {
    player.prev()
}

#[tauri::command]
fn player_seek(player: tauri::State<'_, PlayerHandle>, secs: f64) -> Result<(), String> {
    player.seek(secs)
}

#[tauri::command]
fn player_volume(player: tauri::State<'_, PlayerHandle>, v: f32) -> Result<(), String> {
    player.volume(v)
}

#[tauri::command]
fn player_stop(player: tauri::State<'_, PlayerHandle>) -> Result<(), String> {
    player.stop()
}

#[tauri::command]
fn player_status(player: tauri::State<'_, PlayerHandle>) -> PlayerState {
    player.status()
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
async fn analyze_xml(app: tauri::AppHandle, args: AnalyzeArgs) -> Result<AnalyzeSummary, String> {
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
fn default_db_path(app: tauri::AppHandle) -> String {
    // Tablets: the only library is the one imported into the app's data dir.
    if cfg!(mobile) {
        match app_library_path(&app) {
            Ok(p) => return p.display().to_string(),
            Err(e) => {
                eprintln!("default_db_path: {e}");
                return "library.db".to_string();
            }
        }
    }
    // Desktop heuristic: cwd/library.db. Falls back to ~/library.db.
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
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(PlayerHandle::spawn(Box::new(move |s| {
                let _ = handle.emit(player::STATE_EVENT, s);
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_library,
            import_library,
            compat,
            export_playlist,
            default_db_path,
            analyze_xml,
            playback::read_track_audio,
            playback::decode_track_pcm,
            playback::write_recording,
            project::read_project,
            project::write_project,
            player_play,
            player_toggle,
            player_next,
            player_prev,
            player_seek,
            player_volume,
            player_stop,
            player_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Stop the audio thread before the runtime tears down.
                if let Some(p) = app.try_state::<PlayerHandle>() {
                    p.shutdown();
                }
            }
        });
}
