//! Traktor collection (NML) import and export.
//!
//! NML is XML. A track lives in `COLLECTION/ENTRY` with its file split across
//! `LOCATION` attributes: `VOLUME` (disk name on macOS, `C:` on Windows),
//! `DIR` (path with `/:` as the separator, e.g. `/:Users/:me/:Music/:`) and
//! `FILE`. Playlists reference tracks by `VOLUME + DIR + FILE`.
//!
//! The export writes a minimal but complete NML (collection + one playlist),
//! meant for Traktor's *Import Another Collection*. It has been checked
//! against the structure real NML files use and round-trips through our own
//! reader, but not against a running copy of Traktor.

use anyhow::{anyhow, Context, Result};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::keys::Camelot;
use crate::source::{path_track_id, stars_from_255, Imported, Playlist, SourceTrack};
use crate::store::TrackRow;

#[derive(Debug, Clone)]
pub struct TraktorOptions {
    /// Name of the boot volume as Traktor records it on macOS. Paths on other
    /// volumes map to `/Volumes/<name>`.
    pub boot_volume: String,
}

impl Default for TraktorOptions {
    fn default() -> Self {
        Self {
            boot_volume: "Macintosh HD".to_string(),
        }
    }
}

// ───────────────────────────── paths ─────────────────────────────

fn is_drive_letter(volume: &str) -> bool {
    let b = volume.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// NML (`volume`, `dir`, `file`) → filesystem path.
pub fn nml_to_path(volume: &str, dir: &str, file: &str, boot_volume: &str) -> PathBuf {
    let mut rel = format!("{}{}", dir, file).replace("/:", "/");
    if !rel.starts_with('/') {
        rel.insert(0, '/');
    }
    let full = if is_drive_letter(volume) {
        format!("{}{}", volume, rel)
    } else if volume.is_empty() || volume == boot_volume {
        rel
    } else {
        format!("/Volumes/{}{}", volume, rel)
    };
    PathBuf::from(full)
}

/// Filesystem path → NML (`volume`, `dir`, `file`). `default_volume` is used
/// for plain unix paths that aren't under `/Volumes/<disk>`.
pub fn path_to_nml(path: &str, default_volume: &str) -> (String, String, String) {
    let p = path.replace('\\', "/");
    let (volume, rest): (String, String) = {
        let b = p.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            (p[..2].to_string(), p[2..].to_string())
        } else if let Some(r) = p.strip_prefix("/Volumes/") {
            match r.split_once('/') {
                Some((disk, tail)) => (disk.to_string(), format!("/{}", tail)),
                None => (r.to_string(), "/".to_string()),
            }
        } else {
            (default_volume.to_string(), p.clone())
        }
    };
    let rest = if rest.starts_with('/') {
        rest
    } else {
        format!("/{}", rest)
    };
    let (dir_part, file) = match rest.rfind('/') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => ("", rest.as_str()),
    };
    let mut dir = String::new();
    for comp in dir_part.split('/').filter(|c| !c.is_empty()) {
        dir.push_str("/:");
        dir.push_str(comp);
    }
    dir.push_str("/:");
    (volume, dir, file.to_string())
}

// ───────────────────────────── import ─────────────────────────────

#[derive(Default)]
struct Entry {
    title: String,
    artist: String,
    volume: String,
    dir: String,
    file: String,
    genre: String,
    label: String,
    key: String,
    ranking: u32,
    playcount: i64,
    bpm: Option<f32>,
    musical_key: Option<u8>,
}

fn attr_map(e: &BytesStart<'_>) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for a in e.attributes().with_checks(false).flatten() {
        let key = String::from_utf8_lossy(a.key.as_ref()).to_string();
        let val = match a.unescape_value() {
            Ok(v) => v.to_string(),
            Err(_) => String::from_utf8_lossy(&a.value).to_string(),
        };
        m.insert(key, val);
    }
    m
}

