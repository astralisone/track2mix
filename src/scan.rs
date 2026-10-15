//! Walk directories for audio files and read their embedded tags.

use anyhow::{anyhow, Result};
use lofty::prelude::*;
use lofty::tag::ItemKey;
use rayon::prelude::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::keys::Camelot;
use crate::source::{path_track_id, SourceTrack};

/// Containers/codecs symphonia can decode. (Opus and WMA are not among them,
/// so they're left out rather than reported as failures on every scan.)
pub const AUDIO_EXTS: &[&str] = &[
    "mp3", "flac", "wav", "wave", "aif", "aiff", "aifc", "m4a", "mp4", "aac", "ogg", "oga",
];

pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Default)]
pub struct ScanOptions {
    /// Maximum directory depth below each root (`None` = unlimited).
    pub max_depth: Option<usize>,
}

#[derive(Debug, Default)]
pub struct ScanResult {
    pub tracks: Vec<SourceTrack>,
    /// Roots that don't exist or aren't directories.
    pub bad_roots: Vec<String>,
    /// Directory entries we couldn't read (permissions, vanished files).
    pub unreadable: usize,
    /// Files that were already seen via another root.
    pub duplicates: usize,
}

/// Directories that never hold a music library but can be huge.
fn skip_dir_name(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("$RECYCLE.BIN")
        || name.eq_ignore_ascii_case("System Volume Information")
        || name.eq_ignore_ascii_case("node_modules")
}

pub fn scan_dirs(roots: &[PathBuf], opts: &ScanOptions) -> ScanResult {
    let mut result = ScanResult::default();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut files: Vec<PathBuf> = Vec::new();

    for root in roots {
        let canon = match std::fs::canonicalize(root) {
            Ok(p) if p.is_dir() => p,
            _ => {
                result.bad_roots.push(root.display().to_string());
                continue;
            }
        };
        let mut walker = WalkDir::new(&canon).follow_links(false);
        if let Some(d) = opts.max_depth {
            walker = walker.max_depth(d.max(1));
        }
        let iter = walker.into_iter().filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                !skip_dir_name(&name)
            } else {
                // Hidden files, including macOS AppleDouble `._foo.mp3` stubs.
                !name.starts_with('.')
            }
        });
        for entry in iter {
            match entry {
                Ok(e) if e.file_type().is_file() && is_audio_file(e.path()) => {
                    let p = e.into_path();
                    if seen.insert(p.clone()) {
                        files.push(p);
                    } else {
                        result.duplicates += 1;
                    }
                }
                Ok(_) => {}
                Err(_) => result.unreadable += 1,
            }
        }
    }

    // Tag reads touch every file header, which is slow on spinning disks and
    // network shares; do them in parallel but on the capped analysis pool.
    let mut tracks: Vec<SourceTrack> = crate::analyze::with_pool(None, || {
        files.par_iter().map(|p| track_from_file(p)).collect()
    });
    tracks.sort_by(|a, b| a.path.cmp(&b.path));
    result.tracks = tracks;
    result
}

/// Tags we care about, as the file spells them.
#[derive(Debug, Default, Clone)]
pub struct Tags {
    pub title: String,
    pub artist: String,
    pub genre: String,
    pub label: String,
    pub bpm: Option<f32>,
    pub key: String,
}

pub fn read_tags(path: &Path) -> Result<Tags> {
    let tagged = lofty::read_from_path(path).map_err(|e| anyhow!("{}", e))?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(Tags::default());
    };
    let text = |k: ItemKey| {
        tag.get_string(k)
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    Ok(Tags {
        title: tag
            .title()
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        artist: tag
            .artist()
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        genre: tag
            .genre()
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        label: text(ItemKey::Label),
        // ID3v2 `TBPM` and MP4 `tmpo` are integer-only; Vorbis/APE carry decimals.
        bpm: parse_bpm(&text(ItemKey::Bpm)).or_else(|| parse_bpm(&text(ItemKey::IntegerBpm))),
        key: text(ItemKey::InitialKey),
    })
}

/// "174", "174.00", "87,5" → Some(f32). Zero and nonsense → None.
pub fn parse_bpm(s: &str) -> Option<f32> {
    let v: f32 = s.trim().replace(',', ".").parse().ok()?;
    (v.is_finite() && (20.0..=400.0).contains(&v)).then_some(v)
}

/// Build a `SourceTrack` for a file from its tags, falling back to the file
/// name when it has none. Unreadable tags are not an error: the audio may
/// still decode.
pub fn track_from_file(path: &Path) -> SourceTrack {
    let tags = read_tags(path).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // Only keep a key tag we can actually interpret.
    let key = if Camelot::parse(&tags.key).is_some() {
        tags.key
    } else {
        String::new()
    };
    SourceTrack {
        track_id: path_track_id("scan", path),
        name: if tags.title.is_empty() {
            stem
        } else {
            tags.title
        },
        artist: tags.artist,
        genre: tags.genre,
        label: tags.label,
        bpm: tags.bpm,
        tonality: key,
        rating: 0,
        play_count: 0,
        path: path.to_path_buf(),
    }
}
