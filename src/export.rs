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
/// Skips rows with no resolvable file path; returns the count actually written.
pub fn write_m3u8(out: &Path, playlist_name: &str, rows: &[TrackRow]) -> Result<usize> {
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(anyhow::anyhow!(
                "output directory does not exist: {}",
                parent.display()
            ));
        }
    }
    let mut file =
        std::fs::File::create(out).with_context(|| format!("creating {}", out.display()))?;
    writeln!(file, "#EXTM3U")?;
    writeln!(file, "#PLAYLIST:{}", playlist_name)?;
    let mut written = 0usize;
    for r in rows {
        let Some(path) = r.file_path.as_deref() else {
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

fn sanitize_extinf(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}
