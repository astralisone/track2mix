# Deploying track2mix.com

The domain is registered and already on Cloudflare nameservers, so this is a
dashboard flow plus one optional CLI step. Roughly five minutes.

## 1. Create the Pages project

Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.

| Setting | Value |
| --- | --- |
| Repository | `astralisone/track2mix` |
| Production branch | `main` |
| Framework preset | **None** |
| Build command | *(leave empty)* |
| Build output directory | `site` |

The site is static, so there is nothing to build. `functions/api/contact.js` is
picked up automatically — Pages treats a top-level `functions/` directory as
routes without any configuration.

Deploy. You get `track2mix.pages.dev` immediately.

## Troubleshooting: "Missing entry-point to Worker script or to assets directory"

If the build log contains this, near the top:

```
▲ [WARNING] It seems that you have run `wrangler deploy` on a Pages project,
            `wrangler pages deploy` should be used instead.
✘ [ERROR] Missing entry-point to Worker script or to assets directory
```

then the project is running the **Workers** deploy command against a **Pages**
project. `wrangler deploy` ignores `pages_build_output_dir`, goes looking for a
Worker entry point, finds none, and stops. Nothing is wrong with `wrangler.toml`.

It happens when the project was created from the **Workers** tab (Workers
Builds defaults its deploy command to `npx wrangler deploy`) rather than the
**Pages** tab.

Two ways out.

**Change the deploy command** — one field, keeps the project you already have.
Project → **Settings → Build** → *Deploy command*:

```
npx wrangler pages deploy
```

No path is needed: `pages_build_output_dir = "site"` in `wrangler.toml` already
says where the output is. `npm run deploy` is wired to the same thing.

**Or recreate it as a Pages project**, which is what step 1 above describes and
what this repository is configured for. Workers & Pages → Create → the **Pages**
tab → Connect to Git. Leave the build command empty and set the output
directory to `site`. A Pages project needs no deploy command at all.

Prefer the second if nothing depends on the existing project yet: Pages is the
product `functions/api/contact.js` is written for. A top-level `functions/`
directory becomes routes automatically under Pages; Workers uses a different
model and would need that endpoint rewritten as a Worker entry point.

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

Then bind it: project → **Settings → Bindings → Add → D1 database**, variable
name `CONTACTS_DB`, database `contacts`. Add it for Production *and* Preview.

Finally the mailing list, so the download link can actually be sent:

```bash
wrangler pages secret put LIST_ENDPOINT
# https://api.buttondown.email/v1/subscribers

wrangler pages secret put LIST_AUTH_HEADER
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
