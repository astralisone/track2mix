use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use indicatif::{ProgressBar, ProgressStyle};
use rayon::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use track2mix_core::export::{energy_score, write_m3u8};
use track2mix_core::keys::Camelot;
use track2mix_core::store::{Store, TrackRow};
use track2mix_core::{audio, features, rekordbox};

/// 22050 Hz retains everything up to ~11 kHz — ample for MIR features and
/// roughly half the work of 44.1 kHz.
const ANALYSIS_SR: u32 = 22050;

#[derive(Parser)]
#[command(
    name = "track2mix",
    about = "Parse a Rekordbox library, extract audio features, and query the result."
)]
struct Cli {
    /// Path to the SQLite database used by every subcommand.
    #[arg(long, default_value = "library.db", global = true)]
    db: PathBuf,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Parse a Rekordbox XML export, decode each referenced file, and write features to the DB.
    Analyze {
        /// Path to a Rekordbox XML export (File → Export Collection in xml format).
        #[arg(long)]
        xml: PathBuf,
        /// Limit number of tracks processed (useful for a quick sanity pass).
        #[arg(long)]
        limit: Option<usize>,
        /// Skip tracks already present and analyzed in the DB.
        #[arg(long)]
        skip_analyzed: bool,
        /// Report coverage (how many paths resolve) without decoding any audio.
        #[arg(long)]
        dry_run: bool,
        /// Rewrite a path prefix before resolving. Repeatable.
        /// Format: `OLD=NEW`. Example: `--path-map '/Volumes/Old/music=/Volumes/New/music'`.
        #[arg(long = "path-map", value_parser = parse_path_map)]
        path_map: Vec<(String, String)>,
    },
    /// Show top-N tracks sorted by a feature column.
    Top {
        /// Sort metric: energy | bpm | rms | centroid | flux | onsets | rating | plays
        #[arg(long, default_value = "energy")]
        by: String,
        /// Number of rows to show.
        #[arg(long, default_value_t = 20)]
        limit: usize,
        /// Case-insensitive substring filter on the Rekordbox Genre tag.
        #[arg(long)]
        genre: Option<String>,
        /// Case-insensitive substring filter on the parent-folder name on disk
        /// (e.g. "liquid", "neuro") — useful when the Genre tag is too coarse.
        #[arg(long = "sub-genre")]
        sub_genre: Option<String>,
        /// Sort ascending instead of descending.
        #[arg(long)]
        asc: bool,
        /// Also write the matching tracks to an M3U8 playlist at this path
        /// (Rekordbox: File → Import Playlist).
        #[arg(long)]
        export: Option<PathBuf>,
        /// Playlist name embedded in the M3U8 header. Defaults to the file stem.
        #[arg(long = "playlist-name")]
        playlist_name: Option<String>,
    },
    /// Suggest harmonically + BPM-compatible tracks around a reference track.
    Compat {
        /// Substring search against track name or artist; the top-ranked match is used as the anchor.
        query: String,
        /// BPM tolerance (± this value around the anchor's BPM).
        #[arg(long, default_value_t = 3.0)]
        bpm_tol: f32,
        /// Maximum number of suggestions to return.
        #[arg(long, default_value_t = 20)]
        limit: usize,
        /// Ignore Camelot compatibility (BPM-only matching).
        #[arg(long)]
        any_key: bool,
        /// Also match tracks at half and double the anchor's BPM
        /// (e.g. a 175 BPM DnB anchor matches 86–88 BPM half-time tagging of the same tempo).
        #[arg(long = "half-double-ok")]
        half_double_ok: bool,
        /// Also write the compatible tracks to an M3U8 playlist at this path.
        #[arg(long)]
        export: Option<PathBuf>,
        /// Playlist name embedded in the M3U8 header. Defaults to "<anchor name> — compat".
        #[arg(long = "playlist-name")]
        playlist_name: Option<String>,
    },
    /// Summary of what's in the database.
    Stats,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Analyze {
            xml,
            limit,
            skip_analyzed,
            dry_run,
            path_map,
        } => cmd_analyze(&cli.db, &xml, limit, skip_analyzed, dry_run, &path_map),
        Command::Top {
            by,
            limit,
            genre,
            sub_genre,
            asc,
            export,
            playlist_name,
        } => cmd_top(
            &cli.db,
            &by,
            limit,
            genre.as_deref(),
            sub_genre.as_deref(),
            asc,
            export.as_deref(),
            playlist_name.as_deref(),
        ),
        Command::Compat {
            query,
            bpm_tol,
            limit,
            any_key,
            half_double_ok,
            export,
            playlist_name,
        } => cmd_compat(
            &cli.db,
            &query,
            bpm_tol,
            limit,
            any_key,
            half_double_ok,
            export.as_deref(),
            playlist_name.as_deref(),
        ),
        Command::Stats => cmd_stats(&cli.db),
    }
}

