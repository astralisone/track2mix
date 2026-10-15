//! Folder scanning plus Traktor and Serato import/export, end to end through
//! the shared analysis pipeline. Audio is synthesised (tiny PCM WAVs) so the
//! tests need no fixtures.

use std::fs;
use std::path::{Path, PathBuf};

use track2mix_core::analyze::{run_imported, RunOptions};
use track2mix_core::export::{write_playlist, ExportFormat, ExportOptions};
use track2mix_core::scan::{scan_dirs, ScanOptions};
use track2mix_core::serato::{self, crate_bytes};
use track2mix_core::source::Imported;
use track2mix_core::store::{Store, TrackRow};
use track2mix_core::traktor::{self, TraktorOptions};

// ───────────────────────────── helpers ─────────────────────────────

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let mut p = std::env::temp_dir();
        p.push(format!("track2mix-djfmt-{}-{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        // Canonical so comparisons survive /tmp → /private/tmp style symlinks.
        TempDir(fs::canonicalize(p).unwrap())
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A mono 16-bit PCM WAV of a decaying 100 Hz pulse train, `secs` long.
fn write_wav(path: &Path, secs: u32) {
    let sr = 22050u32;
    let n = sr * secs;
    let mut pcm = Vec::with_capacity(n as usize * 2);
    for i in 0..n {
        let t = i as f32 / sr as f32;
        let beat = (t * 2.0).fract();
        let v = (2.0 * std::f32::consts::PI * 100.0 * t).sin() * (-beat * 8.0).exp() * 0.8;
        pcm.extend_from_slice(&((v * 32767.0) as i16).to_le_bytes());
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sr.to_le_bytes());
    out.extend_from_slice(&(sr * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(&pcm);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, out).unwrap();
}

fn opts(db: &Path) -> RunOptions {
    RunOptions {
        db_path: db.to_path_buf(),
        limit: None,
        skip_analyzed: false,
        dry_run: false,
        path_map: Vec::new(),
        estimate_missing: true,
        threads: Some(2),
    }
}

fn row(name: &str, artist: &str, path: &str, bpm: f32, key: &str) -> TrackRow {
    TrackRow {
        track_id: name.to_string(),
        name: name.to_string(),
        artist: artist.to_string(),
        genre: "Drum & Bass".to_string(),
        sub_genre: None,
        bpm: Some(bpm),
        tonality: key.to_string(),
        energy: Some(0.5),
        file_path: Some(path.to_string()),
        label: "Hospital".to_string(),
        rating: 4,
        play_count: 7,
    }
}

// ───────────────────────────── scanning ─────────────────────────────

#[test]
fn scan_finds_audio_recursively_and_ignores_the_rest() {
    let d = TempDir::new("scan");
    write_wav(&d.path().join("a.wav"), 2);
    write_wav(&d.path().join("deep/er/b.WAV"), 2);
    write_wav(&d.path().join(".hidden/c.wav"), 2);
    write_wav(&d.path().join("._a.wav"), 2); // macOS AppleDouble stub
    fs::write(d.path().join("notes.txt"), "x").unwrap();
    fs::write(d.path().join("cover.jpg"), "x").unwrap();

    let r = scan_dirs(&[d.path().to_path_buf()], &ScanOptions::default());
    let names: Vec<_> = r.tracks.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, vec!["a", "b"], "got {:?}", names);
    // File name is the fallback title when a file carries no tags.
    assert!(r.tracks.iter().all(|t| t.artist.is_empty()));
    assert!(r.bad_roots.is_empty());
}

#[test]
fn scan_dedupes_overlapping_roots_and_reports_bad_ones() {
    let d = TempDir::new("scan-overlap");
    write_wav(&d.path().join("x/one.wav"), 2);
    let r = scan_dirs(
        &[
            d.path().to_path_buf(),
            d.path().join("x"),
            d.path().join("missing"),
        ],
        &ScanOptions::default(),
    );
    assert_eq!(r.tracks.len(), 1);
    assert_eq!(r.duplicates, 1);
    assert_eq!(r.bad_roots.len(), 1);
}

#[test]
fn scan_respects_max_depth() {
    let d = TempDir::new("scan-depth");
    write_wav(&d.path().join("top.wav"), 2);
    write_wav(&d.path().join("sub/inner.wav"), 2);
    let r = scan_dirs(
        &[d.path().to_path_buf()],
        &ScanOptions { max_depth: Some(1) },
    );
    assert_eq!(r.tracks.len(), 1);
}

#[test]
fn track_ids_are_stable_and_path_derived() {
    let d = TempDir::new("scan-ids");
    write_wav(&d.path().join("t.wav"), 2);
    let a = scan_dirs(&[d.path().to_path_buf()], &ScanOptions::default());
    let b = scan_dirs(&[d.path().to_path_buf()], &ScanOptions::default());
    assert_eq!(a.tracks[0].track_id, b.tracks[0].track_id);
    assert!(a.tracks[0].track_id.starts_with("scan:"));
}

#[test]
fn scan_then_analyze_fills_the_store_and_rescan_skips() {
    let d = TempDir::new("pipeline");
    let db = d.path().join("lib.db");
    write_wav(&d.path().join("music/one.wav"), 3);
    write_wav(&d.path().join("music/two.wav"), 3);
    fs::write(d.path().join("music/broken.wav"), b"not audio").unwrap();

    let scan = scan_dirs(&[d.path().join("music")], &ScanOptions::default());
    let total = scan.tracks.len();
    assert_eq!(total, 3);
    let imp = Imported {
        tracks: scan.tracks.clone(),
        ..Default::default()
    };
    let s = run_imported(imp, total, &opts(&db), |_| {}).unwrap();
    assert_eq!(
        (s.ok, s.failed),
        (2, 1),
        "the broken file costs one track, not the run"
    );

    let store = Store::open(&db).unwrap();
    let rows = store.list_all().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows
        .iter()
        .all(|r| r.energy.is_some() && r.file_path.is_some()));
    // 3 s clips are too short for tempo/key estimation: no made-up values.
    assert!(rows
        .iter()
        .all(|r| r.bpm.is_none() && r.tonality.is_empty()));

    let again = Imported {
        tracks: scan.tracks,
        ..Default::default()
    };
    let mut o = opts(&db);
    o.skip_analyzed = true;
    let s2 = run_imported(again, total, &o, |_| {}).unwrap();
    assert_eq!(s2.skipped_already_analyzed, 2);
}

// ───────────────────────────── Traktor ─────────────────────────────

#[test]
fn traktor_export_reads_back_with_metadata_and_playlist() {
    let d = TempDir::new("nml-rt");
    let nml = d.path().join("set.nml");
    let rows = vec![
        row(
            "Steel & Rolling",
            "Bench \"Mark\"",
            "/Users/me/Music/DnB/steel.mp3",
            174.0,
            "8A",
        ),
        row(
            "Zoë – Lune",
            "Control Group",
            "/Volumes/SSD/Tunes/lune.flac",
            86.5,
            "11B",
        ),
    ];
    let n = traktor::write_nml(&nml, "Friday <warmup>", &rows, &TraktorOptions::default()).unwrap();
    assert_eq!(n, 2);

    let back = traktor::read_nml(&nml, &TraktorOptions::default()).unwrap();
    assert_eq!(back.tracks.len(), 2);
    let a = &back.tracks[0];
    assert_eq!(a.name, "Steel & Rolling");
    assert_eq!(a.artist, "Bench \"Mark\"");
    assert_eq!(a.bpm, Some(174.0));
    assert_eq!(a.tonality, "8A");
    assert_eq!(a.rating, 4);
    assert_eq!(a.play_count, 7);
    assert_eq!(a.genre, "Drum & Bass");
    assert_eq!(a.label, "Hospital");
    assert_eq!(a.path, PathBuf::from("/Users/me/Music/DnB/steel.mp3"));

    let b = &back.tracks[1];
    assert_eq!(b.name, "Zoë – Lune");
    assert_eq!(b.tonality, "11B");
    assert_eq!(b.path, PathBuf::from("/Volumes/SSD/Tunes/lune.flac"));

    assert_eq!(back.playlists.len(), 1);
    assert_eq!(back.playlists[0].name, "Friday <warmup>");
    assert_eq!(
        back.playlists[0].paths,
        vec![a.path.clone(), b.path.clone()]
    );
}

/// Shaped like a real Traktor 3 file: different attribute order, extra
/// elements we ignore, a Windows volume, an entity-escaped title, an entry
/// with no location, a playlist inside a folder, and a playlist entry whose
/// track isn't in the collection.
const TRAKTOR_SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<NML VERSION="19"><HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"></HEAD>
<MUSICFOLDERS></MUSICFOLDERS>
<COLLECTION ENTRIES="3">
<ENTRY MODIFIED_DATE="2024/5/3" MODIFIED_TIME="59063" AUDIO_ID="AAA" TITLE="Rock &amp; Roll" ARTIST="Les Mis&#233;rables">
<LOCATION DIR="/:Users/:dj/:Music/:" FILE="rock.mp3" VOLUME="C:" VOLUMEID="C:"></LOCATION>
<ALBUM TRACK="1" TITLE="Album"></ALBUM>
<MODIFICATION_INFO AUTHOR_TYPE="user"></MODIFICATION_INFO>
<INFO BITRATE="320000" GENRE="Techno" LABEL="Lbl" COMMENT="x" KEY="5d" PLAYCOUNT="12" PLAYTIME="400" RANKING="204" IMPORT_DATE="2024/5/3" FLAGS="12"></INFO>
<TEMPO BPM="132.500000" BPM_QUALITY="100.000000"></TEMPO>
<LOUDNESS PEAK_DB="-0.1" PERCEIVED_DB="-5.2" ANALYZED_DB="-5.2"></LOUDNESS>
<MUSICAL_KEY VALUE="3"></MUSICAL_KEY>
<CUE_V2 NAME="AutoGrid" DISPL_ORDER="0" TYPE="4" START="100.0" LEN="0" REPEATS="-1" HOTCUE="0"></CUE_V2>
</ENTRY>
<ENTRY TITLE="No Key Tag" ARTIST="X">
<LOCATION DIR="/:Users/:dj/:Music/:" FILE="nokey.wav" VOLUME="C:" VOLUMEID="C:"></LOCATION>
<INFO RANKING="0"></INFO>
<TEMPO BPM="0.000000" BPM_QUALITY="0"></TEMPO>
<MUSICAL_KEY VALUE="21"></MUSICAL_KEY>
</ENTRY>
<ENTRY TITLE="Ghost" ARTIST="Nobody"></ENTRY>
</COLLECTION>
<SETS ENTRIES="0"></SETS>
<PLAYLISTS><NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES COUNT="1">
<NODE TYPE="FOLDER" NAME="Gigs"><SUBNODES COUNT="1">
<NODE TYPE="PLAYLIST" NAME="Saturday"><PLAYLIST ENTRIES="3" TYPE="LIST" UUID="abc">
<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="C:/:Users/:dj/:Music/:rock.mp3"></PRIMARYKEY></ENTRY>
<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="C:/:Users/:dj/:Music/:nokey.wav"></PRIMARYKEY></ENTRY>
<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="D:/:Old/:gone.mp3"></PRIMARYKEY></ENTRY>
</PLAYLIST></NODE>
</SUBNODES></NODE>
</SUBNODES></NODE></PLAYLISTS>
<INDEXING></INDEXING>
</NML>
"#;

#[test]
fn traktor_reader_handles_a_real_style_file() {
    let d = TempDir::new("nml-real");
    let nml = d.path().join("collection.nml");
    fs::write(&nml, TRAKTOR_SAMPLE).unwrap();
    let imp = traktor::read_nml(&nml, &TraktorOptions::default()).unwrap();

    assert_eq!(imp.tracks.len(), 2);
    assert_eq!(
        imp.no_location, 1,
        "the entry without a LOCATION is counted, not imported"
    );

    let rock = &imp.tracks[0];
    assert_eq!(rock.name, "Rock & Roll");
    assert_eq!(rock.artist, "Les Misérables");
    assert_eq!(rock.genre, "Techno");
    assert_eq!(rock.bpm, Some(132.5));
    // Open Key 5d = E major = Camelot 12B (INFO KEY wins over MUSICAL_KEY=3).
    assert_eq!(rock.tonality, "12B");
    assert_eq!(rock.rating, 4);
    assert_eq!(rock.play_count, 12);
    assert_eq!(rock.path, PathBuf::from("C:/Users/dj/Music/rock.mp3"));

    let nokey = &imp.tracks[1];
    assert_eq!(nokey.bpm, None, "BPM 0 means unknown");
    // No KEY attribute: derived from MUSICAL_KEY 21 = A minor = Camelot 8A.
    assert_eq!(nokey.tonality, "8A");

    assert_eq!(imp.playlists.len(), 1);
    assert_eq!(imp.playlists[0].name, "Saturday");
    assert_eq!(
        imp.playlists[0].paths,
        vec![
            PathBuf::from("C:/Users/dj/Music/rock.mp3"),
            PathBuf::from("C:/Users/dj/Music/nokey.wav"),
            PathBuf::from("D:/Old/gone.mp3"),
        ]
    );
}

#[test]
fn traktor_reader_rejects_non_nml_files() {
    let d = TempDir::new("nml-bad");
    let p = d.path().join("nope.nml");
    fs::write(&p, "<html><body>hi</body></html>").unwrap();
    assert!(traktor::read_nml(&p, &TraktorOptions::default()).is_err());
    fs::write(&p, [0u8, 159, 146, 150, 1, 2, 3]).unwrap();
    assert!(traktor::read_nml(&p, &TraktorOptions::default()).is_err());
    assert!(traktor::read_nml(&d.path().join("missing.nml"), &TraktorOptions::default()).is_err());
}

#[test]
fn traktor_import_runs_through_the_pipeline_and_saves_the_playlist() {
    let d = TempDir::new("nml-pipeline");
    let db = d.path().join("lib.db");
    let wav = d.path().join("music/real.wav");
    write_wav(&wav, 3);

    // Export a playlist that points at a real file plus one that's gone.
    let nml = d.path().join("mix.nml");
    let rows = vec![
        row("Real", "Me", wav.to_str().unwrap(), 120.0, "8A"),
        row("Gone", "Me", "/nowhere/gone.wav", 120.0, "8A"),
    ];
    traktor::write_nml(&nml, "Mix", &rows, &TraktorOptions::default()).unwrap();

    let imp = traktor::read_nml(&nml, &TraktorOptions::default()).unwrap();
    let s = run_imported(imp, 2, &opts(&db), |_| {}).unwrap();
    assert_eq!(s.ok, 1);
    assert_eq!(s.dropped.missing_file, 1);
    assert_eq!(s.playlists, 1);

    let store = Store::open(&db).unwrap();
    let rows = store.playlist_rows("Mix").unwrap();
    // Only the analysed, existing track is in the playlist view.
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "Real");
    // Tags from Traktor survive into the library.
    assert_eq!(rows[0].bpm, Some(120.0));
    assert_eq!(rows[0].tonality, "8A");
    assert_eq!(rows[0].rating, 4);
    assert_eq!(
        store.list_playlists().unwrap(),
        vec![("Mix".to_string(), "traktor".to_string(), 2)]
    );
}

