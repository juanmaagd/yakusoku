# x402 v2 Integration Reference (Yakusoku)

Copy-ready reference for `@x402/core`, `@x402/evm`, `@x402/express`, `@x402/fetch`, `@x402/extensions` — all pinned to **2.27.0**. Network: `eip155:84532` (Base Sepolia). Facilitator: `https://x402.org/facilitator`. USDC asset: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals).

Verified against (in priority order):
1. **Context7** `/coinbase/x402` (High reputation, 3878 snippets — usable and current for this task; every item below sourced from it is tagged `SOURCE: context7`)
2. Official docs `https://docs.x402.org`
3. Official repo `github.com/x402-foundation/x402` (examples + `specs/`)
4. Installed `.d.mts` declarations in the spike (`@x402/{core,evm,express,fetch,extensions}@2.27.0`, read-only) — the ground truth for exact TypeScript signatures, tagged `SOURCE: installed types`

Prior verified facts (spend cap, idempotency end-to-end, latency, onchain confirmation) are in `docs/research/spike-x402-resultados.md` and are **not** repeated here except where needed for a signature or gotcha.

---

## 1. WU2 — Store (resource server, Express)

### 1.1 Minimal setup: `paymentMiddleware` + `x402ResourceServer` + `ExactEvmScheme` (server)

```ts
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const app = express();

const facilitatorClient = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme());

app.use(
  paymentMiddleware(
    {
      "GET /giftcard/:sku": {
        accepts: {
          scheme: "exact",
          price: "$25.00",           // or an AssetAmount { asset, amount, extra? }
          network: "eip155:84532",
          payTo: "0xYourAddress",
          maxTimeoutSeconds: 60,      // optional, part of PaymentOption
        },
        description: "Amazon gift card — $25",   // sibling of `accepts`, NOT inside it
        mimeType: "application/json",             // optional
      },
    },
    resourceServer,
  ),
);

app.get("/giftcard/:sku", (req, res) => res.json({ code: "GC-XXXX" }));
app.listen(4021);
```
`SOURCE: context7` (`typescript/packages/http/express/README.md`), cross-checked against `SOURCE: installed types` (`@x402/express/dist/esm/index.d.mts`, `@x402/evm/dist/esm/exact/server/index.d.mts`).

`paymentMiddleware` signature (installed types):
```ts
function paymentMiddleware(
  routes: RoutesConfig,
  server: x402ResourceServer,
  paywallConfig?: PaywallConfig,
  paywall?: PaywallProvider,
  syncFacilitatorOnStart?: boolean,
): (req: Request, res: Response, next: NextFunction) => Promise<void>;
```
`SOURCE: installed types` (`@x402/express/dist/esm/index.d.mts`).

Two other entry points exist and are worth knowing:
- `paymentMiddlewareFromHTTPServer(httpServer, paywallConfig?, paywall?, syncFacilitatorOnStart?)` — needed when you must attach `onProtectedRequest` (see idempotency, §1.3). `SOURCE: installed types`.
- `paymentMiddlewareFromConfig(routes, facilitatorClients?, schemes?, paywallConfig?, paywall?, syncFacilitatorOnStart?)` — builds the `x402ResourceServer` for you from a `SchemeRegistration[]`. `SOURCE: installed types`.

### 1.2 Route config shape — where `description`/`resource` come from

`RouteConfig` (per route key `"METHOD /path"`):
```ts
interface RouteConfig {
  accepts: PaymentOption | PaymentOption[];
  resource?: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  customPaywallHtml?: string;
  // + unpaidResponse callback (preview data for non-browser clients without payment)
}
type RoutesConfig = Record<string, RouteConfig> | RouteConfig;

interface PaymentOption {
  scheme: string;
  payTo: string | DynamicPayTo;
  price: Price | DynamicPrice;   // Price = Money (string|number) | AssetAmount
  network: Network;               // `${string}:${string}` — CAIP-2, e.g. "eip155:84532"
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}
```
`SOURCE: installed types` (`@x402/core/dist/esm/x402Client-C7_OogbK.d.mts`, lines ~849–871, 1366).

