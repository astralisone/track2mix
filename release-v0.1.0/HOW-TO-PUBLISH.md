# Publishing v0.1.0

I built and verified these artifacts but could not publish them: this session's
GitHub proxy returns 403 on tag pushes and refuses release creation outright
("Creating, editing, or deleting releases is not permitted for this session
type"). It is a capability limit of the session, not a repository setting, so
there is nothing to reconfigure — the last step has to be run by you.

Two minutes either way.

## With the gh CLI

```bash
git clone https://github.com/astralisone/track2mix
cd track2mix
git tag -a v0.1.0 bc0de42 -m "Track2Mix v0.1.0"
git push origin v0.1.0

gh release create v0.1.0 \
  --title "Track2Mix v0.1.0" \
  --notes-file RELEASE-NOTES.md \
  --prerelease \
  track2mix-cli-v0.1.0-linux-x86_64.tar.gz \
  track2mix-desktop-v0.1.0-linux-x86_64.tar.gz \
  SHA256SUMS
```

## Or in the browser

**Releases → Draft a new release** on `astralisone/track2mix`. Tag `v0.1.0`
(create it on `main`), paste `RELEASE-NOTES.md` into the body, drag the three
files in, tick **Set as a pre-release**, publish.

## Verify the downloads afterwards

```bash
sha256sum -c SHA256SUMS
```

Both archives were smoke-tested after packing: the extracted CLI runs and reads
a real analysed database.

## Why pre-release, and why Linux only

The site promises macOS and Windows. Those builds come from
`.github/workflows/release.yml`, which has never been able to run — GitHub has
not assigned a runner to this organisation across nine runs and two re-runs.
These Linux builds exist so the download link resolves to something real
instead of a 404. The moment Actions works, tagging `v0.1.0` again produces the
macOS and Windows bundles, signed and notarized when the `APPLE_*` secrets are
present.
