# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

DJs who keep a large Rekordbox library (thousands of tracks) and play from CDJs, at home preparing sets and in the booth. They know the top of their collection cold and the rest not at all. They read Camelot or classical key notation, BPMs and genres daily; they are not developers. Inferred from the repository's README and GO-TO-MARKET.md, not confirmed in an interview this session.

## Product Purpose

Track2Mix is a free, pay-what-you-want desktop app (Windows, Linux; macOS planned) that analyses a Rekordbox library on the user's own machine, scores every track for energy from the audio itself, and ranks the tracks that mix with the one playing by key, BPM and energy. It then lets the user audition the shortlist, build and order a set, export it back to Rekordbox as M3U8, and blend it on a multi-lane timeline (Compose) that renders to WAV or MP3. Success: the DJ reaches the back of their own library and leaves with a set that works.

## Positioning

Rekordbox stores keys and BPMs but has no honest measure of how hard a track hits. Track2Mix measures energy from the waveform (loudness and dynamics, brightness, spectral movement, rhythmic density) and uses it to rank the harmonically and tempo-compatible candidates, turning hundreds of technically valid options into a handful worth auditioning. It runs entirely offline with no account, no upload and no telemetry, and the desktop app is pay what you want. Keys come from Rekordbox's own analysis on purpose, so results match the CDJs.

## Operating Context

The workflow: in Rekordbox, File then Export Collection in xml format; Track2Mix reads that XML, resolves which entries are real files on disk, decodes three 30-second stretches per track, writes a single SQLite file (library.db) next to the XML. Views: Library (track table with Title, Artist, Genre, BPM, Key, Energy 0 to 10; filters with live counts; a clickable Camelot wheel; a compatibility panel; a preview player), Playlist (harmonic flow, energy ramp, BPM order; transition badges Perfect, Relative, one step, Boost, Drop, Clash with a 0 to 100 score; set curve; Suggest next; export M3U8, M3U, TXT), Compose (one lane per track, three-band EQ with kills, high and low pass, mute, solo, vinyl-style sync, snap to beat grid, auto-crossfade, Auto-arrange on 8-bar phrases with 4 to 32-bar blends, Record live, Bounce WAV, Export MP3 at 320 kbps, .t2m project files). A command-line analyser shares the same database. Website: track2mix.com (marketing, email-gated download link, PayPal tip jar) and downloads.track2mix.com (files per platform, fed by the latest GitHub release).

## Capabilities and Constraints

Reads Rekordbox 6 or 7 XML only; Serato, Traktor and Engine DJ are not supported yet. Decodes MP3, FLAC, WAV, AIFF, M4A. Does not detect keys itself. Never modifies the Rekordbox collection or audio files. No network calls from the app. Sync changes pitch (no key-lock). Platforms: Windows 10+ (.msi, setup .exe), Debian/Ubuntu (.deb), Fedora (.rpm), Arch (pacman package, PKGBUILD), any Linux (AppImage); macOS build coming. Paid Android tablet app exists but is marketed only in Google Play, never on the website (decided 2026-10-22). Pricing: desktop free, pay what you want, suggested tips $5, $15, $30 via PayPal (business account Astralis One llc; PayPal.Me drops prefilled amounts). The download form collects name and email (stored in Cloudflare D1, subscribed to Buttondown); the link it returns points at downloads.track2mix.com. Site is hand-written HTML, CSS and one JS file on Cloudflare Workers static assets; no build step.

## Brand Commitments

Name: Track2Mix. Logo: a waveform mark of iris (#7C7EE5) and gold (#F5B71C) bars with a thin light centre line (brand/track2mix-mark.svg, lockups in brand/). Palette the app uses: navy ground (#01020f), light ink (#e1e1e3), iris for keys and structure, gold for energy and emphasis; mirrored in tailwind.config.ts. Typeface in the app and on the site: DM Sans, with JetBrains Mono for figures inside the interface. The owner has said the site must not mix desktop marketing with the paid mobile apps. Voice in existing copy: direct, specific, no hype, first person from the maker on money and feedback. These are inferred from the repository (brand/, site/, docs/) and recorded as binding until the owner says otherwise.

## Evidence on Hand

No screenshots of the real app exist yet; the site shows interface fragments rebuilt in HTML from the real views. Brand assets in brand/. A sample library is not published. No customers, testimonials, press, user counts or benchmarks exist and none may be invented. Openly licensed photographs and a record clip from Wikimedia Commons are in site/assets/pics/ with credits in credits.json. Release artifacts and checksums live on GitHub releases (astralisone/track2mix).

## Product Principles

- Prove, never claim: the ranked shortlist, the energy number and the Camelot matches are the argument.
- The user's library is the hero; Track2Mix is a lens on it, not a replacement for Rekordbox.
- Offline, no account, no upload, no telemetry; say it plainly, once.
- Free to download with nothing withheld; the tip is asked after the value lands.
- Keep desktop marketing and the paid mobile apps apart.
