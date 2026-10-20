# Deploying track2mix.com

The domain is registered and already on Cloudflare nameservers, so this is a
dashboard flow plus one optional CLI step. Roughly five minutes.

## 1. The Cloudflare project

The project exists as a **Workers** service named `track2mix`. The site ships
as **Workers Static Assets**:

| `wrangler.toml` | Effect |
| --- | --- |
| `main = "worker/index.js"` | the Worker Cloudflare runs |
| `[assets] directory = "site"` | `site/` is uploaded to the edge as-is |
| `[assets] binding = "ASSETS"` | the Worker can serve those files |
| `[assets] run_worker_first = true` | every request reaches the Worker first |

`worker/index.js` routes `POST /api/contact` to `worker/contact.js`, rewrites
`/` on the `downloads.` host to the downloads page, and hands everything else
to the asset server, adding the response headers on the way out.

There is no build step — the pages are hand-written HTML, CSS and one JS file.

### Deploys happen on push to main

**Cloudflare Workers Builds** is connected to `astralisone/track2mix` and runs
`wrangler deploy` on every push to `main`; the deployments it makes show up in
`npx wrangler deployments list` with no source message. Verify after a push
with:

```bash
npx wrangler deployments list | grep -A1 Created | tail -4
```

Build settings live in the Cloudflare dashboard (**Workers & Pages →
track2mix → Settings → Builds**), not in the repository. The default deploy
command is all it needs because there is no build step.

### The domain: Worker Custom Domains (moved 20 Oct 2026)

`track2mix.com` and `downloads.track2mix.com` are Worker Custom Domains,
declared in `wrangler.toml` so they travel with the config:

```toml
routes = [
  { pattern = "track2mix.com", custom_domain = true },
  { pattern = "downloads.track2mix.com", custom_domain = true },
]
workers_dev = true
```

`workers_dev = true` is there on purpose: declaring routes makes wrangler turn
the `https://track2mix.gregory-a-starr.workers.dev` URL off by default, and that
URL is the way to check a deploy independently of DNS.

Before 20 Oct the two hostnames were custom domains of a **Cloudflare Pages
project also named `track2mix`**, so pushes updated the Worker while the domain
kept serving the old Pages site. The move, for the record and for the next
domain that needs it:

1. Detach the hostnames from the Pages project. The dashboard does it under
   **Workers & Pages → track2mix (Pages) → Custom domains**; so does the API
   with the `wrangler login` token:
   `DELETE /accounts/<id>/pages/projects/track2mix/domains/<hostname>`.
2. **Delete the DNS records the Pages project left behind** (the CNAMEs to
   `track2mix.pages.dev`), in **DNS → Records** on the zone. Detaching does
   *not* remove them, and while they exist the domain answers **522** and the
   Worker refuses to claim it: *"already has externally managed DNS records,
   delete them first"* (code 100117). Wrangler's "DNS records conflict, update
   them?" prompt does not get past this either, and in a non-interactive shell
   the prompt is auto-declined so the deploy silently skips the attach.
3. `npx wrangler deploy` — Cloudflare creates the records and certificates.
   Confirm with `curl -sI https://track2mix.com/ | grep -i cf-ray`.

The Pages project still exists with no domains; delete it when convenient
(`npx wrangler pages project delete track2mix`) so nothing deploys to it by
mistake.