#[test]
fn reimporting_the_same_file_from_another_source_reuses_its_row() {
    let d = TempDir::new("merge");
    let db = d.path().join("lib.db");
    let wav = d.path().join("music/same.wav");
    write_wav(&wav, 3);

    let scan = scan_dirs(&[d.path().join("music")], &ScanOptions::default());
    run_imported(
        Imported {
            tracks: scan.tracks,
            ..Default::default()
        },
        1,
        &opts(&db),
        |_| {},
    )
    .unwrap();

    let nml = d.path().join("c.nml");
    traktor::write_nml(
        &nml,
        "P",
        &[row("Same", "Artist", wav.to_str().unwrap(), 130.0, "8B")],
        &TraktorOptions::default(),
    )
    .unwrap();
    let imp = traktor::read_nml(&nml, &TraktorOptions::default()).unwrap();
    run_imported(imp, 1, &opts(&db), |_| {}).unwrap();

    let store = Store::open(&db).unwrap();
    let rows = store.list_all().unwrap();
    assert_eq!(
        rows.len(),
        1,
        "one file, one row, whichever app it came from"
    );
    assert_eq!(rows[0].name, "Same");
    assert_eq!(rows[0].bpm, Some(130.0));
}

// ───────────────────────────── Serato ─────────────────────────────

