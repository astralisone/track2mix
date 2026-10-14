import assert from "node:assert/strict";
import { onRequest } from "./_middleware.js";

function run(url, method = "GET") {
  const calls = { assets: [], next: 0 };
  const context = {
    request: new Request(url, { method }),
    env: {
      ASSETS: {
        fetch: async (req) => {
          calls.assets.push(new URL(req.url).pathname);
          return new Response("downloads page");
        },
      },
    },
    next: async () => {
      calls.next += 1;
      return new Response("passthrough");
    },
  };
  return onRequest(context).then(async (res) => ({ body: await res.text(), calls }));
}

let r = await run("https://downloads.track2mix.com/");
assert.equal(r.body, "downloads page", "downloads host root serves the downloads page");
assert.deepEqual(r.calls.assets, ["/downloads/"]);
assert.equal(r.calls.next, 0);

r = await run("https://downloads.track2mix.com/index.html");
assert.equal(r.body, "downloads page", "/index.html on the downloads host is also rewritten");

r = await run("https://downloads.track2mix.com/", "HEAD");
assert.deepEqual(r.calls.assets, ["/downloads/"], "HEAD is rewritten too");

r = await run("https://track2mix.com/");
assert.equal(r.body, "passthrough", "main host root is untouched");
assert.equal(r.calls.assets.length, 0);

r = await run("https://downloads.track2mix.com/styles.css");
assert.equal(r.body, "passthrough", "assets on the downloads host pass through");

r = await run("https://downloads.track2mix.com/api/contact", "POST");
assert.equal(r.body, "passthrough", "non-GET requests are never rewritten");

r = await run("https://www.track2mix.com/");
assert.equal(r.body, "passthrough", "other subdomains are untouched");

console.log("middleware: all checks passed");