fn parse_path_map(s: &str) -> Result<(String, String), String> {
    let (old, new) = s
        .split_once('=')
        .ok_or_else(|| format!("expected OLD=NEW, got `{}`", s))?;
    if old.is_empty() {
        return Err("OLD prefix must not be empty".into());
    }
    Ok((old.to_string(), new.to_string()))
}

fn apply_path_map(path: PathBuf, path_map: &[(String, String)]) -> PathBuf {
    if path_map.is_empty() {
        return path;
    }
    let s = path.to_string_lossy();
    for (old, new) in path_map {
        if let Some(rest) = s.strip_prefix(old.as_str()) {
            return PathBuf::from(format!("{}{}", new, rest));
        }
    }
    path
}

fn cmd_analyze(
    db: &Path,
    xml_path: &Path,
    limit: Option<usize>,
    skip_analyzed: bool,
    dry_run: bool,
    path_map: &[(String, String)],
) -> Result<()> {
    println!("Parsing Rekordbox XML…");
    let xml = rekordbox::parse(xml_path)?;
    let mut tracks = xml.collection.tracks;
    println!("  found {} tracks", tracks.len());

    if let Some(n) = limit {
        tracks.truncate(n);
        println!("  limited to {}", n);
    }
    if !path_map.is_empty() {
        println!("  path remaps:");
        for (old, new) in path_map {
            println!("    {} → {}", old, new);
        }
    }

    let store = Mutex::new(Store::open(db)?);

    let mut resolved: Vec<(rekordbox::Track, PathBuf)> = Vec::new();
    let mut no_location = 0usize;
    let mut unparseable_uri = 0usize;
    let mut missing_file = 0usize;
    let mut missing_examples: Vec<String> = Vec::new();
    for t in tracks {
        if t.location.trim().is_empty() {
            no_location += 1;
            continue;
        }
        match t.resolve_path() {
            None => unparseable_uri += 1,
            Some(path) => {
                let remapped = apply_path_map(path, path_map);
                if !remapped.exists() {
                    missing_file += 1;
                    if missing_examples.len() < 3 {
                        missing_examples.push(remapped.display().to_string());
                    }
                } else {
                    resolved.push((t, remapped));
                }
            }
        }
    }

    println!("  {} resolved to an existing local file", resolved.len());
    if no_location + unparseable_uri + missing_file > 0 {
        println!("  Dropped:");
        if no_location > 0 {
            println!("    {} with no Location attribute", no_location);
        }
        if unparseable_uri > 0 {
            println!("    {} with unparseable file:// URIs", unparseable_uri);
        }
        if missing_file > 0 {
            println!(
                "    {} pointing at files not on disk (external drive unmounted? moved library?)",
                missing_file
            );
            for ex in &missing_examples {
                println!("      e.g. {}", ex);
            }
        }
    }

    let skipped_analyzed = if skip_analyzed {
        let before = resolved.len();
        resolved.retain(|(t, _)| !store.lock().unwrap().already_analyzed(&t.track_id));
        before - resolved.len()
    } else {
        0
    };
    if skipped_analyzed > 0 {
        println!("  {} skipped (already analyzed)", skipped_analyzed);
    }

    let candidates = resolved;
    if dry_run {
        println!(
            "  dry-run: skipping audio decode. {} track(s) would be analyzed.",
            candidates.len()
        );
        return Ok(());
    }
    if candidates.is_empty() {
        println!("  nothing to do.");
        return Ok(());
    }
    println!("  analyzing {}…", candidates.len());

    let pb = ProgressBar::new(candidates.len() as u64);
    pb.set_style(
        ProgressStyle::with_template(
            "{spinner} [{elapsed_precise}] [{bar:40}] {pos}/{len} ({eta}) {msg}",
        )
        .unwrap()
        .progress_chars("=>-"),
    );

    let start = Instant::now();
    let ok = Mutex::new(0usize);
    let failed = Mutex::new(Vec::<(String, String)>::new());

    candidates.par_iter().for_each(|(track, path)| {
        pb.set_message(format!("{} - {}", track.artist, track.name));
        match analyze_one(track, path, &store) {
            Ok(()) => {
                *ok.lock().unwrap() += 1;
            }
            Err(e) => {
                failed
                    .lock()
                    .unwrap()
                    .push((track.name.clone(), format!("{:#}", e)));
            }
        }
        pb.inc(1);
    });

    pb.finish();
    let elapsed = start.elapsed();
    let ok_count = *ok.lock().unwrap();
    let failed_list = failed.into_inner().unwrap();

    println!();
    println!("Done in {:.1}s", elapsed.as_secs_f32());
    println!(
        "  {} succeeded, {} failed, {:.2}s/track avg",
        ok_count,
        failed_list.len(),
        elapsed.as_secs_f32() / candidates.len().max(1) as f32
    );
    if !failed_list.is_empty() {
        println!("  first 5 failures:");
        for (name, err) in failed_list.iter().take(5) {
            println!("    {}: {}", name, err);
        }
    }

    Ok(())
}