fn rec(tag: &str, payload: &[u8]) -> Vec<u8> {
    let mut v = tag.as_bytes().to_vec();
    v.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    v.extend_from_slice(payload);
    v
}

fn txt(s: &str) -> Vec<u8> {
    s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect()
}

/// A `database V2` with one `otrk` per (path, title, artist, bpm, key).
fn database_v2(tracks: &[(&str, &str, &str, &str, &str)]) -> Vec<u8> {
    let mut out = rec("vrsn", &txt("2.0/Serato Scratch LIVE Database"));
    for (path, title, artist, bpm, key) in tracks {
        let mut t = Vec::new();
        t.extend(rec("ttyp", &txt("wav")));
        t.extend(rec("pfil", &txt(path)));
        t.extend(rec("tsng", &txt(title)));
        t.extend(rec("tart", &txt(artist)));
        t.extend(rec("tbpm", &txt(bpm)));
        t.extend(rec("tkey", &txt(key)));
        t.extend(rec("ufsb", &123u32.to_be_bytes()));
        out.extend(rec("otrk", &t));
    }
    out
}

#[test]
fn crate_round_trips_and_uses_drive_relative_paths() {
    let d = TempDir::new("crate-rt");
    let out = d.path().join("Set.crate");
    let rows = vec![
        row("A", "x", "/Users/me/Music/a.mp3", 120.0, "8A"),
        row("B", "y", "/Users/me/Music/日本語/b.flac", 120.0, "8A"),
    ];
    let (w, skipped) = serato::write_crate(&out, &rows, None).unwrap();
    assert_eq!((w, skipped), (2, 0));
    let paths = serato::read_crate_paths(&out).unwrap();
    assert_eq!(
        paths,
        vec!["Users/me/Music/a.mp3", "Users/me/Music/日本語/b.flac"]
    );
}

