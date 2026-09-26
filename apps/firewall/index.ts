// Omamorisan firewall — the only process holding the signing key. Verifies
// signed TaskIntents, runs the pre-signature decision pipeline, signs x402
// payments on the agent's behalf, and streams live decision events to the
// dashboard over SSE (root CLAUDE.md, plan-tecnico.md §2, WU9).

import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { getConnInfo } from "hono/bun";
import { z } from "zod";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { Hex } from "viem";
import {
  purchaseRefSchema,
  signedTaskIntentSchema,
  transition,
  USDC_DECIMALS,
  X402_NETWORK,
  type DecisionReceipt,
} from "@yakusoku/shared";
import {
  createIntent,
  createNonce,
  createSession,
  findAccountByAccountKey,
  findIntentByAgentKey,
  getAccount,
  getControlState,
  getIntent,
  getOwnerControl,
  getPendingApprovalByReceiptId,
  getPromise,
  getReceipt,
  getSessionByToken,
  listAccountsByOwner,
  listAllPromises,
  listIntents,
  listOwnedMandateIds,
  listPromisesByAccount,
  listReceipts,
  remainingBudget,
  revokeIntent,
  revokeSession,
  saveReceipt,
  setAccountHealthOverride,
  setControlState,
  setOwnerControl,
  type StoredAccount,
  type StoredIntent,
  type StoredPromise,
} from "./store";
import { extractBearerToken } from "./auth";
import { verifyTaskIntentSignature } from "./signer";
import { verifySiweSignIn } from "./siwe";
import { computePaymentIdentifier, computePurchaseIdentifier, runSignPipeline } from "./pipeline";
import { approvalStatusResponse, resumePendingApprovalsOnBoot } from "./approvals";
import { devApproveConnect, pollConnect, resumeConnectRequestsOnBoot, startConnect } from "./accounts";
import {
  createPromiseRequest,
  devApprovePromise,
  resolveMandate,
  revokeOwnerPromiseRequest,
  revokePromiseRequest,
  resumePromiseApprovalsOnBoot,
  serializePromiseDetail,
  serializePromiseSummary,
} from "./promises";
import { createSetupLink, describeAccountDeployment, getSetupStatus, linkOwner } from "./account-setup";
import { createFirstPromiseRequestOutcome, devApproveFirstPromise, pollFirstPromise, resumeFirstPromiseApprovalsOnBoot } from "./first-promise";
import { publish, subscribe, type FirewallEvent } from "./events-bus";

const PORT = Number(process.env.PORT) || 4001;
const SSE_HEARTBEAT_MS = 15_000;

const app = new Hono();

// --- T1 request log + health (odd/tasks/dokploy-deploy.md) ------------------
// Method, path, status and ms, to stdout — mirrors apps/mcp/index.ts's own
// `withRequestLog` (one line, pathname only). Originally used `hono/logger`,
// but that prints the full URL INCLUDING the query string, which would leak
// `GET /events?session=<SIWE bearer token>` straight to stdout — and one
// path segment is itself a bearer credential (`GET /setup/:token`, `POST
// /setup/:token/owner`: "the token itself is the credential", this file's
// own comment on that route). `redactLoggedPath` strips both. Registered
// first so it wraps every route below, including CORS preflights and the
// SSE stream.
function redactLoggedPath(pathname: string): string {
  const setupMatch = /^\/setup\/[^/]+(\/owner)?$/.exec(pathname);
  return setupMatch ? `/setup/:token${setupMatch[1] ?? ""}` : pathname;
}

app.use(async (c, next) => {
  const start = Date.now();
  await next();
  console.log(`${c.req.method} ${redactLoggedPath(new URL(c.req.url).pathname)} ${c.res.status} ${Date.now() - start}ms`);
});

app.get("/health", (c) => c.json({ ok: true }));

// --- CORS (WU-P3) ------------------------------------------------------------
// The site (a separate origin) needs the Authorization header for session
// Bearer calls; the dashboard is same-origin (served off this same process)
// so it never goes through CORS at all. Env-configurable so a deployed site
// origin doesn't require a code change.
const SITE_ORIGINS = (process.env.OMAMORISAN_SITE_ORIGINS ?? "http://localhost:4321,http://localhost:4322")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
// P6: "Accept" wasn't on this list — harmless for a plain `fetch()`, but a
// cross-origin `EventSource` (which always sends `Accept: text/event-stream`
// itself, non-optionally per spec) preflights on it and then hangs instead of
// failing fast when the preflight doesn't allow it back (confirmed while
// QA'ing the P6 dashboard's live SSE stream). The dashboard's own fetch-based
// SSE client (apps/site/src/lib/sse.ts) works around it by never sending that
// header at all, but any other cross-origin consumer using a native
// `EventSource` still needs this listed.
app.use("/*", cors({ origin: SITE_ORIGINS, allowHeaders: ["Content-Type", "Authorization", "Accept", "x-yakusoku-admin"] }));

app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "internal_error", message: err instanceof Error ? err.message : String(err) }, 500);
});

// --- GET /dashboard (WU10) --------------------------------------------------
// Minimal plain HTML/CSS/JS dashboard, same-origin as the API (no CORS
// needed). Served straight off disk with Bun.file — no build step.

const PUBLIC_DIR = new URL("./public/", import.meta.url);

const DASHBOARD_ASSETS: Record<string, { file: string; contentType: string }> = {
  "/dashboard": { file: "dashboard.html", contentType: "text/html; charset=utf-8" },
  "/dashboard.css": { file: "dashboard.css", contentType: "text/css; charset=utf-8" },
  "/dashboard.js": { file: "dashboard.js", contentType: "application/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", contentType: "image/svg+xml" },
};

for (const [route, asset] of Object.entries(DASHBOARD_ASSETS)) {
  app.get(route, async (c) => {
    const file = Bun.file(new URL(asset.file, PUBLIC_DIR));
    if (!(await file.exists())) return c.text("not found", 404);
    return new Response(file, { headers: { "Content-Type": asset.contentType } });
  });
}

// --- SIWE sign-in (WU-P3) -----------------------------------------------------
// The site authenticates a wallet owner (not an agent — see the WU-P1 vs
// WU-P3 auth note further below) with EIP-4361: fetch a nonce, sign a
// message embedding it, exchange the signed message for a session token.

app.get("/auth/nonce", (c) => c.json(createNonce()));

const authVerifySchema = z.object({
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "not a hex signature"),
});

