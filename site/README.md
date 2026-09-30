# Track2Mix marketing site

Static HTML/CSS/JS. No build step, no dependencies, no framework. Deploy the
`site/` directory as-is.

```
site/
  index.html     landing page
  styles.css     tokens mirrored from ../tailwind.config.ts
  main.js        email capture (needs one line of config, below)
  _headers       security + cache headers (Cloudflare Pages / Netlify)
  robots.txt
  assets/logo.svg
```

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

## Wire up payments

Set at least one handle in `PAYMENTS` at the top of `main.js`:
`paypalMe`, `koFi`, `githubSponsors`. Each link renders only when configured,
and with none set the tip jar disables itself and says so.

PayPal is the only one that accepts a prefilled amount, so the tier buttons
deep-link to it — and note it takes the amount as a **path segment**
(`paypal.me/you/15USD`), not `?amount=`. Comparison table and the reasoning are
in [docs/CONTACTS.md](../docs/CONTACTS.md#payments).

## Before you launch

- [ ] Create the D1 database, apply the schema and bind it, then submit the
      form once and confirm the row lands in `contacts` and the person lands in
      your mailing list. See [docs/CONTACTS.md](../docs/CONTACTS.md).
- [ ] Set at least one handle in `PAYMENTS` and click a tier to confirm it opens
      prefilled at the right amount.
- [ ] Replace the hero preview with **real screenshots** of the app running on
      your own library. The markup in `index.html` under
      `<!-- Accurate rendering of the Track2Mix track view -->` is an honest
      rendering of the real columns with anonymised rows, but a genuine
      screenshot converts better and removes any doubt. A side-by-side of
      Rekordbox's Related Tracks against Track2Mix's picks for the same anchor
      track is the single most persuasive image you can put here.
- [ ] Add `assets/og.png` at 1200×630 for link previews — `index.html` already
      references it. Without it, shared links render without an image.
- [ ] Point `DOWNLOAD_URL` in `wrangler.toml` at a real release once GitHub
      Releases has a signed build.
- [ ] Update the GitHub URLs if the repo moves — they appear in `index.html`
      in the nav-adjacent CTA (`#gh-link`) and the footer.
- [ ] Turn on **Cloudflare Web Analytics** (free, no cookie banner needed) so
      you can see which channel actually sends traffic.
