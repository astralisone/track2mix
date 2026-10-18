use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, Row};
use std::path::Path;

use crate::features::Features;
use crate::rekordbox::Track;

pub struct Store {
    conn: Connection,
}

#[derive(Debug, Clone)]
pub struct TrackRow {
    pub track_id: String,
    pub name: String,
    pub artist: String,
    pub genre: String,
    pub sub_genre: Option<String>,
    pub bpm: Option<f32>,
    pub tonality: String,
    pub energy: Option<f32>,
    pub file_path: Option<String>,
}

/// The parent directory name of the given file path. Used as a "sub-genre"
/// proxy when the Rekordbox `Genre` tag is flat (e.g. all DnB tracks tagged
/// plain "Drum & Bass") but the user organises into genre folders on disk.
fn parent_folder_name(file_path: &str) -> Option<String> {
    std::path::Path::new(file_path)
        .parent()?
        .file_name()?
        .to_str()
        .map(|s| s.to_string())
}

#[derive(Debug, Clone, Default)]
pub struct DbStats {
    pub total: i64,
    pub analyzed: i64,
    pub avg_bpm: Option<f32>,
    pub avg_energy: Option<f32>,
    pub min_energy: Option<f32>,
    pub max_energy: Option<f32>,
    pub distinct_genres: i64,
    pub distinct_keys: i64,
}

fn metric_column(metric: &str) -> Result<&'static str> {
    Ok(match metric {
        "energy" => "energy",
        "bpm" => "bpm",
        "rms" => "rms_mean",
        "centroid" => "spectral_centroid",
        "flux" => "spectral_flux",
        "onsets" => "onset_rate",
        "rating" => "rating",
        "plays" => "play_count",
        other => {
            return Err(anyhow!(
                "unknown metric `{}`. try: energy | bpm | rms | centroid | flux | onsets | rating | plays",
                other
            ));
        }
    })
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<TrackRow> {
    Ok(TrackRow {
        track_id: row.get(0)?,
        name: row.get(1)?,
        artist: row.get(2)?,
        genre: row.get(3)?,
        sub_genre: row.get(4)?,
        bpm: row.get(5)?,
        tonality: row.get(6)?,
        energy: row.get(7)?,
        file_path: row.get(8)?,
    })
}

const SELECT_COLS: &str =
    "track_id, name, artist, genre, sub_genre, bpm, tonality, energy, file_path";

