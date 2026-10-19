# Publishing v0.2.0

Everything in this directory and in the repository is ready; the publishing
steps below need your GitHub, Play and App Store accounts.

## 1. Desktop release on GitHub

```bash
git tag -a v0.2.0 -m "Track2Mix v0.2.0"
git push origin v0.2.0
```

`.github/workflows/release.yml` builds the Windows `.msi` + setup `.exe`, the
Linux `.deb` / `.rpm` / AppImage, and the macOS universal `.dmg`, and opens a
**draft** release. Paste `RELEASE-NOTES.md` into the body, add the Arch package
and `PKGBUILD` if you build them locally (`bun run build:bundles` produces the
Linux bundles under `src-tauri/target/release/bundle/`), publish a
`SHA256SUMS`, then publish the release.

The downloads page (`downloads.track2mix.com`) reads the latest release from
the GitHub API, so it shows the new version, file names and sizes as soon as
the release is published — no site edit needed. Its static markup is the
fallback for when the API is unreachable; update the version and asset names
there when convenient.

If GitHub Actions still has no runner for the organisation (the v0.1.0
situation), build the Linux bundles locally as above and the Windows installer
on a Windows machine with `bun run build:bundles`, and upload them by hand.

## 2. Android

The signed `.aab` is produced locally (see `docs/MOBILE.md`):

```
src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab
```

Upload it in the Play Console under **Production → Create release**, with
`RELEASE-NOTES.md` as the release notes. Then put the listing URL into
`STORES.googlePlay` in `site/main.js` and deploy the site.

## 3. iPad

Needs a Mac with Xcode, or the `ipad` job in `.github/workflows/mobile.yml`
with the Apple secrets set and the `IOS_BUILD_ENABLED` repository variable set
to `true`. Steps and the App Store Connect checklist are in `docs/MOBILE.md`.
Then put the listing URL into `STORES.appStore` in `site/main.js` and deploy.

## 4. Verify

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

and on a clean machine: install, open an existing `library.db`, play a track,
build a playlist, export an M3U8 and import it into Rekordbox.
