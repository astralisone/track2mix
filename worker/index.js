/**
 * Worker entry point for track2mix.com.
 *
 * The Cloudflare project is a Workers service (Workers Builds runs
 * `wrangler deploy`), not a Pages project, so the site is served through
 * Workers Static Assets: `[assets] directory = "site"` in wrangler.toml
 * uploads site/ to the edge and this Worker sits in front of it.
 *
 * `run_worker_first = true` means every request lands here before the asset
 * server. That is deliberate. Cloudflare's own `_headers` file is a Pages
 * convention, and rather than depend on how far it carries over to Workers
 * assets, the response headers are set below in code, where they can be read
 * and tested. One file decides them instead of two.
 */

import { onRequestPost, onRequest } from "./contact.js";

/** Applied to every response, asset or API. */
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

/** Hashed build output under /assets/ is safe to cache forever. */
const IMMUTABLE_PREFIX = "/assets/";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Responses from env.ASSETS.fetch() are immutable, so decorating them means
 * rebuilding. The body is passed through untouched.
 */
function withSiteHeaders(response, pathname) {
  const decorated = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    decorated.headers.set(key, value);
  }
  if (pathname.startsWith(IMMUTABLE_PREFIX)) {
    decorated.headers.set("Cache-Control", IMMUTABLE_CACHE_CONTROL);
  }
  return decorated;
}

/**
 * downloads.track2mix.com is attached to this same Worker, so its root would
 * otherwise show the marketing homepage. The page lives at
 * site/downloads/index.html and stays reachable at /downloads/ on any host;
 * only "/" on a downloads.* host is rewritten, and only for reads.
 */
function downloadsHostRewrite(request) {
  const url = new URL(request.url);
  const isDownloadsHost = url.hostname.startsWith("downloads.");
  const isRoot = url.pathname === "/" || url.pathname === "/index.html";
  const isRead = request.method === "GET" || request.method === "HEAD";
  if (!(isDownloadsHost && isRoot && isRead)) return null;
  return new Request(new URL("/downloads/", url), request);
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/contact") {
      // contact.js sets its own Cache-Control: no-store and Content-Type, so
      // only the security headers are added.
      const response =
        request.method === "POST"
          ? await onRequestPost({ request, env })
          : await onRequest({ request, env });
      const decorated = new Response(response.body, response);
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
        decorated.headers.set(key, value);
      }
      return decorated;
    }

    // Everything else is the static site. A path with no matching asset comes
    // back as the asset server's 404, which is the behaviour Pages had.
    const rewritten = downloadsHostRewrite(request);
    if (rewritten) {
      return withSiteHeaders(await env.ASSETS.fetch(rewritten), "/downloads/");
    }
    return withSiteHeaders(await env.ASSETS.fetch(request), pathname);
  },
};