**How the 402 exposes description/resource info**: on a 402, the middleware builds a `PaymentRequired` object and sends it base64-encoded in the `PAYMENT-REQUIRED` header. `resource` is a `ResourceInfo`:
```ts
interface ResourceInfo {
  url: string;
  description?: string;   // copied from RouteConfig.description
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}
type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];   // one PaymentRequirements per matched PaymentOption
  extensions?: Record<string, unknown>;
};
```
`SOURCE: installed types` (same file, lines ~1368–1391). Confirmed with a live decoded example in the spec:
```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": { "url": "https://api.example.com/premium-data", "description": "Access to premium market data", "mimeType": "application/json" },
  "accepts": [{ "scheme": "exact", "network": "eip155:84532", "amount": "10000", "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "payTo": "0x209693Bc...", "maxTimeoutSeconds": 60, "extra": { "name": "USDC", "version": "2" } }]
}
```
`SOURCE: repo path` `specs/transports-v2/http.md`.

### 1.3 `payment-identifier` server extension (idempotency)

Package: `@x402/extensions` (separate from `@x402/core` — not bundled in `@x402/{core,evm,express,fetch}`; confirmed absent by `rg` over installed `node_modules/@x402/*` in `docs/research/spike-x402-resultados.md`).

```ts
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";

const routes = {
  "GET /weather": {
    accepts: [{ scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: address }],
    description: "Weather data with idempotency support",
    extensions: { [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false) }, // false = optional
  },
};

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .onAfterSettle(async ({ paymentPayload }) => {
    const paymentId = extractPaymentIdentifier(paymentPayload);
    if (paymentId) idempotencyCache.set(paymentId, { timestamp: Date.now(), fingerprint: payloadFingerprint(paymentPayload), response: {/* ... */} });
  });

const httpServer = new x402HTTPResourceServer(resourceServer, routes)
  .onProtectedRequest(async (context) => {
    if (!context.paymentHeader) return;                                 // no payment yet → normal flow
    const payload = JSON.parse(Buffer.from(context.paymentHeader, "base64").toString("utf-8"));
    const paymentId = extractPaymentIdentifier(payload);
    if (!paymentId) return;
    const cached = idempotencyCache.get(paymentId);
    if (cached) {
      const fp = payloadFingerprint(payload);
      // same id + same fingerprint → serve cache; same id + different fingerprint → your route handler returns 409
      return { grantAccess: true };
    }
  });

const app = express();
app.use(paymentMiddlewareFromHTTPServer(httpServer));
```
`SOURCE: repo path` `examples/typescript/servers/payment-identifier/index.ts` (full file read via `gh api`), function-level docs `SOURCE: context7` (`docs/extensions/payment-identifier.mdx`).

Key exports from `@x402/extensions/payment-identifier`:
```ts
declare const PAYMENT_IDENTIFIER = "payment-identifier";
declare const PAYMENT_ID_MIN_LENGTH = 16;   // id must be 16–128 chars, [A-Za-z0-9_-]
declare const PAYMENT_ID_MAX_LENGTH = 128;

declare function declarePaymentIdentifierExtension(required?: boolean): PaymentIdentifierExtension;  // server: advertise support
declare function generatePaymentId(prefix?: string): string;                                          // client: "pay_<hex>" by default
declare function appendPaymentIdentifierToExtensions(extensions: Record<string, unknown>, id?: string): Record<string, unknown>; // client: attach id (only if server declared it)
declare function extractPaymentIdentifier(paymentPayload: PaymentPayload, validate?: boolean): string | null;  // server: read id
declare function extractAndValidatePaymentIdentifier(paymentPayload: PaymentPayload): { id: string | null; validation: PaymentIdentifierValidationResult };
declare function validatePaymentIdentifier(extension: unknown): { valid: boolean; errors?: string[] };
declare function isPaymentIdentifierRequired(extension: unknown): boolean;
declare function hasPaymentIdentifier(paymentPayload: PaymentPayload): boolean;
```
`SOURCE: installed types` (`@x402/extensions/dist/esm/payment-identifier/index.d.mts`).

