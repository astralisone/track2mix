use anyhow::{Context, Result};
use std::io::Write;
use std::path::Path;

use crate::store::TrackRow;

/// Map a raw energy feature to a 0..=10 integer, normalised across the
/// library's observed min/max. This lets the scale use its full range even
/// when raw values cluster in a narrow slice.
pub fn energy_score(raw: f32, lib_min: f32, lib_max: f32) -> u8 {
    let range = lib_max - lib_min;
    let normalised = if range > 1e-6 {
        (raw - lib_min) / range
    } else {
        raw
    };
    (normalised * 10.0).round().clamp(0.0, 10.0) as u8
}

/// Write an M3U8 playlist that Rekordbox (and other DJ apps) can import.
/// Skips rows with no writable file path; returns the count actually written.
pub fn write_m3u8(out: &Path, playlist_name: &str, rows: &[TrackRow]) -> Result<usize> {
    let mut file = create_out(out)?;
    writeln!(file, "#EXTM3U")?;
    writeln!(file, "#PLAYLIST:{}", sanitize_extinf(playlist_name))?;
    let mut written = 0usize;
    for r in rows {
        let Some(path) = playable_path(r) else {
            continue;
        };
        writeln!(
            file,
            "#EXTINF:-1,{} - {}",
            sanitize_extinf(&r.artist),
            sanitize_extinf(&r.name)
        )?;
        writeln!(file, "{}", path)?;
        written += 1;
    }
    Ok(written)
}

/// The row's file path, if it can be written as a single playlist line. A
/// path containing a line break (legal on Linux) would split the entry, and
/// rewriting it would point at the wrong file, so such rows are skipped.
fn playable_path(r: &TrackRow) -> Option<&str> {
    r.file_path
        .as_deref()
        .filter(|p| !p.is_empty() && !p.contains(['\r', '\n']))
}

fn sanitize_extinf(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

/// Check the destination's parent exists, then create the file.
fn create_out(out: &Path) -> Result<std::fs::File> {
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(anyhow::anyhow!(
                "output directory does not exist: {}",
                parent.display()
            ));
        }
    }
    std::fs::File::create(out).with_context(|| format!("creating {}", out.display()))
}

/// Write a plain M3U: one file path per line, no `#EXT` directives. The most
/// portable playlist shape — every player and DJ app reads it.
/// Skips rows with no resolvable file path; returns the count actually written.
pub fn write_m3u_plain(out: &Path, rows: &[TrackRow]) -> Result<usize> {
    let mut file = create_out(out)?;
    let mut written = 0usize;
    for r in rows {
        let Some(path) = playable_path(r) else {
            continue;
        };
        writeln!(file, "{}", path)?;
        written += 1;
    }
    Ok(written)
}

/// Write a human-readable tracklist: a title line, then one numbered
/// `Artist - Title` line per track. Every row is written, with or without a
/// file path, since the list is for reading rather than importing.
pub fn write_tracklist_txt(out: &Path, playlist_name: &str, rows: &[TrackRow]) -> Result<usize> {
    let mut file = create_out(out)?;
    writeln!(file, "{}", sanitize_extinf(playlist_name))?;
    writeln!(file)?;
    let width = rows.len().to_string().len().max(2);
    for (i, r) in rows.iter().enumerate() {
        writeln!(
            file,
            "{:0width$}. {} - {}",
            i + 1,
            sanitize_extinf(&r.artist),
            sanitize_extinf(&r.name),
            width = width
        )?;
    }
    Ok(rows.len())
}
