First tagged build of Track2Mix — the Rekordbox library analyser that tells you which of your tracks actually mix with the one you're playing.

## What's in this release

| Asset | What it is |
| --- | --- |
| `track2mix-cli-v0.1.0-linux-x86_64.tar.gz` | The analyser CLI: `analyze`, `top`, `compat`, `stats` |
| `track2mix-desktop-v0.1.0-linux-x86_64.tar.gz` | The desktop GUI (requires `libwebkit2gtk-4.1`, `libgtk-3`) |
| `SHA256SUMS` | Checksums for both archives |

## Linux only, and why

The site describes Track2Mix as a macOS and Windows app, and that is the intent. Those builds are produced by `.github/workflows/release.yml`, which cannot run: **GitHub Actions has never assigned a runner to this organisation** — nine runs and two re-runs across three pull requests, every one dying at scheduling with `runner_id=0` and zero steps. Until that is fixed at the org level, no CI build of any platform can be cut.

These Linux artifacts were built and verified by hand instead, so that something real exists behind the download link rather than a 404. macOS and Windows builds follow the moment Actions works — the workflow is written, and signs and notarizes when the `APPLE_*` secrets are present.

Marked as a pre-release for that reason.

## Verified

```
cargo test --package track2mix --all-targets    10 tests
node functions/api/contact.test.mjs             21 assertions
bun run build                                   tsc + vite
```

Beyond the test suites, the app was run end to end against a library with deliberately ordered energy profiles. `top --by energy` returned exactly the designed order, and `compat` from an `8A` anchor returned `7A`, `8A` and `9A` while excluding a `2A` track sitting at the identical 174 BPM — which `--any-key` then included. The extracted CLI in this archive was smoke-tested against that same database.

## Getting started

```bash
tar -xzf track2mix-cli-v0.1.0-linux-x86_64.tar.gz
./track2mix analyze --xml ~/rekordbox.xml --dry-run   # coverage check first
./track2mix analyze --xml ~/rekordbox.xml
./track2mix top --by energy --limit 20
./track2mix compat "the track you're opening with" --bpm-tol 3
```

Full instructions, including the Gatekeeper workaround for unsigned macOS builds once those exist: [docs/INSTALL.md](https://github.com/astralisone/track2mix/blob/main/docs/INSTALL.md)

## Known limits

Track2Mix uses Rekordbox's own key analysis rather than detecting its own, so an unanalysed track has no key here either. It reads Rekordbox XML only — no Serato or Traktor yet. And the energy weighting is tuned by ear on one person's library, which is exactly what this beta is meant to test: if the scores don't match your ear, that's a bug report worth filing.
