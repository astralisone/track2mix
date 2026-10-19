# Track2Mix

**Which of your tracks actually mixes with this one?**

DJ library intelligence for Rekordbox. Track2Mix reads your collection export,
decodes every track on your own machine, scores it for energy, and then — given
any anchor track — hands you the harmonically and rhythmically compatible
shortlist, ranked. From there you can audition tracks, build and arrange a
playlist, lay tracks out on a timeline with EQ and tempo sync, and render the
result to WAV or MP3. Playlists export as M3U8 and Rekordbox imports them
directly.

Runs entirely offline. No account, no upload, no server.

- 🌐 **Site:** `site/` — landing page and downloads page, see [site/README.md](site/README.md)
- 💾 **Install (desktop):** [docs/INSTALL.md](docs/INSTALL.md)
- 📱 **iPad and Android tablet builds:** [docs/MOBILE.md](docs/MOBILE.md)
- 📈 **Go-to-market and pricing:** [GO-TO-MARKET.md](GO-TO-MARKET.md)
- 🚀 **Deploy the site:** [docs/DEPLOY.md](docs/DEPLOY.md)
- 🔑 **Signing a release:** [docs/CODE-SIGNING.md](docs/CODE-SIGNING.md)
- 📝 **Release notes:** [release-v0.2.0/RELEASE-NOTES.md](release-v0.2.0/RELEASE-NOTES.md)

## Platforms

