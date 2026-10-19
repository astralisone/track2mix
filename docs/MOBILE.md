# Track2Mix for iPad and Android tablets

How the tablet builds are produced, signed and submitted, and what they do.

## What the tablet app is

The same Tauri app as the desktop, built for `aarch64`/`armv7`/`x86_64`
Android and for iPadOS, with the identifier `com.track2mix.app` (the desktop
keeps `com.track2mix.desktop`; the override lives in
`src-tauri/tauri.android.conf.json` and `src-tauri/tauri.ios.conf.json`).

Rekordbox does not run on a tablet and neither does the analysis, so the
tablet app is the **digging half**: open a `library.db` produced by the desktop
app or the CLI, then browse, filter, use the Camelot wheel, match, build
playlists and export M3U8. Preview and Compose are present but need the audio
files on the device; the database stores the desktop paths, so on a tablet
each missing file is reported per track (`nofile`), never silently.

What differs from the desktop in code:

| Concern | Desktop | Tablet |
| --- | --- | --- |
| Startup library | `./library.db`, else `~/library.db` | `<app data dir>/library.db` |
| Opening a library | `open_library(path)` in place | **`import_library(source)`**: the picker's result (`content://` on Android, a security-scoped copy on iPadOS) is copied atomically into the app data dir through `tauri-plugin-fs`, then opened |
| Playlist export | written to the chosen path | written to a temp file, then copied into the picker's destination through `tauri-plugin-fs` |
| Import Rekordbox XML, skip-analyzed | shown | hidden; the empty state explains the copy-the-db flow |
| Window chrome | drag region, 64 px left gap for macOS traffic lights | no gap; `decorations: false` |
| Permissions | `capabilities/default.json` (desktop platforms) | `capabilities/mobile.json` (`core:default`, `dialog:default`) |

`ui/src/lib/platform.ts` decides which it is from the user agent (iPadOS
reports as a Mac, so touch points are checked too).

---

## Android

### Toolchain (Linux or macOS)

Nothing system-wide is needed; this is what the first build on this machine
installed, all under `$HOME`:

| Piece | Where | How |
| --- | --- | --- |
| rustup + Android targets | `~/.rustup`, `~/.cargo` | `rustup-init -y --no-modify-path`; `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android` |
| Android SDK | `~/Android/Sdk` | command-line tools zip, then `sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.2.12479018"` |
| JDK 17+ | `/usr/lib/jvm/java-21-openjdk` | distro package |

Environment for every Tauri Android command:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export PATH="$HOME/.cargo/bin:$ANDROID_HOME/platform-tools:$PATH"
```

`$HOME/.cargo/bin` has to come first so Tauri uses the rustup toolchain, which
has the Android targets, rather than a distro `cargo`. A plain
`cargo check --target aarch64-linux-android` does **not** work (LAME's
`configure` and SQLite need the NDK compilers that only the Tauri CLI exports);
use the Tauri commands below.

### The generated project

`src-tauri/gen/android/` was created by `bunx tauri android init` and is
committed. Three things in it are hand-edited and must survive a re-init:

- `app/src/main/AndroidManifest.xml` — `<supports-screens>` with
  `requiresSmallestWidthDp="600"` so phones are excluded from the listing, the
  activity pinned to `userLandscape`, and the Android TV launcher category
  removed.
- `app/build.gradle.kts` — a `release` signing config read from
  `keystore.properties`.
- `.gitignore` — `keystore.properties`, `*.jks`, `*.keystore`.

### Signing

The upload keystore is **outside the repository** and git-ignored everywhere:

```
~/.config/track2mix/upload-keystore.jks        PKCS12, alias "upload", RSA 2048, valid 10000 days
src-tauri/gen/android/keystore.properties      storeFile=, storePassword=, keyAlias=, keyPassword=
```

Both were generated on 2026-10-19 with `keytool -genkeypair` and a random
28-character password that lives only in `keystore.properties`. **Back both
files up** (password manager). If `keystore.properties` is missing the release
build still completes but Gradle logs
`track2mix: keystore.properties not found — the release build will be unsigned`
and Play rejects the bundle. Use **Play App Signing** when creating the app in
the Play Console; then this key is only the upload key and can be reset with
Google if it is ever lost.

### Build

```bash
bun install
bunx tauri android build --apk --aab --target aarch64 --target armv7 --target x86_64
```

Outputs:

```
src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab   → Play Console
src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk     → sideload / testing
```

`versionName` comes from `tauri.conf.json` (`0.2.0`); `versionCode` is derived
from it by the Tauri CLI, so every store upload needs a version bump in
`tauri.conf.json`, `package.json` and both `Cargo.toml` files.

Install on a connected tablet with USB debugging on:

```bash
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

