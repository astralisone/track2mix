/**
 * POST /api/contact — capture a contact, then hand back the download link.
 *
 * Invoked by worker/index.js, which routes /api/contact here. Running on the
 * server is the whole point: the D1 binding and the list credential stay here
 * and the browser never sees either, rather than site/main.js posting straight
 * to the mailing-list provider with a key in the page source.
 *
 * The signature is Cloudflare's Pages Function shape ({ request, env }) because
 * it costs nothing to keep and means this file works unchanged if the project
 * is ever moved to Pages.
 *
 * Order of operations matters: the contact is written to the central database
 * FIRST and the mailing-list subscription is attempted second. A list outage
 * must never cost you the contact or block someone's download — when it fails,
 * the failure is recorded on the event row and returned in `warnings` so it is
 * visible and retryable, rather than swallowed.
 *
 * Bindings and variables (see wrangler.toml and docs/CONTACTS.md):
 *   CONTACTS_DB       D1 database binding   (required)
 *   APP_NAME          attribution string    (required)
 *   DOWNLOAD_URL      link handed back      (required)
 *   LIST_ENDPOINT     mailing-list API URL  (secret, optional)
 *   LIST_AUTH_HEADER  "Token abc123", or just the key (secret, optional)
 *
 * The optional `interest` field says what the person is after:
 *   "desktop" (default)  the free desktop download — the response carries
 *                        DOWNLOAD_URL and the event is `download_requested`.
 *   "ipad" | "android"   the paid tablet app, which is bought in the store, not
 *                        downloaded here. The event is `store_interest` with
 *                        the platform in its metadata, and no download link
 *                        is returned because there is none to give.
 */

const INTERESTS = new Set(["desktop", "ipad", "android"]);

const MAX_NAME = 120;
const MAX_EMAIL = 254;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** Deliberately permissive: reject only what is obviously not an address. */
function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/**
 * Subscribe to the mailing list. Shaped for Buttondown; to switch providers,
 * this function is the only thing that changes.
 * Returns { ok: true } or { ok: false, reason } — it never throws, because a
 * list failure must not fail the request.
 */
/**
 * The Authorization value for the list API. Buttondown wants "Token <key>";
 * a bare key pasted into the secret is the easy mistake and answers 401 with
 * no hint, so a value with no scheme in front gets the Token scheme added.
 */
export function listAuthHeader(value) {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  return trimmed.includes(" ") ? trimmed : `Token ${trimmed}`;
}

async function subscribeToList(env, { name, email, ip }) {
  if (!env.LIST_ENDPOINT) {
    return { ok: false, reason: "LIST_ENDPOINT is not configured" };
  }

  try {
    const headers = { "Content-Type": "application/json" };
    const auth = listAuthHeader(env.LIST_AUTH_HEADER);
    if (auth) headers.Authorization = auth;

    const response = await fetch(env.LIST_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email_address: email,
        metadata: { name },
        tags: [env.APP_NAME],
        // The visitor's own IP, so Buttondown's firewall scores the person
        // rather than Cloudflare's egress addresses. Without it every signup
        // looks like one busy IP and gets blocked as suspicious.
        ...(ip ? { ip_address: ip } : {}),
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return {
        ok: false,
        reason: `${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

export async function onRequestPost({ request, env }) {
  // Misconfiguration is reported loudly rather than silently degrading: a
  // deployment missing its binding should be obvious on the first submission.
  const missing = ["CONTACTS_DB", "APP_NAME", "DOWNLOAD_URL"].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`/api/contact misconfigured — missing: ${missing.join(", ")}`);
    return json(
      { error: `Server is misconfigured (missing ${missing.join(", ")}). This is not your fault.` },
      500
    );
  }

  let name;
  let email;
  let interest;
  try {
    const contentType = request.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      const body = await request.json();
      name = body.name;
      email = body.email;
      interest = body.interest;
    } else {
      const form = await request.formData();
      name = form.get("name");
      email = form.get("email");
      interest = form.get("interest");
    }
  } catch (error) {
    return json({ error: `Could not read the submitted form: ${error}` }, 400);
  }

  name = String(name ?? "").trim().slice(0, MAX_NAME);
  email = String(email ?? "").trim().toLowerCase().slice(0, MAX_EMAIL);
  interest = String(interest ?? "desktop").trim().toLowerCase() || "desktop";

  if (!INTERESTS.has(interest)) {
    return json({ error: `Unknown interest "${interest}" — expected desktop, ipad or android.` }, 400);
  }
  // The tablet notify form asks for an email only; a name is still required
  // for the desktop download, where it has always been part of the gate.
  const storeInterest = interest !== "desktop";
  if (!storeInterest && name.length < 2) return json({ error: "Please enter your name." }, 400);
  if (!looksLikeEmail(email)) return json({ error: "That doesn't look like an email address." }, 400);
  if (storeInterest && name.length < 2) name = email.split("@")[0].slice(0, MAX_NAME);

  const warnings = [];

  try {
    // One row per person, keyed by email. A returning contact updates their
    // name and timestamp instead of creating a duplicate.
    const contact = await env.CONTACTS_DB.prepare(
      `INSERT INTO contacts (email, name)
       VALUES (?1, ?2)
       ON CONFLICT (email) DO UPDATE SET
         name = excluded.name,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       RETURNING id`
    )
      .bind(email, name)
      .first();

    if (!contact?.id) throw new Error("contacts upsert returned no id");

    const list = await subscribeToList(env, {
      name,
      email,
      ip: request.headers.get("CF-Connecting-IP") || "",
    });
    if (!list.ok) {
      warnings.push(`mailing list: ${list.reason}`);
      console.error(`/api/contact list subscribe failed for ${email}: ${list.reason}`);
    }

    await env.CONTACTS_DB.prepare(
      `INSERT INTO contact_events (contact_id, app, event, metadata)
       VALUES (?1, ?2, ?3, ?4)`
    )
      .bind(
        contact.id,
        env.APP_NAME,
        storeInterest ? "store_interest" : "download_requested",
        JSON.stringify({
          platform: interest,
          referrer: request.headers.get("Referer") || null,
          country: request.cf?.country || null,
          list_subscribed: list.ok,
          list_error: list.ok ? null : list.reason,
        })
      )
      .run();

    if (storeInterest) {
      // Nothing to download: the tablet app is bought in the store. The
      // contact is saved so they can be told when the listing goes live.
      return json({ ok: true, interest, warnings });
    }

    // The link comes from the server, so it is not sitting in the page source
    // before anyone fills the form in.
    return json({ ok: true, interest, download_url: env.DOWNLOAD_URL, warnings });
  } catch (error) {
    console.error("/api/contact database write failed:", error);
    return json({ error: `Could not save your details: ${error.message || error}` }, 500);
  }
}

/** Anything other than POST is a mistake worth naming. */
export async function onRequest({ request }) {
  return json({ error: `${request.method} not allowed on /api/contact — use POST.` }, 405);
}