#[test]
fn crate_export_leaves_out_tracks_outside_the_root() {
    let rows = vec![
        row("In", "x", "/Volumes/SSD/Music/in.mp3", 120.0, "8A"),
        row("Out", "x", "/Users/me/out.mp3", 120.0, "8A"),
    ];
    let (_, written, skipped) = crate_bytes(&rows, Some(Path::new("/Volumes/SSD")));
    assert_eq!((written, skipped), (1, 1));
}

#[test]
fn serato_library_import_reads_database_and_crates() {
    let d = TempDir::new("serato-lib");
    // Layout of an external drive: <drive>/_Serato_ + music beside it.
    let drive = d.path().join("DRIVE");
    let a = drive.join("Music/a.wav");
    let b = drive.join("Music/b.wav");
    write_wav(&a, 3);
    write_wav(&b, 3);
    let ser = drive.join("_Serato_");
    fs::create_dir_all(ser.join("Subcrates")).unwrap();

    let rel = |p: &Path| {
        p.strip_prefix(&drive)
            .unwrap()
            .to_string_lossy()
            .to_string()
    };
    fs::write(
        ser.join("database V2"),
        database_v2(&[
            (&rel(&a), "Track A", "Artist A", "174.00", "Am"),
            (&rel(&b), "Track B", "Artist B", "", "8B"),
        ]),
    )
    .unwrap();

    let rows = vec![
        row("a", "", a.to_str().unwrap(), 0.0, ""),
        row("b", "", b.to_str().unwrap(), 0.0, ""),
    ];
    serato::write_crate(&ser.join("Subcrates/Warmup.crate"), &rows, Some(&drive)).unwrap();
    serato::write_crate(
        &ser.join("Subcrates/Gigs%%Friday.crate"),
        &rows[..1],
        Some(&drive),
    )
    .unwrap();
    fs::write(ser.join("Subcrates/garbage.crate"), b"\x00\x01").unwrap(); // must not sink the import

    let imp = serato::read_serato(&ser, None).unwrap();
    assert_eq!(imp.tracks.len(), 2);
    let ta = imp.tracks.iter().find(|t| t.name == "Track A").unwrap();
    assert_eq!(ta.artist, "Artist A");
    assert_eq!(ta.bpm, Some(174.0));
    assert_eq!(ta.tonality, "8A");
    assert_eq!(ta.path, a);
    let tb = imp.tracks.iter().find(|t| t.name == "Track B").unwrap();
    assert_eq!(tb.bpm, None);
    assert_eq!(tb.tonality, "8B");

    let mut names: Vec<_> = imp.playlists.iter().map(|p| p.name.clone()).collect();
    names.sort();
    assert_eq!(names, vec!["Gigs / Friday", "Warmup"]);
    let warm = imp.playlists.iter().find(|p| p.name == "Warmup").unwrap();
    assert_eq!(warm.paths, vec![a.clone(), b.clone()]);

    // …and through the pipeline.
    let db = d.path().join("lib.db");
    let s = run_imported(imp, 2, &opts(&db), |_| {}).unwrap();
    assert_eq!((s.ok, s.failed, s.playlists), (2, 0, 2));
    let store = Store::open(&db).unwrap();
    assert_eq!(store.playlist_rows("Warmup").unwrap().len(), 2);
    let ta_row = store
        .list_all()
        .unwrap()
        .into_iter()
        .find(|r| r.name == "Track A")
        .unwrap();
    assert_eq!(ta_row.bpm, Some(174.0), "database BPM wins over estimation");
}