app.post("/auth/verify", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = authVerifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_auth_request", issues: parsed.error.issues }, 400);
  }
  const result = await verifySiweSignIn(parsed.data.message, parsed.data.signature as Hex);
  if (!result.ok) {
    return c.json({ error: "invalid_signature", message: result.reason }, 401);
  }
  const { token, expiresAt } = createSession(result.address);
  return c.json({ sessionToken: token, address: result.address, expiresAt });
});

app.post("/auth/logout", (c) => {
  const auth = authenticateSession(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const token = extractBearerToken(c.req.header("authorization"));
  if (token) revokeSession(token);
  return c.json({ ok: true });
});

app.get("/auth/me", (c) => {
  const auth = authenticateSession(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  return c.json({ address: auth.address, expiresAt: auth.expiresAt });
});

function serializeIntent(intent: StoredIntent) {
  return {
    id: intent.id,
    message: {
      task: intent.message.task,
      budget: intent.message.budget.toString(),
      categories: intent.message.categories,
      expiry: intent.message.expiry.toString(),
      nonce: intent.message.nonce,
    },
    signer: intent.signer,
    createdAt: intent.createdAt,
    remainingBudget: remainingBudget(intent).toString(),
    revoked: intent.revoked,
    revokedAt: intent.revokedAt,
  };
}

// --- WU13 kill switch / revoke: minimal local-only admin guard -------------
//
// These control endpoints have no real authentication tonight (local demo
// only, per the WU13 scope). This is not a security boundary — it only
// keeps the local demo box from being poked by another process on the same
// machine/LAN: the request must come from a loopback TCP peer (checked via
// Hono's Bun `getConnInfo`, not a spoofable header) AND carry a fixed
// `x-yakusoku-admin: 1` header that only the dashboard's own fetch calls
// send. Neither check is cryptographic.
function isLocalAdminRequest(c: Context): boolean {
  const address = getConnInfo(c).remote.address ?? "";
  const isLoopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
  return isLoopback && c.req.header("x-yakusoku-admin") === "1";
}

function requireLocalAdmin(c: Context, next: Next) {
  if (!isLocalAdminRequest(c)) {
    return c.json({ error: "forbidden" }, 403);
  }
  return next();
}

/** `GET /events` variant of `isLocalAdminRequest` (WU-P3): `EventSource`
 * cannot set custom headers, so the operator dashboard's SSE connection is
 * distinguished by a `?admin=1` query param instead — still gated on the
 * same loopback check, still not cryptographic, just enough to keep a
 * random local process from opening the unfiltered stream. */
function isLocalAdminEventsRequest(c: Context): boolean {
  const address = getConnInfo(c).remote.address ?? "";
  const isLoopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
  return isLoopback && c.req.query("admin") === "1";
}

// --- WU-P3 SIWE session auth --------------------------------------------------
//
// A session token authenticates the SITE on behalf of one wallet owner — a
// distinct concept from the WU-P1 agent mandate key (`authenticateAgent`
// above): a session identifies a human owner across all their mandates,
// while a mandate key identifies one agent's authority over one intent.

type SessionAuthResult =
  | { ok: true; address: `0x${string}`; expiresAt: string }
  | { ok: false; status: 401; body: { error: "unauthorized" } };

function authenticateSession(c: Context): SessionAuthResult {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return { ok: false, status: 401, body: { error: "unauthorized" } };
  const session = getSessionByToken(token);
  if (!session) return { ok: false, status: 401, body: { error: "unauthorized" } };
  return { ok: true, address: session.address, expiresAt: session.expiresAt };
}

// --- WU-P1 mandate credential auth -------------------------------------------
//
// `POST /sign` and `GET /approvals/:receiptId` are the agent-facing
// endpoints: an agent authenticates with `Authorization: Bearer <agentKey>`,
// the credential `POST /intents` handed the human exactly once. The key ->
// mandate lookup (`findIntentByAgentKey`, store.ts) is authoritative — a
// caller-supplied `intentId` (still accepted on `/sign` for explicitness) is
// only ever checked for a MATCH against the authenticated mandate, never
// used to look anything up on its own. A revoked mandate can never
// authenticate again, so its key refuses here (401) before any pipeline
// stage ever runs.
type AgentAuthResult =
  | { ok: true; mandate: StoredIntent }
  | { ok: false; status: 401 | 403; body: { error: "unauthorized" | "forbidden" } };

function authenticateAgent(c: Context, requestedIntentId?: string): AgentAuthResult {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return { ok: false, status: 401, body: { error: "unauthorized" } };
  const mandate = findIntentByAgentKey(token);
  if (!mandate || mandate.revoked) return { ok: false, status: 401, body: { error: "unauthorized" } };
  if (requestedIntentId !== undefined && requestedIntentId !== mandate.id) {
    return { ok: false, status: 403, body: { error: "forbidden" } };
  }
  return { ok: true, mandate };
}

// --- P9.1 account credential auth --------------------------------------------
//
// `GET /account` and `POST /promises` are account-scoped: an account
// authenticates with `Authorization: Bearer <accountKey>` (`ya_...`, minted
// once by `POST /connect/poll`). Unlike a mandate key, one account key can
// own several promises, so it never resolves a single mandate by itself.

type AccountAuthResult =
  | { ok: true; account: StoredAccount }
  | { ok: false; status: 401; body: { error: "unauthorized" } };

function authenticateAccount(c: Context): AccountAuthResult {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return { ok: false, status: 401, body: { error: "unauthorized" } };
  const account = findAccountByAccountKey(token);
  if (!account) return { ok: false, status: 401, body: { error: "unauthorized" } };
  return { ok: true, account };
}

// --- P9.2 unified mandate-credential auth ------------------------------------
//
// `/sign`, `/approvals/:receiptId` and `/receipts/:id/settlement` accept
// EITHER a wallet mandate key (`yk_...`, unchanged since WU-P1 — see
// `authenticateAgent` above, whose exact behavior this reproduces byte for
// byte for a `yk_` token) OR an account key (`ya_...`) naming one of that
// account's own promises via `requestedIntentId` (the request's `intentId` /
// the receipt's `intentId`). An account key with no `requestedIntentId` still
// authenticates (kind `"account"`, `mandate: undefined`) — used for a
// pre-body-parse check (mirrors `/sign`'s `preAuth` pattern) before the
// caller knows which promise the request names.
type MandateCredentialResult =
  | { ok: true; kind: "wallet"; mandate: StoredIntent }
  | { ok: true; kind: "account"; account: StoredAccount; mandate?: StoredIntent }
  | { ok: false; status: 401 | 403; body: { error: "unauthorized" | "forbidden" } };

function authenticateMandateCredential(c: Context, requestedIntentId?: string): MandateCredentialResult {
  const token = extractBearerToken(c.req.header("authorization"));
  if (!token) return { ok: false, status: 401, body: { error: "unauthorized" } };

  const walletMandate = findIntentByAgentKey(token);
  if (walletMandate) {
    if (walletMandate.revoked) return { ok: false, status: 401, body: { error: "unauthorized" } };
    if (requestedIntentId !== undefined && requestedIntentId !== walletMandate.id) {
      return { ok: false, status: 403, body: { error: "forbidden" } };
    }
    return { ok: true, kind: "wallet", mandate: walletMandate };
  }

  const account = findAccountByAccountKey(token);
  if (account) {
    if (requestedIntentId === undefined) return { ok: true, kind: "account", account };
    const promise = getPromise(requestedIntentId);
    if (!promise || promise.accountId !== account.id) return { ok: false, status: 403, body: { error: "forbidden" } };
    // resolveMandate never returns undefined here — `getPromise` just found
    // this exact row, and `resolveMandate` checks the very same table.
    return { ok: true, kind: "account", account, mandate: resolveMandate(requestedIntentId) };
  }

  return { ok: false, status: 401, body: { error: "unauthorized" } };
}

// --- POST /connect (P9.1) -----------------------------------------------------
//
// No auth: nobody is authenticated yet, that's the whole point of connecting
// an agent to a human via World ID. Starts a fresh device flow and returns
// everything the MCP client needs to show the human a link/code and start
// polling.

app.post("/connect", async (c) => {
  try {
    const result = await startConnect();
    return c.json(result, 201);
  } catch (err) {
    return c.json(
      { error: "connect_start_failed", message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

const connectPollSchema = z.object({
  connectId: z.string().min(1),
  pollSecret: z.string().min(1),
});

app.post("/connect/poll", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = connectPollSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_connect_poll_request", issues: parsed.error.issues }, 400);
  }
  const result = pollConnect(parsed.data.connectId, parsed.data.pollSecret);
  if (!result.ok) return c.json(result.body, result.status);
  const { ok: _ok, ...body2 } = result;
  return c.json(body2);
});

// --- GET /account (P9.1) ------------------------------------------------------

app.get("/account", async (c) => {
  const auth = authenticateAccount(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  // P11.3a — `smartAccount`/`owner`/`balanceUsdc` are only ever populated
  // once this account has actually deployed (`describeAccountDeployment`
  // reads the on-chain USDC balance live, so this is an async handler now).
  const deployment = await describeAccountDeployment(auth.account);
  return c.json({
    accountId: auth.account.id,
    createdAt: auth.account.createdAt,
    promises: listPromisesByAccount(auth.account.id).map(serializePromiseSummary),
    smartAccount: deployment.smartAccount,
    owner: deployment.owner,
    balanceUsdc: deployment.balanceUsdc,
    perPaymentLimitUsdc: deployment.perPaymentLimitUsdc,
    recipients: deployment.recipients,
  });
});

// --- Account setup (P11.3a) ---------------------------------------------------
// Links the account's own wallet as the owner of a freshly deployed
// `OmamorisanAccount` smart account — see account-setup.ts's header for the
// full flow and its fail-closed contract.

app.post("/accounts/setup-link", (c) => {
  const auth = authenticateAccount(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  return c.json(createSetupLink(auth.account.id), 201);
});

app.get("/setup/:token", async (c) => {
  // No auth — the token itself is the credential (root API contract). 404
  // for both "never existed" and "expired before ever deploying", so a
  // guess never learns which is which.
  const outcome = await getSetupStatus(c.req.param("token"));
  if (!outcome.ok) return c.json({ error: "setup_token_not_found" }, 404);
  const { ok: _ok, ...body } = outcome;
  return c.json(body);
});

const setupOwnerSchema = z.object({
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "not a hex address"),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "not a hex signature"),
});

app.post("/setup/:token/owner", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = setupOwnerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_setup_owner_request", issues: parsed.error.issues }, 400);
  }
  const outcome = await linkOwner(c.req.param("token"), parsed.data.owner as Hex, parsed.data.signature as Hex);
  if (!outcome.ok) {
    if (outcome.reason === "not_found") return c.json({ error: "setup_token_not_found" }, 404);
    if (outcome.reason === "invalid_signature") return c.json({ error: "invalid_signature" }, 401);
    return c.json({ error: "deploy_failed", message: outcome.message }, 500);
  }
  return c.json({ status: "deployed", smartAccount: outcome.smartAccount, owner: outcome.owner, txHash: outcome.txHash });
});

// --- Promises (P9.2) ----------------------------------------------------------

const createPromiseSchema = z.object({
  task: z.string().min(1),
  budgetUsdc: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  categories: z.array(z.string().min(1)).min(1).max(5),
  expiresInSeconds: z.number().int().positive(),
  /** H1 fix — the store's URL; `createPromiseRequest` (promises.ts)
   * normalizes it to an origin and binds this promise to it. */
  merchant: z.string().min(1),
  /** Promise-replacement fix — the id of an existing promise this new one
   * replaces. Shared by both `POST /promises` and `POST /promises/first`:
   * `validatePromiseInput` (promises.ts) is what actually fail-closed
   * refuses it on the first-time no-credential path, since there's no
   * account yet on that path to own either promise. */
  replaces: z.string().min(1).optional(),
});

app.post("/promises", async (c) => {
  const auth = authenticateAccount(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const body = await c.req.json().catch(() => undefined);
  const parsed = createPromiseSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_promise_request", issues: parsed.error.issues }, 400);
  }
  if (!Number.isFinite(parsed.data.budgetUsdc)) {
    return c.json({ error: "invalid_promise_request", issues: "budgetUsdc must be numeric" }, 400);
  }
  const outcome = await createPromiseRequest(auth.account, parsed.data);
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  const p = outcome.promise;
  return c.json(
    {
      promiseId: p.id,
      status: p.status,
      verificationUri: p.verificationUri,
      verificationUriComplete: p.verificationUriComplete,
      userCode: p.userCode,
      expiresAt: p.expiresAt,
      summary: p.summary,
    },
    201,
  );
});

app.get("/promises", (c) => {
  const auth = authenticateAccount(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  // Same detail shape as `GET /promises/:id` (pending-approval info included
  // while pending) — an MCP client's `list_promises` wants to show a live
  // approval link without a follow-up call per promise.
  return c.json(listPromisesByAccount(auth.account.id).map(serializePromiseDetail));
});

app.get("/promises/:id", (c) => {
  const auth = authenticateAccount(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const promise = getPromise(c.req.param("id"));
  if (!promise || promise.accountId !== auth.account.id) return c.json({ error: "promise_not_found" }, 404);
  return c.json(serializePromiseDetail(promise));
});

app.get("/promises/:id/attestation", (c) => {
  const auth = authenticateAccount(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const promise = getPromise(c.req.param("id"));
  if (!promise || promise.accountId !== auth.account.id) return c.json({ error: "promise_not_found" }, 404);
  if (!promise.attestation) return c.json({ error: "attestation_not_found" }, 404);
  return c.json(promise.attestation);
});

app.post("/promises/:id/revoke", (c) => {
  const auth = authenticateAccount(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const promise = revokePromiseRequest(c.req.param("id"), auth.account.id);
  if (!promise) return c.json({ error: "promise_not_found" }, 404);
  return c.json(serializePromiseDetail(promise));
});

// --- POST /promises/first (P9.6) ----------------------------------------------
// No auth — nobody is authenticated yet, same as `POST /connect`. A single
// World ID approval creates the account AND activates this promise together
// (first-promise.ts) — the MCP's `request_promise` calls this instead of
// `POST /promises` when the session has no credential at all yet.

app.post("/promises/first", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = createPromiseSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_promise_request", issues: parsed.error.issues }, 400);
  }
  if (!Number.isFinite(parsed.data.budgetUsdc)) {
    return c.json({ error: "invalid_promise_request", issues: "budgetUsdc must be numeric" }, 400);
  }
  const outcome = await createFirstPromiseRequestOutcome(parsed.data);
  if (!outcome.ok) return c.json({ error: outcome.error }, outcome.status);
  const r = outcome.request;
  return c.json(
    {
      promiseId: r.id,
      pollSecret: r.pollSecret,
      verificationUri: r.verificationUri,
      verificationUriComplete: r.verificationUriComplete,
      userCode: r.userCode,
      expiresAt: r.expiresAt,
      summary: r.summary,
    },
    201,
  );
});

const pollFirstPromiseSchema = z.object({ pollSecret: z.string().min(1) });

app.post("/promises/first/:id/poll", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = pollFirstPromiseSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_poll_request", issues: parsed.error.issues }, 400);
  }
  const result = pollFirstPromise(c.req.param("id"), parsed.data.pollSecret);
  if (!result.ok) return c.json(result.body, result.status);
  const { ok: _ok, ...responseBody } = result;
  return c.json(responseBody);
});

// --- POST /intents -----------------------------------------------------------

app.post("/intents", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = signedTaskIntentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_intent", issues: parsed.error.issues }, 400);
  }
  const { message, signature, signer } = parsed.data;

  let validSignature: boolean;
  try {
    validSignature = await verifyTaskIntentSignature(message, signature as Hex, signer as Hex);
  } catch (err) {
    // Fail-closed: an RPC/verification error is never treated as a valid signature.
    return c.json(
      { error: "signature_verification_failed", message: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
  if (!validSignature) {
    return c.json({ error: "invalid_signature" }, 400);
  }

  // WU-P1: mints the mandate credential too — `agentKey` is the raw value,
  // returned exactly once here and never again (only its hash is persisted,
  // store.ts). `serializeIntent` never includes it, so the SSE broadcast
  // below and every later `GET /intents`/`GET /intents/:id` response stay
  // silent about it.
  const { intent, agentKey } = createIntent(message, signature as Hex, signer as Hex);
  publish("intent.created", serializeIntent(intent));
  return c.json({ id: intent.id, remainingBudget: remainingBudget(intent).toString(), agentKey }, 201);
});

// --- GET /intents (WU-P3 owner-scoped) --------------------------------------
// The operator header path (loopback + `x-yakusoku-admin`) keeps full
// visibility for the legacy `/dashboard`; every other caller needs a valid
// SIWE session and only ever sees intents it signed.

app.get("/intents", (c) => {
  if (isLocalAdminRequest(c)) return c.json(listIntents().map(serializeIntent));
  const auth = authenticateSession(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const owner = auth.address.toLowerCase();
  return c.json(
    listIntents()
      .filter((i) => i.signer.toLowerCase() === owner)
      .map(serializeIntent),
  );
});

// --- GET /intents/:id (P5: no longer public) --------------------------------
// Closed per the P5 brief: this used to answer any caller with the full
// intent (including its `remainingBudget`). Three ways in now, same shape as
// every other owner-scoped route in this file: the operator path (loopback +
// admin header, full authority), the mandate's own owner via a SIWE session
// (404 for a real id owned by someone else — never confirms existence to a
// non-owner, same pattern as `GET /receipts/:id`), or the mandate's own agent
// key (what `apps/agent/scripts/attack.ts` and the scenarios harness use to
// read a mandate's task/budget before asking `/sign`).

app.get("/intents/:id", (c) => {
  const id = c.req.param("id");
  if (isLocalAdminRequest(c)) {
    const intent = getIntent(id);
    if (!intent) return c.json({ error: "intent_not_found" }, 404);
    return c.json(serializeIntent(intent));
  }

  const sessionAuth = authenticateSession(c);
  if (sessionAuth.ok) {
    const intent = getIntent(id);
    if (!intent || intent.signer.toLowerCase() !== sessionAuth.address.toLowerCase()) {
      return c.json({ error: "intent_not_found" }, 404);
    }
    return c.json(serializeIntent(intent));
  }

  const agentAuth = authenticateAgent(c, id);
  if (agentAuth.ok) return c.json(serializeIntent(agentAuth.mandate));

  // Neither path accepted a credential at all -> 401; a credential that
  // authenticates but names the wrong mandate -> 403 (authenticateAgent's
  // own mismatch signal, same as /sign's).
  return c.json(agentAuth.body, agentAuth.status);
});

// --- POST /intents/:id/revoke (WU13, WU-P3 owner path) ----------------------
// Permanent: no "unrevoke". Future `/sign` for this intent refuses through
// the existing `policy` check (pipeline.ts's `checkPolicy`) with reason
// "intent revoked"; a World ID approval already in flight for it is
// re-checked right before signing (approvals.ts) instead of slipping
// through late. Two ways in: the operator (loopback + admin header, full
// authority, unchanged since WU13) or the mandate's own owner via a SIWE
// session — which may only ever revoke a mandate it signed itself (403
// otherwise).

app.post("/intents/:id/revoke", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "intent_not_found" }, 404);

  if (!isLocalAdminRequest(c)) {
    const auth = authenticateSession(c);
    if (!auth.ok) return c.json(auth.body, auth.status);
    const target = getIntent(id);
    if (!target) return c.json({ error: "intent_not_found" }, 404);
    if (target.signer.toLowerCase() !== auth.address.toLowerCase()) {
      return c.json({ error: "forbidden" }, 403);
    }
  }

  const intent = revokeIntent(id);
  if (!intent) return c.json({ error: "intent_not_found" }, 404);
  const serialized = serializeIntent(intent);
  publish("intent.revoked", serialized);
  return c.json(serialized);
});

// --- Kill switch (WU13) ------------------------------------------------------

app.get("/control", requireLocalAdmin, (c) => c.json(getControlState()));

const pauseRequestSchema = z.object({ reason: z.string().min(1).optional() }).optional();

app.post("/control/pause", requireLocalAdmin, async (c) => {
  const body = await c.req.json().catch(() => undefined);
  const parsed = pauseRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_pause_request", issues: parsed.error.issues }, 400);
  }
  const control = setControlState(true, parsed.data?.reason);
  publish("control.changed", control);
  return c.json(control);
});

app.post("/control/resume", requireLocalAdmin, (c) => {
  const control = setControlState(false);
  publish("control.changed", control);
  return c.json(control);
});

// --- Per-owner pause (WU-P3) --------------------------------------------------
// A SIWE session's own kill switch — pauses every mandate that owner signed,
// independent of the global operator kill switch above (pipeline.ts's
// `checkPolicy` checks both, and approvals.ts re-checks both right before
// signing an approved World ID gate).

app.get("/me/control", (c) => {
  const auth = authenticateSession(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  return c.json(getOwnerControl(auth.address));
});

app.post("/me/pause", async (c) => {
  const auth = authenticateSession(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const body = await c.req.json().catch(() => undefined);
  const parsed = pauseRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_pause_request", issues: parsed.error.issues }, 400);
  }
  return c.json(setOwnerControl(auth.address, true, parsed.data?.reason));
});

app.post("/me/resume", (c) => {
  const auth = authenticateSession(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  return c.json(setOwnerControl(auth.address, false));
});

// --- GET /mandate (WU-P2) -----------------------------------------------------
// Lets an authenticated agent introspect what the human actually authorized —
// the MCP server's `get_mandate` tool is the first stop for any agent client.
// Same auth as `/sign`: an unknown, missing, or revoked-mandate key never
// reaches this handler's body.

app.get("/mandate", (c) => {
  const auth = authenticateAgent(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const mandate = auth.mandate;
  return c.json({
    id: mandate.id,
    task: mandate.message.task,
    budget: mandate.message.budget.toString(),
    remainingBudget: remainingBudget(mandate).toString(),
    categories: mandate.message.categories,
    expiry: mandate.message.expiry.toString(),
    revoked: mandate.revoked,
  });
});

// --- T1 one-line decision summary (odd/tasks/dokploy-deploy.md) -------------
// A receipt's own `reasons`/`timeline` already carry the full detail (WU9),
// but an operator tailing stdout during a team test shouldn't have to open
// the dashboard or fetch a receipt just to see what a `/sign` call decided —
// this maps the receipt's final `state` to the pipeline stage that actually
// decided it, one line, no secrets, no full payloads.
const STAGE_BY_RECEIPT_STATE: Partial<Record<DecisionReceipt["state"], string>> = {
  idempotent_hit: "idempotency",
  policy_rejected: "policy",
  merchant_blocked: "merchant",
  provenance_blocked: "provenance",
  intercepta_blocked: "intercepta",
  intercepta_escalated: "intercepta",
  jev_refused: "jev",
  jev_ask_human: "jev",
  awaiting_world_id: "world_id",
  world_id_denied: "world_id",
  world_id_expired: "world_id",
  paused: "control",
  sign_failed: "sign",
  signed: "sign",
  settled: "sign",
  settlement_failed: "sign",
  error: "pipeline",
};

function truncateReason(reason: string, max = 160): string {
  return reason.length > max ? `${reason.slice(0, max)}…` : reason;
}

function logSignDecision(receiptId: string, verdict: string, reason: string, stage: string): void {
  console.log(`[sign] receiptId=${receiptId} verdict=${verdict} stage=${stage} reason="${truncateReason(reason)}"`);
}

// --- POST /sign --------------------------------------------------------------

const signRequestSchema = z
  .object({
    // WU-P1: optional now — the authenticated mandate (Authorization header)
    // is authoritative. Still accepted so a caller can be explicit about
    // which intent it means; a mismatch against the authenticated mandate is
    // a 403, never a silent override.
    intentId: z.string().min(1).optional(),
    /** Base64 `PAYMENT-REQUIRED` header value, as decoded by the agent from the store's 402. */
    paymentRequiredHeader: z.string().min(1).optional(),
    /** Already-decoded `PaymentRequired` object, as an alternative to the header. */
    paymentRequired: z.unknown().optional(),
    resourceUrl: z.string().min(1),
    /** Free-form context for later pipeline layers (provenance/Jev, WU6/WU8). */
    context: z.record(z.string(), z.unknown()).optional(),
    /** WU: purchase ref — tells a NEW purchase of the same item apart from a
     * RETRY of the same purchase (pipeline.ts's file-header comment). Absent
     * -> pre-existing behavior, unchanged. */
    purchaseRef: purchaseRefSchema.optional(),
  })
  .refine((v) => v.paymentRequiredHeader !== undefined || v.paymentRequired !== undefined, {
    message: "either paymentRequiredHeader or paymentRequired is required",
  });

app.post("/sign", async (c) => {
  // P9.2: authenticate first — an unknown/invalid credential, or a revoked
  // wallet mandate, gets no validation details and never reaches the
  // pipeline. Accepts either the wallet mandate key (`yk_`, unchanged) or an
  // account key (`ya_`) — see `authenticateMandateCredential`.
  const preAuth = authenticateMandateCredential(c);
  if (!preAuth.ok) return c.json(preAuth.body, preAuth.status);

  const body = await c.req.json().catch(() => undefined);
  const parsed = signRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_sign_request", issues: parsed.error.issues }, 400);
  }
  const { paymentRequiredHeader, resourceUrl, context, purchaseRef } = parsed.data;

  const auth = authenticateMandateCredential(c, parsed.data.intentId);
  if (!auth.ok) return c.json(auth.body, auth.status);
  // An account key with no resolvable `intentId` (either omitted, or naming
  // a promise it doesn't own) never reaches here as `ok:true` without a
  // `mandate` — the account-key branch above only returns `mandate:
  // undefined` when `requestedIntentId` itself was undefined, which for
  // `/sign` means the caller never said which promise to pay from.
  if (!auth.mandate) {
    return c.json({ error: "intent_id_required" }, 400);
  }
  const intentId = auth.mandate.id;

  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = paymentRequiredHeader
      ? decodePaymentRequiredHeader(paymentRequiredHeader)
      : (parsed.data.paymentRequired as PaymentRequired);
  } catch (err) {
    return c.json(
      { error: "invalid_payment_required", message: err instanceof Error ? err.message : String(err) },
      400,
    );
  }

  // WU: purchase ref — this event's `paymentIdentifier` mirrors what the
  // receipt itself will display (the PURCHASE identifier), computed the
  // exact same way `runSignPipeline` does.
  const baseIdentifierForEvent = computePaymentIdentifier(intentId, paymentRequired.accepts?.[0], resourceUrl);
  publish("sign.requested", {
    intentId,
    resourceUrl,
    paymentIdentifier: computePurchaseIdentifier(baseIdentifierForEvent, purchaseRef),
  });

  // runSignPipeline is itself fail-closed end-to-end; this catch is a last
  // resort net so a bug here still never surfaces a `pay` verdict.
  try {
    const outcome = await runSignPipeline({ intentId, paymentRequired, resourceUrl, context, purchaseRef });
    // The pipeline already persisted the receipt; re-read it for its full
    // timeline so the dashboard gets one `stage.completed` event per stage
    // followed by the final `decision`, not just the terse HTTP response.
    const receipt = getReceipt(outcome.receiptId);
    if (receipt) {
      for (const entry of receipt.timeline) {
        publish("stage.completed", { receiptId: receipt.receiptId, ...entry });
      }
      publish("decision", receipt);
    }
    logSignDecision(outcome.receiptId, outcome.verdict, outcome.reason, (receipt && STAGE_BY_RECEIPT_STATE[receipt.state]) ?? "unknown");
    return c.json(outcome);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("sign pipeline error", err);
    logSignDecision("unavailable", "refuse", reason, "pipeline_error");
    return c.json({ verdict: "refuse", reason, receiptId: "unavailable" }, 200);
  }
});

// --- GET /receipts (WU-P3 owner-scoped) -------------------------------------
// Same operator-vs-owner split as `GET /intents` above.

app.get("/receipts", (c) => {
  const limitParam = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;
  if (isLocalAdminRequest(c)) return c.json(listReceipts(limit));
  const auth = authenticateSession(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  // dashboard-promises (D1): legacy wallet-signed intents this wallet signed,
  // union the promise ids of every account it linked as owner — a
  // promise-backed receipt's `intentId` never matches `intent.signer`
  // directly (see `listOwnedMandateIds`, store.ts).
  const ownedIntentIds = listOwnedMandateIds(auth.address);
  return c.json(listReceipts(limit).filter((r) => ownedIntentIds.has(r.intentId)));
});

// --- GET /receipts/:id (WU-P3 owner-scoped) ---------------------------------
// 401 for no/invalid session, 404 for a real receipt owned by someone else —
// never reveals whether a receipt id exists to a non-owner.

app.get("/receipts/:id", (c) => {
  const receipt = getReceipt(c.req.param("id"));
  if (!receipt) return c.json({ error: "receipt_not_found" }, 404);
  if (isLocalAdminRequest(c)) return c.json(receipt);
  const auth = authenticateSession(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  // dashboard-promises (D1) — same ownership set as `GET /receipts` above,
  // covers both a wallet-signed intent and a promise-backed one.
  if (!listOwnedMandateIds(auth.address).has(receipt.intentId)) {
    return c.json({ error: "receipt_not_found" }, 404);
  }
  return c.json(receipt);
});

// --- GET /owner/promises (dashboard-promises D1) ----------------------------
// The owner-session counterpart to `GET /promises` (account-key-scoped,
// P9.2 above): every promise across every account this wallet linked as
// owner at `/setup` (account-setup.ts's `linkOwner`), newest first. Same
// operator-vs-owner split as `GET /intents`/`GET /receipts`. Public fields
// only — no agent keys, no attestation internals (see `serializePromiseSummary`).

function serializeOwnerPromise(promise: StoredPromise, account: StoredAccount | undefined) {
  return {
    ...serializePromiseSummary(promise),
    accountId: promise.accountId,
    smartAccount: account?.smartAccount,
  };
}

app.get("/owner/promises", (c) => {
  if (isLocalAdminRequest(c)) {
    return c.json(listAllPromises().map((p) => serializeOwnerPromise(p, getAccount(p.accountId))));
  }
  const auth = authenticateSession(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const accounts = listAccountsByOwner(auth.address);
  const promises = accounts
    .flatMap((account) => listPromisesByAccount(account.id).map((p) => serializeOwnerPromise(p, account)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json(promises);
});

// --- POST /owner/promises/:id/revoke (P6) -------------------------------
// The owner-session counterpart to the account-key-scoped `POST
// /promises/:id/revoke` above (used by the MCP client) — lets the wallet
// that linked itself as a promise's account owner at `/setup` revoke it
// straight from the site, without holding that account's own key. Same
// 404-for-both shape as everywhere else in this file: an unknown promise id
// and one owned by a DIFFERENT wallet are indistinguishable.

app.post("/owner/promises/:id/revoke", (c) => {
  const auth = authenticateSession(c);
  if (!auth.ok) return c.json(auth.body, auth.status);
  const promise = revokeOwnerPromiseRequest(c.req.param("id"), auth.address);
  if (!promise) return c.json({ error: "promise_not_found" }, 404);
  return c.json(serializeOwnerPromise(promise, getAccount(promise.accountId)));
});

// --- GET /receipts/:id/attestation (WU12) -------------------------------
// Serves the StepUp EIP-712 attestation on its own, so a third party can
// fetch (and independently `verifyStepUpAttestation`) just the evidence,
// without pulling the whole receipt. 404 when this receipt never went
// through a valid World ID approval (no attestation exists to serve).

app.get("/receipts/:id/attestation", (c) => {
  const receipt = getReceipt(c.req.param("id"));
  const attestation = receipt?.worldId?.attestation;
  if (!attestation) return c.json({ error: "attestation_not_found" }, 404);
  return c.json(attestation);
});

// --- POST /receipts/:id/settlement ------------------------------------------

const settlementRequestSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex transaction hash"),
});

app.post("/receipts/:id/settlement", async (c) => {
  // P9.2: authenticate the credential itself first (any valid wallet key or
  // account key) — same "an invalid credential never learns whether the
  // receipt exists" ordering the original wallet-only check used.
  const preAuth = authenticateMandateCredential(c);
  if (!preAuth.ok) return c.json(preAuth.body, preAuth.status);

  const id = c.req.param("id");
  const body = await c.req.json().catch(() => undefined);
  const parsed = settlementRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_settlement", issues: parsed.error.issues }, 400);
  }

  const receipt = getReceipt(id);
  if (!receipt) return c.json({ error: "receipt_not_found" }, 404);

  // Only the receipt's own mandate may report its settlement — resolve
  // ownership against the receipt's ACTUAL `intentId`: a wallet key must BE
  // that mandate, an account key must OWN that promise.
  const auth = authenticateMandateCredential(c, receipt.intentId);
  if (!auth.ok) return c.json(auth.body, auth.status);
  if (!auth.mandate || receipt.intentId !== auth.mandate.id) return c.json({ error: "forbidden" }, 403);
  if (receipt.verdict !== "pay") {
    return c.json({ error: "not_a_pay_receipt", verdict: receipt.verdict }, 400);
  }

  let newState;
  try {
    newState = transition(receipt.state, "settled");
  } catch (err) {
    return c.json(
      { error: "invalid_state_for_settlement", state: receipt.state, message: err instanceof Error ? err.message : String(err) },
      409,
    );
  }

  const updated: DecisionReceipt = {
    ...receipt,
    state: newState,
    settlement: { txHash: parsed.data.txHash, network: X402_NETWORK, reportedAt: new Date().toISOString() },
  };
  saveReceipt(updated);
  publish("settlement.reported", updated);
  return c.json(updated);
});

// --- GET /approvals/:receiptId (WU11, WU-P1 auth) -----------------------------

app.get("/approvals/:receiptId", (c) => {
  // The legacy plain `/dashboard` (WU10/WU13) polls this route as a local
  // admin, not as the agent that owns the mandate — same
  // `isLocalAdminRequest` identity it already uses for pause/resume/revoke.
  if (isLocalAdminRequest(c)) {
    const approval = getPendingApprovalByReceiptId(c.req.param("receiptId"));
    if (!approval) return c.json({ error: "approval_not_found" }, 404);
    return c.json(approvalStatusResponse(approval));
  }

  // P6: the site's `/app/dashboard` runs on a different origin, so it's never
  // a loopback+admin request — it needs its own way in. A SIWE session reads
  // the World ID approval card for a receipt it owns, same "own session or
  // own agent key" split (and the same 404-on-mismatch, never a 403, to
  // avoid confirming another owner's receipt exists) as `GET /receipts/:id`
  // above. Every other caller (the agent itself, e.g. approvals.test.ts's
  // callers and apps/agent's polling) still needs the mandate's own key.
  const sessionAuth = authenticateSession(c);
  if (sessionAuth.ok) {
    const approval = getPendingApprovalByReceiptId(c.req.param("receiptId"));
    if (!approval) return c.json({ error: "approval_not_found" }, 404);
    // dashboard-promises (D1) — same ownership set as `GET /receipts` above,
    // so a promise-backed approval (its `intentId` is a promise id, never a
    // real wallet signer) shows up for its account's linked owner too.
    if (!listOwnedMandateIds(sessionAuth.address).has(approval.intentId)) {
      return c.json({ error: "approval_not_found" }, 404);
    }
    return c.json(approvalStatusResponse(approval));
  }

  // P9.2: the wallet mandate key path above is untouched; a caller
  // presenting an account key instead reads any approval belonging to a
  // promise that account owns.
  const preAuth = authenticateMandateCredential(c);
  if (!preAuth.ok) return c.json(preAuth.body, preAuth.status);
  const approval = getPendingApprovalByReceiptId(c.req.param("receiptId"));
  if (!approval) return c.json({ error: "approval_not_found" }, 404);
  const auth = authenticateMandateCredential(c, approval.intentId);
  // P9: a credential that's otherwise valid (checked by `preAuth` above) but
  // doesn't own THIS approval's mandate used to answer 403 forbidden — a
  // different, distinguishable shape from the 404 above for "doesn't exist
  // at all". Collapse both into the exact same 404, same reasoning as the
  // session-owner branch just above (and `GET /receipts/:id`): a caller can
  // never tell "exists but isn't yours" apart from "never existed".
  if (!auth.ok || !auth.mandate || approval.intentId !== auth.mandate.id) {
    return c.json({ error: "approval_not_found" }, 404);
  }
  return c.json(approvalStatusResponse(approval));
});

// --- GET /events (SSE, WU-P3 owner-scoped) ------------------------------------
// `EventSource` can't send an `Authorization` header, so both auth paths ride
// the query string: `?admin=1` (+ loopback) for the unfiltered operator
// dashboard stream, unchanged from WU9; `?session=<token>` for a wallet
// owner's own stream, filtered to only the events that belong to its mandates.

/** dashboard-promises (D1) — resolves the owning wallet address for ANY
 * mandate id, wallet-signed or promise-backed: a wallet intent's own
 * `signer`, or a world_id promise's linked account owner (`resolveMandate`'s
 * `source`/`accountId`, promises.ts's `promiseAsMandate`). `undefined` when
 * the mandate doesn't exist, or a promise's account has no linked owner yet
 * (documented limitation, odd/tasks/dashboard-promises.md). */
function mandateOwnerAddress(intentId: string): string | undefined {
  const mandate = resolveMandate(intentId);
  if (!mandate) return undefined;
  if (mandate.source === "world_id") {
    return mandate.accountId ? getAccount(mandate.accountId)?.owner : undefined;
  }
  return mandate.signer;
}

/** Resolves the owning wallet address for one firewall event, or `undefined`
 * when the event has no single owner (`control.changed`, the global kill
 * switch) or its owner can't be resolved. Every event either carries the
 * intent's `signer` (`intent.created`/`intent.revoked`) or an accountId
 * (`promise.*`) directly, or a receiptId/intentId this looks up through the
 * store via `mandateOwnerAddress`. */
function eventOwnerAddress(evt: FirewallEvent): string | undefined {
  const payload = evt.payload as Record<string, unknown> | undefined;
  switch (evt.event) {
    case "intent.created":
    case "intent.revoked":
      return typeof payload?.signer === "string" ? payload.signer : undefined;
    case "promise.requested":
    case "promise.approved":
    case "promise.denied": {
      const accountId = payload?.accountId;
      return typeof accountId === "string" ? getAccount(accountId)?.owner : undefined;
    }
    case "decision":
    case "settlement.reported":
    case "sign.requested": {
      const intentId = payload?.intentId;
      return typeof intentId === "string" ? mandateOwnerAddress(intentId) : undefined;
    }
    case "stage.completed":
    case "approval.requested":
    case "approval.resolved": {
      const receiptId = payload?.receiptId;
      if (typeof receiptId !== "string") return undefined;
      const receipt = getReceipt(receiptId);
      return receipt ? mandateOwnerAddress(receipt.intentId) : undefined;
    }
    default:
      return undefined; // e.g. "control.changed" — the global kill switch has no single owner
  }
}

app.get("/events", (c) => {
  const adminRequest = isLocalAdminEventsRequest(c);
  let ownerAddress: string | undefined;
  if (!adminRequest) {
    const token = c.req.query("session");
    const session = token ? getSessionByToken(token) : undefined;
    if (!session) return c.json({ error: "unauthorized" }, 401);
    ownerAddress = session.address.toLowerCase();
  }

  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribe((evt) => {
      if (ownerAddress && eventOwnerAddress(evt)?.toLowerCase() !== ownerAddress) return;
      void stream.writeSSE({ data: JSON.stringify(evt.payload), event: evt.event, id: evt.id });
    });
    stream.onAbort(unsubscribe);
    // Write a first frame right away so clients see the stream open without
    // waiting for the first 15 s heartbeat.
    await stream.writeSSE({ event: "heartbeat", data: "", id: crypto.randomUUID() });
    while (!stream.aborted) {
      await stream.sleep(SSE_HEARTBEAT_MS);
      if (!stream.aborted) {
        await stream.writeSSE({ event: "heartbeat", data: "", id: crypto.randomUUID() });
      }
    }
  });
});

// --- Dev account-health seam (OMAMORISAN_ACCOUNT_READER=stub) ----------------
//
// Off unless the funding stage's reader is itself stubbed (funding.ts) —
// gated on that same env var rather than `OMAMORISAN_DEV_APPROVALS`, since
// this is a different concern (fake on-chain account state, not a fake World
// ID approval): it exists ONLY so scenarios.ts can deterministically drive
// every funding refusal (paused/recipient/limit/balance) without a real
// deployed contract. Never set `OMAMORISAN_ACCOUNT_READER=stub` on the live
// :4001 firewall. Same operator-only bar as every other dev/admin route
// (`requireLocalAdmin` — loopback + the fixed `x-yakusoku-admin` header).
if (process.env.OMAMORISAN_ACCOUNT_READER === "stub") {
  console.warn(
    "[SECURITY] OMAMORISAN_ACCOUNT_READER=stub — the fake account-health dev seam is ENABLED on this process. " +
      "Never set this on the live demo firewall (:4001).",
  );

  const accountHealthSchema = z.object({
    paused: z.boolean().optional(),
    recipientAllowed: z.boolean().optional(),
    /** Decimal USDC strings (site contract convention), e.g. "0.5" — never atomic units. */
    perPaymentLimitUsdc: z.string().optional(),
    balanceUsdc: z.string().optional(),
  });

  app.post("/dev/accounts/:id/health", async (c) => {
    if (!isLocalAdminRequest(c)) return c.json({ error: "forbidden" }, 403);
    const account = getAccount(c.req.param("id"));
    if (!account) return c.json({ error: "account_not_found" }, 404);
    const body = await c.req.json().catch(() => undefined);
    const parsed = accountHealthSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_account_health_request", issues: parsed.error.issues }, 400);

    const toAtomic = (usdc: string | undefined) =>
      usdc === undefined ? undefined : BigInt(Math.round(Number(usdc) * 10 ** USDC_DECIMALS));
    setAccountHealthOverride(account.id, {
      paused: parsed.data.paused,
      recipientAllowed: parsed.data.recipientAllowed,
      perPaymentLimitAtomic: toAtomic(parsed.data.perPaymentLimitUsdc),
      balanceAtomic: toAtomic(parsed.data.balanceUsdc),
    });
    return c.json({ ok: true });
  });
}

// --- Dev approval seam (OMAMORISAN_DEV_APPROVALS=1) --------------------------
//
// Off by default. Exists ONLY so the scenarios' isolated firewall
// (scripts/scenarios.ts) can exercise the paid path behind a world_id
// promise without a real phone — never set this on the live :4001 firewall.
// Gated on BOTH the env var (checked once here, at boot, so the routes don't
// even exist unless it's on) and `requireLocalAdmin` (loopback + the fixed
// `x-yakusoku-admin` header) per-request, same operator-only bar as
// `/control/pause`. Every attestation minted through this path carries
// `acr: "dev"`, never `orb-v3` — nothing genuine.
if (process.env.OMAMORISAN_DEV_APPROVALS === "1") {
  console.warn(
    "[SECURITY] OMAMORISAN_DEV_APPROVALS=1 — the fabricated-approval dev seam is ENABLED on this process. " +
      "Never set this on the live demo firewall (:4001).",
  );

  const devApproveSchema = z.object({ subject: z.string().min(1) });

  // `isLocalAdminRequest` called directly (rather than as the
  // `requireLocalAdmin` middleware) so Hono keeps inferring `:id` as `string`
  // from the literal path pattern on these routes.
  app.post("/dev/connect/:id/approve", async (c) => {
    if (!isLocalAdminRequest(c)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => undefined);
    const parsed = devApproveSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_dev_approve_request", issues: parsed.error.issues }, 400);
    const result = await devApproveConnect(c.req.param("id"), parsed.data.subject);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.post("/dev/promises/:id/approve", async (c) => {
    if (!isLocalAdminRequest(c)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => undefined);
    const parsed = devApproveSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_dev_approve_request", issues: parsed.error.issues }, 400);
    const result = await devApprovePromise(c.req.param("id"), parsed.data.subject);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  // P9.6 — same dev-only fabricated-approval seam for the combined
  // account+promise gate.
  app.post("/dev/promises/first/:id/approve", async (c) => {
    if (!isLocalAdminRequest(c)) return c.json({ error: "forbidden" }, 403);
    const body = await c.req.json().catch(() => undefined);
    const parsed = devApproveSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_dev_approve_request", issues: parsed.error.issues }, 400);
    const result = await devApproveFirstPromise(c.req.param("id"), parsed.data.subject);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });
}

// Resume any World ID approval left pending by a previous process (crash or
// `--watch` restart) — approvals.ts fails closed (expires + releases budget)
// for any row whose deadline already passed while the firewall was down.
resumePendingApprovalsOnBoot();
// Same resumability for a connect request (accounts.ts) or a promise
// approval (promises.ts) left pending across a restart.
resumeConnectRequestsOnBoot();
resumePromiseApprovalsOnBoot();
resumeFirstPromiseApprovalsOnBoot();

console.log(`Omamorisan firewall listening on :${PORT}`);

// WU10 fix: Bun's default HTTP idleTimeout is 10s, shorter than the SSE
// heartbeat above (15s) — every /events connection was silently killed by
// Bun before its first heartbeat could keep it alive, so the dashboard's
// EventSource looped connect -> ~10s alive -> reconnect forever instead of
// staying live. Raise it well past SSE_HEARTBEAT_MS.
export default { port: PORT, fetch: app.fetch, idleTimeout: 60 };
