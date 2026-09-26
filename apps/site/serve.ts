#!/usr/bin/env bun
// Minimal static file server for the site's production build (T3,
// odd/tasks/dokploy-deploy.md). apps/site/astro.config.mjs sets no
// `output`/adapter, so `astro build` is Astro's default "static" mode —
// plain files in dist/, no Node/SSR server to run. Bun-native per this
// repo's own convention (root CLAUDE.md: Bun.serve() + Bun.file, no extra
// static-server dependency), and it's the only thing Dockerfile.site's
// runtime stage needs installed.

import { extname, resolve, sep } from "node:path";

// Resolved once, no trailing slash, so every candidate path can be checked
// against it with a plain prefix test (the actual traversal guard below).
const DIST_ROOT = resolve(new URL("./dist/", import.meta.url).pathname);
const PORT = Number(process.env.PORT) || 4321;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
};

/** Astro's default "directory" build format serves `/foo` from
 * `dist/foo/index.html` — tries the exact path first (a real asset like
 * `/brand/og.png`), then the directory-index form, then a bare `.html`
 * sibling, mirroring how most static hosts (Netlify, Vercel) resolve
 * extension-less routes.
 *
 * Path-traversal fix (security review, odd/tasks/dokploy-deploy.md): the
 * caller already ran `decodeURIComponent` on the raw pathname before this is
 * called, which turns a `%2f`-encoded slash into a real `/` — so a request
 * like `/..%2f..%2f..%2fetc%2fpasswd` arrives here as `/../../../etc/passwd`.
 * `path.join`/`path.resolve` both happily normalize `..` segments RIGHT OUT
 * OF `DIST_ROOT` if given enough of them — normalizing is not containment.
 * The actual guard is the explicit prefix check below: resolve each
 * candidate to an absolute path, then only ever serve it if that path is
 * `DIST_ROOT` itself or nested under it. A NUL byte is rejected outright
 * (some platforms/APIs treat it as a string terminator, a classic filter
 * bypass). */
async function resolveFile(pathname: string): Promise<Response> {
  if (pathname.includes("\0")) return new Response("not found", { status: 404 });

  const candidates = pathname.endsWith("/")
    ? [`${pathname}index.html`]
    : [pathname, `${pathname}/index.html`, `${pathname}.html`];
  for (const candidate of candidates) {
    // The leading "." keeps `resolve` from treating `candidate` (which
    // starts with "/") as its own absolute path and discarding DIST_ROOT
    // entirely — see path.resolve's own "later absolute segment wins" rule.
    const resolved = resolve(DIST_ROOT, `.${candidate}`);
    if (resolved !== DIST_ROOT && !resolved.startsWith(DIST_ROOT + sep)) continue; // escaped DIST_ROOT — refuse
    const file = Bun.file(resolved);
    if (await file.exists()) {
      const type = CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream";
      return new Response(file, { headers: { "Content-Type": type } });
    }
  }
  return new Response("not found", { status: 404 });
}

Bun.serve({
  port: PORT,
  idleTimeout: 30,
  async fetch(req) {
    const start = Date.now();
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      const res = Response.json({ ok: true });
      console.log(`${req.method} ${url.pathname} ${res.status} ${Date.now() - start}ms`);
      return res;
    }
    let decodedPathname: string;
    try {
      decodedPathname = decodeURIComponent(url.pathname);
    } catch {
      // Malformed %-escape — never let it reach path resolution.
      const res = new Response("not found", { status: 404 });
      console.log(`${req.method} ${url.pathname} ${res.status} ${Date.now() - start}ms`);
      return res;
    }
    const res = await resolveFile(decodedPathname);
    console.log(`${req.method} ${url.pathname} ${res.status} ${Date.now() - start}ms`);
    return res;
  },
});

console.log(`Omamori site (static) listening on :${PORT}`);