#[test]
fn single_crate_import_takes_metadata_from_file_tags() {
    let d = TempDir::new("serato-single");
    let a = d.path().join("Music/solo.wav");
    write_wav(&a, 3);
    let crate_path = d.path().join("Solo.crate");
    // Anchor paths at the temp dir, the way a drive root would be.
    serato::write_crate(
        &crate_path,
        &[row("solo", "", a.to_str().unwrap(), 0.0, "")],
        Some(d.path()),
    )
    .unwrap();
    let imp = serato::read_serato(&crate_path, Some(d.path())).unwrap();
    assert_eq!(imp.tracks.len(), 1);
    assert_eq!(imp.tracks[0].name, "solo", "no tags → file name");
    assert_eq!(imp.playlists[0].name, "Solo");
}

#[test]
fn serato_rejects_things_that_are_not_libraries() {
    let d = TempDir::new("serato-bad");
    assert!(serato::read_serato(d.path(), None).is_err());
    let junk = d.path().join("x.crate");
    fs::write(&junk, b"definitely not a crate").unwrap();
    assert!(serato::read_serato(&junk, Some(d.path())).is_err());
    assert!(serato::read_crate_paths(&junk).is_err());
    assert!(serato::read_serato(&d.path().join("nope"), None).is_err());
}

