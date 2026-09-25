// Yakusoku demo store — an x402-protected gift-card shop an AI shopping agent
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
    description: "Yakusoku demo store — pay to unlock a gift card code",
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
  console.log(`Yakusoku store listening on :${PORT} (merchant ${merchantAddress})`);
});
