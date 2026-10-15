use anyhow::{Context, Result};
use rayon::prelude::*;
use serde::Serialize;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use crate::audio;
use crate::estimate;
use crate::features;
use crate::keys::Camelot;
use crate::rekordbox;
use crate::source::{self, Imported, SourceTrack};
use crate::store::Store;

pub const ANALYSIS_SR: u32 = 22050;

/// Lock a mutex even if another thread panicked while holding it. Analysis
/// panics are caught per track, and the guarded data (a SQLite handle, the
/// open-library cache) stays usable, so poisoning should never take the whole
/// app down.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Worker threads for analysis. Leaves a core free so the UI stays
/// responsive, and caps at 8 because each worker holds a decoded track in
/// memory. Override with `TRACK2MIX_THREADS`.
pub fn default_threads() -> usize {
    if let Some(n) = std::env::var("TRACK2MIX_THREADS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
    {
        return n;
    }
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2);
    cores.saturating_sub(1).clamp(1, 8)
}

/// Run `f` on a bounded rayon pool instead of the global one (which would
/// spin up one thread per logical core).
pub fn with_pool<R: Send>(threads: Option<usize>, f: impl FnOnce() -> R + Send) -> R {
    let n = threads.unwrap_or_else(default_threads).max(1);
    match rayon::ThreadPoolBuilder::new()
        .num_threads(n)
        .stack_size(8 * 1024 * 1024)
        .thread_name(|i| format!("track2mix-worker-{i}"))
        .build()
    {
        Ok(pool) => pool.install(f),
        Err(_) => f(),
    }
}

#[derive(Debug, Clone)]
pub struct AnalyzeOptions {
    pub xml_path: PathBuf,
    pub db_path: PathBuf,
    pub limit: Option<usize>,
    pub skip_analyzed: bool,
    pub dry_run: bool,
    pub path_map: Vec<(String, String)>,
}

/// Options shared by every import source (Rekordbox, Traktor, Serato, folder scan).
#[derive(Debug, Clone)]
pub struct RunOptions {
    pub db_path: PathBuf,
    pub limit: Option<usize>,
    pub skip_analyzed: bool,
    pub dry_run: bool,
    pub path_map: Vec<(String, String)>,
    /// Fill in missing BPM / key from the audio.
    pub estimate_missing: bool,
    pub threads: Option<usize>,
}

