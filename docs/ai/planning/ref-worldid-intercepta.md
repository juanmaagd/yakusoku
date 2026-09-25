# World ID for Agents & Intercepta — verification pass (2026-09-25)

Purpose: cross-check `docs/research/world-id-implementacion.md` and `docs/research/intercepta-implementacion.md` against live sources fetched **today** (session date 2026-09-25), and fill the two gaps requested: exact `jose` verification code (with `auth_time` freshness + `clockTolerance`), a QR library recommendation for `verification_uri_complete`, and Intercepta's "quickstart" claim. The World ID device flow itself was **not** re-run (it needs the user's phone) — the live-verified request/response shape already recorded in `docs/20-producto.md` (§6) and `world-id-implementacion.md` is reused as-is below and marked accordingly.

Convention: **SOURCE** = URL fetched live in this session (2026-09-25) via `mcp__wigolo__fetch` or `mcp__context7__query-docs`, or an explicit line from `docs/20-producto.md` / `world-id-implementacion.md` already marked VERIFICADO from a prior live run. No claim below is asserted without one of these.

---

## Part A — World ID for Agents (OIDC device flow)

### A.1 What it is

SOURCE: https://sandbox.auth.world.org/docs (fetched live today, `content_completeness: full`).

> "The Human Continuity IdP makes that recognition available to applications through OpenID Connect."
> "For agent experiences, the application uses the same OIDC federation, binds the issuer and subject to its own account or grant, and issues credentials for its APIs or MCP server."
> "Give agent experiences a persistent connection to the human who authorized them, with fresh authentication for important actions."

For Yakusoku we only use the **fresh authentication** piece (not the durable-continuity/`sub`-recognition piece): each `ask_human` escalation starts a brand-new device flow, never reuses a token.

The docs page also confirms an MCP server is exposed at `/mcp` ("Connect your coding agent to the MCP server at `/mcp`") and lists the implemented standard surface (OIDC Core/Discovery/Dynamic Registration, RFC 6749/6750/7009/7523/7636/8252/8414/**8628 Device Authorization Grant**/9207/9470/9728, and JOSE RFC 7515/7517/7519/7638). Confirms the device flow we use is standard RFC 8628, not a bespoke World protocol.

### A.2 Discovery document — exact fields (fetched live today)

SOURCE: `GET https://sandbox.auth.world.org/.well-known/openid-configuration` (harmless unauthenticated GET, run in this session, `http_status: 200`):

```json
{
  "issuer": "https://sandbox.auth.world.org",
  "authorization_endpoint": "https://sandbox.auth.world.org/api/v1/authorize",
  "token_endpoint": "https://sandbox.auth.world.org/api/v1/token",
  "device_authorization_endpoint": "https://sandbox.auth.world.org/api/v1/device_authorization",
  "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post", "private_key_jwt"],
  "token_endpoint_auth_signing_alg_values_supported": ["RS256"],
  "jwks_uri": "https://sandbox.auth.world.org/.well-known/jwks.json",
  "response_types_supported": ["code"],
  "response_modes_supported": ["query"],
  "grant_types_supported": ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
  "scopes_supported": ["openid"],
  "claims_supported": ["iss", "sub", "aud", "exp", "iat", "jti", "nonce", "auth_time", "acr", "amr"],
  "prompt_values_supported": ["none", "login"],
  "acr_values_supported": ["https://world.org/oidc/acr/orb-v3"],
  "subject_types_supported": ["pairwise"],
  "id_token_signing_alg_values_supported": ["RS256"],
  "code_challenge_methods_supported": ["S256"],
  "request_uri_parameter_supported": false
}
```

Byte-identical to the copy already in `world-id-implementacion.md` (same session date, re-fetched independently today — no drift). Key facts this confirms:

- **Device Authorization Grant is supported**: `urn:ietf:params:oauth:grant-type:device_code` is in `grant_types_supported`. SOURCE: field above.
- **`acr_values_supported` still only lists `orb-v3`** — no `passport`/`selfie` acr at the discovery level for this IdP (unlike IDKit, see `world-id-implementacion.md` §B). SOURCE: field above.
- **`claims_supported` includes `nonce`** alongside `auth_time`/`acr`/`amr` — the ID token *can* carry a `nonce` claim if one is sent in the request. SOURCE: field above; see A.6 for how to use it.
- `jwks_uri` → `https://sandbox.auth.world.org/.well-known/jwks.json`. SOURCE: field above, and independently confirmed live (A.3).
- `token_endpoint_auth_methods_supported` includes `client_secret_basic` → `Authorization: Basic base64(client_id:client_secret)` is valid, matching `docs/20-producto.md` §6's live-verified device flow ("app OIDC registrada (Client secret Basic)").

