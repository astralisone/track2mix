# Track2Mix marketing site

Static HTML/CSS/JS. No build step, no dependencies, no framework. Deploy the
`site/` directory as-is.

```
site/
  index.html           landing page
  downloads/index.html downloads page, served at downloads.track2mix.com
                       (shows the latest GitHub release; static markup is the fallback)
  privacy/index.html   privacy policy — required by Google Play
  styles.css           tokens mirrored from ../tailwind.config.ts
  main.js              email capture, tip jar and store links (three constants, below)
  robots.txt
  assets/              logo, favicons, app icon
```

Response headers are set by `../worker/index.js`, which also routes
`/api/contact` and rewrites `/` on the downloads host; see
[docs/DEPLOY.md](../docs/DEPLOY.md).

## Local preview

```bash
python3 -m http.server 8000 --directory site
# → http://localhost:8000
```

## Deploy free on Cloudflare Pages

1. Push this repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick the repo. **Framework preset:** None. **Build command:** leave empty.
   **Build output directory:** `site`.
4. Deploy. You get `https://<project>.pages.dev` on free TLS, with a rebuild on
   every push to the branch you selected.

Netlify, Vercel and GitHub Pages all work the same way — the only setting that
matters is that the publish directory is `site`.

## Wire up the download gate (required before launch)

The download is gated: name and email are mandatory, and the link is returned
by the server only after the contact is saved. Nothing to configure in this
directory — the form posts to `/api/contact`, which the Worker in `worker/`
handles: it writes to the shared D1 contacts database and subscribes the person
to your mailing list.

Full setup (create the database, apply the schema, set the list secrets, bind it
to the Worker) is in **[docs/CONTACTS.md](../docs/CONTACTS.md)**.

Until the binding exists, submitting the form returns a 500 that names the
missing variable. It does not fake a success, and it does not hand out the
download.

### One thing the gate cannot do

GitHub Releases is public. Anyone who goes to the repository directly can
download the build without ever seeing the form, and the site links to the
source on purpose. So treat this as a soft gate that captures the large
majority who arrive via the site, not as access control. Hardening it properly
would mean serving the binary from R2 behind a signed, expiring URL that
`/api/contact` issues — worth doing only if the leakage turns out to matter.

## The look: the dark room

Both pages follow one art direction, dealt by the `design-taste-frontend` skill
in `.agents/skills/` (direction "dark-room", seed 1132536334, brand palette and
type kept; the sheet is reprinted with `node .agents/skills/design-taste-frontend/scripts/draw.mjs --show`).
One dark ground, and in it lit things: the app's own interface fragments
(`data-ui` blocks in `index.html`, styled under `[data-ui]` in `styles.css`), and
four openly licensed pictures in `assets/pics/` with their credits in
`assets/pics/credits.json` and in the footer. House rules the skill enforces:
no eyebrow labels, no monospace outside the app fragments and code, no
gradients, no glows, no icon cards, two-line headlines everywhere. Check a change
with:

```bash
node .agents/skills/design-taste-frontend/scripts/lint.mjs site/index.html site/styles.css site/main.js
node .agents/skills/design-taste-frontend/scripts/inspect.mjs site/index.html --allow palette-purple,mono
```

`--allow palette-purple,mono` is deliberate: iris is the app's own key colour and
JetBrains Mono its own figures face, and both appear only inside the fragments.

## No tablet marketing here

The site sells the desktop app only. The paid Android tablet app is marketed
by its Google Play listing, not here, so that the pay-what-you-want pitch and
a priced product never share a page (decided 22 Oct 2026). The privacy policy
keeps a paragraph covering the tablet app because Play requires it.

## Wire up payments (desktop tip jar)

Set at least one handle in `PAYMENTS` at the top of `main.js`:
`paypalMe`, `koFi`, `githubSponsors`. Each link renders only when configured,
and with none set the tip jar disables itself and says so.

PayPal is the only one that accepts a prefilled amount, so the tier buttons
deep-link to it — and note it takes the amount as a **path segment**
(`paypal.me/you/15USD`), not `?amount=`. Comparison table and the reasoning are
in [docs/CONTACTS.md](../docs/CONTACTS.md#payments).

## Before you launch

- [x] Create the D1 database, apply the schema and bind it, then submit the
      form once and confirm the row lands in `contacts` and the person lands in
      your mailing list. See [docs/CONTACTS.md](../docs/CONTACTS.md).
- [x] Set at least one handle in `PAYMENTS` (`astralisboss`, the Astralis One
      business account; its PayPal.Me drops the amount, so the page says to
      enter it on PayPal's side).
- [ ] Replace the interface fragments (the band and the Compose cards) with **real screenshots**
      of the app running on your own library. The markup in `index.html` under
      `<!-- Accurate rendering of the Track2Mix track view -->` is an honest
      rendering of the real columns with anonymised rows, but a genuine
      screenshot converts better and removes any doubt. A side-by-side of
      Rekordbox's Related Tracks against Track2Mix's picks for the same anchor
      track is the single most persuasive image you can put here.
- [ ] Add `assets/og.png` at 1200×630 for link previews — `index.html` already
      references it. Without it, shared links render without an image.
- [x] `DOWNLOAD_URL` in `wrangler.toml` points at downloads.track2mix.com, which
      lists the latest GitHub release itself.
- [ ] Update the GitHub URLs if the repo moves — they appear in `index.html`
      in the nav-adjacent CTA (`#gh-link`) and the footer.
- [ ] Turn on **Cloudflare Web Analytics** (free, no cookie banner needed) so
      you can see which channel actually sends traffic.
