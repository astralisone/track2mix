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
 *   LIST_AUTH_HEADER  e.g. "Token abc123"   (secret, optional)
 */

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
async function subscribeToList(env, { name, email }) {
  if (!env.LIST_ENDPOINT) {
    return { ok: false, reason: "LIST_ENDPOINT is not configured" };
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (env.LIST_AUTH_HEADER) headers.Authorization = env.LIST_AUTH_HEADER;

    const response = await fetch(env.LIST_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email_address: email,
        metadata: { name },
        tags: [env.APP_NAME],
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
  try {
    const contentType = request.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      const body = await request.json();
      name = body.name;
      email = body.email;
    } else {
      const form = await request.formData();
      name = form.get("name");
      email = form.get("email");
    }
  } catch (error) {
    return json({ error: `Could not read the submitted form: ${error}` }, 400);
  }

  name = String(name ?? "").trim().slice(0, MAX_NAME);
  email = String(email ?? "").trim().toLowerCase().slice(0, MAX_EMAIL);

  if (name.length < 2) return json({ error: "Please enter your name." }, 400);
  if (!looksLikeEmail(email)) return json({ error: "That doesn't look like an email address." }, 400);

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

    const list = await subscribeToList(env, { name, email });
    if (!list.ok) {
      warnings.push(`mailing list: ${list.reason}`);
      console.error(`/api/contact list subscribe failed for ${email}: ${list.reason}`);
    }

    await env.CONTACTS_DB.prepare(
      `INSERT INTO contact_events (contact_id, app, event, metadata)
       VALUES (?1, ?2, 'download_requested', ?3)`
    )
      .bind(
        contact.id,
        env.APP_NAME,
        JSON.stringify({
          referrer: request.headers.get("Referer") || null,
          country: request.cf?.country || null,
          list_subscribed: list.ok,
          list_error: list.ok ? null : list.reason,
        })
      )
      .run();

    // The link comes from the server, so it is not sitting in the page source
    // before anyone fills the form in.
    return json({ ok: true, download_url: env.DOWNLOAD_URL, warnings });
  } catch (error) {
    console.error("/api/contact database write failed:", error);
    return json({ error: `Could not save your details: ${error.message || error}` }, 500);
  }
}

/** Anything other than POST is a mistake worth naming. */
export async function onRequest({ request }) {
  return json({ error: `${request.method} not allowed on /api/contact — use POST.` }, 405);
}