### A.3 JWKS — fetched live today

SOURCE: `GET https://sandbox.auth.world.org/.well-known/jwks.json` (harmless unauthenticated GET, `http_status: 200`):

```json
{
  "keys": [
    {
      "use": "sig",
      "kty": "RSA",
      "kid": "SjxoYTY6TKyO9wDOz9VmG4ze3tJsvwsPE5zgkOqqwAo",
      "alg": "RS256",
      "n": "pV14GMAHj_jkDzWPW5fMEJh-KgHQtA14n4SMq62W3IPDaPV2rPdmL_dbFvN6_ASr-A7ZmanG7ruaXfpr12w-aRdLFrXXoKd1vH29IAKz_3ZybBrK7ZZLd12qXLvWOJunwLln_DnWH6R0iM_Pf3Y3c3TiSYTRJkf-udqYL_06N5dRZ5bIDniPQBFo3ub-Dt7x8oIFyCMMbdoCeOh7vVXbA98yaDGCwgLOHCrQliOJlRbZotwXE4O_5xOrbIFmh1xP3qJgsc2UXzDKq0NiPz1cXgeyzGPkLPA9kwqKcvgOrCXzN4ojhk-z1-5wQD84tdPPY5JCSlfnyIechdpwMeRTyw",
      "e": "AQAB"
    }
  ]
}
```

Single RSA key, `alg: RS256`, `use: sig` — matches `jwtVerify`'s default algorithm expectation for `id_token_signing_alg_values_supported: ["RS256"]`. Do not hardcode `kid`; `createRemoteJWKSet` resolves the right key by `kid`/`alg` from the header (see A.5).

### A.4 Device flow request/response fields and polling rules

SOURCE (this exact shape, **live-verified against the real sandbox with a real phone approval**, 2026-09-25): `docs/20-producto.md` §6:

> "app OIDC registrada (Client secret Basic), el **device flow** (`POST /api/v1/device_authorization` con `scope=openid`, `prompt=login`) devolvió `user_code` y `verification_uri_complete` (vence en 1200 s, intervalo 5 s). El participante aprobó con la World App y el `/api/v1/token` devolvió un ID token con `acr=https://world.org/oidc/acr/orb-v3`, `amr=["pop"]` y un `auth_time` fresco (14 s)."

Field-by-field, cross-referenced against RFC 8628 §3.2 (device_authorization response) and §3.4 (token response), both named explicitly as implemented standards on the docs page (A.1):

