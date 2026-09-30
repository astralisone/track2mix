# Central contacts store, and taking payments

Everyone who downloads Track2Mix is captured into one Cloudflare D1 database
designed to be shared by all your apps, and subscribed to your mailing list.
This is the setup.

## Why there's a server-side piece at all

The site is static, so anything in `site/main.js` is readable by anyone who
views source. A database credential or list API key cannot live there. So the
form posts to `/api/contact`, which `worker/index.js` routes to
`worker/contact.js`. That runs on Cloudflare's side, holds the secrets, and
returns the download link only after the contact is saved.

That also means the download URL isn't in the page source before someone fills
the form in — the server hands it back with the success response.

## The data model

Two tables, so that a second app never duplicates a person.

**`contacts`** — one row per human, keyed by email (case-insensitive). A
returning contact updates their name and `updated_at` instead of inserting
again.

**`contact_events`** — one row per interaction, carrying `app`, `event` and a
JSON `metadata` blob. Track2Mix writes `download_requested` with
`app = "track2mix"`. Your next app writes its own events against the same
contact.

To find everyone who has touched anything:

```sql
SELECT c.name, c.email, GROUP_CONCAT(DISTINCT e.app) AS apps, MAX(e.occurred_at) AS last_seen
FROM contacts c
LEFT JOIN contact_events e ON e.contact_id = c.id
GROUP BY c.id
ORDER BY last_seen DESC;
```

## Setup

### 1. Create the database (once, for all apps)

```bash
npm install -g wrangler
wrangler login
wrangler d1 create contacts
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`PASTE_DATABASE_ID_FROM_WRANGLER_D1_CREATE`.

### 2. Apply the schema

```bash
wrangler d1 execute contacts --remote --file=./migrations/0001_contacts.sql
```

Check it landed:

```bash
wrangler d1 execute contacts --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

### 3. Connect the mailing list

The endpoint subscribes people so you can actually send the download link and
version notes the site promises. [Buttondown](https://buttondown.com) is free to
100 subscribers and its API shape is what `subscribeToList()` is written for.

```bash
wrangler secret put LIST_ENDPOINT
# https://api.buttondown.email/v1/subscribers

wrangler secret put LIST_AUTH_HEADER
# Token <your-buttondown-api-key>
```

Secrets are deliberately not in `wrangler.toml`, which is committed to git.

To use a different provider, `subscribeToList()` in
`worker/contact.js` is the only function that changes.

**A list outage never costs you a contact.** The database write happens first.
If the list call then fails, the contact is still saved, the download is still
granted, the failure is written onto the event row as `list_error`, and it comes
back in the response's `warnings`. Find anyone who needs re-subscribing with:

```sql
SELECT c.email, c.name, json_extract(e.metadata, '$.list_error') AS error
FROM contact_events e JOIN contacts c ON c.id = e.contact_id
WHERE json_extract(e.metadata, '$.list_subscribed') = 0;
```

### 4. Bind the database to the Worker

Uncomment the `[[d1_databases]]` block in `wrangler.toml` and paste in the
`database_id` from step 2. On a Workers service the binding is declared in
config rather than in the dashboard, so it is reviewable and travels with the
repository. Verify with:

```bash
npx wrangler deploy --dry-run
```

`env.CONTACTS_DB` should appear in the bindings table it prints.

### 5. Test it locally before deploying

```bash
node worker/contact.test.mjs                # 21 assertions, no network
node worker/index.test.mjs                  # 22 assertions, routing and headers
wrangler dev --d1 CONTACTS_DB=contacts
```

Then submit the form at `http://localhost:8787` and confirm the row:

```bash
wrangler d1 execute contacts --local --command "SELECT * FROM contacts"
```

---

## Payments

Set the handles at the top of `site/main.js`. Each renders only when
configured; with none set the tip jar disables itself and says so rather than
linking nowhere.

```js
const PAYMENTS = {
  paypalMe: "",        // paypal.me/<handle>
  koFi: "",            // ko-fi.com/<handle>
  githubSponsors: "",  // github.com/sponsors/<username>
};
```

| Method | Fee | Setup | Role |
| --- | --- | --- | --- |
| **PayPal.me** | Standard PayPal fees | Minutes — just claim a handle | Primary. The only one that takes a prefilled amount, so the $5/$15/$30 tiers deep-link to it. |
| **Ko-fi** | 0% platform fee | ~10 minutes | Covers card and Apple Pay for people without PayPal. |
| **GitHub Sponsors** | 0% | Needs approval, ~a day | One-off or monthly, and it fits a public repo. |

### The PayPal.me gotcha

PayPal.me carries the amount as a **path segment**, not a query parameter:

```
https://paypal.me/yourhandle/15USD     ✅ opens prefilled at $15
https://paypal.me/yourhandle?amount=15 ❌ ignored, blank amount field
```

`paypalUrlFor()` builds the correct shape. Change `TIP_CURRENCY` if you don't
want USD.

### Recommended combination

PayPal as the default (every DJ already has one), Ko-fi alongside it for cards
and Apple Pay, and GitHub Sponsors for the handful who'd rather back it monthly.
That covers effectively everyone without a payment processor account, business
details, or a single line of checkout code.

### Where the tip ask actually converts

Not on the landing page. Put it where the value just landed:

1. **After a successful analysis run, inside the app.** The moment a DJ sees
   their library scored is the moment the tool has proven itself. By far the
   highest-converting placement, and it costs nothing.
2. **On the download email.** They opted in; use it.
3. **In each release's notes.** People who update are people who use it.

The tier block on the site exists to establish that paying is normal. It is not
where the money comes from.
