//! Serato crate (`_Serato_/Subcrates/*.crate`) and `database V2` import,
//! plus crate export.
//!
//! Both files are a flat stream of tagged records: a 4-character tag, a
//! big-endian u32 length, then the payload. Tags starting with `o` hold more
//! records, `t`/`p` hold UTF-16BE text, `b` a bool byte, `u` a u32.
//!
//! * crate:     `vrsn`, `osrt`, `ovct`…, then one `otrk{ ptrk }` per track
//! * database:  `vrsn`, then one `otrk{ pfil, tsng, tart, tgen, tbpm, tkey, … }` per track
//!
//! Track paths are stored relative to the root of the drive that holds the
//! `_Serato_` folder, without a leading slash. For the home drive that root is
//! `/` (or `C:\`), for an external drive it is the drive's mount point.
//!
//! The layout follows the community reverse-engineered documentation. It
//! round-trips through our own reader, but it has not been loaded into a
//! running copy of Serato.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};

use crate::keys::Camelot;
use crate::scan::{parse_bpm, track_from_file};
use crate::source::{path_track_id, Imported, Playlist, SourceTrack};
use crate::store::TrackRow;

const CRATE_VERSION: &str = "1.0/Serato ScratchLive Crate";

// ───────────────────────────── TLV ─────────────────────────────

fn tags(data: &[u8]) -> Result<Vec<(String, &[u8])>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() {
        if data.len() - i < 8 {
            return Err(anyhow!("truncated record header at byte {}", i));
        }
        let name = String::from_utf8_lossy(&data[i..i + 4]).to_string();
        let len = u32::from_be_bytes([data[i + 4], data[i + 5], data[i + 6], data[i + 7]]) as usize;
        let start = i + 8;
        let end = start
            .checked_add(len)
            .filter(|e| *e <= data.len())
            .ok_or_else(|| {
                anyhow!(
                    "record `{}` at byte {} runs past the end of the file",
                    name,
                    i
                )
            })?;
        out.push((name, &data[start..end]));
        i = end;
    }
    Ok(out)
}

fn utf16be(b: &[u8]) -> String {
    let units: Vec<u16> = b
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&units)
        .trim_end_matches('\0')
        .to_string()
}

fn enc_text(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect()
}

fn record(tag: &str, payload: &[u8]) -> Vec<u8> {
    debug_assert_eq!(tag.len(), 4);
    let mut v = Vec::with_capacity(8 + payload.len());
    v.extend_from_slice(tag.as_bytes());
    v.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    v.extend_from_slice(payload);
    v
}

// ───────────────────────────── paths ─────────────────────────────

/// Root a `_Serato_` folder's relative paths are anchored at.
pub fn guess_root(serato_dir: &Path) -> PathBuf {
    let parent = serato_dir.parent().unwrap_or(serato_dir);
    let is_music = parent
        .file_name()
        .map(|n| n.eq_ignore_ascii_case("Music"))
        .unwrap_or(false);
    let in_home = parent.ancestors().skip(1).any(|a| {
        matches!(
            a.file_name().and_then(|n| n.to_str()),
            Some("Users") | Some("home")
        )
    });
    if is_music && in_home {
        // Home-drive library: paths are relative to the filesystem root.
        parent.ancestors().last().unwrap_or(parent).to_path_buf()
    } else {
        parent.to_path_buf()
    }
}

fn resolve(root: &Path, rel: &str) -> PathBuf {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_start_matches('/');
    root.join(rel)
}

fn relative_to(path: &str, root: Option<&Path>) -> Option<String> {
    let p = path.replace('\\', "/");
    match root {
        Some(r) => {
            let r = r.to_string_lossy().replace('\\', "/");
            let r = r.trim_end_matches('/');
            p.strip_prefix(r)
                .map(|t| t.trim_start_matches('/').to_string())
                .filter(|t| !t.is_empty())
        }
        None => {
            let b = p.as_bytes();
            let t = if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
                &p[2..]
            } else {
                p.as_str()
            };
            Some(t.trim_start_matches('/').to_string())
        }
    }
}

// ───────────────────────────── import ─────────────────────────────

/// Paths (relative to the drive root, as stored) listed in a crate file.
pub fn read_crate_paths(file: &Path) -> Result<Vec<String>> {
    let data = std::fs::read(file).with_context(|| format!("reading {}", file.display()))?;
    let top = tags(&data).with_context(|| format!("parsing {}", file.display()))?;
    if !top.iter().any(|(n, _)| n == "vrsn") {
        return Err(anyhow!(
            "{} is not a Serato crate (no version record)",
            file.display()
        ));
    }
    let mut paths = Vec::new();
    for (name, payload) in top {
        if name != "otrk" {
            continue;
        }
        for (n, p) in tags(payload)? {
            if n == "ptrk" {
                paths.push(utf16be(p));
            }
        }
    }
    Ok(paths)
}

