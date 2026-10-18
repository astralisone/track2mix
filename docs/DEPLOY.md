# Deploying track2mix.com

The domain is registered and already on Cloudflare nameservers, and the Worker
exists, so publishing a change is one command from a checkout. Roughly five
minutes for a first-time setup.

## 0. Deploys run from a checkout, not from Workers Builds

Deploy with:

```bash
npx wrangler deploy
```

from a clean, up-to-date checkout of `main`. `npm run deploy` is the same
command.

This is deliberate. Workers Builds — Cloudflare's own CI, triggered by pushes
to the connected repository — has been failing on this project with builds that
report zero duration: `started_at` and `completed_at` land on the same second,
so nothing is cloned, installed or deployed. No change to this repository can
fix a build that never starts, and the Builds API is not reachable from the
tooling here to read why. Deploying from a checkout removes the dependency
entirely.

**Disconnect the integration** so the red check stops appearing on every pull
request: Cloudflare dashboard → **Workers & Pages** → `track2mix` → **Settings**
→ **Builds** → disconnect the repository. The Worker, its routes, its custom
domains and its bindings are untouched by this; only the automatic build on
push goes away.

The trade-off is that nothing deploys unless someone runs the command, so a
merged change sits unpublished until then. `wrangler deploy --dry-run` runs in
CI on every pull request and catches a broken config before merge, but it
cannot deploy. Check what is actually live after merging something:

```bash
curl -s https://track2mix.com/styles.css | wc -c
```

## 1. The Cloudflare project

The project exists as a **Workers** service named `track2mix`. Nothing to
create.

That is what the repository is configured for. The site ships as **Workers
Static Assets**:

| `wrangler.toml` | Effect |
| --- | --- |
| `main = "worker/index.js"` | the Worker Cloudflare runs |
| `[assets] directory = "site"` | `site/` is uploaded to the edge as-is |
| `[assets] binding = "ASSETS"` | the Worker can serve those files |
| `[assets] run_worker_first = true` | every request reaches the Worker first |

`worker/index.js` routes `POST /api/contact` to `worker/contact.js` and hands
everything else to the asset server, adding the response headers on the way out.

There is no build step — the landing page is hand-written HTML, CSS and one JS
file — so deploying is a single `npx wrangler deploy`, as above.

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

Project → **Custom domains → Set up a custom domain** → `track2mix.com`.

Because the domain is already in the same Cloudflare account, the DNS record and
certificate are created for you. Add `www.track2mix.com` the same way if you want
it; Cloudflare will redirect it to the apex.

## 3. Turn the download form on

The database half is done: `contacts` exists, both tables and all four indexes
are applied, and the `[[d1_databases]]` block in `wrangler.toml` binds it. On a
Workers service the binding lives in config, not in the dashboard, so
`npx wrangler deploy --dry-run` lists `env.CONTACTS_DB` among the bindings.

This has to reach the edge to take effect. A binding added to `wrangler.toml`
does nothing until the next deploy, so the live `/api/contact` keeps answering
500 and naming `CONTACTS_DB` until one runs. That 500 is deliberate — the form
reports the failure rather than pretending someone was signed up — but it means
every submission is lost while it lasts, so deploy promptly after merging a
binding change.

What remains is the mailing list, so the download link can actually be sent:

```bash
wrangler secret put LIST_ENDPOINT
# https://api.buttondown.email/v1/subscribers

wrangler secret put LIST_AUTH_HEADER
# Token <your-buttondown-api-key>
```

## 4. Payments

Put your PayPal.me handle into `PAYMENTS` at the top of `site/main.js` and push.
Until at least one handle is set, the tip jar renders disabled and says so.

## 5. Check it end to end

- [ ] `https://track2mix.com` loads over HTTPS with no certificate warning.
- [ ] Submit the download form with a real address, then confirm the row landed:
      `wrangler d1 execute contacts --remote --command "SELECT * FROM contacts"`.
- [ ] Confirm the same address reached your mailing list.
- [ ] Click a tip tier and confirm PayPal opens prefilled at the right amount.
- [ ] Turn on **Cloudflare Web Analytics** (free, no cookie banner) so you can
      see which channel actually sends traffic.

## Why the D1 block was commented out

It is filled in now, but the reason it shipped commented out is worth keeping:
Cloudflare validates `database_id` as a UUID, so a placeholder there fails
config validation and blocks the entire deploy — including the static site,
which does not need the database at all. That is why the site shipped first and
the binding followed. If you ever need to stage this again on a new account,
comment the block out rather than leaving a placeholder id in it.