/// For databases created before the `sub_genre` column existed, add it and
/// backfill any missing values from `file_path`. Safe to call on a fresh DB
/// too — the column-existence check prevents duplicate ALTERs.
fn migrate_sub_genre(conn: &Connection) -> Result<()> {
    let already: bool = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('tracks') WHERE name = 'sub_genre'",
        [],
        |r| r.get::<_, i64>(0),
    )? > 0;
    if !already {
        conn.execute("ALTER TABLE tracks ADD COLUMN sub_genre TEXT", [])?;
    }
    let to_backfill: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT track_id, file_path FROM tracks \
             WHERE sub_genre IS NULL AND file_path IS NOT NULL",
        )?;
        let collected = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        collected
    };
    if to_backfill.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for (track_id, file_path) in to_backfill {
        if let Some(sg) = parent_folder_name(&file_path) {
            tx.execute(
                "UPDATE tracks SET sub_genre = ?1 WHERE track_id = ?2",
                params![sg, track_id],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS tracks (
                track_id TEXT PRIMARY KEY,
                name TEXT,
                artist TEXT,
                genre TEXT,
                sub_genre TEXT,
                label TEXT,
                bpm REAL,
                tonality TEXT,
                rating INTEGER,
                play_count INTEGER,
                file_path TEXT,
                rms_mean REAL,
                rms_variance REAL,
                spectral_centroid REAL,
                spectral_flux REAL,
                onset_rate REAL,
                energy REAL,
                analyzed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_energy ON tracks(energy);
            CREATE INDEX IF NOT EXISTS idx_bpm ON tracks(bpm);
            CREATE INDEX IF NOT EXISTS idx_tonality ON tracks(tonality);
            "#,
        )?;
        migrate_sub_genre(&conn)?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sub_genre ON tracks(sub_genre)",
            [],
        )?;
        Ok(Self { conn })
    }

    pub fn upsert(&self, track: &Track, features: &Features, file_path: &str) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let sub_genre = parent_folder_name(file_path);

        self.conn.execute(
            r#"
            INSERT INTO tracks (
                track_id, name, artist, genre, sub_genre, label, bpm, tonality,
                rating, play_count, file_path,
                rms_mean, rms_variance, spectral_centroid, spectral_flux,
                onset_rate, energy, analyzed_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                ?12, ?13, ?14, ?15, ?16, ?17, ?18
            )
            ON CONFLICT(track_id) DO UPDATE SET
                name = excluded.name,
                artist = excluded.artist,
                genre = excluded.genre,
                sub_genre = excluded.sub_genre,
                label = excluded.label,
                bpm = excluded.bpm,
                tonality = excluded.tonality,
                rating = excluded.rating,
                play_count = excluded.play_count,
                file_path = excluded.file_path,
                rms_mean = excluded.rms_mean,
                rms_variance = excluded.rms_variance,
                spectral_centroid = excluded.spectral_centroid,
                spectral_flux = excluded.spectral_flux,
                onset_rate = excluded.onset_rate,
                energy = excluded.energy,
                analyzed_at = excluded.analyzed_at
            "#,
            params![
                track.track_id,
                track.name,
                track.artist,
                track.genre,
                sub_genre,
                track.label,
                track.bpm_f32(),
                track.tonality,
                track.rating_u8(),
                track.play_count.parse::<i64>().unwrap_or(0),
                file_path,
                features.rms_mean,
                features.rms_variance,
                features.spectral_centroid_mean,
                features.spectral_flux_mean,
                features.onset_rate,
                features.energy,
                now,
            ],
        )?;
        Ok(())
    }

    pub fn already_analyzed(&self, track_id: &str) -> bool {
        self.conn
            .query_row(
                "SELECT 1 FROM tracks WHERE track_id = ?1 AND analyzed_at IS NOT NULL",
                params![track_id],
                |_| Ok(()),
            )
            .is_ok()
    }

    /// Top-N tracks sorted by a named feature. `genre` and `sub_genre` are
    /// case-insensitive substring filters (the latter matches the track's
    /// parent-directory name). `asc` flips the sort direction.
    pub fn top_by(
        &self,
        metric: &str,
        limit: usize,
        genre: Option<&str>,
        sub_genre: Option<&str>,
        asc: bool,
    ) -> Result<Vec<TrackRow>> {
        let col = metric_column(metric)?;
        let order = if asc { "ASC" } else { "DESC" };
        let genre_pat = genre
            .map(|g| format!("%{}%", g))
            .unwrap_or_else(|| "%".into());
        match sub_genre {
            Some(sg) => {
                let sg_pat = format!("%{}%", sg);
                let sql = format!(
                    "SELECT {SELECT_COLS} \
                     FROM tracks \
                     WHERE genre LIKE ?1 AND sub_genre LIKE ?2 AND {col} IS NOT NULL \
                     ORDER BY {col} {order} \
                     LIMIT ?3"
                );
                let mut stmt = self.conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(params![genre_pat, sg_pat, limit as i64], map_row)?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            }
            None => {
                let sql = format!(
                    "SELECT {SELECT_COLS} \
                     FROM tracks \
                     WHERE genre LIKE ?1 AND {col} IS NOT NULL \
                     ORDER BY {col} {order} \
                     LIMIT ?2"
                );
                let mut stmt = self.conn.prepare(&sql)?;
                let rows = stmt
                    .query_map(params![genre_pat, limit as i64], map_row)?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            }
        }
    }

    /// Load every analyzed track into memory. Cheap for libraries up to
    /// hundreds of thousands of rows (one row is ~300 bytes).
    pub fn list_all(&self) -> Result<Vec<TrackRow>> {
        let sql = format!(
            "SELECT {SELECT_COLS} FROM tracks \
             WHERE analyzed_at IS NOT NULL \
             ORDER BY name ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt
            .query_map([], map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Fuzzy name/artist substring search. Ranked by rating then play count so
    /// ambiguous queries favour your most-used track.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<TrackRow>> {
        let pat = format!("%{}%", query);
        let sql = format!(
            "SELECT {SELECT_COLS} \
             FROM tracks \
             WHERE name LIKE ?1 OR artist LIKE ?1 \
             ORDER BY rating DESC, play_count DESC, name ASC \
             LIMIT ?2"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params![pat, limit as i64], map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Analyzed tracks whose BPM is in `[bpm_min, bpm_max]`, excluding `exclude_id`.
    pub fn in_bpm_range(
        &self,
        bpm_min: f32,
        bpm_max: f32,
        exclude_id: &str,
    ) -> Result<Vec<TrackRow>> {
        let sql = format!(
            "SELECT {SELECT_COLS} \
             FROM tracks \
             WHERE bpm BETWEEN ?1 AND ?2 AND track_id <> ?3 \
             ORDER BY energy DESC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params![bpm_min, bpm_max, exclude_id], map_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn stats(&self) -> Result<DbStats> {
        let mut s = DbStats::default();
        self.conn.query_row(
            "SELECT
                COUNT(*),
                COUNT(analyzed_at),
                AVG(bpm),
                AVG(energy),
                MIN(energy),
                MAX(energy),
                COUNT(DISTINCT genre),
                COUNT(DISTINCT tonality)
             FROM tracks",
            [],
            |row| {
                s.total = row.get(0)?;
                s.analyzed = row.get(1)?;
                s.avg_bpm = row.get(2)?;
                s.avg_energy = row.get(3)?;
                s.min_energy = row.get(4)?;
                s.max_energy = row.get(5)?;
                s.distinct_genres = row.get(6)?;
                s.distinct_keys = row.get(7)?;
                Ok(())
            },
        )?;
        Ok(s)
    }
}