fn analyze_one(track: &rekordbox::Track, path: &Path, store: &Mutex<Store>) -> Result<()> {
    let audio = audio::decode_mono(path, ANALYSIS_SR)
        .with_context(|| format!("decoding {}", path.display()))?;
    let feats = features::extract(&audio.samples, audio.sample_rate);
    let path_str = path.to_string_lossy().to_string();
    store.lock().unwrap().upsert(track, &feats, &path_str)?;
    Ok(())
}

fn cmd_top(
    db: &Path,
    metric: &str,
    limit: usize,
    genre: Option<&str>,
    sub_genre: Option<&str>,
    asc: bool,
    export: Option<&Path>,
    playlist_name: Option<&str>,
) -> Result<()> {
    let store = Store::open(db)?;
    let rows = store.top_by(metric, limit, genre, sub_genre, asc)?;
    if rows.is_empty() {
        println!("no matching tracks — run `analyze` first or loosen --genre / --sub-genre.");
        return Ok(());
    }
    let stats = store.stats()?;
    let (emin, emax) = (
        stats.min_energy.unwrap_or(0.0),
        stats.max_energy.unwrap_or(1.0),
    );
    print_table(&rows, emin, emax);
    if let Some(out) = export {
        let name = resolve_playlist_name(playlist_name, out, "top");
        let written = write_m3u8(out, &name, &rows)?;
        println!(
            "\nWrote {} track(s) to {} (playlist: \"{}\")",
            written,
            out.display(),
            name
        );
    }
    Ok(())
}

fn cmd_compat(
    db: &Path,
    query: &str,
    bpm_tol: f32,
    limit: usize,
    any_key: bool,
    half_double_ok: bool,
    export: Option<&Path>,
    playlist_name: Option<&str>,
) -> Result<()> {
    let store = Store::open(db)?;
    let matches = store.search(query, 5)?;
    let Some(anchor) = matches.first().cloned() else {
        println!("no track found matching `{}`.", query);
        return Ok(());
    };
    let anchor_bpm = anchor.bpm.ok_or_else(|| {
        anyhow::anyhow!("anchor track has no BPM; re-run `analyze` on this track")
    })?;
    let anchor_camelot = Camelot::parse(&anchor.tonality);

    let mut ranges = vec![(anchor_bpm - bpm_tol, anchor_bpm + bpm_tol)];
    if half_double_ok {
        let half = anchor_bpm / 2.0;
        let dbl = anchor_bpm * 2.0;
        ranges.push((half - bpm_tol, half + bpm_tol));
        ranges.push((dbl - bpm_tol, dbl + bpm_tol));
    }
    let range_descriptions: Vec<String> = ranges
        .iter()
        .map(|(lo, hi)| format!("{:.1}–{:.1}", lo, hi))
        .collect();

    println!("Anchor: {} — {}", anchor.artist, anchor.name);
    println!(
        "  {:.1} BPM · key {} · {}",
        anchor_bpm,
        format_key(&anchor.tonality, anchor_camelot.as_ref()),
        if any_key {
            "BPM-only matching".to_string()
        } else {
            format!(
                "Camelot matching {}",
                anchor_camelot
                    .as_ref()
                    .map(|c| format!("({})", c))
                    .unwrap_or_else(|| "(key unparsed — falling back to no key filter)".into())
            )
        }
    );
    if half_double_ok {
        println!("  BPM windows: {}", range_descriptions.join(", "));
    }
    if matches.len() > 1 {
        println!(
            "  ({} other tracks matched the search — refine the query to pick a different anchor)",
            matches.len() - 1
        );
    }
    println!();

    let mut pool_by_id: std::collections::HashMap<String, TrackRow> =
        std::collections::HashMap::new();
    for (lo, hi) in ranges {
        for t in store.in_bpm_range(lo, hi, &anchor.track_id)? {
            pool_by_id.entry(t.track_id.clone()).or_insert(t);
        }
    }
    let apply_key_filter = !any_key && anchor_camelot.is_some();

    let mut compatible: Vec<_> = pool_by_id
        .into_values()
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
    compatible.truncate(limit);

    if compatible.is_empty() {
        println!(
            "no compatible tracks in ±{:.1} BPM{}{}.",
            bpm_tol,
            if half_double_ok {
                " (with half/double)"
            } else {
                ""
            },
            if apply_key_filter {
                " with a compatible key"
            } else {
                ""
            },
        );
        return Ok(());
    }
    let stats = store.stats()?;
    let (emin, emax) = (
        stats.min_energy.unwrap_or(0.0),
        stats.max_energy.unwrap_or(1.0),
    );
    print_table(&compatible, emin, emax);
    if let Some(out) = export {
        let default = format!("{} — compat", anchor.name);
        let name = playlist_name.map(|s| s.to_string()).unwrap_or_else(|| {
            out.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
                .unwrap_or(default)
        });
        let written = write_m3u8(out, &name, &compatible)?;
        println!(
            "\nWrote {} track(s) to {} (playlist: \"{}\")",
            written,
            out.display(),
            name
        );
    }
    Ok(())
}

