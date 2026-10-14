/**
 * Serves the downloads page at the root of downloads.track2mix.com.
 *
 * That hostname is attached to this same Pages project, so without this it
 * would show the marketing homepage. The page itself lives at
 * site/downloads/index.html and is also reachable at /downloads/ on any host.
 * Only "/" on a downloads.* host is rewritten; every other path, and every
 * other host, passes straight through.
 */
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  const isDownloadsHost = url.hostname.startsWith("downloads.");
  const isRoot = url.pathname === "/" || url.pathname === "/index.html";
  const isRead = request.method === "GET" || request.method === "HEAD";

  if (isDownloadsHost && isRoot && isRead) {
    return env.ASSETS.fetch(new Request(new URL("/downloads/", url), request));
  }
  return next();
}
