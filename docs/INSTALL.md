# Installing Track2Mix

Track2Mix is a desktop app. It runs entirely on your machine — no account, no
upload, and it makes no network calls to do its job.

**Requirements**

- macOS 11 or later (Apple Silicon and Intel), or Windows 10 or later
- Rekordbox 6 or 7, to produce the collection export
- Your audio files present on disk (streaming-only entries can't be analysed)

Download the latest build from the [Releases page](https://github.com/astralisone/track2mix/releases/latest).

---

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

## Windows

Run the `.msi` installer.

Windows SmartScreen may show **"Windows protected your PC"** on a build without
an established reputation. Click **More info → Run anyway**. Reputation builds up
as more people download a given release.

---

## First run

1. **Export your collection from Rekordbox.** In Rekordbox:
   **File → Export Collection in xml format**. Save it somewhere you'll find it.
2. **Open Track2Mix** and point it at that XML file.
3. **Do a coverage check first.** Real libraries are messy — moved drives, dead
   paths, Beatport streaming stubs that aren't local files at all. A dry run tells
   you how many tracks will actually resolve before you commit to a long
   analysis:

   ```bash
   track2mix analyze --xml ~/rekordbox.xml --dry-run
   ```

4. **Run the analysis.** It parallelises across all your cores. Results are
   written to `library.db`, a single SQLite file you own and can delete.
5. **Click any track** to see its harmonically and rhythmically compatible
   neighbours, ranked. Tick the ones you want and export an M3U8 — Rekordbox
   imports it directly.

### If your drive letter or mount point changed

Files still on disk but at a new path can be remapped without re-tagging
anything in Rekordbox:

```bash
track2mix analyze --xml ~/rekordbox.xml \
    --path-map '/Volumes/OldName/music=/Volumes/NewName/music' \
    --skip-analyzed
```

`--skip-analyzed` makes re-runs cheap: only newly-resolved tracks get decoded.

---

## Troubleshooting

**A lot of tracks failed to analyse.** Check the coverage summary from
`--dry-run`. The usual causes are a moved or unmounted drive (use `--path-map`),
streaming entries that were never local files, and DRM-protected M4A files
bought from the iTunes Store, which cannot be decoded.

**A track has no key.** Track2Mix uses Rekordbox's own key analysis rather than
second-guessing it, so your results match what shows on your CDJs. If a track is
unanalysed in Rekordbox, analyse it there first and re-export.

**The energy scores don't match my ear.** That's a real and useful bug report,
not user error — the weights in `src/features.rs` are hand-tuned and may not
generalise to your genre. Please open an issue with the genre and a couple of
tracks you think are scored wrongly.

**Does this modify my Rekordbox collection?** No. Track2Mix only reads the XML
you export. It writes M3U8 playlists and its own SQLite database, and never
touches your collection file or your audio files.
