use anyhow::{anyhow, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle};
use std::path::{Path, PathBuf};

use track2mix_core::analyze::{self, AnalyzeOptions, AnalyzeSummary, ProgressEvent, RunOptions};
use track2mix_core::export::{energy_score, write_playlist, ExportFormat, ExportOptions};
use track2mix_core::keys::Camelot;
use track2mix_core::scan::{scan_dirs, ScanOptions};
use track2mix_core::serato;
use track2mix_core::source::Imported;
use track2mix_core::store::{Store, TrackRow};
use track2mix_core::traktor::{self, TraktorOptions};

#[derive(Parser)]
#[command(
    name = "track2mix",
    about = "Scan folders or import Rekordbox, Traktor and Serato libraries, extract audio features, query the result, and export to any of them."
)]
struct Cli {
    /// Path to the SQLite database used by every subcommand.
    #[arg(long, default_value = "library.db", global = true)]
    db: PathBuf,

    #[command(subcommand)]
    command: Command,
}

/// Options for the import-style commands (`scan`, `import`).
#[derive(Args, Clone)]
struct PipeFlags {
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
    /// Don't estimate BPM / key from the audio for tracks whose tags lack them.
    #[arg(long)]
    no_estimate: bool,
    /// Worker threads (default: cores − 1, at most 8; env TRACK2MIX_THREADS).
    #[arg(long)]
    threads: Option<usize>,
}

impl PipeFlags {
    fn run_options(&self, db: &Path) -> RunOptions {
        RunOptions {
            db_path: db.to_path_buf(),
            limit: self.limit,
            skip_analyzed: self.skip_analyzed,
            dry_run: self.dry_run,
            path_map: self.path_map.clone(),
            estimate_missing: !self.no_estimate,
            threads: self.threads,
        }
    }
}

/// Options for anything that writes a playlist file.
#[derive(Args, Clone, Default)]
struct ExportFlags {
    /// Export format: m3u8 | traktor | serato. Default: inferred from the
    /// output extension (.m3u8, .nml, .crate).
    #[arg(long)]
    format: Option<String>,
    /// Traktor: volume name for paths not under /Volumes/<disk> or a drive
    /// letter (default "Macintosh HD"; use "C:" for a Windows machine).
    #[arg(long = "traktor-volume")]
    traktor_volume: Option<String>,
    /// Serato: drive root the crate's relative paths are anchored at
    /// (e.g. /Volumes/SSD). Default: the filesystem root (home-drive library).
    #[arg(long = "serato-root")]
    serato_root: Option<PathBuf>,
    /// Rewrite path prefixes in the exported file. Repeatable, `OLD=NEW`.
    /// Use when the DJ machine sees the files somewhere else.
    #[arg(long = "export-path-map", value_parser = parse_path_map)]
    export_path_map: Vec<(String, String)>,
}

impl ExportFlags {
    fn format_for(&self, out: &Path) -> Result<ExportFormat> {
        if let Some(f) = &self.format {
            return ExportFormat::parse(f)
                .ok_or_else(|| anyhow!("unknown format `{}` (use m3u8, traktor or serato)", f));
        }
        Ok(ExportFormat::from_extension(out).unwrap_or(ExportFormat::M3u8))
    }