/// Tracks recorded in `database V2`, with absolute paths under `root`.
pub fn read_database(file: &Path, root: &Path) -> Result<Vec<SourceTrack>> {
    let data = std::fs::read(file).with_context(|| format!("reading {}", file.display()))?;
    let top = tags(&data).with_context(|| format!("parsing {}", file.display()))?;
    let mut out = Vec::new();
    for (name, payload) in top {
        if name != "otrk" {
            continue;
        }
        let mut t = SourceTrack::default();
        let mut rel = String::new();
        let mut key = String::new();
        for (n, p) in tags(payload)? {
            match n.as_str() {
                "pfil" => rel = utf16be(p),
                "tsng" => t.name = utf16be(p),
                "tart" => t.artist = utf16be(p),
                "tgen" => t.genre = utf16be(p),
                "tlbl" => t.label = utf16be(p),
                "tbpm" => t.bpm = parse_bpm(&utf16be(p)),
                "tkey" => key = utf16be(p),
                _ => {}
            }
        }
        if rel.is_empty() {
            continue;
        }
        t.path = resolve(root, &rel);
        if t.name.trim().is_empty() {
            t.name = t
                .path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
        }
        t.tonality = Camelot::parse(&key)
            .map(|c| c.to_string())
            .unwrap_or_default();
        t.track_id = path_track_id("serato", &t.path);
        out.push(t);
    }
    Ok(out)
}

/// Import from a `_Serato_` folder, a `Subcrates` folder, a single `.crate`
/// or a `database V2` file. `root` overrides where relative paths are anchored.
pub fn read_serato(input: &Path, root: Option<&Path>) -> Result<Imported> {
    // Everything below reasons about parents and roots, which needs absolute paths.
    let input = &std::fs::canonicalize(input)
        .with_context(|| format!("cannot open {}", input.display()))?;
    let (serato_dir, single_crate): (PathBuf, Option<PathBuf>) = if input.is_dir() {
        let name = input.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "_Serato_" {
            (input.to_path_buf(), None)
        } else if name == "Subcrates" {
            (input.parent().unwrap_or(input).to_path_buf(), None)
        } else if input.join("_Serato_").is_dir() {
            (input.join("_Serato_"), None)
        } else {
            return Err(anyhow!(
                "{} doesn't look like a Serato library: expected a `_Serato_` folder, a `.crate` file or `database V2`",
                input.display()
            ));
        }
    } else if input
        .extension()
        .map(|e| e.eq_ignore_ascii_case("crate"))
        .unwrap_or(false)
    {
        let dir = input
            .parent()
            .and_then(|p| p.parent())
            .filter(|d| d.file_name().map(|n| n == "_Serato_").unwrap_or(false))
            .map(Path::to_path_buf)
            // A loose crate: with no `_Serato_` around it, anchor at the
            // filesystem root unless the caller says otherwise.
            .unwrap_or_else(|| input.ancestors().last().unwrap_or(input).join("_Serato_"));
        (dir, Some(input.to_path_buf()))
    } else if input
        .file_name()
        .map(|n| n == "database V2")
        .unwrap_or(false)
    {
        (input.parent().unwrap_or(input).to_path_buf(), None)
    } else {
        return Err(anyhow!(
            "{} isn't a Serato file I know: pass a `_Serato_` folder, a `.crate`, or `database V2`",
            input.display()
        ));
    };

    let root: PathBuf = match root {
        Some(r) => r.to_path_buf(),
        None if single_crate.is_some() && !serato_dir.exists() => serato_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default(),
        None => guess_root(&serato_dir),
    };

    let mut out = Imported::default();
    let mut known: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    // Metadata from the database (title/artist/genre/BPM/key), when present.
    if single_crate.is_none() {
        let db = serato_dir.join("database V2");
        if db.is_file() {
            for t in read_database(&db, &root)? {
                known.insert(t.path.clone());
                out.tracks.push(t);
            }
        }
    }

    // Crates → playlists. Tracks that appear only in a crate get their
    // metadata from the audio file's own tags.
    let crate_files: Vec<PathBuf> = match &single_crate {
        Some(c) => vec![c.clone()],
        None => {
            let dir = serato_dir.join("Subcrates");
            let mut v: Vec<PathBuf> = std::fs::read_dir(&dir)
                .map(|rd| {
                    rd.flatten()
                        .map(|e| e.path())
                        .filter(|p| {
                            p.extension()
                                .map(|e| e.eq_ignore_ascii_case("crate"))
                                .unwrap_or(false)
                        })
                        .collect()
                })
                .unwrap_or_default();
            v.sort();
            v
        }
    };
    for cf in crate_files {
        let rels = match read_crate_paths(&cf) {
            Ok(r) => r,
            Err(e) => {
                // One damaged crate shouldn't sink the import.
                eprintln!("skipping {}: {:#}", cf.display(), e);
                continue;
            }
        };
        let paths: Vec<PathBuf> = rels.iter().map(|r| resolve(&root, r)).collect();
        for p in &paths {
            if known.insert(p.clone()) && p.exists() {
                let mut t = track_from_file(p);
                t.track_id = path_track_id("serato", p);
                out.tracks.push(t);
            }
        }
        let stem = cf
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        out.playlists.push(Playlist {
            name: stem.replace("%%", " / "),
            source: "serato",
            paths,
        });
    }

    if out.tracks.is_empty() && out.playlists.is_empty() {
        return Err(anyhow!(
            "found no tracks or crates under {} (is this the right `_Serato_` folder?)",
            serato_dir.display()
        ));
    }
    Ok(out)
}

