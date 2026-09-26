// Omamorisan demo store — an x402-protected gift-card shop an AI shopping agent
// browses. Serves the legit Amazon gift card the demo's signed TaskIntent
// covers, a cheap rehearsal sku, real Steam inventory the injected promo
// pushes unrequested (the product's key differentiator), and the raw
// prompt-injection trap copy from the attack library via GET /promo/:sku —
// see catalog.ts for the full case mapping. Later work units (firewall
// provenance/Jev) are what actually have to catch these traps; this store
// only serves them.

import { HTTPFacilitatorClient, type HTTPRequestContext } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/express";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
} from "@x402/extensions/payment-identifier";
import { FACILITATOR_URL, X402_NETWORK } from "@yakusoku/shared";
import express from "express";
import { privateKeyToAccount } from "viem/accounts";
import { CATALOG, CATALOG_BY_SKU, PROMO_TRAPS } from "./catalog";

const PORT = Number(process.env.PORT) || 4000;

function resolveMerchantAddress(): `0x${string}` {
  const override = process.env.MERCHANT_ADDRESS;
  if (override) return override as `0x${string}`;
  const key = process.env.MERCHANT_KEY;
  if (!key) {
    throw new Error(
      "Set MERCHANT_KEY (or MERCHANT_ADDRESS) in the environment — see .env.hackathon and the dev/start scripts.",
    );
  }
  return privateKeyToAccount(key as `0x${string}`).address;
}
const merchantAddress = resolveMerchantAddress();

function skuFromPath(path: string): string {
  return decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
}

