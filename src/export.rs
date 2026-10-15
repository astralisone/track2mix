use anyhow::{Context, Result};
use std::io::Write;
use std::path::Path;

use crate::serato;
use crate::source::apply_path_map;
use crate::store::TrackRow;
use crate::traktor::{self, TraktorOptions};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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

// ───────────────────────── multi-format export ─────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// Rekordbox (and most players): `.m3u8`
    M3u8,
    /// Traktor collection with one playlist: `.nml`
    Traktor,
    /// Serato crate: `.crate`
    Serato,
}

impl ExportFormat {
    pub fn from_extension(path: &Path) -> Option<Self> {
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "m3u8" | "m3u" => Some(Self::M3u8),
            "nml" => Some(Self::Traktor),
            "crate" => Some(Self::Serato),
            _ => None,
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "m3u8" | "m3u" | "rekordbox" => Some(Self::M3u8),
            "traktor" | "nml" => Some(Self::Traktor),
            "serato" | "crate" => Some(Self::Serato),
            _ => None,
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::M3u8 => "m3u8",
            Self::Traktor => "nml",
            Self::Serato => "crate",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ExportOptions {
    /// Traktor volume name for paths that aren't on a named volume.
    pub traktor_volume: Option<String>,
    /// Serato: drive root the crate's relative paths are anchored at.
    /// `None` = strip the leading `/` or drive letter (home-drive library).
    pub serato_root: Option<PathBuf>,
    /// Rewrite path prefixes on the way out (`OLD=NEW`), e.g. when the files
    /// live at a different place on the machine that will open the export.
    pub path_map: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ExportReport {
    pub written: usize,
    /// Tracks left out: no file path, or outside the Serato root.
    pub skipped: usize,
}

pub fn write_playlist(
    format: ExportFormat,
    out: &Path,
    playlist_name: &str,
    rows: &[TrackRow],
    opts: &ExportOptions,
) -> Result<ExportReport> {
    let mapped: Vec<TrackRow> = rows
        .iter()
        .map(|r| {
            let mut r = r.clone();
            if let Some(p) = r.file_path.take() {
                r.file_path = Some(
                    apply_path_map(PathBuf::from(p), &opts.path_map)
                        .to_string_lossy()
                        .to_string(),
                );
            }
            r
        })
        .collect();

    let written = match format {
        ExportFormat::M3u8 => write_m3u8(out, playlist_name, &mapped)?,
        ExportFormat::Traktor => {
            let mut t = TraktorOptions::default();
            if let Some(v) = &opts.traktor_volume {
                t.boot_volume = v.clone();
            }
            traktor::write_nml(out, playlist_name, &mapped, &t)?
        }
        ExportFormat::Serato => {
            let (w, _) = serato::write_crate(out, &mapped, opts.serato_root.as_deref())?;
            w
        }
    };
    Ok(ExportReport {
        written,
        skipped: rows.len() - written,
    })
}