**Manual fallback.** `.github/workflows/deploy.yml` runs the same deploy from
GitHub Actions on manual dispatch (Actions → *Deploy site (manual fallback)* →
Run workflow), after the Worker tests. It needs two repository secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID shown by `npx wrangler whoami` (already set) |
| `CLOUDFLARE_API_TOKEN` | [dash.cloudflare.com → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → *Edit Cloudflare Workers* template |

```bash
gh secret set CLOUDFLARE_API_TOKEN            # paste the token when prompted
```

`npm run deploy` deploys by hand from a checkout using your local
`wrangler login`.

Check the config before pushing:

```bash
npx wrangler deploy --dry-run
```

It reports the files it read from `site/` and the bindings the Worker will have.
CI runs it on every pull request.

## Troubleshooting: "run a Workers-specific command in a Pages project"

If a build log contains this:

```
✘ [ERROR] It looks like you've run a Workers-specific command in a Pages project.
          For Pages, please run `wrangler pages deploy` instead.
```

or the older wording of the same thing:

```
▲ [WARNING] It seems that you have run `wrangler deploy` on a Pages project,
            `wrangler pages deploy` should be used instead.
✘ [ERROR] Missing entry-point to Worker script or to assets directory
```

then `wrangler.toml` still has `pages_build_output_dir` in it. Wrangler treats
that key as "this is a Pages project" and refuses `wrangler deploy`, which is
the command Workers Builds runs. The fix is the config above: `main` plus an
`[assets]` block, and no `pages_build_output_dir`.

### If you would rather run this on Pages

Pages works too, and `worker/contact.js` keeps Cloudflare's Pages Function
signature so it needs no changes. Moving back means: create a Pages project
(**Workers & Pages → Create → Pages → Connect to Git**, empty build command,
output directory `site`), move `worker/contact.js` to `functions/api/contact.js`
so Pages picks it up as a route, put `pages_build_output_dir = "site"` back and
drop `main` and `[assets]`, and restore `site/_headers` — `worker/index.js`
holds those header rules now.

Worth it only if you specifically want Pages. The Workers path is already
configured, already has the project, and gets the same result.

## 2. Attach the domain

Done — see "The domain: Worker Custom Domains" above. To add a hostname (say
`www.track2mix.com`), append it to `routes` in `wrangler.toml` and deploy;
make sure no DNS record for it exists first.

## 3. Turn the download form on

Done — the `contacts` D1 database (`dfd0eb85-…`) is bound as `CONTACTS_DB` in
`wrangler.toml` and the schema from `migrations/0001_contacts.sql` is applied.
`npx wrangler deploy --dry-run` lists `env.CONTACTS_DB` among the bindings.
Had it not been: `wrangler d1 create contacts`, paste the id into the
`[[d1_databases]]` block, then
`wrangler d1 execute contacts --remote --file=./migrations/0001_contacts.sql`.
Without the binding `/api/contact` answers 500 naming `CONTACTS_DB`, which is
deliberate: the form reports the failure rather than pretending someone was
signed up.

Finally the mailing list, so the download link can actually be sent:

```bash
wrangler secret put LIST_ENDPOINT
# https://api.buttondown.email/v1/subscribers

wrangler secret put LIST_AUTH_HEADER
# Token <your-buttondown-api-key>
```

## 4. Payments

Put your PayPal.me handle into `PAYMENTS` at the top of `site/main.js` and push.
Until at least one handle is set, the tip jar renders disabled and says so.

## 5. Store links for the tablet apps

The iPad and Android tablet apps are sold through the App Store and Google
Play, not downloaded from the site. Once each listing is live, paste its URL
into `STORES` at the top of `site/main.js`:

```js
const STORES = {
  appStore: "https://apps.apple.com/app/id<...>",
  googlePlay: "https://play.google.com/store/apps/details?id=com.track2mix.app",
};
```

Until a URL is set, that platform's badge renders as **Coming soon** without a
link and the "tell me when it's out" form offers that platform; it posts to the
same `/api/contact` endpoint with `interest: "ipad" | "android"`, which writes a
`store_interest` event (see [CONTACTS.md](CONTACTS.md)). With both URLs set the
form removes itself. The displayed price comes from `TABLET_PRICE` in the same
file; change it there when the store price changes. Building and submitting the
apps is covered in [MOBILE.md](MOBILE.md).

## 6. Check it end to end

- [x] `https://track2mix.com` loads over HTTPS with no certificate warning.
- [x] Submit the download form with a real address, then confirm the row landed:
      `wrangler d1 execute contacts --remote --command "SELECT * FROM contacts"`.
- [ ] Confirm the same address reached your mailing list.
- [ ] Click a tip tier and confirm PayPal opens prefilled at the right amount.
- [ ] On the iPad & Android section, confirm each badge either opens its store
      listing or says "Coming soon", and that the notify form saves a row with
      `event = 'store_interest'`.
- [x] Open `https://downloads.track2mix.com` and confirm the cards show the
      latest GitHub release (the page fetches it; the static markup is the
      fallback when the API is unreachable).
- [x] `https://track2mix.com/privacy/` loads — both stores require it.
- [ ] Turn on **Cloudflare Web Analytics** (free, no cookie banner) so you can
      see which channel actually sends traffic.

## Why `database_id` must never be a placeholder

Cloudflare validates `database_id` as a UUID. A placeholder there fails config
validation and blocks the entire deploy — including the static site, which does
not need the database. That is why the block was commented out until the real
id existed.