**Step 1 — `POST /api/v1/device_authorization`**
Request: `Content-Type: application/x-www-form-urlencoded`, `Authorization: Basic base64(client_id:client_secret)`, body `scope=openid` (SOURCE: `world-id-implementacion.md`, itself built from `docs/20-producto.md`'s live run — `prompt=login` was sent in the live run per the quoted line above). Response fields observed live: `device_code`, `user_code`, `verification_uri_complete`, `expires_in` (observed value **1200**), `interval` (observed value **5**). RFC 8628 also defines a bare `verification_uri` (without the pre-filled code) as a sibling field — not separately confirmed live, but standard per RFC 8628 §3.2 and present in the discovery-confirmed grant type's spec.

**Step 2 — poll `POST /api/v1/token`**
Request: same Basic auth, body `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=<device_code>&client_id=<client_id>` (RFC 8628 §3.4). Response on success: an ID token whose live-decoded claims were `acr=https://world.org/oidc/acr/orb-v3`, `amr=["pop"]`, `auth_time` (fresh, 14s old at decode time) — SOURCE: `docs/20-producto.md` §6, live run.

**Polling rules** (RFC 8628 §3.5, standard — the docs page names RFC 8628 as an implemented standard, A.1; the *specific error strings* were not independently re-verified in a fresh live call this session, since re-running the flow needs the user's phone per task constraints):
- Poll no faster than `interval` seconds (live-observed default: 5s).
- `error: "authorization_pending"` → keep polling at the same interval; the human has not acted yet.
- `error: "slow_down"` → the client polled too fast; add **5 seconds** to the interval per RFC 8628 §3.5 and keep polling at the new (larger) interval.
- `error: "access_denied"` → the human explicitly rejected → terminal, stop polling.
- `error: "expired_token"` → `expires_in` elapsed with no resolution → terminal, stop polling.
- Any other `error` value → treat as unexpected/terminal, fail closed (do not retry silently).

All four error codes above are the RFC 8628 §3.5 standard vocabulary; the discovery doc's declared `grant_types_supported` entry for this exact grant type is the SOURCE tying that RFC to this IdP (A.2). Yakusoku's own `WorldIdDenied`/`WorldIdExpired` typed-error mapping in `world-id-implementacion.md` (lines ~130–174) already implements this correctly.

### A.5 `jose` verification code — `createRemoteJWKSet` + `jwtVerify`

SOURCE: Context7 `/panva/jose` (package resolved via `resolve-library-id`, "Source Reputation: High", 888 snippets), `docs/jwks/remote/functions/createRemoteJWKSet.md` and `docs/jwt/verify/functions/jwtVerify.md`, and `docs/jwt/verify/interfaces/JWTVerifyOptions.md` for `clockTolerance`/`maxTokenAge`/`currentDate`.

Base pattern (SOURCE, `jose` docs, adapted to our issuer/client):

```ts
// bun add jose
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = "https://sandbox.auth.world.org";
const CLIENT_ID = process.env.WORLD_AGENTS_CLIENT_ID!;

// createRemoteJWKSet(url, options?) — SOURCE: docs/jwks/remote/functions/createRemoteJWKSet.md
// Resolves the signing key by the JWT header's `kid`/`alg` against the live JWKS
// (A.3); caches it, re-fetches only on a cache miss / after cooldownDuration.
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export async function verifyWorldIdToken(idToken: string, maxAuthAgeSeconds: number) {
  // jwtVerify(jwt, getKey, options?) — SOURCE: docs/jwt/verify/functions/jwtVerify.md
  const { payload, protectedHeader } = await jwtVerify(idToken, JWKS, {
    issuer: ISSUER,          // rejects if `iss` != this value
    audience: CLIENT_ID,     // rejects if `aud` != this value
    clockTolerance: "5s",    // SOURCE: JWTVerifyOptions.clockTolerance — skew tolerance for `nbf`/`exp` (and `iat` if maxTokenAge is set)
  });
  // Signature (RS256, per id_token_signing_alg_values_supported, A.2), iss, aud,
  // and exp/nbf (with the 5s clock tolerance) are already verified at this point.

  return { payload, protectedHeader };
}
```

`JWTVerifyOptions` (SOURCE, `docs/jwt/verify/interfaces/JWTVerifyOptions.md`, extends `JWTClaimVerificationOptions`) also exposes:
- `maxTokenAge?: string | number` — "Maximum time since the JWT `iat` Claim... Requires the claim to be present." Could be used as a coarse freshness gate on `iat`, but `iat` is *token issuance* time, not *human authentication* time — for Yakusoku the field that actually matters is `auth_time` (A.6), so `maxTokenAge` is not a substitute for the manual `auth_time` check below.
- `currentDate?: Date` — override "now" for testing; not needed in production code.
- `clockTolerance?: string | number` — accepts a plain number of seconds or a duration string (e.g. `"5 seconds"`); used above as `"5s"`.

### A.6 `auth_time` freshness check (manual — `jose` does not do this for you)

`jwtVerify` validates `exp`/`nbf`/`iss`/`aud`/`clockTolerance` but has **no built-in option for `auth_time`** (SOURCE: `JWTVerifyOptions`/`JWTClaimVerificationOptions` fields enumerated above — no `auth_time`/`maxAuthAge` field exists). `auth_time` is in `claims_supported` (A.2) but its freshness must be checked manually, exactly as already designed in `world-id-implementacion.md`:

```ts
export async function verifyFreshApproval(idToken: string, opts: { maxAuthAgeSeconds: number }) {
  const { payload } = await verifyWorldIdToken(idToken, opts.maxAuthAgeSeconds);

  const authTime = payload.auth_time as number | undefined;
  if (typeof authTime !== "number") {
    throw new Error("ID token missing auth_time: cannot validate freshness"); // fail closed
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - authTime;
  if (ageSeconds > opts.maxAuthAgeSeconds) {
    throw new Error(`Approval is ${ageSeconds}s old, exceeds max ${opts.maxAuthAgeSeconds}s`); // fail closed
  }

  if (payload.acr !== "https://world.org/oidc/acr/orb-v3") {
    throw new Error(`Unexpected acr: ${payload.acr}`); // fail closed — only orb-v3 is offered today (A.2)
  }

  return payload; // sub (pairwise), acr, auth_time, amr
}
```

This matches the live-observed values in `docs/20-producto.md` §6 (`acr=orb-v3`, `amr=["pop"]`, fresh `auth_time`). Always start a **new** `device_authorization` per approval request rather than reusing a token — this is the actual freshness guarantee for Yakusoku, since RFC 9470 step-up semantics are not confirmed to apply to the device-code branch specifically (unresolved question already flagged in `world-id-implementacion.md` §A, not re-tested here since it needs a live phone approval).

### A.7 Nonce handling

SOURCE: A.2 discovery document, `claims_supported` includes `"nonce"`. This means the IdP **can** echo a `nonce` claim back in the ID token if the relying party sends one in the request — standard OIDC replay-protection pattern. **Not independently re-verified live this session** (would require running the device flow with a real phone) whether `device_authorization` accepts a `nonce` request parameter the way `authorize` does for the interactive flow; the discovery document exposes `nonce` at the IdP level but, same caveat as `prompt`/`acr_values` already flagged in `world-id-implementacion.md` §A, does not say which endpoint(s) accept it as an input parameter.

**Recommended posture for the MVP (defensive, no live dependency):** generate a random nonce per `ask_human` escalation, store it server-side keyed by `paymentId`, and — if the device-flow request accepts a `nonce` body parameter — send it; **regardless**, after `jwtVerify` succeeds, if the decoded payload contains a `nonce` claim, compare it to the stored value and reject on mismatch. If the response never carries a `nonce` (because the endpoint silently ignores the parameter), the freshness guarantee still holds via A.6 (fresh `device_authorization` per request + `auth_time` check) — nonce is defense-in-depth, not the primary freshness mechanism here.

### A.8 Showing `verification_uri_complete` as a QR code in the web dashboard

The dashboard is Next.js/React (`docs/20-producto.md` §8: "Next.js/React + wagmi"). Recommended library: **`qrcode.react`** (npm) — a small React component (`<QRCodeSVG>` / `<QRCodeCanvas>`) that takes a single string `value` prop and renders a scannable QR, no server round-trip, no canvas boilerplate to write by hand. Fits directly into the SSE-driven approval-request UI already designed in `world-id-implementacion.md` §B (the `IDKitRequestWidget` sibling flow already renders similar on-screen prompts).

```tsx
// bun add qrcode.react
import { QRCodeSVG } from "qrcode.react";

// device.verification_uri_complete comes from step 1 of the device flow (A.4)
<QRCodeSVG value={device.verification_uri_complete} size={220} />;
```

If a non-React, CDN-only path is ever needed (e.g. a plain HTML fallback screen), `qrcodejs` (davidshimjs) is available unpkg/cdnjs-hosted and needs only a `<div id="qr"></div>` + `new QRCode(el, text)` call — mentioned here only as a fallback; `qrcode.react` is the primary recommendation since the dashboard is already React. Neither library choice was live-fetched this session (no doc URL to verify against — this is a standard, widely-used package pick, not a fact requiring a live source check); treat the exact API surface as UNVERIFIED against a live npm/cdnjs fetch and confirm the import name when first `bun add`-ing it.

### A.9 Error-handling map (consolidated)

| Stage | Signal | SOURCE | Handling |
|---|---|---|---|
| `device_authorization` request fails (non-2xx) | HTTP error | RFC 8628 §3.2 (standard, named on docs page, A.1) | fail closed — do not proceed to polling |
| Poll: `authorization_pending` | token endpoint error | RFC 8628 §3.5 (A.4) | keep polling at current interval |
| Poll: `slow_down` | token endpoint error | RFC 8628 §3.5 (A.4) | add 5s to interval, keep polling |
| Poll: `access_denied` | token endpoint error | RFC 8628 §3.5 (A.4); mapped live pattern in `world-id-implementacion.md` (`WorldIdDenied`) | terminal → `refuse`, never retry |
| Poll: `expired_token` / `expires_in` elapsed | token endpoint error / client-side deadline | RFC 8628 §3.5 (A.4); `world-id-implementacion.md` (`WorldIdExpired`) | terminal → `refuse`, never retry |
| ID token signature/iss/aud/exp invalid | `jwtVerify` throws | A.5 (`jose` docs) | terminal → `refuse` |
| `auth_time` missing or stale | manual check | A.6 | terminal → `refuse` |
| `acr` not `orb-v3` | manual check | A.6, A.2 (`acr_values_supported`) | terminal → `refuse` |
| `nonce` mismatch (if used) | manual check | A.7 | terminal → `refuse` |

Fail-closed on every branch — consistent with the project's non-negotiable constraint #4 in `odd/tasks/yakusoku.md` ("any error or doubt → `refuse` or `ask_human`, never `pay`").

---

## Part B — Intercepta (Web3 Antivirus API)

Base URL `https://api.web3antivirus.io`, auth header `X-API-KEY`. All schemas below were re-fetched live today directly from `docs.web3antivirus.io/reference/*.md` (the `.md` suffix trick from `/llms.txt`) and are **byte-identical** to what's already recorded in `intercepta-implementacion.md` — no schema drift found.

### B.1 Endpoint verification (re-fetched live today)

| Endpoint | Path | SOURCE (fetched today) | `updatedAt` reported by the doc |
|---|---|---|---|
| Quick Scan Address | `GET /api/public/v2/extension/account/{address}/quick-scan` | https://docs.web3antivirus.io/reference/quick-scan-address.md | 2026-05-12T09:23:11Z |
| Deep Scan Address | `GET /api/public/v2/extension/account/{address}/toxic-score` | https://docs.web3antivirus.io/reference/scan-address.md | 2026-05-12T09:23:11Z |
| Scan Token | `GET /api/public/v2/extension/token-intelligence/token/{address}/risks?chainId=` | https://docs.web3antivirus.io/reference/scan-token.md | 2026-07-06T14:45:48Z |
| Scan Message | `POST /api/public/v2/extension/analysis/signature` | https://docs.web3antivirus.io/reference/scan-message.md | 2026-04-27T07:19:22Z |

Confirmed identical to `intercepta-implementacion.md` §1:
- `ToxicScoreShortResponseV2` (`toxicScore: number`, `traits: ToxicScoreTraitV2[]`) — **same shape for both Quick Scan and Deep Scan** (confirmed by fetching both pages independently today: `quick-scan-address.md` and `scan-address.md` return the identical `ToxicScoreShortResponseV2`/`ToxicScoreTraitV2` schema block, only the endpoint path and the descriptive prose differ).
- `traits[].name` enum (15 values: `known_scammer`, `initiator_scam_transactions`, `sanction_address_communication`, `suspicious_dex_pair_deployer`, `suspicious_deployer`, `attack_money_target`, `zero_address_risk`, `sanction_address`, `fake_phishing_transfer`, `non_kyc_transfers`, `mixer_transfers`, `fake_phishing_contract_communication`, `rug_pull`, `rug_pull_trader`, `blacklist`) — unchanged.
- `TokenRiskAnalysisV2Response` (`apiVersion`, `saleTax`/`buyTax` as `{currentValue,minValue,maxValue}`, `riskScore: number`, `riskLevel: neutral|low|medium|high`, `category: malicious|restricted|suspicious|availability|sanctioned|unverified|info`, `trust: whitelist|blocklist|neutral`, `action: block|warn|info`, `detectors: Detector[]`, `token: TokenDetails`) — unchanged, 27-value `Detector.code` enum unchanged. `scan-token`'s `chainId` query enum now explicitly includes `"solana"` and `"57073"` in the live fetch (visible in the raw OpenAPI JSON: `["1868","7777777","1","8453","130","146","56","137","10","42161","480","42220","43114","324","81457","59144","999","33139","solana","57073"]`) — `8453` (Base mainnet) is present, as `intercepta-implementacion.md` already relied on.
- `AnalyzeSignatureRequestDTO` (`from` required, `website` optional, `message: string` (`format: json`) required, top-level `chainId` enum **mainnet-only, no `84532`**, default `"1"`) and `SignatureAnalysisResponseDTO` (`domain`, `from`, `messageType` enum limited to `Permit|PermitSingle|PermitBatch|PermitForAll|PermitTransferFrom|PermitBatchTransferFrom` — **`TransferWithAuthorization` still not in the enum**, confirming the EIP-3009 risk already flagged) — unchanged.

Net conclusion: **no schema drift since `intercepta-implementacion.md` was written** (same session date); its endpoint shapes, enums, and the EIP-3009/testnet-`chainId` gaps are all still accurate today.

### B.2 The "quickstart" claim — verified, and what it actually is

SOURCE: https://intercepta.io/ethglobal (fetched live today):

> "02 · First call in ten minutes — The [quickstart](https://docs.web3antivirus.io/reference/api-overview) gets you to a real verdict with one request. A TypeScript example repo is in the Discord channel."

This confirms the wording quoted in the task prompt ("the quickstart gets you to a first call in ten minutes" — the live page's exact phrasing is "First call in ten minutes... a real verdict with one request", same claim). **However**, the link labelled "quickstart" does **not** point to a dedicated quickstart page — it points to `reference/api-overview`, titled **"Introduction"** (fetched live today, confirmed by page `<title>`). There is **no separate "Quickstart" entry** in the documentation index (SOURCE: https://docs.web3antivirus.io/llms.txt, fetched live today — the "API Reference" section lists "Introduction", "Getting Started", then every endpoint page directly; no "Quickstart" page exists).

`reference/getting-started-1.md` (SOURCE, fetched live today) is the closest thing to an onboarding flow: request an API key via a form → paste the key into the **AUTHORIZATION** field on a reference page → click **Try It!** → expect `200` on success, `403` on a bad key. This page still references the legacy host `w3a.readme.io` (`https://w3a.readme.io/reference/website_scan-website`) instead of `docs.web3antivirus.io`/`api.web3antivirus.io` — confirms the stale-reference finding already noted in `intercepta-implementacion.md`'s draft feedback §8, still present today.

So: **no newer quickstart page exists**; "the quickstart" is marketing shorthand for the Introduction page + "Try It!" pattern on any reference page, and the "ten minutes to a first call" claim is realistic given that flow (API key → paste into one reference page → click a button) but is not backed by a dedicated tutorial page.

### B.3 Live API calls — not made

`INTERCEPTA_API_KEY` was checked in `/Users/juanma/Desktop/eth-global/.env.hackathon` (read with the user's prior authorization; value never printed or logged) and is **absent or empty**. Per the task instructions, live calls were gated on this key being non-empty — since it is not, **no live calls to `api.web3antivirus.io` were made in this session**, and no real response shapes (as opposed to the documented example payloads already in B.1 / `intercepta-implementacion.md`) can be recorded yet. Once the key arrives, the three calls specified in the task (quick-scan of a well-known exchange address, and `token-intelligence/token/{address}/risks?chainId=8453` for Base mainnet USDC `0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913`) should be re-run and this file updated with the real observed `toxicScore`/`riskScore` values — the numeric thresholds in `intercepta-implementacion.md` §5 are still explicitly marked UNVERIFIED pending that.

---

## Summary of what changed vs. the two existing docs

- No schema drift found in either World ID's discovery/JWKS or any of the four Intercepta endpoints checked — both existing docs remain accurate as of today's re-fetch.
- New, previously missing: concrete `jose` `createRemoteJWKSet`/`jwtVerify` call with `issuer`/`audience`/`clockTolerance` (A.5, SOURCE: Context7 `/panva/jose`), the RFC 8628 §3.5 polling/error semantics spelled out per-code (A.4/A.9), a `nonce`-handling recommendation (A.7, since `nonce` is now confirmed present in `claims_supported`), and a QR library pick for `verification_uri_complete` (A.8, `qrcode.react`).
- Confirmed: no dedicated Intercepta "quickstart" page exists; the linked target is the Introduction page (B.2).
- Confirmed: `INTERCEPTA_API_KEY` is not yet set — Part B's live-call requirement (task's Discord-day requirement, and the track's "at least one live call" rule in `intercepta-implementacion.md` §8) is still open and must be re-run once the key arrives.