    fn options(&self) -> ExportOptions {
        ExportOptions {
            traktor_volume: self.traktor_volume.clone(),
            serato_root: self.serato_root.clone(),
            path_map: self.export_path_map.clone(),
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum ImportKind {
    /// A Traktor collection (`collection.nml`) — tracks and playlists.
    Traktor,
    /// A Serato library: a `_Serato_` folder, a `.crate`, or `database V2`.
    Serato,
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
        /// Estimate BPM / key from the audio for tracks whose tags lack them.
        #[arg(long)]
        estimate: bool,
        /// Worker threads (default: cores − 1, at most 8; env TRACK2MIX_THREADS).
        #[arg(long)]
        threads: Option<usize>,
    },
    /// Walk one or more folders for audio files, read their tags, and analyze them.
    Scan {
        /// Folders to scan (recursively).
        #[arg(required = true)]
        dirs: Vec<PathBuf>,
        /// Maximum folder depth below each root.
        #[arg(long)]
        depth: Option<usize>,
        #[command(flatten)]
        pipe: PipeFlags,
    },
    /// Import a Traktor collection or Serato library (tracks + playlists/crates).
    Import {
        kind: ImportKind,
        /// collection.nml, or a Serato `_Serato_` folder / `.crate` / `database V2`.
        path: PathBuf,
        /// Serato: drive root the stored relative paths are anchored at.
        /// Default: guessed from where `_Serato_` lives.
        #[arg(long)]
        root: Option<PathBuf>,
        /// Traktor: name of the macOS boot volume in the NML (default "Macintosh HD").
        #[arg(long = "boot-volume")]
        boot_volume: Option<String>,
        #[command(flatten)]
        pipe: PipeFlags,
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
        /// Also write the matching tracks to a playlist file: .m3u8 (Rekordbox),
        /// .nml (Traktor) or .crate (Serato).
        #[arg(long)]
        export: Option<PathBuf>,
        /// Playlist name embedded in the file. Defaults to the file stem.
        #[arg(long = "playlist-name")]
        playlist_name: Option<String>,
        #[command(flatten)]
        fmt: ExportFlags,
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
        /// Also write the compatible tracks to a playlist file (.m3u8, .nml or .crate).
        #[arg(long)]
        export: Option<PathBuf>,
        /// Playlist name embedded in the file. Defaults to "<anchor name> — compat".
        #[arg(long = "playlist-name")]
        playlist_name: Option<String>,
        #[command(flatten)]
        fmt: ExportFlags,
    },
    /// Export the whole library, a filtered slice, or an imported playlist.
    Export {
        /// Output file (.m3u8, .nml or .crate).
        out: PathBuf,
        /// Export an imported Traktor/Serato playlist by name (see `playlists`).
        #[arg(long)]
        playlist: Option<String>,
        /// Case-insensitive substring filter on the Genre tag.
        #[arg(long)]
        genre: Option<String>,
        /// Case-insensitive substring filter on the parent-folder name.
        #[arg(long = "sub-genre")]
        sub_genre: Option<String>,
        /// Playlist name embedded in the file. Defaults to the file stem.
        #[arg(long = "playlist-name")]
        playlist_name: Option<String>,
        #[command(flatten)]
        fmt: ExportFlags,
    },
    /// List playlists / crates imported from Traktor or Serato.
    Playlists {
        /// Show the tracks of one playlist.
        #[arg(long)]
        show: Option<String>,
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
            estimate,
            threads,
        } => cmd_analyze(
            &cli.db,
            &xml,
            limit,
            skip_analyzed,
            dry_run,
            &path_map,
            estimate,
            threads,
        ),
        Command::Scan { dirs, depth, pipe } => cmd_scan(&cli.db, &dirs, depth, &pipe),
        Command::Import {
            kind,
            path,
            root,
            boot_volume,
            pipe,
        } => cmd_import(&cli.db, kind, &path, root.as_deref(), boot_volume, &pipe),
        Command::Top {
            by,
            limit,
            genre,
            sub_genre,
            asc,
            export,
            playlist_name,
            fmt,
        } => cmd_top(
            &cli.db,
            &by,
            limit,
            genre.as_deref(),
            sub_genre.as_deref(),
            asc,
            export.as_deref(),
            playlist_name.as_deref(),
            &fmt,
        ),
        Command::Compat {
            query,
            bpm_tol,
            limit,
            any_key,
            half_double_ok,
            export,
            playlist_name,
            fmt,
        } => cmd_compat(
            &cli.db,
            &query,
            bpm_tol,
            limit,
            any_key,
            half_double_ok,
            export.as_deref(),
            playlist_name.as_deref(),
            &fmt,
        ),
        Command::Export {
            out,
            playlist,
            genre,
            sub_genre,
            playlist_name,
            fmt,
        } => cmd_export(
            &cli.db,
            &out,
            playlist.as_deref(),
            genre.as_deref(),
            sub_genre.as_deref(),
            playlist_name.as_deref(),
            &fmt,
        ),
        Command::Playlists { show } => cmd_playlists(&cli.db, show.as_deref()),
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

/// Progress handler that drives a progress bar and prints the resolve report.
fn progress_handler() -> (impl Fn(ProgressEvent) + Send + Sync, ProgressBar) {
    let pb = ProgressBar::with_draw_target(Some(0), ProgressDrawTarget::hidden());
    pb.set_style(
        ProgressStyle::with_template(
            "{spinner} [{elapsed_precise}] [{bar:40}] {pos}/{len} ({eta}) {msg}",
        )
        .unwrap()
        .progress_chars("=>-"),
    );
    let bar = pb.clone();
    let handler = move |ev: ProgressEvent| match ev {
        ProgressEvent::Parsed { total_in_xml } => println!("  found {} tracks", total_in_xml),
        ProgressEvent::Resolved {
            ready,
            no_location,
            unparseable_uri,
            missing_file,
            missing_examples,
            already_analyzed,
        } => {
            println!(
                "  {} resolved to an existing local file",
                ready + already_analyzed
            );
            if no_location + unparseable_uri + missing_file > 0 {
                println!("  Dropped:");
                if no_location > 0 {
                    println!("    {} with no location", no_location);
                }
                if unparseable_uri > 0 {
                    println!("    {} with unparseable file URIs", unparseable_uri);
                }
                if missing_file > 0 {
                    println!(
                        "    {} pointing at files not on disk (external drive unmounted? moved library? try --path-map)",
                        missing_file
                    );
                    for ex in missing_examples.iter().take(3) {
                        println!("      e.g. {}", ex);
                    }
                }
            }
            if already_analyzed > 0 {
                println!("  {} skipped (already analyzed)", already_analyzed);
            }
            pb.set_length(ready as u64);
            if ready > 0 {
                pb.set_draw_target(ProgressDrawTarget::stderr());
            }
        }
        ProgressEvent::Track {
            done, name, artist, ..
        } => {
            pb.set_position(done as u64);
            pb.set_message(format!("{} - {}", artist, name));
        }
        ProgressEvent::Failed { name, error } => {
            pb.println(format!("  failed: {}: {}", name, error))
        }
    };
    (handler, bar)
}

fn print_summary(s: &AnalyzeSummary, dry_run: bool) {
    println!();
    if dry_run {
        println!(
            "  dry-run: skipping audio decode. {} track(s) would be analyzed.",
            s.total_considered
        );
    } else if s.total_considered == 0 {
        println!("  nothing to do.");
    } else {
        println!("Done in {:.1}s", s.elapsed_secs);
        println!(
            "  {} succeeded, {} failed, {:.2}s/track avg",
            s.ok,
            s.failed,
            s.elapsed_secs / s.total_considered.max(1) as f32
        );
        if s.estimated_bpm + s.estimated_key > 0 {
            println!(
                "  estimated from audio: {} BPM, {} key (tags had none; treat as a starting point)",
                s.estimated_bpm, s.estimated_key
            );
        }
    }
    if s.playlists > 0 {
        println!(
            "  {} playlist(s) saved — see `track2mix playlists`",
            s.playlists
        );
    }
}

fn cmd_analyze(
    db: &Path,
    xml_path: &Path,
    limit: Option<usize>,
    skip_analyzed: bool,
    dry_run: bool,
    path_map: &[(String, String)],
    estimate: bool,
    threads: Option<usize>,
) -> Result<()> {
    println!("Parsing Rekordbox XML…");
    if !path_map.is_empty() {
        println!("  path remaps:");
        for (old, new) in path_map {
            println!("    {} → {}", old, new);
        }
    }
    let opts = AnalyzeOptions {
        xml_path: xml_path.to_path_buf(),
        db_path: db.to_path_buf(),
        limit,
        skip_analyzed,
        dry_run,
        path_map: path_map.to_vec(),
    };
    let (handler, bar) = progress_handler();
    let mut run_opts = RunOptions::from(&opts);
    run_opts.estimate_missing = estimate;
    run_opts.threads = threads;
    // Rekordbox XML goes through the same pipeline as everything else.
    let summary = analyze::run_with(opts, run_opts, handler)?;
    bar.finish();
    print_summary(&summary, dry_run);
    Ok(())
}

fn cmd_scan(db: &Path, dirs: &[PathBuf], depth: Option<usize>, pipe: &PipeFlags) -> Result<()> {
    println!("Scanning {} folder(s)…", dirs.len());
    let scanned = scan_dirs(dirs, &ScanOptions { max_depth: depth });
    for bad in &scanned.bad_roots {
        eprintln!("  not a folder: {}", bad);
    }
    if scanned.unreadable > 0 {
        eprintln!(
            "  {} entries could not be read (permissions?)",
            scanned.unreadable
        );
    }
    if scanned.tracks.is_empty() {
        return Err(anyhow!("no audio files found"));
    }
    let total = scanned.tracks.len();
    let imported = Imported {
        tracks: scanned.tracks,
        ..Default::default()
    };
    run_import(db, imported, total, pipe)
}

fn cmd_import(
    db: &Path,
    kind: ImportKind,
    path: &Path,
    root: Option<&Path>,
    boot_volume: Option<String>,
    pipe: &PipeFlags,
) -> Result<()> {
    let imported = match kind {
        ImportKind::Traktor => {
            println!("Reading Traktor collection…");
            let mut o = TraktorOptions::default();
            if let Some(v) = boot_volume {
                o.boot_volume = v;
            }
            traktor::read_nml(path, &o)?
        }
        ImportKind::Serato => {
            println!("Reading Serato library…");
            serato::read_serato(path, root)?
        }
    };
    println!("  {} playlist(s)/crate(s) found", imported.playlists.len());
    let total = imported.tracks.len() + imported.no_location + imported.unparseable_uri;
    run_import(db, imported, total, pipe)
}

fn run_import(db: &Path, imported: Imported, total: usize, pipe: &PipeFlags) -> Result<()> {
    let (handler, bar) = progress_handler();
    let summary = analyze::run_imported(imported, total, &pipe.run_options(db), handler)?;
    bar.finish();
    print_summary(&summary, pipe.dry_run);
    Ok(())
}

fn export_rows(
    out: &Path,
    default_name: &str,
    playlist_name: Option<&str>,
    rows: &[TrackRow],
    fmt: &ExportFlags,
) -> Result<()> {
    let format = fmt.format_for(out)?;
    let name = resolve_playlist_name(playlist_name, out, default_name);
    let report = write_playlist(format, out, &name, rows, &fmt.options())?;
    println!(
        "\nWrote {} track(s) to {} (playlist: \"{}\", format: {})",
        report.written,
        out.display(),
        name,
        format.extension()
    );
    if report.skipped > 0 {
        println!(
            "  {} track(s) left out (no file path, or outside --serato-root)",
            report.skipped
        );
    }
    Ok(())
}

fn cmd_export(
    db: &Path,
    out: &Path,
    playlist: Option<&str>,
    genre: Option<&str>,
    sub_genre: Option<&str>,
    playlist_name: Option<&str>,
    fmt: &ExportFlags,
) -> Result<()> {
    let store = Store::open(db)?;
    let mut rows = match playlist {
        Some(name) => {
            let rows = store.playlist_rows(name)?;
            if rows.is_empty() {
                let names: Vec<String> = store
                    .list_playlists()?
                    .into_iter()
                    .map(|(n, _, _)| n)
                    .collect();
                return Err(anyhow!(
                    "playlist `{}` has no analyzed tracks. known playlists: {}",
                    name,
                    if names.is_empty() {
                        "(none — run `import` first)".to_string()
                    } else {
                        names.join(", ")
                    }
                ));
            }
            rows
        }
        None => store.list_all()?,
    };
    let contains = |hay: &str, needle: &str| hay.to_lowercase().contains(&needle.to_lowercase());
    if let Some(g) = genre {
        rows.retain(|r| contains(&r.genre, g));
    }
    if let Some(sg) = sub_genre {
        rows.retain(|r| {
            r.sub_genre
                .as_deref()
                .map(|s| contains(s, sg))
                .unwrap_or(false)
        });
    }
    if rows.is_empty() {
        println!("nothing to export — no tracks match.");
        return Ok(());
    }
    export_rows(out, "export", playlist_name.or(playlist), &rows, fmt)
}

fn cmd_playlists(db: &Path, show: Option<&str>) -> Result<()> {
    let store = Store::open(db)?;
    if let Some(name) = show {
        let rows = store.playlist_rows(name)?;
        if rows.is_empty() {
            println!("no analyzed tracks in `{}`.", name);
            return Ok(());
        }
        let stats = store.stats()?;
        print_table(
            &rows,
            stats.min_energy.unwrap_or(0.0),
            stats.max_energy.unwrap_or(1.0),
        );
        return Ok(());
    }
    let lists = store.list_playlists()?;
    if lists.is_empty() {
        println!("no playlists yet — `track2mix import traktor|serato …` brings them in.");
        return Ok(());
    }
    for (name, source, n) in lists {
        println!("{:<8} {:>5}  {}", source, n, name);
    }
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
    fmt: &ExportFlags,
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
        export_rows(out, "top", playlist_name, &rows, fmt)?;
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
    fmt: &ExportFlags,
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
        export_rows(out, &default, playlist_name, &compatible, fmt)?;
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
