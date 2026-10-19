Track2Mix 0.2.0 turns the analyser into a working tool for building a set: a preview player, a playlist builder, and a multi-lane composer that beat-matches, blends and renders your picks.

## What's new

**Listen before you commit**
- A native preview player: play any row, queue a whole selection, seek, skip 30 s, volume. Unplayable files are skipped and named.

**Find the shortlist faster**
- A filter pane with live counts: free-text search, Genre and Sub-genre chips, BPM and Energy range sliders with histograms, and a clickable Camelot wheel with **Match anchor**.
- The compatibility panel gained half/double-tempo matching, an ignore-key switch and a results limit; every result can be previewed, re-anchored or added.

**Build the set**
- A Playlist view that arranges the selection as a harmonic flow, an energy ramp, by BPM or in selection order, scores every transition, shows the set curve, and suggests the next track.
- Export as Rekordbox M3U8, plain M3U, or a text tracklist.

**Compose**
- A timeline with a lane per track: volume, three-band EQ, high- and low-pass, mute, solo, and vinyl-style tempo sync to the master BPM.
- Drag, trim and fade clips on a snapping beat grid; auto-crossfade across overlaps.
- **Auto-arrange** estimates each track's beat grid and downbeat, aligns phrases, and lays the lanes out as a blended mix.
- **Record live**, **Bounce WAV** and **Export MP3** (320 kbps, LAME compiled in, ID3 tags).
- `.t2m` project files with unsaved-change protection, `Ctrl/Cmd+O`, `Ctrl/Cmd+S`, `Ctrl/Cmd+Shift+S`.

**Platforms**
- Linux: `.deb`, `.rpm`, an AppImage that bundles GStreamer, and an Arch package.
- First iPad and Android tablet builds (see `docs/MOBILE.md`). Sold through the App Store and Google Play; the desktop builds stay pay-what-you-want.

## Fixed
- Engine clock drift, fade automation and recording issues found in verification.
- WebKitGTK 2.52 web-process crash at exit on Linux.
- Audio-device failures are reported in the UI instead of failing silently.

## Known limits
Keys still come from Rekordbox's analysis, so an unanalysed track has no key here either. Rekordbox XML is the only input format. Tempo sync in Compose resamples (pitch follows tempo); there is no key-lock yet. The GUI import has no dry run or path remapping — the CLI covers both.

## Verified
```
cargo test --workspace
bun run test
node worker/contact.test.mjs
node worker/index.test.mjs
bun run build
```
