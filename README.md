# Track2Mix

**Which of your tracks actually mixes with this one?**

DJ library intelligence for Rekordbox. Track2Mix reads your collection export,
decodes every track on your own machine, scores it for energy, and then — given
any anchor track — hands you the harmonically and rhythmically compatible
shortlist, ranked. Export it as an M3U8 and Rekordbox imports it directly.

Runs entirely offline. No account, no upload, no server.

- 🌐 **Site:** `site/` — static landing page, see [site/README.md](site/README.md)
- 📈 **Go-to-market:** [GO-TO-MARKET.md](GO-TO-MARKET.md)
- 🚀 **Deploy the site:** [docs/DEPLOY.md](docs/DEPLOY.md)
- 💾 **Install:** [docs/INSTALL.md](docs/INSTALL.md)
- 🔑 **Signing a release:** [docs/CODE-SIGNING.md](docs/CODE-SIGNING.md)

## Two ways in

- **CLI** (`track2mix`) — run the audio analysis pipeline, query the resulting DB, export M3U8 playlists from the shell.
- **GUI** (`track2mix-tauri`) — search and filter the analysed library, click a track to get harmonically / BPM-compatible suggestions, tick the ones you want, and export an M3U8 that Rekordbox can import directly.

Run the GUI in development:
```
bun install        # first time
bun tauri dev
```

The GUI auto-opens `./library.db` from the project root if it exists; otherwise click **Open DB** in the title bar.

A release build installs the CLI as `track2mix`; the examples below use `cargo run` so they work from a checkout.

Build the installable bundles:
```
bun run tauri build
```

**On Linux, set two variables first:**
```
APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true bun run tauri build
```
The `.deb` and `.rpm` bundle without them; the AppImage does not. Tauri shells
out to `linuxdeploy`, which is an AppImage that mounts its own payload with
FUSE, and most current distributions and CI images no longer ship `libfuse2`.
When that mount fails you get ``failed to bundle project `failed to run
linuxdeploy` `` — linuxdeploy's actual complaint, `No suitable fusermount
binary found on the $PATH`, is printed above it and easy to miss. Extracting instead
of mounting avoids FUSE altogether. `NO_STRIP` covers the other common failure,
where linuxdeploy fails the bundle because `strip` errored on a library it does
not own.

Installing `libfuse2` works too, if you would rather have it on the system.

## What this proves (or disproves)

1. **Rekordbox XML is parseable and round-trippable.** If this chokes on your real library, the whole product is in trouble.
2. **Pure-Rust audio decoding handles your formats.** MP3, FLAC, WAV, AIFF, M4A via Symphonia.
3. **Feature extraction is fast enough.** Target: < 2 seconds per track on an M-series Mac, parallelized.
4. **The computed energy values correlate with your ear.** This is the real test. If a liquid roller and a neurofunk banger score the same, the features are too coarse.

## Usage

```bash
# Rekordbox: File → Export Collection in xml format
cargo run --release -- analyze --xml ~/rekordbox.xml --limit 500

# Real-world Rekordbox libraries contain a lot of streaming / stale /
# moved entries — do a fast coverage check before committing to a
# long full-library run:
cargo run --release -- analyze --xml ~/rekordbox.xml --dry-run

# If a directory moved (files still there, just at a new path), remap it:
cargo run --release -- analyze --xml ~/rekordbox.xml \
    --path-map '/Volumes/OldName/music=/Volumes/NewName/music' \
    --skip-analyzed
```

Notes:
- `--skip-analyzed` makes re-runs cheap — only newly-resolved tracks get decoded.
- Tracks with paths like `/v4/catalog/tracks/...` are Beatport streaming entries, not local files; they are dropped and reported in the coverage summary.

Then explore the library without touching SQL:

```bash
# Top / bottom N by any extracted feature, optionally filtered by genre.
cargo run --release -- top --by energy --limit 20
cargo run --release -- top --by energy --genre liquid --asc

# Harmonically + BPM-compatible neighbours around a reference track.
# Matches Camelot / classical / open-key notation in the Rekordbox "Tonality" field.
cargo run --release -- compat "circles around" --bpm-tol 3
cargo run --release -- compat "my favourite track" --any-key   # BPM-only

# Snapshot of what's in the database.
cargo run --release -- stats
```

Every subcommand accepts `--db /path/to/library.db` if you keep multiple libraries.

Direct SQL still works if you want ad-hoc queries:

```bash
sqlite3 library.db "SELECT name, artist, bpm, tonality, energy FROM tracks ORDER BY energy DESC LIMIT 20"
```

## The validation checklist

Run against 500 of your own tracks, then:

- [ ] **Speed.** Total time under 10 minutes? Per-track under 2 seconds on release build?
- [ ] **Coverage.** How many tracks failed? If > 5%, investigate why (moved files, exotic formats, encrypted M4A from iTunes).
- [ ] **Energy sanity.** Sort by energy descending. Top 20 should be your hardest tracks. Bottom 20 should be your intros/ambient/deep tracks. If it's random noise, the weights in `features.rs` need retuning.
- [ ] **Genre coherence.** Group by genre, plot energy distribution. Liquid DnB should cluster lower than neurofunk. Tech house should cluster mid. If genres overlap completely, features aren't discriminating.
- [ ] **Harmonic mixing sanity check.** Pick a track you know mixes well with X. Query for tracks in compatible keys (same Camelot number, ±1, relative major/minor) within ±3 BPM. Do the suggestions actually mix?

## Known limitations vs. a shippable v1

- Linear resampling. Fine for MIR, not for audio playback. Swap `rubato` if you ever play back.
- Onset detection is a simple flux-spike heuristic. For real use, port a proper algorithm (complex domain or superflux). Aubio has a well-tested one.
- No key detection. We trust Rekordbox's analysis. If you want to verify or re-detect, that's a chromagram + key profile correlation — another 100 lines.
- No embedding generation yet. Once features look good, the next step is composing a text profile per track (metadata + feature descriptors like "dense, bright, dynamic") and embedding it.
- Energy weights are hand-tuned. For a real product, collect labels (users rating sets they built) and learn the weights.

## What comes next if this works

1. Add a `--export` command that writes a Rekordbox-compatible XML playlist, proving the round-trip.
2. Add text embedding generation via the OpenAI or Voyage API, store vectors in a sibling `vectors` table using `sqlite-vec`.
3. Build a tiny TUI that takes a natural-language prompt and returns a candidate playlist.
4. Port to Tauri v2 as a sidecar binary or compile the analyzer as a library and call it from the Rust backend directly.