**Idempotency contract** (the library only declares/extracts/validates the `id` — caching, fingerprinting and the 409 response are the app's responsibility):

| Scenario | Expected response |
|---|---|
| new `id` | process normally |
| same `id`, same payload (fingerprint match) | cached response |
| same `id`, different payload | **409 Conflict** |
| `required: true` and no `id` | **400 Bad Request** |

`SOURCE: repo path` `specs/extensions/payment_identifier.md`. The spec explicitly recommends the fingerprint cover `scheme, network, asset, amount, payTo, resource path/method` **and scoping the cache key** by tenant/merchant/route if the same backend serves multiple resources — do not key on `id` alone. `SOURCE: repo path` `specs/extensions/payment_identifier.md` (§ Request Binding).

### 1.4 `ExactEvmScheme` (server) — decimals gotcha

```ts
declare class ExactEvmScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  getAssetDecimals(asset: string, network: Network): number | undefined;   // undefined for unknown assets
  parsePrice(price: Price, network: Network): Promise<AssetAmount>;
  registerMoneyParser(parser: MoneyParser): ExactEvmScheme;                // custom $-to-atomic-units conversion chain
}
```
`x402ResourceServer.getAssetDecimalsForRequirements(requirements)` falls back to **6** for display purposes only when the scheme can't resolve decimals; **settlement `$…` overrides do NOT use that fallback and throw if decimals are unknown** — always register/verify the asset explicitly for non-default tokens. `SOURCE: installed types` (`@x402/core/dist/esm/x402Client-C7_OogbK.d.mts`, comment on `getAssetDecimalsForRequirements`).

---

## 2. WU3 — Firewall signing (decoupled: agent has no key, firewall signs)

### 2.1 `x402Client.fromConfig` with `spendControls`

```ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.FIREWALL_PRIVATE_KEY as `0x${string}`);

const guardian = x402Client.fromConfig({
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
  spendControls: { maxAmountPerPayment: "$25" },   // default without this line: "$1"
  // policies?: PaymentPolicy[]  — filter/transform accepted requirements before selection
  // paymentRequirementsSelector?: SelectPaymentRequirements — default picks first option
});
```
`SOURCE: context7` (`typescript/packages/mechanisms/evm/README.md`), confirmed by `SOURCE: installed types`:
```ts
static fromConfig(config: x402ClientConfig): x402Client;

interface x402ClientConfig {
  schemes: SchemeRegistration[];
  policies?: PaymentPolicy[];
  spendControls?: SpendControls | false;   // false disables ALL controls (any asset, no caps)
  paymentRequirementsSelector?: SelectPaymentRequirements;
}
interface SpendControls {
  /** Per-payment USD cap on default-recognized assets. `false` disables. @default "$1" */
  maxAmountPerPayment?: Money | false;
  /** omit = default assets only; true = any asset; list = defaults + listed entries (each with an optional atomic maxAmountPerPayment) */
  allowedAssets?: true | SpendControlAsset[];
}
interface SpendControlAsset { network: Network; asset: string; maxAmountPerPayment?: string; } // atomic units, not "$X"
declare const DEFAULT_MAX_AMOUNT_PER_PAYMENT: Money;  // "$1"
```
`SOURCE: installed types` (`@x402/core/dist/esm/x402Client-C7_OogbK.d.mts`, lines ~1882–1961). The cap is **inclusive** (`amount <= cap`) and evaluated **entirely client-side, before any signature is created** (`applySpendControls` inside `createPaymentPayload`) — confirmed live in `docs/research/spike-x402-resultados.md` §1 (a $5.00 charge passes a $5 cap, $5.01 is rejected).

Rejection is a **generic `Error`**, not a typed class — match on `error.message.includes("rejected by spendControls")` (confirmed by spike test output; no `SpendControlError` class exists in the installed types).

### 2.2 `onBeforePaymentCreation` hook — signature and abort shape

```ts
interface PaymentCreationContext {
  paymentRequired: PaymentRequired;
  selectedRequirements: PaymentRequirements;   // the option spendControls/policies already picked
}
type BeforePaymentCreationHook = (
  context: PaymentCreationContext,
) => Promise<void | { abort: true; reason: string }>;

// on x402Client:
onBeforePaymentCreation(hook: BeforePaymentCreationHook): x402Client;   // chainable, multiple hooks allowed
```
`SOURCE: installed types` (`@x402/core/dist/esm/x402Client-C7_OogbK.d.mts`, lines ~1784–1800, ~2065). Usage (this is where Yakusoku's Intercepta/Jev/World-ID pipeline plugs in, before the signature is ever created):
```ts
guardian.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
  const verdict = await runPipeline(paymentRequired, selectedRequirements);
  if (verdict !== "pay") return { abort: true, reason: verdict.reason };
  // returning void/undefined lets payment creation proceed
});
```
`SOURCE: context7` (`go/CLIENT.md`, `examples/typescript/clients/advanced/README.md` — same contract, TS hook confirmed independently in installed types).

There are two sibling hooks worth knowing for the pipeline's later stages:
```ts
type AfterPaymentCreationHook = (context: PaymentCreatedContext) => Promise<void>;               // context.paymentPayload available
type OnPaymentCreationFailureHook = (context: PaymentCreationFailureContext) => Promise<void | { recovered: true; payload: PaymentPayload }>;
```
`SOURCE: installed types` (same file, lines ~1788–1805).

### 2.3 `createPaymentPayload` + `encodePaymentSignatureHeader`

```ts
import { encodePaymentSignatureHeader } from "@x402/core/http";

const paymentPayload = await guardian.createPaymentPayload(paymentRequired);  // runs spendControls → policies → selector → beforeHooks → sign → afterHooks
const paymentHeader = encodePaymentSignatureHeader(paymentPayload);            // base64 string, ready for the PAYMENT-SIGNATURE header
```
```ts
createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload>;   // method on x402Client
declare function encodePaymentSignatureHeader(paymentPayload: PaymentPayload): string;
```
`SOURCE: context7` (`examples/typescript/clients/custom/README.md`), `SOURCE: installed types` (`@x402/core/dist/esm/http/index.d.mts`).

`PaymentPayload` shape:
```ts
type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: Record<string, unknown>;      // scheme-specific (EIP-3009 signature/authorization for `exact` EVM)
  extensions?: Record<string, unknown>;
};
```
`SOURCE: installed types`.

### 2.4 Attaching `payment-identifier` when signing is decoupled

Because the firewall (not the agent) calls `createPaymentPayload`, the payment-identifier `id` must be appended **inside the firewall's own `onBeforePaymentCreation` hook** (or generated by the firewall itself) — not by the agent, since the agent never touches `paymentRequired.extensions` in this flow:
```ts
import { appendPaymentIdentifierToExtensions, generatePaymentId } from "@x402/extensions/payment-identifier";

const paymentId = generatePaymentId(); // e.g. "pay_7d5d747be160e280504c099d984bcfe0"
guardian.onBeforePaymentCreation(async ({ paymentRequired }) => {
  if (paymentRequired.extensions) {
    appendPaymentIdentifierToExtensions(paymentRequired.extensions, paymentId);  // no-op if server didn't declare the extension
  }
});
```
`SOURCE: context7` (`docs/extensions/payment-identifier.mdx`), full working example `SOURCE: repo path` `examples/typescript/clients/payment-identifier/index.ts` (also shows capturing the encoded header via `onAfterPaymentCreation` + replaying it via `httpClient.onPaymentRequired` on retry — useful if the firewall wants to re-serve an already-signed payload instead of re-signing):
```ts
const httpClient = new x402HTTPClient(guardian);
let capturedPaymentHeaders: Record<string, string> | undefined;
guardian.onAfterPaymentCreation(async ({ paymentPayload }) => {
  capturedPaymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload); // note: returns headers object here, not a bare string
});
httpClient.onPaymentRequired(async () => {
  if (capturedPaymentHeaders) return { headers: capturedPaymentHeaders };
});
```
Note the two `encodePaymentSignatureHeader` overloads: the free function from `@x402/core/http` returns a `string`; the `x402HTTPClient.encodePaymentSignatureHeader` **method** returns `Record<string, string>` (a headers object). Don't mix them up. `SOURCE: installed types` (`@x402/core/dist/esm/client/index.d.mts`).

---

## 3. WU4 — Agent side (no private key, retries with the firewall's signature)

```ts
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";

let response = await fetch(url);

if (response.status === 402) {
  const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");
  const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader!);
  // paymentRequired.accepts: PaymentRequirements[]  — send this to the firewall's /sign endpoint

  const paymentHeader = await askFirewallToSign(paymentRequired);  // firewall returns the PAYMENT-SIGNATURE value (base64 string)

  response = await fetch(url, { headers: { "PAYMENT-SIGNATURE": paymentHeader } });
}

if (response.status === 200) {
  const settlementHeader = response.headers.get("PAYMENT-RESPONSE");
  if (settlementHeader) {
    const settlement = decodePaymentResponseHeader(settlementHeader);  // SettleResponse
    console.log(settlement.transaction, settlement.network, settlement.payer);
  }
}
```
`SOURCE: repo path` `examples/typescript/clients/custom/index.ts` (full file read via `gh api`), signatures `SOURCE: installed types`:
```ts
declare function decodePaymentRequiredHeader(paymentRequiredHeader: string): PaymentRequired;
declare function decodePaymentResponseHeader(paymentResponseHeader: string): SettleResponse;
declare function encodePaymentSignatureHeader(paymentPayload: PaymentPayload): string;
```
(`@x402/core/dist/esm/http/index.d.mts`). All three also re-exported from `@x402/fetch` for convenience if the agent uses `wrapFetchWithPayment`/`x402HTTPClient` instead of hand-rolling this — but in Yakusoku's decoupled design the agent has **no signer to register**, so it should use the manual flow above (`@x402/core/http` only), not `wrapFetchWithPayment` (which requires an `x402Client` with a registered scheme/signer).

`SettleResponse` shape (also what `PAYMENT-RESPONSE` decodes to):
```ts
type SettleResponse = {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: Network;
  amount?: string;              // actual settled amount, relevant for `upto` scheme
  extensions?: Record<string, unknown>;
  extensionResponses?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};
```
`SOURCE: installed types`.

---

## 4. Error shapes (all packages)

| Error | Where | Shape |
|---|---|---|
| Spend-control rejection | `x402Client.createPaymentPayload` (client) | Generic `Error`; message contains `"rejected by spendControls"` — string-match only, no typed class. `SOURCE: installed types` + confirmed live in spike. |
| `VerifyError` | facilitator verify failure (client-visible via `x402HTTPClient`) | `class VerifyError extends Error { invalidReason?: string; invalidMessage?: string; payer?: string; statusCode: number }`. `SOURCE: installed types`. |
| `SettleError` | facilitator settle failure | `class SettleError extends Error { errorReason?: string; errorMessage?: string; payer?: string; transaction: string; network: Network; statusCode: number }`. `SOURCE: installed types`. |
| `RouteConfigurationError` / `RouteValidationError` | server route config parsing | Thrown when a `RouteConfig`/`accepts` entry is malformed. `SOURCE: installed types` (exported from `@x402/core/server`, `@x402/express`). |
| Payment-identifier 400/409 | app-level (not thrown by the SDK) | `required: true` + no `id` → app should return 400; same `id` + different fingerprint → app should return 409. `SOURCE: repo path` `specs/extensions/payment_identifier.md`. |
| `PaymentCreationFailureContext.error` | `onPaymentCreationFailure` hook | Raw `Error` from whatever step failed (signer, network, etc.); hook can return `{ recovered: true, payload }` to substitute a payload and continue. `SOURCE: installed types`. |
| `wrapFetchWithPayment` throws | `@x402/fetch` | Plain `Error` for: no scheme registered for the network, missing request config, payment already attempted for this request, or payload-creation error. `SOURCE: context7` (`docs.x402.org/getting-started/quickstart-for-buyers`, §5 Error Handling) + `SOURCE: installed types` (JSDoc `@throws` on `wrapFetchWithPayment`). |

---

## 5. Gotchas

1. **v1 vs v2 headers — do not mix them.**
   - **v2 (what we use)**: three headers, all base64 JSON — `PAYMENT-REQUIRED` (server→client, on the 402), `PAYMENT-SIGNATURE` (client→server, retry), `PAYMENT-RESPONSE` (server→client, settlement). `SOURCE: context7` (`docs/core-concepts/http-402.md`, `python/x402/README.md`).
   - **v1 (legacy — do not use, but be aware since some public examples still show it)**: payment requirements sent **in the 402 JSON body** (not a header), client sends `X-PAYMENT`, server responds with `X-PAYMENT-RESPONSE`. `x402Client.registerV1(network: string, client)` exists for mixed v1/v2 clients (`network` is a *plain* string like `"base-sepolia"`, not CAIP-2) but Yakusoku has no reason to touch it. `SOURCE: context7` (`docs/guides/migration-v1-to-v2.mdx`, `examples/go/clients/custom/README.md`).

2. **CORS (relevant to WU5's browser calls, not WU2–4's server-to-server ones).** The three payment headers are custom headers; a browser `fetch` cannot read `PAYMENT-REQUIRED`/`PAYMENT-RESPONSE` cross-origin unless the resource server sends `Access-Control-Expose-Headers` naming them (or `*`), and CORS/preflight (`OPTIONS`) middleware must run **before** `paymentMiddleware` so the preflight isn't itself blocked by the 402 logic. No official x402 doc page covers this explicitly (checked `docs.x402.org` core-concepts and the `@x402/express` README — neither mentions CORS); this is standard Express/CORS behavior plus a documented community pitfall. `SOURCE: docs URL` (absence checked at `https://docs.x402.org`, `typescript/packages/http/express/README.md`); pitfall pattern corroborated by community example code found via web search (not an x402-foundation source — treat as a general CORS reminder, not a protocol guarantee).

3. **Decimals**: never hardcode `10**6` for USDC. Use `ExactEvmScheme.getAssetDecimals(asset, network)` (returns `undefined` for unknown assets) or `x402ResourceServer.getAssetDecimalsForRequirements(requirements)` (falls back to 6, **display only** — settlement `$` overrides throw instead of guessing). `SOURCE: installed types`.

4. **Network id format**: v2 requires CAIP-2 (`"eip155:84532"`), typed as `Network = \`${string}:${string}\`` — a bare string like `"base-sepolia"` will fail TypeScript's type check on `register()` and is only valid on the separate `registerV1`/`registerExact` v1 path. Always use `"eip155:84532"` for Base Sepolia in every v2 call (`x402ResourceServer.register`, `x402Client.fromConfig({ schemes: [...] })`, route `network` field). `SOURCE: installed types`.

5. **`spendControls` default is silent.** If you construct `x402Client.fromConfig({ schemes: [...] })` without `spendControls`, you get the **$1 default cap**, not "no cap" — confirmed live (`docs/research/spike-x402-resultados.md` §1: default guardian rejects a $5 charge). Yakusoku must set `spendControls: { maxAmountPerPayment: "$25" }` (or the per-intent budget) explicitly on the firewall's guardian client, or payments above $1 silently fail with a generic `Error`.

6. **`payment-identifier` is a separate package.** Not included in `@x402/core`/`@x402/evm`/`@x402/express`/`@x402/fetch` — must add `@x402/extensions@2.27.0` explicitly. It only covers `id` declare/generate/attach/extract/validate; the idempotency **cache, fingerprint, and 409 response are 100% app code**. `SOURCE: repo path` `specs/extensions/payment_identifier.md` + confirmed absent by `rg` in `docs/research/spike-x402-resultados.md` §2.

7. **`x402HTTPClient.encodePaymentSignatureHeader` (method) ≠ `encodePaymentSignatureHeader` (free function)**: the method returns `Record<string, string>` (a headers object, ready to spread into `fetch` `headers`), the free function from `@x402/core/http` returns a bare `string` (the header value only). Using the wrong one produces either `[object Object]` in a header or a headers object where a string was expected. `SOURCE: installed types` (`@x402/core/dist/esm/client/index.d.mts` vs `@x402/core/dist/esm/http/index.d.mts`).

8. **`RouteConfig.description` is a sibling of `accepts`, not nested inside it.** Easy to misplace when writing multi-option routes (`accepts: PaymentOption[]`) — `description`/`mimeType`/`resource` apply to the whole route, all options share one `ResourceInfo`. `SOURCE: installed types`.

---

## 6. Package/import map (quick lookup)

| Import path | What it exports (used above) |
|---|---|
| `@x402/express` | `paymentMiddleware`, `paymentMiddlewareFromHTTPServer`, `paymentMiddlewareFromConfig`, `x402ResourceServer`, `x402HTTPResourceServer`, `setSettlementOverrides` |
| `@x402/core/server` | `x402ResourceServer`, `x402HTTPResourceServer`, `HTTPFacilitatorClient`, `RouteConfig`/`RoutesConfig`/`ResourceConfig` types |
| `@x402/core/client` | `x402Client`, `x402HTTPClient`, `x402ClientConfig`, `SpendControls`, `DEFAULT_MAX_AMOUNT_PER_PAYMENT` |
| `@x402/core/http` | `encodePaymentSignatureHeader`, `decodePaymentSignatureHeader`, `encodePaymentRequiredHeader`, `decodePaymentRequiredHeader`, `encodePaymentResponseHeader`, `decodePaymentResponseHeader` |
| `@x402/core/types` | `PaymentRequired`, `PaymentPayload`, `PaymentRequirements`, `SettleResponse`, `Network`, `Money` |
| `@x402/evm/exact/server` | `ExactEvmScheme` (server), `registerExactEvmScheme` |
| `@x402/evm/exact/client` | `ExactEvmScheme` (client), `registerExactEvmScheme` |
| `@x402/evm` (root) | `ExactEvmScheme` (= the **client** one), `UptoEvmScheme`, `BatchSettlementEvmScheme`, default-asset helpers |
| `@x402/fetch` | `wrapFetchWithPayment`, `wrapFetchWithPaymentFromConfig`, re-exports `x402Client`, `decodePaymentResponseHeader` |
| `@x402/extensions/payment-identifier` | `PAYMENT_IDENTIFIER`, `declarePaymentIdentifierExtension`, `generatePaymentId`, `appendPaymentIdentifierToExtensions`, `extractPaymentIdentifier`, `validatePaymentIdentifier` |

`SOURCE: installed types` (directory listing + each package's `dist/esm/**/*.d.mts`).

---

## 7. Sources consulted

- Context7 `/coinbase/x402` — resolved and queried 3×, returned current, on-point snippets (paymentMiddleware, x402Client.fromConfig, spendControls, hooks, payment-identifier, v1↔v2 header migration). **Usable, high-reputation source; the fastest path to correct signatures alongside installed types.**
- `https://docs.x402.org` — homepage, `getting-started/quickstart-for-buyers` (spendControls table, error handling).
- `github.com/x402-foundation/x402` via `gh api` (raw file reads): `examples/typescript/servers/express/index.ts`, `examples/typescript/servers/payment-identifier/index.ts`, `examples/typescript/clients/custom/index.ts`, `examples/typescript/clients/payment-identifier/index.ts`, `specs/extensions/payment_identifier.md`, `specs/transports-v2/http.md`.
- Installed `.d.mts` in the spike (read-only, not modified): `@x402/core@2.27.0`, `@x402/evm@2.27.0`, `@x402/express@2.27.0`, `@x402/fetch@2.27.0`, `@x402/extensions@2.27.0` (`node_modules/@x402/*/dist/esm/**/*.d.mts`).
- `docs/research/spike-x402-resultados.md` — prior verified runtime facts (spend cap live tests, idempotency live tests, latency, onchain confirmation) referenced but not re-derived here.
