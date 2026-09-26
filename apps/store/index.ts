// Omamorisan demo stores — three x402-protected shops (gift cards, data &
// APIs, cloud credits) an AI shopping agent browses, served by ONE process on
// THREE separate ports. A promise binds one exact merchant ORIGIN
// (odd/tasks/multi-store.md), so each store needs its own origin — hence its
// own port, each with its own Express app, catalog and payTo. `createStoreApp`
// below is the one factory every store shares; everything that varies between
// stores lives in catalog.ts's `StoreDefinition` data, so a fourth store costs
// a new catalog entry, not a change here (design-for-the-next-case).
//
// Every store serves its legit catalog, a cheap $1 rehearsal sku where one
// exists, and raw prompt-injection trap copy from the attack library via
// GET /promo/:sku — see catalog.ts for the full case mapping. Later work
// units (firewall provenance/Jev) are what actually have to catch these
// traps; the stores only serve them.

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
import express, { type Express } from "express";
import { privateKeyToAccount } from "viem/accounts";
import { STORES, type Product, type StoreDefinition } from "./catalog";

function resolveMerchantAddress(store: StoreDefinition): `0x${string}` {
  const override = process.env[store.merchantAddressEnvVar];
  if (override) return override as `0x${string}`;
  if (store.merchantKeyEnvVar) {
    const key = process.env[store.merchantKeyEnvVar];
    if (key) return privateKeyToAccount(key as `0x${string}`).address;
  }
  if (store.fallbackMerchantAddress) return store.fallbackMerchantAddress;
  throw new Error(
    `Set ${store.merchantAddressEnvVar}${store.merchantKeyEnvVar ? ` (or ${store.merchantKeyEnvVar})` : ""} in the environment for the ${store.name} store — see .env.hackathon and the dev/start scripts.`,
  );
}