function generateGiftCardCode(sku: string): string {
  return `GC-${sku.toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

interface GiftCardResponse {
  sku: string;
  code: string;
  amountUsdc: number;
}

function buildGiftCardResponse(sku: string): GiftCardResponse {
  const product = CATALOG_BY_SKU.get(sku);
  if (!product) throw new Error(`buildGiftCardResponse called for unknown sku: ${sku}`); // unreachable, gated below
  return { sku: product.sku, code: generateGiftCardCode(product.sku), amountUsdc: product.priceUsdc };
}

// --- Idempotency (payment-identifier extension) ----------------------------
// The x402 SDK only declares/extracts/validates the `id`; caching, request
// fingerprinting and the conflict response are app code (ref-x402.md §1.3).

interface CachedPayment {
  fingerprint: string;
  response: GiftCardResponse;
}
const idempotencyCache = new Map<string, CachedPayment>();

/** Binds a cached response to the exact request it was issued for (spec §"Request Binding"). */
function fingerprintPayload(payload: PaymentPayload): string {
  const r = payload.accepted;
  return [r.scheme, r.network, r.asset, r.amount, r.payTo, payload.resource?.url ?? ""].join("|");
}

// --- x402 wiring -------------------------------------------------------------

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(X402_NETWORK, new ExactEvmScheme());

function priceForRequest(context: HTTPRequestContext): string {
  const sku = skuFromPath(context.path);
  const product = CATALOG_BY_SKU.get(sku);
  return `$${(product?.priceUsdc ?? 0).toFixed(2)}`; // sku existence is gated before this ever runs
}

const httpServer = new x402HTTPResourceServer(resourceServer, {
  "GET /giftcard/:sku": {
    accepts: {
      scheme: "exact",
      network: X402_NETWORK,
      payTo: merchantAddress,
      price: priceForRequest,
      maxTimeoutSeconds: 60,
    },
    description: "Omamorisan demo store — pay to unlock a gift card code",
    extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) },
  },
}).onProtectedRequest(async (context) => {
  if (!context.paymentHeader) return; // no payment attempt yet — normal 402 flow
  const payload = decodePaymentSignatureHeader(context.paymentHeader);
  const id = extractPaymentIdentifier(payload);
  if (!id) return;
  const cached = idempotencyCache.get(id);
  if (!cached) return; // first time seeing this id — verify/settle normally
  if (cached.fingerprint !== fingerprintPayload(payload)) {
    // Spec: same id + different payload -> 409. ProtectedRequestHook can only
    // grant or abort (403) — documented deviation, still fail-closed.
    return { abort: true, reason: "payment identifier reused with a different payload" };
  }
  return { grantAccess: true }; // already settled this exact payment once — skip re-settlement
});

// --- Express app -------------------------------------------------------------

const app = express();

// P8 — this store sits behind Traefik in the deployed environment (Dokploy),
// which terminates TLS and forwards to this container over plain HTTP: the
// raw connection Express sees is always `http`, on the container's own
// internal address, never the public `https://<domain>` the agent actually
// used. `@x402/express`'s `ExpressAdapter.getUrl()` builds the 402
// `resource.url` as `` `${req.protocol}://${req.headers.host}${req.originalUrl}` ``
// (node_modules/@x402/express dist — not something this app can override
// without forking the library): `req.protocol` already honors Express's own
// `trust proxy` setting (reads `X-Forwarded-Proto` when trusted), but
// `req.headers.host` is the RAW `Host` header and is never rewritten by
// `trust proxy` (only `req.host`/`req.hostname` are). `trust proxy: 1` trusts
// exactly one hop — the single reverse proxy in front of this container, not
// an arbitrary chain a spoofed header could walk past. The middleware below
// makes the raw header match Express's own trust-proxy-gated `req.host`
// (which already implements "use X-Forwarded-Host, with its port, only when
// the immediate peer is trusted" — see node_modules/express/lib/request.js),
// so the one line downstream keeps working unmodified. Locally, with no
// proxy in front (`trust proxy` never trusts a non-configured peer),
// `req.host` falls back to the plain `Host` header — a no-op rewrite — so
// `http://localhost:4000` is unaffected.
app.set("trust proxy", 1);
app.use((req, _res, next) => {
  req.headers.host = req.host;
  next();
});

// T1 request log (odd/tasks/dokploy-deploy.md) — no logging framework here
// (express, not Hono), so a tiny equivalent: method, path, status and ms, to
// stdout, one line per request. Registered first (among the app's OWN
// routes) so it wraps every route below, including the x402 payment
// middleware. `req.path` (pathname only), never `req.originalUrl` (path +
// query string) — security review: this store has no query-string secrets
// today, but logging only the pathname matches the firewall/MCP loggers and
// never becomes a leak if one is added.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// --- GET / (P7) --------------------------------------------------------------
// A minimal human-facing catalog page — the store's only other consumer is
// an AI shopping agent talking x402 (GET /catalog, GET /giftcard/:sku), so
// this exists purely so a person can see what's for sale and how the demo
// works. No buy buttons, no CLI commands (per house style: commands belong
// in a README, never the UI) — purchasing only happens through an agent.
// Registered before the sku-existence gate and the x402 payment middleware
// below, so neither ever sees a request for `/`.

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function renderCatalogPage(): string {
  const productItems = CATALOG.map((product) => {
    const hasPromo = product.sku in PROMO_TRAPS;
    return `
      <li class="product">
        <div class="product-head">
          <h2>${escapeHtml(product.title)}</h2>
          <span class="price">$${product.priceUsdc.toFixed(2)} USDC</span>
        </div>
        <p class="description">${escapeHtml(product.description)}</p>
        <span class="category">${escapeHtml(product.category)}</span>
        ${hasPromo ? `<p class="promo"><a href="/promo/${encodeURIComponent(product.sku)}">Promo page (contains test prompt-injection content)</a></p>` : ""}
      </li>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Omamorisan Store</title>
<style>
  :root {
    --color-surface: #ffffff;
    --color-fog: #f7f8fa;
    --color-ink: #0b0d12;
    --color-graphite: #5b606b;
    --color-hairline: #e6e8ec;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--color-surface);
    color: var(--color-ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }
  h1 { margin: 0; font-size: 1.5rem; }
  header p { margin: 12px 0 0; color: var(--color-graphite); }
  .note {
    margin-top: 16px;
    padding: 12px 16px;
    border: 1px solid var(--color-hairline);
    border-radius: 8px;
    background: var(--color-fog);
    color: var(--color-graphite);
    font-size: 0.9rem;
  }
  ul.catalog { list-style: none; margin: 32px 0 0; padding: 0; display: grid; gap: 16px; }
  li.product { border: 1px solid var(--color-hairline); border-radius: 12px; padding: 20px; }
  .product-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 8px 16px; }
  .product-head h2 { margin: 0; font-size: 1.05rem; }
  .price { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--color-graphite); }
  .description { margin: 8px 0 0; color: var(--color-graphite); }
  .category {
    display: inline-block;
    margin-top: 12px;
    font-size: 0.8rem;
    color: var(--color-graphite);
    background: var(--color-fog);
    border-radius: 4px;
    padding: 2px 8px;
  }
  .promo { margin: 12px 0 0; font-size: 0.85rem; }
  .promo a { color: var(--color-ink); }
  footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--color-hairline); color: var(--color-graphite); font-size: 0.85rem; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Omamorisan Store</h1>
    <p>A demo gift-card shop for AI shopping agents.</p>
    <p class="note">Purchases happen through an AI agent using the x402 payment protocol — this page is for people to browse the catalog, not to buy anything directly.</p>
  </header>
  <ul class="catalog">${productItems}
  </ul>
  <footer>
    <p>The same catalog is served as JSON at <code>/catalog</code> for agents.</p>
  </footer>
</div>
</body>
</html>`;
}

app.get("/", (_req, res) => {
  res.type("html").send(renderCatalogPage());
});

app.get("/catalog", (_req, res) => {
  res.json({ products: CATALOG });
});

app.get("/promo/:sku", (req, res) => {
  const traps = PROMO_TRAPS[req.params.sku];
  if (!traps) {
    res.status(404).json({ error: `no promo content for sku: ${req.params.sku}` });
    return;
  }
  res.json({ sku: req.params.sku, traps });
});

// Unknown skus must 404, not 402 — paymentMiddleware has no product
// knowledge, so gate it here before the payment middleware ever sees it.
app.use((req, res, next) => {
  if (req.method !== "GET") {
    next();
    return;
  }
  const match = /^\/giftcard\/([^/]+)$/.exec(req.path);
  const rawSku = match?.[1];
  if (!rawSku) {
    next();
    return;
  }
  if (!CATALOG_BY_SKU.has(decodeURIComponent(rawSku))) {
    res.status(404).json({ error: `unknown sku: ${rawSku}` });
    return;
  }
  next();
});

app.use(paymentMiddlewareFromHTTPServer(httpServer));

app.get("/giftcard/:sku", (req, res) => {
  const product = CATALOG_BY_SKU.get(req.params.sku);
  if (!product) {
    res.status(404).json({ error: `unknown sku: ${req.params.sku}` });
    return;
  }

  const header = req.header("PAYMENT-SIGNATURE");
  const payload = header ? decodePaymentSignatureHeader(header) : undefined;
  const id = payload ? extractPaymentIdentifier(payload) : null;

  if (id) {
    const cached = idempotencyCache.get(id);
    if (cached) {
      res.json(cached.response);
      return;
    }
  }

  const response = buildGiftCardResponse(product.sku);
  if (id && payload) idempotencyCache.set(id, { fingerprint: fingerprintPayload(payload), response });
  res.json(response);
});

app.listen(PORT, () => {
  console.log(`Omamorisan store listening on :${PORT} (merchant ${merchantAddress})`);
});