impl From<&AnalyzeOptions> for RunOptions {
    fn from(o: &AnalyzeOptions) -> Self {
        RunOptions {
            db_path: o.db_path.clone(),
            limit: o.limit,
            skip_analyzed: o.skip_analyzed,
            dry_run: o.dry_run,
            path_map: o.path_map.clone(),
            estimate_missing: false,
            threads: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProgressEvent {
    Parsed {
        total_in_xml: usize,
    },
    Resolved {
        ready: usize,
        no_location: usize,
        unparseable_uri: usize,
        missing_file: usize,
        missing_examples: Vec<String>,
        already_analyzed: usize,
    },
    Track {
        done: usize,
        total: usize,
        name: String,
        artist: String,
    },
    Failed {
        name: String,
        error: String,
    },
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Dropped {
    pub no_location: usize,
    pub unparseable_uri: usize,
    pub missing_file: usize,
    pub missing_examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyzeSummary {
    pub ok: usize,
    pub failed: usize,
    pub skipped_already_analyzed: usize,
    pub dropped: Dropped,
    pub elapsed_secs: f32,
    pub total_considered: usize,
    pub db_path: String,
    /// BPM values filled in by the estimator (tags had none).
    pub estimated_bpm: usize,
    /// Keys filled in by the estimator (tags had none).
    pub estimated_key: usize,
    /// Playlists / crates written to the database.
    pub playlists: usize,
}

/// Rekordbox XML → shared pipeline.
pub fn run<F>(opts: AnalyzeOptions, on_progress: F) -> Result<AnalyzeSummary>
where
    F: Fn(ProgressEvent) + Send + Sync,
{
    let run_opts = RunOptions::from(&opts);
    run_with(opts, run_opts, on_progress)
}

/// Like [`run`], with full control over the shared pipeline options.
pub fn run_with<F>(
    opts: AnalyzeOptions,
    run_opts: RunOptions,
    on_progress: F,
) -> Result<AnalyzeSummary>
where
    F: Fn(ProgressEvent) + Send + Sync,
{
    let parsed = rekordbox::parse(&opts.xml_path)?;
    let mut imported = Imported::default();
    for t in &parsed.collection.tracks {
        if t.location.trim().is_empty() {
            imported.no_location += 1;
            continue;
        }
        match t.resolve_path() {
            None => imported.unparseable_uri += 1,
            Some(path) => imported.tracks.push(SourceTrack::from_rekordbox(t, path)),
        }
    }
    let total_in_source = parsed.collection.tracks.len();
    run_imported(imported, total_in_source, &run_opts, on_progress)
}

/// The shared pipeline: map paths, drop what isn't on disk, decode and score
/// what's left in parallel, write rows and playlists to the store.
pub fn run_imported<F>(
    imported: Imported,
    total_in_source: usize,
    opts: &RunOptions,
    on_progress: F,
) -> Result<AnalyzeSummary>
where
    F: Fn(ProgressEvent) + Send + Sync,
{
    on_progress(ProgressEvent::Parsed {
        total_in_xml: total_in_source,
    });

    let mut tracks = imported.tracks;
    if let Some(n) = opts.limit {
        tracks.truncate(n);
    }

    let mut dropped = Dropped {
        no_location: imported.no_location,
        unparseable_uri: imported.unparseable_uri,
        ..Default::default()
    };

    let store = Store::open(&opts.db_path)
        .with_context(|| format!("opening db {}", opts.db_path.display()))?;

    // Resolve paths, drop missing files and in-batch duplicates, and reuse the
    // id of any row that already covers the same file.
    let mut seen_paths = std::collections::HashSet::new();
    let mut resolved: Vec<SourceTrack> = Vec::new();
    for mut t in tracks {
        t.path = source::apply_path_map(t.path, &opts.path_map);
        if !t.path.exists() {
            dropped.missing_file += 1;
            if dropped.missing_examples.len() < 10 {
                dropped.missing_examples.push(t.path.display().to_string());
            }
            continue;
        }
        if !seen_paths.insert(t.path.clone()) {
            continue;
        }
        if let Some(existing) = store.id_for_path(&t.path.to_string_lossy()) {
            t.track_id = existing;
        }
        resolved.push(t);
    }

    let skipped = if opts.skip_analyzed {
        let before = resolved.len();
        resolved.retain(|t| !store.already_analyzed(&t.track_id));
        before - resolved.len()
    } else {
        0
    };

    // Playlists reference files by path, so they can be saved before (and
    // independently of) analysis; a re-import that skips every track still
    // refreshes them.
    let mut playlist_count = 0;
    if !opts.dry_run {
        for pl in &imported.playlists {
            let paths: Vec<String> = pl
                .paths
                .iter()
                .map(|p| source::apply_path_map(p.clone(), &opts.path_map))
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            store.replace_playlist(&pl.name, pl.source, &paths)?;
            playlist_count += 1;
        }
    }

    on_progress(ProgressEvent::Resolved {
        ready: resolved.len(),
        no_location: dropped.no_location,
        unparseable_uri: dropped.unparseable_uri,
        missing_file: dropped.missing_file,
        missing_examples: dropped.missing_examples.clone(),
        already_analyzed: skipped,
    });

    let total = resolved.len();
    if opts.dry_run || total == 0 {
        return Ok(AnalyzeSummary {
            ok: 0,
            failed: 0,
            skipped_already_analyzed: skipped,
            dropped,
            elapsed_secs: 0.0,
            total_considered: total,
            db_path: opts.db_path.display().to_string(),
            estimated_bpm: 0,
            estimated_key: 0,
            playlists: playlist_count,
        });
    }

    let store = Mutex::new(store);
    let start = Instant::now();
    let done = AtomicUsize::new(0);
    let ok = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let est_bpm = AtomicUsize::new(0);
    let est_key = AtomicUsize::new(0);

    // Cap UI updates: for a 5000-track run we emit ~200 Track events, not 5000.
    // The first few and the last one always emit so the bar starts moving
    // immediately and lands exactly on 100%.
    let emit_every = (total / 200).max(1);
    let estimate_missing = opts.estimate_missing;

    with_pool(opts.threads, || {
        resolved.par_iter().for_each(|track| {
            // A malformed file must cost one track, not the whole run.
            let res = catch_unwind(AssertUnwindSafe(|| -> Result<()> {
                let audio = audio::decode_mono(&track.path, ANALYSIS_SR)
                    .with_context(|| format!("decoding {}", track.path.display()))?;
                let feats = features::extract(&audio.samples, audio.sample_rate);

                let mut row = track.clone();
                if estimate_missing {
                    if row.bpm.is_none() {
                        if let Some(b) = estimate::estimate_bpm(&audio.samples, audio.sample_rate) {
                            row.bpm = Some(b);
                            est_bpm.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                    if Camelot::parse(&row.tonality).is_none() {
                        if let Some(k) = estimate::estimate_key(&audio.samples, audio.sample_rate) {
                            row.tonality = k.to_string();
                            est_key.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                }
                lock(&store).upsert_source(&row, &feats)?;
                Ok(())
            }))
            .unwrap_or_else(|_| Err(anyhow::anyhow!("decoder panicked on this file")));

            let n = done.fetch_add(1, Ordering::SeqCst) + 1;
            match res {
                Ok(()) => {
                    ok.fetch_add(1, Ordering::SeqCst);
                }
                Err(e) => {
                    failed.fetch_add(1, Ordering::SeqCst);
                    on_progress(ProgressEvent::Failed {
                        name: track.name.clone(),
                        error: format!("{:#}", e),
                    });
                }
            }
            if n <= 3 || n == total || n.is_multiple_of(emit_every) {
                on_progress(ProgressEvent::Track {
                    done: n,
                    total,
                    name: track.name.clone(),
                    artist: track.artist.clone(),
                });
            }
        });
    });

    Ok(AnalyzeSummary {
        ok: ok.load(Ordering::SeqCst),
        failed: failed.load(Ordering::SeqCst),
        skipped_already_analyzed: skipped,
        dropped,
        elapsed_secs: start.elapsed().as_secs_f32(),
        total_considered: total,
        db_path: opts.db_path.display().to_string(),
        estimated_bpm: est_bpm.load(Ordering::SeqCst),
        estimated_key: est_key.load(Ordering::SeqCst),
        playlists: playlist_count,
    })
}