// ───────────────────────────── export ─────────────────────────────

/// Serialise rows as a crate. Returns the bytes and how many tracks were
/// written / skipped (no path, or outside `root`).
pub fn crate_bytes(rows: &[TrackRow], root: Option<&Path>) -> (Vec<u8>, usize, usize) {
    let mut body = Vec::new();
    body.extend(record("vrsn", &enc_text(CRATE_VERSION)));

    let mut sort = Vec::new();
    sort.extend(record("tvcn", &enc_text("key")));
    sort.extend(record("brev", &[0u8]));
    body.extend(record("osrt", &sort));

    for col in ["song", "artist", "bpm", "key", "album", "length"] {
        let mut c = Vec::new();
        c.extend(record("tvcn", &enc_text(col)));
        c.extend(record("tvcw", &enc_text("0")));
        body.extend(record("ovct", &c));
    }

    let (mut written, mut skipped) = (0, 0);
    for r in rows {
        let Some(rel) = r.file_path.as_deref().and_then(|p| relative_to(p, root)) else {
            skipped += 1;
            continue;
        };
        body.extend(record("otrk", &record("ptrk", &enc_text(&rel))));
        written += 1;
    }
    (body, written, skipped)
}

/// Returns (written, skipped).
pub fn write_crate(out: &Path, rows: &[TrackRow], root: Option<&Path>) -> Result<(usize, usize)> {
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(anyhow!(
                "output directory does not exist: {}",
                parent.display()
            ));
        }
    }
    let (bytes, written, skipped) = crate_bytes(rows, root);
    std::fs::write(out, bytes).with_context(|| format!("writing {}", out.display()))?;
    Ok((written, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_truncated_records() {
        let mut bytes = record("vrsn", &enc_text(CRATE_VERSION));
        bytes.truncate(bytes.len() - 3);
        assert!(tags(&bytes).is_err());
        assert!(tags(&[1, 2, 3]).is_err());
    }

    #[test]
    fn text_survives_utf16_including_non_bmp() {
        for s in ["plain", "Zoë – Lune", "日本語", "🎧 set"] {
            assert_eq!(utf16be(&enc_text(s)), s);
        }
    }

    #[test]
    fn home_drive_anchors_at_filesystem_root() {
        assert_eq!(
            guess_root(Path::new("/Users/me/Music/_Serato_")),
            PathBuf::from("/")
        );
        assert_eq!(
            guess_root(Path::new("/home/me/Music/_Serato_")),
            PathBuf::from("/")
        );
        assert_eq!(
            guess_root(Path::new("/Volumes/SSD/_Serato_")),
            PathBuf::from("/Volumes/SSD")
        );
    }

    #[test]
    fn relative_paths_strip_the_root() {
        assert_eq!(
            relative_to("/Users/me/a.mp3", None).as_deref(),
            Some("Users/me/a.mp3")
        );
        assert_eq!(
            relative_to("C:\\Users\\me\\a.mp3", None).as_deref(),
            Some("Users/me/a.mp3")
        );
        assert_eq!(
            relative_to("/Volumes/SSD/Music/a.mp3", Some(Path::new("/Volumes/SSD"))).as_deref(),
            Some("Music/a.mp3")
        );
        assert_eq!(
            relative_to("/Users/me/a.mp3", Some(Path::new("/Volumes/SSD"))),
            None
        );
    }
}
