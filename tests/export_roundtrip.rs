//! End-to-end check of the playlist export against a real analysed library.
//!
//! The GUI is the only surface that exports today, so this covers the same
//! `write_m3u8` path its `export_playlist` command calls, without driving a
//! native file dialog. Point TRACK2MIX_TEST_DB at an analysed database to run
//! the full round-trip; without it the file-shape tests still run on
//! synthesised rows.

use std::path::PathBuf;
use track2mix_core::export::{energy_score, write_m3u8};
use track2mix_core::store::TrackRow;

fn row(name: &str, artist: &str, path: Option<&str>) -> TrackRow {
    TrackRow {
        track_id: name.to_string(),
        name: name.to_string(),
        artist: artist.to_string(),
        genre: "Drum & Bass".to_string(),
        sub_genre: None,
        bpm: Some(174.0),
        tonality: "8A".to_string(),
        energy: Some(0.5),
        file_path: path.map(str::to_string),
    }
}

fn tmp(name: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("track2mix-test-{}-{}", std::process::id(), name));
    p
}

#[test]
fn writes_extm3u_header_and_one_entry_per_track() {
    let out = tmp("basic.m3u8");
    let rows = vec![
        row("Steel Rolling", "Bench Mark", Some("/music/steel.wav")),
        row("Night Shift", "Control Group", Some("/music/night.wav")),
    ];

    let written = write_m3u8(&out, "My Set", &rows).expect("write should succeed");
    assert_eq!(written, 2);

    let body = std::fs::read_to_string(&out).unwrap();
    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(lines[0], "#EXTM3U");
    assert_eq!(lines[1], "#PLAYLIST:My Set");
    assert_eq!(lines[2], "#EXTINF:-1,Bench Mark - Steel Rolling");
    assert_eq!(lines[3], "/music/steel.wav");
    assert_eq!(lines[4], "#EXTINF:-1,Control Group - Night Shift");
    assert_eq!(lines[5], "/music/night.wav");

    std::fs::remove_file(&out).ok();
}

#[test]
fn skips_rows_with_no_resolvable_path() {
    let out = tmp("skip.m3u8");
    let rows = vec![
        row("Streaming Stub", "Beatport", None),
        row("Real File", "Bench Mark", Some("/music/real.wav")),
    ];

    let written = write_m3u8(&out, "Set", &rows).expect("write should succeed");
    assert_eq!(written, 1, "the pathless row should not be counted");

    let body = std::fs::read_to_string(&out).unwrap();
    assert!(!body.contains("Streaming Stub"));
    assert!(body.contains("/music/real.wav"));

    std::fs::remove_file(&out).ok();
}

#[test]
fn newlines_in_metadata_cannot_break_the_file_format() {
    let out = tmp("inject.m3u8");
    let rows = vec![row("Bad\nName", "Bad\r\nArtist", Some("/music/ok.wav"))];

    let written = write_m3u8(&out, "Set", &rows).unwrap();
    assert_eq!(written, 1);

    let body = std::fs::read_to_string(&out).unwrap();
    // Header, one EXTINF, one path — a stray newline would add lines.
    assert_eq!(body.lines().count(), 4, "got: {body:?}");

    std::fs::remove_file(&out).ok();
}

#[test]
fn refuses_to_write_into_a_missing_directory() {
    let out = tmp("nope/deeper/set.m3u8");
    let err = write_m3u8(&out, "Set", &[row("A", "B", Some("/x.wav"))])
        .expect_err("a missing parent directory should be an error");
    assert!(
        err.to_string().contains("output directory does not exist"),
        "unexpected error: {err}"
    );
}

#[test]
fn energy_score_spans_the_full_scale_and_clamps() {
    assert_eq!(energy_score(0.0, 0.0, 1.0), 0);
    assert_eq!(energy_score(1.0, 0.0, 1.0), 10);
    assert_eq!(energy_score(0.5, 0.0, 1.0), 5);
    // A narrow observed range should still stretch across the scale.
    assert_eq!(energy_score(0.42, 0.40, 0.44), 5);
    // Out-of-range input clamps rather than overflowing.
    assert_eq!(energy_score(2.0, 0.0, 1.0), 10);
    assert_eq!(energy_score(-1.0, 0.0, 1.0), 0);
}

/// Full round-trip against a real analysed database, when one is provided.
#[test]
fn exports_a_real_analysed_library() {
    let Ok(db) = std::env::var("TRACK2MIX_TEST_DB") else {
        eprintln!("TRACK2MIX_TEST_DB not set — skipping the real-library round-trip");
        return;
    };

    let store = track2mix_core::store::Store::open(std::path::Path::new(&db))
        .expect("opening the test database");
    let rows = store.list_all().expect("listing tracks");
    assert!(!rows.is_empty(), "the test database has no tracks");

    let out = tmp("real.m3u8");
    let written = write_m3u8(&out, "Round Trip", &rows).expect("write should succeed");
    assert_eq!(written, rows.len(), "every analysed row has a file path");

    let body = std::fs::read_to_string(&out).unwrap();
    assert!(body.starts_with("#EXTM3U\n#PLAYLIST:Round Trip\n"));
    // Every referenced path must exist, or Rekordbox would import dead entries.
    for line in body.lines().filter(|l| !l.starts_with('#')) {
        assert!(
            std::path::Path::new(line).exists(),
            "exported path does not exist on disk: {line}"
        );
    }

    std::fs::remove_file(&out).ok();
}
