#!/usr/bin/env bun
// Minimal static file server for the site's production build (T3,
// odd/tasks/dokploy-deploy.md). apps/site/astro.config.mjs sets no
// `output`/adapter, so `astro build` is Astro's default "static" mode —
// plain files in dist/, no Node/SSR server to run. Bun-native per this
// repo's own convention (root CLAUDE.md: Bun.serve() + Bun.file, no extra
// static-server dependency), and it's the only thing Dockerfile.site's
// runtime stage needs installed.

import { extname, join } from "node:path";

const DIST_DIR = new URL("./dist/", import.meta.url).pathname;
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
 * extension-less routes. */
async function resolveFile(pathname: string): Promise<Response> {
  const candidates = pathname.endsWith("/")
    ? [`${pathname}index.html`]
    : [pathname, `${pathname}/index.html`, `${pathname}.html`];
  for (const candidate of candidates) {
    const file = Bun.file(join(DIST_DIR, candidate));
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
    const res = await resolveFile(decodeURIComponent(url.pathname));
    console.log(`${req.method} ${url.pathname} ${res.status} ${Date.now() - start}ms`);
    return res;
  },
});

console.log(`Omamorisan site (static) listening on :${PORT}`);
