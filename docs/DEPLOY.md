# Deploying track2mix.com

The domain is registered and already on Cloudflare nameservers, so this is a
dashboard flow plus one optional CLI step. Roughly five minutes.

## 1. The Cloudflare project

The project already exists as a **Workers** service named `track2mix`, with
Workers Builds connected to `astralisone/track2mix`. Nothing to create.

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
file — so Workers Builds needs only its default deploy command, `npx wrangler
deploy`. `npm run deploy` runs the same thing by hand.

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

Until this is done, `/api/contact` returns a 500 that names `CONTACTS_DB` as the
missing binding. That is deliberate: the form reports the failure rather than
pretending someone was signed up. The rest of the site works normally.

```bash
npm install -g wrangler
wrangler login

wrangler d1 create contacts
# paste the printed database_id into wrangler.toml and uncomment that block

wrangler d1 execute contacts --remote --file=./migrations/0001_contacts.sql
```

Uncommenting the `[[d1_databases]]` block in `wrangler.toml` is what binds it —
on a Workers service the binding lives in config, not in the dashboard. Confirm
it took with `npx wrangler deploy --dry-run`, which lists `env.CONTACTS_DB`
among the bindings.

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

## 5. Check it end to end

- [ ] `https://track2mix.com` loads over HTTPS with no certificate warning.
- [ ] Submit the download form with a real address, then confirm the row landed:
      `wrangler d1 execute contacts --remote --command "SELECT * FROM contacts"`.
- [ ] Confirm the same address reached your mailing list.
- [ ] Click a tip tier and confirm PayPal opens prefilled at the right amount.
- [ ] Turn on **Cloudflare Web Analytics** (free, no cookie banner) so you can
      see which channel actually sends traffic.

## Why the D1 block is commented out

Cloudflare validates `database_id` as a UUID. A placeholder there fails config
validation and blocks the entire deploy — including the static site, which does
not need the database. So the site ships first and the binding is added second.
