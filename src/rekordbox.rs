use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
#[serde(rename = "DJ_PLAYLISTS")]
pub struct RekordboxXml {
    #[serde(rename = "COLLECTION")]
    pub collection: Collection,
}

#[derive(Debug, Deserialize)]
pub struct Collection {
    #[serde(rename = "TRACK", default)]
    pub tracks: Vec<Track>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Track {
    #[serde(rename = "@TrackID")]
    pub track_id: String,
    #[serde(rename = "@Name", default)]
    pub name: String,
    #[serde(rename = "@Artist", default)]
    pub artist: String,
    #[serde(rename = "@Genre", default)]
    pub genre: String,
    #[serde(rename = "@AverageBpm", default)]
    pub bpm: String,
    #[serde(rename = "@Tonality", default)]
    pub tonality: String,
    #[serde(rename = "@Rating", default)]
    pub rating: String,
    #[serde(rename = "@PlayCount", default)]
    pub play_count: String,
    #[serde(rename = "@Location", default)]
    pub location: String,
    #[serde(rename = "@Label", default)]
    pub label: String,
}

impl Track {
    /// Rekordbox stores paths as file:// URIs with URL encoding and a
    /// "localhost" host component. We need a real filesystem path.
    pub fn resolve_path(&self) -> Option<PathBuf> {
        let loc = &self.location;
        let stripped = loc
            .strip_prefix("file://localhost")
            .or_else(|| loc.strip_prefix("file://"))?;
        let decoded = urlencoding::decode(stripped).ok()?;
        Some(PathBuf::from(decoded.into_owned()))
    }

    pub fn bpm_f32(&self) -> Option<f32> {
        self.bpm.parse().ok()
    }

    pub fn rating_u8(&self) -> u8 {
        // Rekordbox uses 0, 51, 102, 153, 204, 255 for 0-5 stars
        match self.rating.parse::<u32>().unwrap_or(0) {
            0 => 0,
            1..=51 => 1,
            52..=102 => 2,
            103..=153 => 3,
            154..=204 => 4,
            _ => 5,
        }
    }
}

pub fn parse(path: &std::path::Path) -> Result<RekordboxXml> {
    let xml =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let parsed: RekordboxXml = quick_xml::de::from_str(&xml).context("parsing Rekordbox XML")?;
    Ok(parsed)
}