Or develop with hot reload on the device: `bunx tauri android dev`.

### Google Play listing

1. [Play Console](https://play.google.com/console) → **Create app** →
   *App*, *Paid*. The one-time $25 developer registration applies if not done.
2. **Set up your app**: content rating (IARC questionnaire: utility, no
   user-generated content), target audience 18+, **Data safety: no data
   collected or shared** (the app makes no network calls), privacy policy URL
   `https://track2mix.com/privacy/`.
3. **Pricing**: $19.99 USD, let Play convert for other countries, then round
   the big markets to local tier prices (€19.99, £17.99, A$29.99, C$26.99).
4. **Store listing**: copy and screenshot sizes below. Play needs at least
   four 7-inch *and* four 10-inch tablet screenshots to show the app to
   tablets, plus the 1024×500 feature graphic and the 512×512 icon
   (`brand/app-icon-512.png`).
5. **Release → Production → Create release**, upload the `.aab`, release notes
   from `release-v0.2.0/RELEASE-NOTES.md`.
6. Paste the listing URL into `STORES.googlePlay` in `site/main.js` and
   redeploy the site; the badge turns from "Coming soon" into "Buy on Google
   Play" and the notify form for Android disappears.

Device targeting: `<supports-screens>` already excludes phones. In the Play
Console, **Device catalog → Manage** confirms the excluded set; don't re-add
phones there.

---

## iPad

### Requirements

- A Mac with Xcode 15 or later (the iOS toolchain only exists on macOS). The
  Linux machine this was set up on cannot produce an iPad build;
  `.github/workflows/mobile.yml` runs the steps below on a `macos-latest`
  runner instead.
- Apple Developer Program membership ($99/yr — the same one
  [CODE-SIGNING.md](CODE-SIGNING.md) needs for the Mac build).
- `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.

### Build

```bash
bun install
bunx tauri ios init               # generates src-tauri/gen/apple/, once; commit it
bunx tauri ios build --export-method app-store-connect
```

The first `init` needs the Team ID: set `APPLE_DEVELOPMENT_TEAM=<TEAMID>` or
pick it in Xcode under the project's Signing settings. The build produces an
`.ipa` under `src-tauri/gen/apple/build/arm64/`. Upload it with Xcode's
**Transporter** app or:

```bash
xcrun altool --upload-app -f Track2Mix.ipa -t ios --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
```

Tablet-only: after `init`, in Xcode set the target's **Deployment Info →
Devices** to **iPad** only (`TARGETED_DEVICE_FAMILY = 2`) and tick only the
landscape orientations. `tauri.ios.conf.json` already sets the minimum to
iPadOS 16.

Develop on a connected iPad with `bunx tauri ios dev`.

### App Store Connect

1. **My Apps → +** → bundle ID `com.track2mix.app` (register it in the
   developer portal first), SKU `track2mix-ipad`.
2. **Pricing and Availability**: price tier for $19.99 USD (Apple fills the
   other territories). Enrol in the **Small Business Program** (15 %
   commission under $1M) before the first sale.
3. **App Privacy**: *Data Not Collected*. Privacy policy URL
   `https://track2mix.com/privacy/`.
4. **App Information**: category *Music*, secondary *Utilities*. Age rating
   4+.
5. Screenshots: 12.9-inch iPad Pro (2048×2732 or 2732×2048) are required;
   13-inch and 11-inch optional.
6. Submit the build from TestFlight, with the review note in the copy section
   below (reviewers need to know the app opens a database made elsewhere).
7. Paste the listing URL into `STORES.appStore` in `site/main.js` and redeploy
   the site.

---

## CI

`.github/workflows/mobile.yml` builds both on every `v*` tag and on manual
dispatch: Android on `ubuntu-latest` (signed when the `ANDROID_KEYSTORE_*`
secrets exist, unsigned otherwise, always uploaded as a workflow artifact) and
iPad on `macos-latest` (only when the `APPLE_*` and `IOS_*` secrets exist). It
does not upload to the stores; that stays a deliberate manual step.

Secrets it reads:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 ~/.config/track2mix/upload-keystore.jks` |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD` | from `keystore.properties` |
| `ANDROID_KEY_ALIAS` | `upload` |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID` | as in [CODE-SIGNING.md](CODE-SIGNING.md), but the certificate is an **Apple Distribution** one |
| `IOS_PROVISIONING_PROFILE_BASE64` | an App Store provisioning profile for `com.track2mix.app` |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_PRIVATE_KEY` | an App Store Connect API key, for `xcodebuild -exportArchive` |

---

## Store copy

**Name**: Track2Mix — DJ library intelligence

**Subtitle / short description** (30 / 80 chars):
*Which of your tracks mixes with this one?*
*Your analysed Rekordbox library on the tablet: key, BPM and energy matching, playlist building, M3U8 export.*

**Description**

Track2Mix tells you which tracks in your own Rekordbox library mix with the one you're playing — by key, by BPM, and by how hard they hit.

Analyse your collection with Track2Mix on your computer (free, pay what you want, at track2mix.com), copy the resulting library.db to your tablet, and open it here.

• Every track scored for energy from the audio itself
• Camelot wheel: same key, relative major/minor, ±1 on the wheel
• BPM tolerance with half/double-tempo matching
• Filters with live counts: search, genre, sub-genre, BPM range, energy range
• A playlist builder that orders your picks as a harmonic flow, an energy ramp or by BPM, scores every transition and suggests the next track
• Export as M3U8 — Rekordbox imports it directly
• Works offline. No account, no upload, no tracking.

Designed for tablets in landscape. Previewing audio and the composer require the audio files to be present on the tablet.

**Keywords (App Store, ≤100 chars)**: `dj,rekordbox,harmonic mixing,camelot,bpm,key,playlist,set,energy,library`

**Review notes**: The app opens a SQLite library produced by the free desktop
version; a sample `library.db` is attached / available at
`<link to a small sample db you upload>`. No account is needed. The app makes
no network requests.

**Screenshots to take** (landscape, same library in each): the track table
sorted by energy; the Camelot wheel with Match anchor on; the compatibility
panel for an anchor; the playlist builder with transition badges and the set
curve; the export sheet.

---

## Pricing

**$19.99 one-time**, no in-app purchases, no subscription, with a two-week
launch price of $14.99. Why that number:

- **Anchored to the desktop tip jar.** The site's "most common" tip is $15 and
  the FAQ promises a desktop user who tipped the typical amount isn't paying
  more for the tablet version than they chose to on the desktop. $19.99 list
  with a $14.99 launch keeps that promise literally at launch and close to it
  afterwards.
- **Store economics.** At $19.99, Apple's Small Business Program (15 %) nets
  about $17 and Play (15 % on the first $1M) the same. At $9.99 it would net
  $8.50 — half the revenue for, realistically, not twice the buyers in a niche
  this small.
- **The comparison set.** Mixed In Key is $58 (desktop, one-time); Lexicon DJ
  is $15/month; Rekordbox's own paid tiers start at $9.99/month. A $19.99
  one-time companion sits clearly under all of them while signalling it's a
  real tool, not a $2.99 utility.
- **Per-platform purchase is normal.** Pro-audio apps on iPad (Koala, AUM,
  djay's one-time options) sell separately from their desktop versions at
  $9.99–$29.99; buyers in this category expect it.

Revisit after the first 100 sales: if conversion from the site's tablet
section is under 1 % with meaningful traffic, test $14.99 permanently; if
reviews call it cheap for what it does, $24.99 is the next Apple tier.

Do not mention the tip jar, pay-what-you-want, or the free desktop download
*price* in the store listings — the stores forbid steering to outside payment
in some territories and it muddies the offer. The listing may say the desktop
analyser exists and where (it has to, for the app to be usable).
