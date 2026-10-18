import { onRequestPost } from "./contact.js";

// Minimal D1 stub: records the SQL it was given and returns plausible results.
function makeDb({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = {
        sql, args: null,
        bind(...a) { stmt.args = a; return stmt; },
        async first() {
          calls.push({ sql, args: stmt.args });
          if (failOn && sql.includes(failOn)) throw new Error("simulated D1 failure");
          return { id: 42 };
        },
        async run() {
          calls.push({ sql, args: stmt.args });
          if (failOn && sql.includes(failOn)) throw new Error("simulated D1 failure");
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

const baseEnv = (db, over = {}) => ({
  CONTACTS_DB: db, APP_NAME: "track2mix",
  DOWNLOAD_URL: "https://example.test/releases/latest", ...over,
});

const req = (body, ct = "application/json") => new Request("https://t/api/contact", {
  method: "POST", headers: { "Content-Type": ct },
  body: ct.includes("json") ? JSON.stringify(body) : new URLSearchParams(body),
});

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

const realFetch = globalThis.fetch;

// 1. happy path, list configured and succeeding
globalThis.fetch = async () => new Response("{}", { status: 200 });
{
  const db = makeDb();
  const res = await onRequestPost({ request: req({ name: "Alex", email: "Alex@Example.COM " }),
    env: baseEnv(db, { LIST_ENDPOINT: "https://list.test/sub", LIST_AUTH_HEADER: "Token x" }) });
  const body = await res.json();
  check("happy path returns 200", res.status === 200, res.status);
  check("returns download_url", body.download_url === "https://example.test/releases/latest");
  check("no warnings when list succeeds", body.warnings.length === 0, JSON.stringify(body.warnings));
  check("email normalised to lowercase+trimmed", db.calls[0].args[0] === "alex@example.com", db.calls[0].args[0]);
  check("writes contact then event", db.calls.length === 2 && db.calls[1].sql.includes("contact_events"));
  check("event records list success", db.calls[1].args[2].includes('"list_subscribed":true'));
}

// 2. list down -> contact still saved, download still granted, warning surfaced
globalThis.fetch = async () => new Response("upstream exploded", { status: 503, statusText: "Service Unavailable" });
{
  const db = makeDb();
  const res = await onRequestPost({ request: req({ name: "Sam", email: "sam@example.com" }),
    env: baseEnv(db, { LIST_ENDPOINT: "https://list.test/sub" }) });
  const body = await res.json();
  check("list outage still returns 200", res.status === 200, res.status);
  check("list outage still grants download", !!body.download_url);
  check("list outage surfaces a warning", body.warnings.some(w => w.includes("503")), JSON.stringify(body.warnings));
  check("list failure recorded on event", db.calls[1].args[2].includes('"list_subscribed":false'));
}

// 3. validation
globalThis.fetch = realFetch;
for (const [label, body, want] of [
  ["rejects missing name", { name: "", email: "a@b.co" }, "name"],
  ["rejects one-char name", { name: "A", email: "a@b.co" }, "name"],
  ["rejects bad email", { name: "Alex", email: "not-an-email" }, "email"],
]) {
  const db = makeDb();
  const res = await onRequestPost({ request: req(body), env: baseEnv(db) });
  const j = await res.json();
  check(label, res.status === 400 && j.error.toLowerCase().includes(want), `${res.status} ${j.error}`);
  check(`  ${label}: nothing written`, db.calls.length === 0);
}

// 4. form-encoded bodies work too
globalThis.fetch = async () => new Response("{}", { status: 200 });
{
  const db = makeDb();
  const res = await onRequestPost({ request: req({ name: "Jo", email: "jo@example.com" },
    "application/x-www-form-urlencoded"), env: baseEnv(db) });
  check("accepts form-encoded body", res.status === 200, res.status);
}

// 5. misconfiguration is loud
{
  const db = makeDb();
  const res = await onRequestPost({ request: req({ name: "Alex", email: "a@b.co" }),
    env: { CONTACTS_DB: db, APP_NAME: "track2mix" } });
  const j = await res.json();
  check("missing DOWNLOAD_URL -> 500 naming it", res.status === 500 && j.error.includes("DOWNLOAD_URL"), j.error);
}

// 6. DB failure surfaces, does not grant the download
{
  const db = makeDb({ failOn: "INSERT INTO contacts" });
  const res = await onRequestPost({ request: req({ name: "Alex", email: "a@b.co" }), env: baseEnv(db) });
  const j = await res.json();
  check("D1 failure -> 500", res.status === 500, res.status);
  check("D1 failure grants no download", !j.download_url);
  check("D1 failure message is specific", j.error.includes("simulated D1 failure"), j.error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
