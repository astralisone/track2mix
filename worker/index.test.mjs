// Routing and response-header tests for worker/index.js.
//
// The Worker sits in front of Workers Static Assets, so the two things worth
// pinning down are that /api/contact reaches the handler (and nothing else
// does), and that the header rules that used to live in site/_headers are
// actually applied — including to asset responses, which arrive immutable and
// have to be rebuilt to be decorated.

import worker from "./index.js";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

/**
 * Stands in for the asset server. Returns an immutable Response the way the
 * real binding does, so a handler that tries to mutate headers in place fails
 * here rather than in production.
 */
function makeEnv(over = {}) {
  const assetRequests = [];
  return {
    assetRequests,
    ASSETS: {
      async fetch(request) {
        assetRequests.push(new URL(request.url).pathname);
        const res = new Response("asset body", {
          status: 200,
          headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=0" },
        });
        Object.freeze(res.headers);
        return res;
      },
    },
    ...over,
  };
}

const get = (path) => new Request(`https://track2mix.com${path}`);

const SECURITY = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

function checkSecurityHeaders(label, res) {
  for (const [header, expected] of Object.entries(SECURITY)) {
    check(`${label}: ${header}`, res.headers.get(header) === expected, res.headers.get(header));
  }
}

// 1. the site is served from the asset binding, with the security headers on
{
  const env = makeEnv();
  const res = await worker.fetch(get("/"), env);
  check("/ is served from ASSETS", env.assetRequests.includes("/"), env.assetRequests);
  check("/ keeps the asset body", (await res.text()) === "asset body");
  check("/ keeps the asset status", res.status === 200, res.status);
  checkSecurityHeaders("/", res);
}

// 2. /assets/* is cached forever; other paths keep whatever the asset server said
{
  const env = makeEnv();
  const hashed = await worker.fetch(get("/assets/logo.svg"), env);
  check(
    "/assets/* is immutable",
    hashed.headers.get("cache-control") === "public, max-age=31536000, immutable",
    hashed.headers.get("cache-control")
  );

  const page = await worker.fetch(get("/index.html"), env);
  check(
    "a page keeps the asset server's Cache-Control",
    page.headers.get("cache-control") === "public, max-age=0",
    page.headers.get("cache-control")
  );
}

// 3. POST /api/contact reaches the handler and never touches the asset binding
{
  const env = makeEnv({ APP_NAME: "track2mix" }); // no CONTACTS_DB: handler 500s, which is fine
  const res = await worker.fetch(
    new Request("https://track2mix.com/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alex", email: "a@b.co" }),
    }),
    env
  );
  const body = await res.json();
  check("POST /api/contact is not served as an asset", env.assetRequests.length === 0, env.assetRequests);
  check("POST /api/contact reaches the handler", res.status === 500 && body.error.includes("CONTACTS_DB"), body);
  check("API response is no-store", res.headers.get("cache-control") === "no-store", res.headers.get("cache-control"));
  checkSecurityHeaders("POST /api/contact", res);
}

// 4. a non-POST on /api/contact is a 405 from the handler, not a 404 from assets
{
  const env = makeEnv();
  const res = await worker.fetch(get("/api/contact"), env);
  const body = await res.json();
  check("GET /api/contact -> 405", res.status === 405, res.status);
  check("405 names the method", body.error.includes("GET"), body.error);
  check("GET /api/contact is not served as an asset", env.assetRequests.length === 0, env.assetRequests);
}

// 5. a path that merely looks like the API is a normal asset request
{
  const env = makeEnv();
  await worker.fetch(get("/api/contact/extra"), env);
  await worker.fetch(get("/api/other"), env);
  check(
    "only the exact /api/contact path is routed to the handler",
    env.assetRequests.length === 2,
    env.assetRequests
  );
}

// 6. the query string does not change routing
{
  const env = makeEnv({ APP_NAME: "track2mix" });
  const res = await worker.fetch(
    new Request("https://track2mix.com/api/contact?utm_source=x", { method: "POST" }),
    env
  );
  check("a query string still routes to the handler", res.status === 500, res.status);
  check("a query string is not served as an asset", env.assetRequests.length === 0, env.assetRequests);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