pub fn read_nml(path: &Path, opts: &TraktorOptions) -> Result<Imported> {
    let mut reader =
        Reader::from_file(path).with_context(|| format!("opening {}", path.display()))?;
    {
        let cfg = reader.config_mut();
        cfg.check_end_names = false;
        cfg.trim_text(true);
    }

    let mut out = Imported::default();
    let mut by_key: HashMap<String, PathBuf> = HashMap::new();
    let mut raw_playlists: Vec<(String, Vec<String>)> = Vec::new();

    let mut in_collection = false;
    let mut entry: Option<Entry> = None;
    let mut pending_name: Option<String> = None;
    let mut playlist: Option<(String, Vec<String>)> = None;
    let mut saw_nml = false;

    let mut buf = Vec::new();
    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .with_context(|| format!("parsing NML at byte {}", reader.buffer_position()))?;
        match ev {
            Event::Eof => break,
            Event::Start(ref e) | Event::Empty(ref e) => {
                let is_empty = matches!(ev, Event::Empty(_));
                match e.name().as_ref() {
                    b"NML" => saw_nml = true,
                    b"COLLECTION" => in_collection = !is_empty,
                    b"ENTRY" if in_collection => {
                        let a = attr_map(e);
                        let cur = Entry {
                            title: a.get("TITLE").cloned().unwrap_or_default(),
                            artist: a.get("ARTIST").cloned().unwrap_or_default(),
                            ..Default::default()
                        };
                        if is_empty {
                            out.no_location += 1;
                        } else {
                            entry = Some(cur);
                        }
                    }
                    b"LOCATION" => {
                        if let Some(cur) = entry.as_mut() {
                            let a = attr_map(e);
                            cur.volume = a.get("VOLUME").cloned().unwrap_or_default();
                            cur.dir = a.get("DIR").cloned().unwrap_or_default();
                            cur.file = a.get("FILE").cloned().unwrap_or_default();
                        }
                    }
                    b"INFO" => {
                        if let Some(cur) = entry.as_mut() {
                            let a = attr_map(e);
                            cur.genre = a.get("GENRE").cloned().unwrap_or_default();
                            cur.label = a.get("LABEL").cloned().unwrap_or_default();
                            cur.key = a.get("KEY").cloned().unwrap_or_default();
                            cur.ranking = a
                                .get("RANKING")
                                .and_then(|v| v.trim().parse().ok())
                                .unwrap_or(0);
                            cur.playcount = a
                                .get("PLAYCOUNT")
                                .and_then(|v| v.trim().parse().ok())
                                .unwrap_or(0);
                        }
                    }
                    b"TEMPO" => {
                        if let Some(cur) = entry.as_mut() {
                            cur.bpm = attr_map(e)
                                .get("BPM")
                                .and_then(|v| v.trim().parse::<f32>().ok())
                                .filter(|b| *b > 0.0);
                        }
                    }
                    b"MUSICAL_KEY" => {
                        if let Some(cur) = entry.as_mut() {
                            cur.musical_key = attr_map(e)
                                .get("VALUE")
                                .and_then(|v| v.trim().parse::<u8>().ok())
                                .filter(|v| *v < 24);
                        }
                    }
                    b"NODE" => {
                        let a = attr_map(e);
                        if a.get("TYPE").map(String::as_str) == Some("PLAYLIST") {
                            pending_name = a.get("NAME").cloned();
                        }
                    }
                    b"PLAYLIST" if !is_empty => {
                        playlist = Some((
                            pending_name
                                .take()
                                .unwrap_or_else(|| "Untitled".to_string()),
                            Vec::new(),
                        ));
                    }
                    b"PRIMARYKEY" => {
                        if let Some((_, keys)) = playlist.as_mut() {
                            if let Some(k) = attr_map(e).get("KEY") {
                                keys.push(k.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
            Event::End(ref e) => match e.name().as_ref() {
                b"COLLECTION" => in_collection = false,
                b"ENTRY" if in_collection => {
                    if let Some(cur) = entry.take() {
                        if cur.file.is_empty() {
                            out.no_location += 1;
                        } else {
                            let key = format!("{}{}{}", cur.volume, cur.dir, cur.file);
                            let p =
                                nml_to_path(&cur.volume, &cur.dir, &cur.file, &opts.boot_volume);
                            by_key.insert(key, p.clone());
                            out.tracks.push(track_from_entry(cur, p));
                        }
                    }
                }
                b"PLAYLIST" => {
                    if let Some(pl) = playlist.take() {
                        raw_playlists.push(pl);
                    }
                }
                _ => {}
            },
            _ => {}
        }
        buf.clear();
    }

    if !saw_nml {
        return Err(anyhow!("{} is not a Traktor NML file", path.display()));
    }

    for (name, keys) in raw_playlists {
        let paths: Vec<PathBuf> = keys
            .iter()
            .filter_map(|k| {
                by_key.get(k).cloned().or_else(|| {
                    // Key not in the collection (track removed, or a different
                    // collection): rebuild the path from the key itself.
                    let (volume, rest) = k.split_once("/:")?;
                    Some(nml_to_path(
                        volume,
                        "",
                        &format!("/:{}", rest),
                        &opts.boot_volume,
                    ))
                })
            })
            .collect();
        out.playlists.push(Playlist {
            name,
            source: "traktor",
            paths,
        });
    }
    Ok(out)
}

fn track_from_entry(e: Entry, path: PathBuf) -> SourceTrack {
    let tonality = Camelot::parse(&e.key)
        .or_else(|| {
            e.musical_key.map(|v| {
                if v < 12 {
                    Camelot::from_tonic(v, true)
                } else {
                    Camelot::from_tonic(v - 12, false)
                }
            })
        })
        .map(|c| c.to_string())
        .unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    SourceTrack {
        track_id: path_track_id("traktor", &path),
        name: if e.title.trim().is_empty() {
            stem
        } else {
            e.title
        },
        artist: e.artist,
        genre: e.genre,
        label: e.label,
        bpm: e.bpm,
        tonality,
        rating: stars_from_255(e.ranking),
        play_count: e.playcount,
        path,
    }
}

// ───────────────────────────── export ─────────────────────────────

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            '\r' | '\n' | '\t' => o.push(' '),
            c if (c as u32) < 0x20 => {}
            c => o.push(c),
        }
    }
    o
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{}/{}/{}", y, m, d)
}

fn uuid_like(seed: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut out = String::new();
    for round in 0..2u8 {
        for b in seed.bytes().chain([round]) {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        out.push_str(&format!("{:016x}", h));
    }
    out
}

/// Traktor `MUSICAL_KEY`: 0–11 are the major keys C, Db, D … B; 12–23 the
/// minor keys c, c#, d … b.
fn musical_key_value(c: &Camelot) -> u8 {
    let (pc, major) = c.tonic();
    if major {
        pc
    } else {
        12 + pc
    }
}

pub fn write_nml(
    out: &Path,
    playlist_name: &str,
    rows: &[TrackRow],
    opts: &TraktorOptions,
) -> Result<usize> {
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(anyhow!(
                "output directory does not exist: {}",
                parent.display()
            ));
        }
    }
    let date = today();
    let mut entries = String::new();
    let mut keys: Vec<String> = Vec::new();

    for r in rows {
        let Some(path) = r.file_path.as_deref() else {
            continue;
        };
        let (volume, dir, file) = path_to_nml(path, &opts.boot_volume);
        let camelot = Camelot::parse(&r.tonality);
        entries.push_str(&format!(
            "<ENTRY MODIFIED_DATE=\"{date}\" MODIFIED_TIME=\"0\" TITLE=\"{title}\" ARTIST=\"{artist}\">\n",
            date = date,
            title = esc(&r.name),
            artist = esc(&r.artist),
        ));
        entries.push_str(&format!(
            "<LOCATION DIR=\"{}\" FILE=\"{}\" VOLUME=\"{}\" VOLUMEID=\"{}\"></LOCATION>\n",
            esc(&dir),
            esc(&file),
            esc(&volume),
            esc(&volume),
        ));
        entries.push_str("<MODIFICATION_INFO AUTHOR_TYPE=\"user\"></MODIFICATION_INFO>\n");
        entries.push_str(&format!(
            "<INFO GENRE=\"{}\" LABEL=\"{}\" KEY=\"{}\" PLAYCOUNT=\"{}\" RANKING=\"{}\" IMPORT_DATE=\"{}\"></INFO>\n",
            esc(&r.genre),
            esc(&r.label),
            camelot.map(|c| c.to_open_key()).unwrap_or_default(),
            r.play_count.max(0),
            (r.rating.min(5) as u32) * 51,
            date,
        ));
        if let Some(bpm) = r.bpm.filter(|b| *b > 0.0) {
            entries.push_str(&format!(
                "<TEMPO BPM=\"{:.6}\" BPM_QUALITY=\"100\"></TEMPO>\n",
                bpm
            ));
        }
        if let Some(c) = camelot {
            entries.push_str(&format!(
                "<MUSICAL_KEY VALUE=\"{}\"></MUSICAL_KEY>\n",
                musical_key_value(&c)
            ));
        }
        entries.push_str("</ENTRY>\n");
        keys.push(format!("{}{}{}", volume, dir, file));
    }

    let mut doc = String::new();
    doc.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\" ?>\n");
    doc.push_str("<NML VERSION=\"19\"><HEAD COMPANY=\"www.native-instruments.com\" PROGRAM=\"Traktor\"></HEAD>\n");
    doc.push_str("<MUSICFOLDERS></MUSICFOLDERS>\n");
    doc.push_str(&format!("<COLLECTION ENTRIES=\"{}\">\n", keys.len()));
    doc.push_str(&entries);
    doc.push_str("</COLLECTION>\n<SETS ENTRIES=\"0\"></SETS>\n");
    doc.push_str("<PLAYLISTS><NODE TYPE=\"FOLDER\" NAME=\"$ROOT\"><SUBNODES COUNT=\"1\">\n");
    doc.push_str(&format!(
        "<NODE TYPE=\"PLAYLIST\" NAME=\"{}\"><PLAYLIST ENTRIES=\"{}\" TYPE=\"LIST\" UUID=\"{}\">\n",
        esc(playlist_name),
        keys.len(),
        uuid_like(playlist_name),
    ));
    for k in &keys {
        doc.push_str(&format!(
            "<ENTRY><PRIMARYKEY TYPE=\"TRACK\" KEY=\"{}\"></PRIMARYKEY></ENTRY>\n",
            esc(k)
        ));
    }
    doc.push_str(
        "</PLAYLIST></NODE>\n</SUBNODES></NODE></PLAYLISTS>\n<INDEXING></INDEXING>\n</NML>\n",
    );

    let mut f =
        std::fs::File::create(out).with_context(|| format!("creating {}", out.display()))?;
    f.write_all(doc.as_bytes())?;
    Ok(keys.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_conversion_round_trips() {
        let cases = [
            (
                "/Users/me/Music/DnB/a b.mp3",
                "Macintosh HD",
                "/:Users/:me/:Music/:DnB/:",
                "a b.mp3",
            ),
            ("/Volumes/SSD/Tunes/x.flac", "SSD", "/:Tunes/:", "x.flac"),
            (
                "C:\\Users\\me\\Music\\y.wav",
                "C:",
                "/:Users/:me/:Music/:",
                "y.wav",
            ),
        ];
        for (path, vol, dir, file) in cases {
            let (v, d, f) = path_to_nml(path, "Macintosh HD");
            assert_eq!(
                (v.as_str(), d.as_str(), f.as_str()),
                (vol, dir, file),
                "{path}"
            );
            let back = nml_to_path(&v, &d, &f, "Macintosh HD");
            assert_eq!(back.to_string_lossy(), path.replace('\\', "/"), "{path}");
        }
    }

    #[test]
    fn civil_dates_are_right() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(20_741), (2026, 10, 15));
    }

    #[test]
    fn musical_key_numbering() {
        assert_eq!(musical_key_value(&Camelot::parse("C").unwrap()), 0);
        assert_eq!(musical_key_value(&Camelot::parse("Bb").unwrap()), 10);
        assert_eq!(musical_key_value(&Camelot::parse("Am").unwrap()), 21);
        assert_eq!(musical_key_value(&Camelot::parse("Cm").unwrap()), 12);
    }
}
