# Installing Track2Mix

Track2Mix is a desktop app, with companion builds for iPad and Android tablets.
It runs entirely on your machine — no account, no upload, and it makes no
network calls to do its job.

**Requirements**

- Windows 10 or later (64-bit), a 64-bit Linux desktop with WebKitGTK 4.1
  (Ubuntu 22.04 / Debian 12 or newer, Arch, Fedora 38+), or macOS 11 or later
  (Apple Silicon and Intel)
- Rekordbox 6 or 7, to produce the collection export
- Your audio files present on disk (streaming-only entries can't be analysed)
- An audio output device, for the preview player and the composer

Download the latest desktop build from the
[Releases page](https://github.com/astralisone/track2mix/releases/latest) or
from [downloads.track2mix.com](https://downloads.track2mix.com). The tablet
apps come from the App Store and Google Play; see
[Tablets](#tablets-ipad-and-android) below.

---

## Windows

Run the `.msi` installer (the setup `.exe` is the same app in a smaller
wizard-style installer).

Windows SmartScreen may show **"Windows protected your PC"** on a build without
an established reputation. Click **More info → Run anyway**. Reputation builds up
as more people download a given release.

## Linux

**Debian / Ubuntu and derivatives (Mint, Pop!_OS):**

```bash
sudo apt install ./Track2Mix_<version>_amd64.deb
```

**Arch and derivatives (EndeavourOS, Manjaro, Omarchy):**

```bash
sudo pacman -U ./track2mix-<version>-1-x86_64.pkg.tar.zst
```

The Arch package also installs the `track2mix` command-line tool. A `PKGBUILD`
is published with each release if you would rather `makepkg -si`.

**Fedora and other RPM distributions** use the `.rpm`; **anything else** can
run the AppImage, which bundles GStreamer so the composer's audio works without
extra packages:

```bash
chmod +x Track2Mix_<version>_amd64.AppImage
./Track2Mix_<version>_amd64.AppImage
```

The preview player plays through ALSA (PipeWire and PulseAudio systems work
through their ALSA layer). The composer plays through the webview's
GStreamer pipeline; if the app reports *Webview audio unavailable*, install your
distribution's `gstreamer` "good" and "bad" plugin packages and the PipeWire or
PulseAudio GStreamer sink.

## macOS

Open the `.dmg` and drag **Track2Mix** to your Applications folder.

### If macOS says the developer cannot be verified

Builds that haven't been notarized yet will show:

> **"Track2Mix" cannot be opened because the developer cannot be verified.**

This is Gatekeeper telling you the app isn't signed with a paid Apple Developer
certificate. It is not a virus warning, and the only obvious button is *Move to
Trash* — don't press it. To open the app anyway:

1. **Right-click** (or Control-click) Track2Mix in Applications.
2. Choose **Open**.
3. Click **Open** again in the dialog that appears.

You only need to do this once. Afterwards it launches normally.

If that dialog doesn't offer an Open button, go to **System Settings → Privacy &
Security**, scroll to the Security section, and click **Open Anyway** next to the
message about Track2Mix.

As a last resort, clearing the quarantine attribute from a terminal does the same
thing:

```bash
xattr -d com.apple.quarantine /Applications/Track2Mix.app
```

Only run that on a download you actually trust. You can verify what you're
running by building from source instead — see the [README](../README.md).

## Tablets (iPad and Android)

The tablet apps are sold as a one-time purchase on the
[App Store](https://apps.apple.com) (iPadOS 16 or later) and
[Google Play](https://play.google.com) (Android 8 or later; designed for
tablets in landscape). They install like any other store app and need no
further setup beyond a library to open.

Rekordbox does not run on a tablet, so the analysis itself happens on your
computer. Analyse there, then bring the results across:

1. Analyse your collection on the desktop app (or the CLI).
2. Copy the resulting `library.db` to the tablet — iCloud Drive, Google Drive,
   a USB drive, AirDrop, or any file transfer you already use.
3. Open the app and choose **Open DB** (the iPadOS Files or Android document
   picker opens).

Browsing, filtering, the Camelot wheel, compatibility matching, the playlist
builder and playlist export all work from the database alone. Previewing and
composing need the audio files, which the database points to by their desktop
path; if those files are not on the tablet, the app says so per track rather
than failing silently. How each build is produced and submitted is documented
in [MOBILE.md](MOBILE.md).

---

## First run

1. **Export your collection from Rekordbox.** In Rekordbox:
   **File → Export Collection in xml format**. Save it somewhere you'll find it.
2. **Open Track2Mix** and click **Import Rekordbox XML**. The database is
   written next to the XML (`rekordbox.xml` → `rekordbox.db`).
3. **Watch the coverage.** Real libraries are messy — moved drives, dead paths,
   Beatport streaming stubs that aren't local files at all. The import overlay
   reports how many entries resolved to files on disk and lists the ones that
   failed. For a dry run *before* decoding anything, use the CLI:

   ```bash
   track2mix analyze --xml ~/rekordbox.xml --dry-run
   ```

4. **Let it finish.** Analysis parallelises across all your cores. Leave
   **skip analyzed** ticked so a later re-import only decodes new tracks.
5. **Click any track** to see its harmonically and rhythmically compatible
   neighbours, ranked by energy. Press play on any row to audition it.
6. **Tick the ones you want**, then open **Playlist** to arrange them (harmonic
   flow, energy ramp, BPM) and export an M3U8 — Rekordbox imports it directly.
7. **Try Compose** to lay a few of them on the timeline, let **Auto-arrange**
   beat-match and blend them, and **Export MP3** to hear the result.

### If your drive letter or mount point changed

Files still on disk but at a new path can be remapped without re-tagging
anything in Rekordbox:

```bash
track2mix analyze --xml ~/rekordbox.xml \
    --path-map '/Volumes/OldName/music=/Volumes/NewName/music' \
    --skip-analyzed
```

`--skip-analyzed` makes re-runs cheap: only newly-resolved tracks get decoded.
Open the resulting database in the app with **Open DB**.

### What Track2Mix writes

- Its own SQLite database (`.db`), next to the XML you imported.
- Playlists you export: `.m3u8` (Rekordbox-ready), `.m3u` (paths only) or
  `.txt` (numbered tracklist).
- Composer projects: `.t2m` files (JSON).
- Renders from the composer: `.wav` and `.mp3`.

It never modifies your Rekordbox collection file or your audio files.

---

## Building on Linux

Building the desktop app from source needs, besides Rust and Bun:

- **WebKitGTK and GTK development packages.** Debian/Ubuntu:
  `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev`. Arch: `webkit2gtk-4.1 gtk3
  libayatana-appindicator librsvg`. Fedora: `webkit2gtk4.1-devel gtk3-devel
  libappindicator-gtk3-devel librsvg2-devel`.
- **ALSA headers** for the preview player. Debian/Ubuntu: `libasound2-dev`.
  Arch: `alsa-lib`. Fedora: `alsa-lib-devel`.
- **A C toolchain with autotools** (`gcc`, `make`, `autoconf`, `automake`,
  `libtool`) — the MP3 encoder compiles LAME from source, so there is no
  `libmp3lame` runtime dependency.
- **GStreamer plugins** at runtime for the composer (`gst-plugins-good`,
  `gst-plugins-bad`, and the PipeWire or PulseAudio sink). The AppImage
  bundles these.

Then:

```bash
bun install
bun tauri dev            # develop
bun run build:bundles    # .deb, .rpm and AppImage in src-tauri/target/release/bundle/
```

`build:bundles` sets `NO_STRIP=true`, which linuxdeploy needs on Arch to
produce the AppImage.

---

## Troubleshooting

**A lot of tracks failed to analyse.** Check the coverage summary in the import
overlay or from `--dry-run`. The usual causes are a moved or unmounted drive
(use `--path-map`), streaming entries that were never local files, and
DRM-protected M4A files bought from the iTunes Store, which cannot be decoded.

**A track has no key.** Track2Mix uses Rekordbox's own key analysis rather than
second-guessing it, so your results match what shows on your CDJs. If a track is
unanalysed in Rekordbox, analyse it there first and re-export.

**"Audio file not found" when previewing.** The database stores the path the
file had when you analysed it. If the drive moved, re-run the analysis with
`--path-map` and `--skip-analyzed`, then reopen the database.

**"Webview audio unavailable" on Linux.** The composer needs the webview's
GStreamer pipeline and an output sink. Install `gst-plugins-good`,
`gst-plugins-bad` and the PipeWire (or PulseAudio) GStreamer sink, or use the
AppImage, which bundles them. The library and the preview player keep working
without them.

**The energy scores don't match my ear.** That's a real and useful bug report,
not user error — the weights in `src/features.rs` are hand-tuned and may not
generalise to your genre. Please open an issue with the genre and a couple of
tracks you think are scored wrongly.

**Does this modify my Rekordbox collection?** No. Track2Mix only reads the XML
you export. It writes playlists, composer projects, renders and its own SQLite
database, and never touches your collection file or your audio files.