// ───────────────────────────── dispatch ─────────────────────────────

#[test]
fn format_is_inferred_from_the_extension() {
    for (p, f) in [
        ("a.m3u8", ExportFormat::M3u8),
        ("a.M3U", ExportFormat::M3u8),
        ("a.nml", ExportFormat::Traktor),
        ("a.crate", ExportFormat::Serato),
    ] {
        assert_eq!(ExportFormat::from_extension(Path::new(p)), Some(f), "{p}");
    }
    assert_eq!(ExportFormat::from_extension(Path::new("a.txt")), None);
    assert_eq!(ExportFormat::parse("Traktor"), Some(ExportFormat::Traktor));
    assert_eq!(ExportFormat::parse("rekordbox"), Some(ExportFormat::M3u8));
    assert_eq!(ExportFormat::parse("???"), None);
}

#[test]
fn export_path_map_rewrites_every_format() {
    let d = TempDir::new("pathmap");
    let rows = vec![row("T", "A", "/mnt/music/dnb/t.mp3", 174.0, "8A")];
    let o = ExportOptions {
        traktor_volume: Some("C:".to_string()),
        serato_root: None,
        path_map: vec![("/mnt/music".to_string(), "C:/Music".to_string())],
    };

    let m3u = d.path().join("p.m3u8");
    write_playlist(ExportFormat::M3u8, &m3u, "P", &rows, &o).unwrap();
    assert!(fs::read_to_string(&m3u)
        .unwrap()
        .contains("\nC:/Music/dnb/t.mp3\n"));

    let nml = d.path().join("p.nml");
    write_playlist(ExportFormat::Traktor, &nml, "P", &rows, &o).unwrap();
    let back = traktor::read_nml(&nml, &TraktorOptions::default()).unwrap();
    assert_eq!(back.tracks[0].path, PathBuf::from("C:/Music/dnb/t.mp3"));

    let cr = d.path().join("p.crate");
    let rep = write_playlist(ExportFormat::Serato, &cr, "P", &rows, &o).unwrap();
    assert_eq!((rep.written, rep.skipped), (1, 0));
    assert_eq!(
        serato::read_crate_paths(&cr).unwrap(),
        vec!["Music/dnb/t.mp3"]
    );
}

#[test]
fn rows_without_a_path_are_reported_as_skipped() {
    let d = TempDir::new("skipped");
    let mut r = row("T", "A", "/x/t.mp3", 120.0, "8A");
    r.file_path = None;
    for (fmt, name) in [
        (ExportFormat::M3u8, "s.m3u8"),
        (ExportFormat::Traktor, "s.nml"),
        (ExportFormat::Serato, "s.crate"),
    ] {
        let rep = write_playlist(
            fmt,
            &d.path().join(name),
            "P",
            &[r.clone()],
            &ExportOptions::default(),
        )
        .unwrap();
        assert_eq!((rep.written, rep.skipped), (0, 1), "{name}");
    }
}

#[test]
fn exports_refuse_a_missing_directory() {
    for fmt in [
        ExportFormat::M3u8,
        ExportFormat::Traktor,
        ExportFormat::Serato,
    ] {
        let err = write_playlist(
            fmt,
            Path::new("/definitely/not/here/out.x"),
            "P",
            &[row("T", "A", "/x/t.mp3", 120.0, "8A")],
            &ExportOptions::default(),
        );
        assert!(err.is_err());
    }
}
