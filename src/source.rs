//! A source-neutral track record. Rekordbox XML, Traktor NML, Serato
//! databases and plain directory scans all reduce to this before analysis,
//! so the analysis pipeline and the store don't care where a track came from.

use std::path::{Path, PathBuf};

use crate::rekordbox;

#[derive(Debug, Clone, Default)]
pub struct SourceTrack {
    pub track_id: String,
    pub name: String,
    pub artist: String,
    pub genre: String,
    pub label: String,
    pub bpm: Option<f32>,
    /// Raw key string as the source wrote it (Camelot, Open Key or classical).
    pub tonality: String,
    /// 0..=5 stars.
    pub rating: u8,
    pub play_count: i64,
    pub path: PathBuf,
}

impl SourceTrack {
    pub fn from_rekordbox(t: &rekordbox::Track, path: PathBuf) -> Self {
        SourceTrack {
            track_id: t.track_id.clone(),
            name: t.name.clone(),
            artist: t.artist.clone(),
            genre: t.genre.clone(),
            label: t.label.clone(),
            bpm: t.bpm_f32().filter(|b| *b > 0.0),
            tonality: t.tonality.clone(),
            rating: t.rating_u8(),
            play_count: t.play_count.parse::<i64>().unwrap_or(0),
            path,
        }
    }
}

/// A playlist / crate pulled out of another app, referencing tracks by file
/// path (ids differ between apps, paths don't).
#[derive(Debug, Clone)]
pub struct Playlist {
    pub name: String,
    pub source: &'static str,
    pub paths: Vec<PathBuf>,
}

/// What an importer hands back before the shared pipeline resolves paths and
/// analyses audio.
#[derive(Debug, Default)]
pub struct Imported {
    pub tracks: Vec<SourceTrack>,
    pub playlists: Vec<Playlist>,
    /// Entries the importer had to drop because they had no usable location.
    pub no_location: usize,
    pub unparseable_uri: usize,
}

/// Stable id for tracks that have no id of their own: FNV-1a over the path
/// bytes. Deterministic across runs and platforms (unlike `DefaultHasher`).
pub fn path_track_id(prefix: &str, path: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in path.to_string_lossy().as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{}:{:016x}", prefix, h)
}

/// Rewrite a path prefix (`OLD=NEW` pairs), first match wins.
pub fn apply_path_map(path: PathBuf, path_map: &[(String, String)]) -> PathBuf {
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

/// 0..=255 rating (Traktor `RANKING`, Rekordbox `Rating`) → 0..=5 stars.
pub fn stars_from_255(v: u32) -> u8 {
    match v {
        0 => 0,
        1..=51 => 1,
        52..=102 => 2,
        103..=153 => 3,
        154..=204 => 4,
        _ => 5,
    }
}