fn cmd_stats(db: &Path) -> Result<()> {
    let store = Store::open(db)?;
    let s = store.stats()?;
    println!("Database: {}", db.display());
    println!("  total rows           {}", s.total);
    println!("  analyzed             {}", s.analyzed);
    println!("  distinct genres      {}", s.distinct_genres);
    println!("  distinct keys        {}", s.distinct_keys);
    println!(
        "  avg BPM              {}",
        s.avg_bpm
            .map(|v| format!("{:.1}", v))
            .unwrap_or_else(|| "—".into())
    );
    println!(
        "  energy (min/avg/max) {} / {} / {}",
        s.min_energy
            .map(|v| format!("{:.2}", v))
            .unwrap_or_else(|| "—".into()),
        s.avg_energy
            .map(|v| format!("{:.2}", v))
            .unwrap_or_else(|| "—".into()),
        s.max_energy
            .map(|v| format!("{:.2}", v))
            .unwrap_or_else(|| "—".into()),
    );
    Ok(())
}

fn resolve_playlist_name(supplied: Option<&str>, out: &Path, fallback: &str) -> String {
    supplied
        .map(|s| s.to_string())
        .or_else(|| {
            out.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| fallback.to_string())
}

fn format_key(raw: &str, parsed: Option<&Camelot>) -> String {
    let trimmed = raw.trim();
    match (trimmed, parsed) {
        ("", None) => "—".into(),
        (r, None) => format!("{} (unparsed)", r),
        (r, Some(c)) if r.eq_ignore_ascii_case(&c.to_string()) => c.to_string(),
        (r, Some(c)) => format!("{} [{}]", r, c),
    }
}

fn genre_display(r: &TrackRow) -> String {
    match (r.genre.trim(), r.sub_genre.as_deref()) {
        ("", Some(sg)) => sg.to_string(),
        (g, Some(sg)) if !g.eq_ignore_ascii_case(sg) => format!("{} › {}", g, sg),
        (g, _) => g.to_string(),
    }
}

fn print_table(rows: &[TrackRow], lib_min_energy: f32, lib_max_energy: f32) {
    let name_w = rows
        .iter()
        .map(|r| truncate(&r.name, 40).chars().count())
        .max()
        .unwrap_or(10)
        .max(4);
    let artist_w = rows
        .iter()
        .map(|r| truncate(&r.artist, 28).chars().count())
        .max()
        .unwrap_or(10)
        .max(6);
    let genre_w = rows
        .iter()
        .map(|r| truncate(&genre_display(r), 24).chars().count())
        .max()
        .unwrap_or(5)
        .max(5);

    println!(
        "{:<name_w$}  {:<artist_w$}  {:<genre_w$}  {:>6}  {:<8}  {:>3}",
        "name",
        "artist",
        "genre",
        "bpm",
        "key",
        "E",
        name_w = name_w,
        artist_w = artist_w,
        genre_w = genre_w,
    );
    println!(
        "{}",
        "-".repeat(name_w + artist_w + genre_w + 6 + 8 + 3 + 10)
    );
    for r in rows {
        let key_display = Camelot::parse(&r.tonality)
            .map(|c| c.to_string())
            .unwrap_or_else(|| {
                if r.tonality.trim().is_empty() {
                    "—".into()
                } else {
                    r.tonality.clone()
                }
            });
        println!(
            "{:<name_w$}  {:<artist_w$}  {:<genre_w$}  {:>6}  {:<8}  {:>3}",
            truncate(&r.name, 40),
            truncate(&r.artist, 28),
            truncate(&genre_display(r), 24),
            r.bpm
                .filter(|v| *v > 0.0)
                .map(|v| format!("{:.1}", v))
                .unwrap_or_else(|| "—".into()),
            truncate(&key_display, 8),
            r.energy
                .map(|v| format!("{}", energy_score(v, lib_min_energy, lib_max_energy)))
                .unwrap_or_else(|| "—".into()),
            name_w = name_w,
            artist_w = artist_w,
            genre_w = genre_w,
        );
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}