function generateRedeemableCode(prefix: string, sku: string): string {
  return `${prefix}-${sku.toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

/** Default `Product.buildResponse` — a redeemable code, same shape a gift
 * card or a cloud credit purchase returns. Data & APIs products override
 * `buildResponse` themselves (catalog.ts) since their content isn't a code. */
function defaultRedeemableCodeResponse(product: Product): Record<string, unknown> {
  return { sku: product.sku, code: generateRedeemableCode("RC", product.sku), amountUsdc: product.priceUsdc };
}

function skuFromPath(purchasePrefix: string, path: string): string {
  const match = new RegExp(`^/${purchasePrefix}/([^/]+)$`).exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// --- GET / (P7) --------------------------------------------------------------
// A minimal human-facing catalog page per store — each store's only other
// consumer is an AI shopping agent talking x402 (GET /catalog, GET
// /<prefix>/:sku), so this exists purely so a person can see what's for sale
// and how the demo works. No buy buttons, no CLI commands (per house style:
// commands belong in a README, never the UI) — purchasing only happens
// through an agent.

function renderCatalogPage(store: StoreDefinition): string {
  const productItems = store.catalog
    .map((product) => {
      const hasPromo = product.sku in store.promoTraps;
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
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(store.name)}</title>
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
    <h1>${escapeHtml(store.name)}</h1>
    <p>${escapeHtml(store.tagline)}</p>
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

// --- x402 wiring (shared across every store) ----------------------------------

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(X402_NETWORK, new ExactEvmScheme());

// --- Idempotency (payment-identifier extension) ----------------------------
// The x402 SDK only declares/extracts/validates the `id`; caching, request
// fingerprinting and the conflict response are app code (ref-x402.md §1.3).
// One cache per store instance — a payment id from one store's own
// idempotency cache must never satisfy another store's request.

interface CachedPayment {
  fingerprint: string;
  response: Record<string, unknown>;
}

/** Binds a cached response to the exact request it was issued for (spec §"Request Binding"). */
function fingerprintPayload(payload: PaymentPayload): string {
  const r = payload.accepted;
  return [r.scheme, r.network, r.asset, r.amount, r.payTo, payload.resource?.url ?? ""].join("|");
}

function createStoreApp(store: StoreDefinition): { app: Express; merchantAddress: `0x${string}` } {
  const merchantAddress = resolveMerchantAddress(store);
  const catalogBySku = new Map(store.catalog.map((product) => [product.sku, product]));
  const purchasePrefix = store.purchasePrefix;
  const idempotencyCache = new Map<string, CachedPayment>();

  function priceForRequest(context: HTTPRequestContext): string {
    const sku = skuFromPath(purchasePrefix, context.path);
    const product = catalogBySku.get(sku);
    return `$${(product?.priceUsdc ?? 0).toFixed(2)}`; // sku existence is gated before this ever runs
  }

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    [`GET /${purchasePrefix}/:sku`]: {
      accepts: {
        scheme: "exact",
        network: X402_NETWORK,
        payTo: merchantAddress,
        price: priceForRequest,
        maxTimeoutSeconds: 60,
      },
      description: `${store.name} — pay to unlock this product`,
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
  // e.g. `http://localhost:4000` is unaffected. Applies identically to every
  // store this factory creates, each behind its own Dokploy domain.
  app.set("trust proxy", 1);
  app.use((req, _res, next) => {
    req.headers.host = req.host;
    next();
  });

  // T1 request log (odd/tasks/dokploy-deploy.md) — no logging framework here
  // (express, not Hono), so a tiny equivalent: store id, method, path, status
  // and ms, to stdout, one line per request, tagged with this store's own id
  // so three stores sharing one process's stdout stay distinguishable.
  // Registered first (among the app's OWN routes) so it wraps every route
  // below, including the x402 payment middleware. `req.path` (pathname only),
  // never `req.originalUrl` (path + query string) — security review: these
  // stores have no query-string secrets today, but logging only the pathname
  // matches the firewall/MCP loggers and never becomes a leak if one is added.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      console.log(`[${store.id}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, store: store.id });
  });

  app.get("/", (_req, res) => {
    res.type("html").send(renderCatalogPage(store));
  });

  app.get("/catalog", (_req, res) => {
    res.json({
      store: { name: store.name, tagline: store.tagline },
      howToBuy: "GET a product's purchaseUrl (relative to this store's origin); it answers 402 with x402 payment requirements.",
      products: store.catalog.map((product) => ({
        sku: product.sku,
        title: product.title,
        description: product.description,
        priceUsdc: product.priceUsdc,
        category: product.category,
        purchaseUrl: `/${purchasePrefix}/${encodeURIComponent(product.sku)}`,
      })),
    });
  });

  app.get("/promo/:sku", (req, res) => {
    const traps = store.promoTraps[req.params.sku];
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
    const match = new RegExp(`^/${purchasePrefix}/([^/]+)$`).exec(req.path);
    const rawSku = match?.[1];
    if (!rawSku) {
      next();
      return;
    }
    if (!catalogBySku.has(decodeURIComponent(rawSku))) {
      res.status(404).json({ error: `unknown sku: ${rawSku}` });
      return;
    }
    next();
  });

  app.use(paymentMiddlewareFromHTTPServer(httpServer));

  app.get(`/${purchasePrefix}/:sku`, (req, res) => {
    const product = catalogBySku.get(req.params.sku);
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

    const response = (product.buildResponse ?? defaultRedeemableCodeResponse)(product);
    if (id && payload) idempotencyCache.set(id, { fingerprint: fingerprintPayload(payload), response });
    res.json(response);
  });

  return { app, merchantAddress };
}

for (const store of STORES) {
  const { app, merchantAddress } = createStoreApp(store);
  const port = Number(process.env[store.portEnvVar]) || store.defaultPort;
  app.listen(port, () => {
    console.log(`${store.name} listening on :${port} (merchant ${merchantAddress})`);
  });
}