| Platform | How you get it | Price |
| --- | --- | --- |
| Windows 10+ (x64) | `.msi` or setup `.exe` from [Releases](https://github.com/astralisone/track2mix/releases/latest) | Pay what you want |
| Debian / Ubuntu, Arch, other Linux | `.deb`, Arch package, `.rpm` or AppImage from Releases | Pay what you want |
| macOS 11+ (Universal) | `.dmg`, built by the release workflow; signed and notarized once the Apple secrets exist | Pay what you want |
| iPad (iPadOS 16+) | App Store | One-time purchase |
| Android tablets (Android 8+) | Google Play | One-time purchase |

The desktop builds are free to download with a tip jar. The tablet apps are sold
through the stores at a fixed price; see [docs/MOBILE.md](docs/MOBILE.md) for
the build and submission steps and [GO-TO-MARKET.md](GO-TO-MARKET.md) for the
pricing reasoning.

## Two ways in

- **GUI** (`track2mix-tauri`) — a desktop app with three views: **Library**,
  **Playlist** and **Compose**.
- **CLI** (`track2mix`) — the same analysis engine from the shell: analyse a
  Rekordbox export, query the database, export M3U8 playlists.

Both read and write the same SQLite database, so you can analyse from a script
and dig in the GUI, or the other way round.

## The desktop app

### Library

- **Import Rekordbox XML** parses the export, resolves which entries are real
  files on disk, and decodes them in parallel across every core. The database is
  written next to the XML (`rekordbox.xml` → `rekordbox.db`). A progress overlay
  shows each phase, the current track, and any failures. **Skip analyzed** (on
  by default) makes re-imports cheap.
- **Open DB** opens any `library.db`. On startup the app opens `./library.db`
  from the working directory if it exists, otherwise `~/library.db`.
- **Track table**: Title, Artist, Genre, BPM, Key and a 0–10 Energy score,
  every column sortable (energy descending by default), with a play button and
  a checkbox on each row.
- **Filters** combine with AND and show live counts: free-text search across
  title, artist, genre, sub-genre and key; Genre chips (the Rekordbox genre
  tag); Sub-genre chips (the track's parent folder on disk); a clickable
  24-segment **Camelot wheel**; BPM and Energy range sliders with histograms.
  **Match anchor** on the wheel selects the anchor's key, its relative
  major/minor and ±1 on the wheel.
- **Compatibility panel**: click any row to make it the anchor. Candidates are
  the analysed tracks within the BPM tolerance (default ±3, half/double tempo
  allowed) whose Camelot key is the same, the relative major/minor, or ±1 on
  the wheel. Results are ranked by energy. Controls: tolerance 1–10,
  half/double, ignore key, results limit 10/25/50/100. Each result can be
  previewed, re-anchored, or added to the selection.
- **Preview player**: a native player (rodio, in the Rust backend) with
  play/pause, previous/next, seek, +30 s, volume and mute, and a queue of up to
  500 tracks. Playing a selected row queues the whole selection in order.
  Unplayable files are skipped and reported.
- Keys are read in Camelot (`8A`), open key (`8m`, `5d`) or classical notation
  (`Am`, `F#m`, `Bb`) from the Rekordbox *Tonality* field.

### Playlist

- Opening the Playlist view with a selection orders it automatically as a
  **harmonic flow** from the anchor (or from the lowest-energy track): key
  relation first, then BPM closeness, then a gentle energy rise.
- Re-arrange with **Harmonic flow**, **Energy ramp**, **BPM ascending** or
  **Selection order**; drag rows, or use Alt+↑ / Alt+↓.
- Every transition carries a badge (**Perfect**, **Relative**, **±1**,
  **+2 Boost**, **−2 Drop**, **Clash**) and a 0–100 score; a **Set curve**
  chart shows energy and BPM across the set.
- **Suggest next** runs the compatibility search on the last track and offers
  up to ten tracks not already in the set.
- **Play set** auditions the whole set in order.
- **Export** as `Rekordbox M3U8` (`#EXTM3U` + `#EXTINF`), plain `M3U` (paths
  only) or a numbered `TXT` tracklist. Rekordbox imports the M3U8 directly.

### Compose

A multi-lane timeline that plays in real time through Web Audio.

- Add lanes from the library (**Add to Compose**) or with **Add track**, which
  can restrict the picker to tracks compatible with the first lane. The first
  lane sets the master BPM.
- Per-lane strip: volume, three-band EQ (low shelf 200 Hz, mid peak 1.2 kHz,
  high shelf 5 kHz, −26 dB kill to +12 dB), high-pass and low-pass filters,
  mute, solo, and a **Sync** toggle that pins the lane to the master BPM
  vinyl-style (pitch follows tempo), folding to the nearest half/double tempo.
- Timeline: bar ruler and waveforms; drag a clip to move it, its edges to trim,
  the corner handles to set fades. Snap to the beat grid (hold **Alt** to
  bypass), **Ctrl/Cmd + wheel** to zoom, **Delete** to remove a clip.
- **Auto-crossfade** (on by default) fades an outgoing clip out and an
  incoming one in across their overlap. Hand-set fades are never overwritten.
- **Auto-arrange** lays every lane out as a mix: it estimates each track's beat
  grid and downbeat, sets the master BPM to the median lane tempo, trims each
  clip to start on its downbeat, and brings each track in on an 8-bar phrase
  boundary of the previous one with a 4/8/16/32-bar blend. Order by harmonic
  flow, energy rise or lane order. If a track's detected grid is confident and
  within 2 % of the Rekordbox tag, its BPM is corrected.
- **Record live** captures the master output in real time, so fader and EQ
  moves are kept. **Bounce WAV** renders offline, faster than real time.
  **Export MP3** renders the same way and encodes at 320 kbps CBR with ID3
  tags (LAME is compiled in; no system dependency).
- **Projects**: `New`, `Open…`, `Save`, `Save as…` write `.t2m` files (JSON)
  holding the master BPM, every lane's mixer settings, every clip, and a
  snapshot of each track so a project reopens even after Rekordbox renumbers
  its ids. Unsaved changes are flagged in the tab, the toolbar and the window
  title, and the app asks before discarding them.

### Keyboard shortcuts

| Keys | Where | Action |
| --- | --- | --- |
| `Space` | Library / Playlist | Play or pause the preview player |
| `Space` | Compose | Play or pause the transport |
| `Ctrl/Cmd+O` | Anywhere | Open a project |
| `Ctrl/Cmd+S` / `Ctrl/Cmd+Shift+S` | Anywhere | Save / Save as |
| `Delete`, `Backspace` | Compose | Remove the selected clip |
| `Alt` while dragging | Compose | Bypass snap |
| `Ctrl/Cmd + wheel` | Compose | Zoom the timeline |
| `Alt+↑` / `Alt+↓` | Playlist | Move the focused row |
| `Delete` | Playlist | Remove the focused row |
| `Enter` / `Space` | Camelot wheel | Toggle a key |
| Double-click | Knobs | Reset to default |

## The CLI

A release build installs the CLI as `track2mix`; the examples below use
`cargo run` so they work from a checkout. Every subcommand accepts
`--db /path/to/library.db` (default `library.db`).

```bash
# Rekordbox: File → Export Collection in xml format
cargo run --release -- analyze --xml ~/rekordbox.xml --limit 500

# Coverage check before a long run: how many entries resolve to real files?
cargo run --release -- analyze --xml ~/rekordbox.xml --dry-run

# A drive moved? Remap it and only decode the newly resolved tracks.
cargo run --release -- analyze --xml ~/rekordbox.xml \
    --path-map '/Volumes/OldName/music=/Volumes/NewName/music' \
    --skip-analyzed
```

Notes:
- `--skip-analyzed` makes re-runs cheap — only newly-resolved tracks get decoded.
- Tracks with paths like `/v4/catalog/tracks/...` are Beatport streaming entries, not local files; they are dropped and reported in the coverage summary.

Then explore the library without touching SQL:

```bash
# Top / bottom N by any extracted feature.
#   --by energy|bpm|rms|centroid|flux|onsets|rating|plays
cargo run --release -- top --by energy --limit 20
cargo run --release -- top --by energy --genre liquid --asc
cargo run --release -- top --by bpm --sub-genre "Neuro" --export neuro.m3u8 --playlist-name "Neuro by BPM"

# Harmonically + BPM-compatible neighbours around a reference track.
# The anchor is the best title/artist substring match.
cargo run --release -- compat "circles around" --bpm-tol 3 --limit 20
cargo run --release -- compat "my favourite track" --any-key          # BPM-only
cargo run --release -- compat "roller" --half-double-ok --export set.m3u8

# Snapshot of what's in the database.
cargo run --release -- stats
```

`--export` on `top` and `compat` writes a Rekordbox-ready M3U8; the playlist
name defaults to the file stem. Plain M3U and TXT exports are GUI-only.

Direct SQL still works if you want ad-hoc queries:

```bash
sqlite3 library.db "SELECT name, artist, bpm, tonality, energy FROM tracks ORDER BY energy DESC LIMIT 20"
```

## How the analysis works

- Decoding is pure Rust (Symphonia): MP3, FLAC, WAV, AIFF and M4A.
- Rather than grinding through whole files, three 30-second windows are taken
  at 20 %, 50 % and 80 % of each track, mixed to mono and resampled to 22.05 kHz.
- Per window it measures RMS loudness and its variance, spectral centroid
  (brightness), spectral flux (movement) and onset rate (rhythmic density).
- Energy = 0.4·rms + 0.2·centroid + 0.2·flux + 0.2·(onsets/10), then shown as a
  0–10 score normalised across the open library.
- Keys and BPM come from Rekordbox's own analysis (`Tonality` and
  `AverageBpm`), so what you see matches your CDJs. The composer's auto-arrange
  additionally estimates a beat grid and downbeat from the audio.

## Development

```bash
bun install                 # first time
bun tauri dev               # desktop app with hot reload
bun run test                # vitest: ui/tests and ui/src/audio/__tests__
cargo test --workspace      # Rust: analyzer, exports, player, MP3, projects
bun run build:bundles       # desktop bundles (NO_STRIP is set for the AppImage)
```

`bun tauri dev` leaves the workspace crates unoptimised but compiles
dependencies at `opt-level = 3`, so analysis in dev is close to release speed.

Linux needs the WebKitGTK/GTK development packages, the ALSA headers and a C
toolchain (LAME is compiled from source); see
[docs/INSTALL.md](docs/INSTALL.md#building-on-linux). The Android and iOS
builds are covered in [docs/MOBILE.md](docs/MOBILE.md).

## The validation checklist

Run against 500 of your own tracks, then:

- [ ] **Speed.** Total time under 10 minutes? Per-track under 2 seconds on release build?
- [ ] **Coverage.** How many tracks failed? If > 5%, investigate why (moved files, exotic formats, encrypted M4A from iTunes).
- [ ] **Energy sanity.** Sort by energy descending. Top 20 should be your hardest tracks. Bottom 20 should be your intros/ambient/deep tracks. If it's random noise, the weights in `features.rs` need retuning.
- [ ] **Genre coherence.** Group by genre, plot energy distribution. Liquid DnB should cluster lower than neurofunk. Tech house should cluster mid. If genres overlap completely, features aren't discriminating.
- [ ] **Harmonic mixing sanity check.** Pick a track you know mixes well with X. Query for tracks in compatible keys (same Camelot number, ±1, relative major/minor) within ±3 BPM. Do the suggestions actually mix?

## Known limitations

- **No key detection.** Keys come from Rekordbox. An unanalysed track there has
  no key here either.
- **Rekordbox XML only.** No Serato, Traktor or Engine DJ parsers yet.
- **Tempo sync changes pitch.** Lane sync in Compose resamples (vinyl-style);
  there is no time-stretch or key-lock.
- **Static EQ and gain per lane.** Fades are the only envelope on the timeline;
  live knob moves are captured only by *Record live*.
- **Clips stay on their lane.** A clip can be moved in time and trimmed, not
  moved to another lane.
- **The GUI import has no dry run or path map.** Use the CLI for a coverage
  check or to remap a moved drive; the GUI then opens the resulting database.
- **Energy weights are hand-tuned** on one person's library. If the scores
  don't match your ear, that is a bug report worth filing.
- **The composer's fallback decoder is mono.** When the webview cannot decode a
  file, Symphonia decodes it with linear resampling to mono.

## Roadmap

1. **Serato / Traktor / Engine DJ parsers.** The engine is library-agnostic;
   each is a parser, not a rewrite.
2. **Dry run and path remapping in the GUI**, so the CLI is never required.
3. **Time-stretch with key-lock** in Compose.
4. **Rekordbox XML playlist export**, alongside M3U8.
5. **Learned energy weights** from the sets people actually build.

Deliberately not planned: accounts, cloud sync, a web version, or AI
set-generation. Each would undermine the offline, no-server promise.
