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
import { signedTaskIntentSchema, transition, X402_NETWORK, type DecisionReceipt } from "@yakusoku/shared";
import {
  createIntent,
  createNonce,
  createSession,
  findIntentByAgentKey,
  getControlState,
  getIntent,
  getOwnerControl,
  getPendingApprovalByReceiptId,
  getReceipt,
  getSessionByToken,
  listIntents,
  listReceipts,
  remainingBudget,
  revokeIntent,
  revokeSession,
  saveReceipt,
  setControlState,
  setOwnerControl,
  type StoredIntent,
} from "./store";
import { extractBearerToken } from "./auth";
import { verifyTaskIntentSignature } from "./signer";
import { verifySiweSignIn } from "./siwe";
import { computePaymentIdentifier, runSignPipeline } from "./pipeline";
import { approvalStatusResponse, resumePendingApprovalsOnBoot } from "./approvals";
import { publish, subscribe, type FirewallEvent } from "./events-bus";

const PORT = Number(process.env.PORT) || 4001;
const SSE_HEARTBEAT_MS = 15_000;

const app = new Hono();

// --- CORS (WU-P3) ------------------------------------------------------------
// The site (a separate origin) needs the Authorization header for session
// Bearer calls; the dashboard is same-origin (served off this same process)
// so it never goes through CORS at all. Env-configurable so a deployed site
// origin doesn't require a code change.
const SITE_ORIGINS = (process.env.OMAMORISAN_SITE_ORIGINS ?? "http://localhost:4321")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use("/*", cors({ origin: SITE_ORIGINS, allowHeaders: ["Content-Type", "Authorization", "x-yakusoku-admin"] }));

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

// --- GET /intents/:id ----------------------------------------------------

app.get("/intents/:id", (c) => {
  const intent = getIntent(c.req.param("id"));
  if (!intent) return c.json({ error: "intent_not_found" }, 404);
  return c.json(serializeIntent(intent));
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
  })
  .refine((v) => v.paymentRequiredHeader !== undefined || v.paymentRequired !== undefined, {
    message: "either paymentRequiredHeader or paymentRequired is required",
  });

app.post("/sign", async (c) => {
  // WU-P1: authenticate first — an unknown, missing, or revoked-mandate key
  // gets no validation details and never reaches the pipeline.
  const preAuth = authenticateAgent(c);
  if (!preAuth.ok) return c.json(preAuth.body, preAuth.status);

  const body = await c.req.json().catch(() => undefined);
  const parsed = signRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_sign_request", issues: parsed.error.issues }, 400);
  }
  const { paymentRequiredHeader, resourceUrl, context } = parsed.data;

  const auth = authenticateAgent(c, parsed.data.intentId);
  if (!auth.ok) return c.json(auth.body, auth.status);
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

  publish("sign.requested", {
    intentId,
    resourceUrl,
    paymentIdentifier: computePaymentIdentifier(intentId, paymentRequired.accepts?.[0], resourceUrl),
  });

  // runSignPipeline is itself fail-closed end-to-end; this catch is a last
  // resort net so a bug here still never surfaces a `pay` verdict.
  try {
    const outcome = await runSignPipeline({ intentId, paymentRequired, resourceUrl, context });
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
    return c.json(outcome);
  } catch (err) {
    console.error("sign pipeline error", err);
    return c.json(
      { verdict: "refuse", reason: err instanceof Error ? err.message : String(err), receiptId: "unavailable" },
      200,
    );
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
  const owner = auth.address.toLowerCase();
  const ownedIntentIds = new Set(
    listIntents()
      .filter((i) => i.signer.toLowerCase() === owner)
      .map((i) => i.id),
  );
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
  const intent = getIntent(receipt.intentId);
  if (!intent || intent.signer.toLowerCase() !== auth.address.toLowerCase()) {
    return c.json({ error: "receipt_not_found" }, 404);
  }
  return c.json(receipt);
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
  // Only the mandate's own agent may report its settlement.
  const auth = authenticateAgent(c);
  if (!auth.ok) return c.json(auth.body, auth.status);

  const id = c.req.param("id");
  const body = await c.req.json().catch(() => undefined);
  const parsed = settlementRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_settlement", issues: parsed.error.issues }, 400);
  }

  const receipt = getReceipt(id);
  if (!receipt) return c.json({ error: "receipt_not_found" }, 404);
  if (receipt.intentId !== auth.mandate.id) return c.json({ error: "forbidden" }, 403);
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
  // The dashboard (WU10/WU13) also polls this route to show live approval
  // status for any receipt — as a local admin, not as the agent that owns
  // the mandate — so it authenticates the same way it already does for
  // pause/resume/revoke (`isLocalAdminRequest`) instead of a Bearer token.
  // Every other caller (the agent itself) needs the mandate's own key.
  if (!isLocalAdminRequest(c)) {
    const auth = authenticateAgent(c);
    if (!auth.ok) return c.json(auth.body, auth.status);
    const approval = getPendingApprovalByReceiptId(c.req.param("receiptId"));
    if (!approval) return c.json({ error: "approval_not_found" }, 404);
    if (approval.intentId !== auth.mandate.id) return c.json({ error: "forbidden" }, 403);
    return c.json(approvalStatusResponse(approval));
  }

  const approval = getPendingApprovalByReceiptId(c.req.param("receiptId"));
  if (!approval) return c.json({ error: "approval_not_found" }, 404);
  return c.json(approvalStatusResponse(approval));
});

// --- GET /events (SSE, WU-P3 owner-scoped) ------------------------------------
// `EventSource` can't send an `Authorization` header, so both auth paths ride
// the query string: `?admin=1` (+ loopback) for the unfiltered operator
// dashboard stream, unchanged from WU9; `?session=<token>` for a wallet
// owner's own stream, filtered to only the events that belong to its mandates.

/** Resolves the owning wallet address for one firewall event, or `undefined`
 * when the event has no single owner (`control.changed`, the global kill
 * switch) or its owner can't be resolved. Every event either carries the
 * intent's `signer` directly (`intent.created`/`intent.revoked`) or a
 * receiptId/intentId this looks up through the store. */
function eventOwnerAddress(evt: FirewallEvent): string | undefined {
  const payload = evt.payload as Record<string, unknown> | undefined;
  switch (evt.event) {
    case "intent.created":
    case "intent.revoked":
      return typeof payload?.signer === "string" ? payload.signer : undefined;
    case "decision":
    case "settlement.reported":
    case "sign.requested": {
      const intentId = payload?.intentId;
      return typeof intentId === "string" ? getIntent(intentId)?.signer : undefined;
    }
    case "stage.completed":
    case "approval.requested":
    case "approval.resolved": {
      const receiptId = payload?.receiptId;
      if (typeof receiptId !== "string") return undefined;
      const receipt = getReceipt(receiptId);
      return receipt ? getIntent(receipt.intentId)?.signer : undefined;
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
    while (!stream.aborted) {
      await stream.sleep(SSE_HEARTBEAT_MS);
      if (!stream.aborted) {
        await stream.writeSSE({ event: "heartbeat", data: "", id: crypto.randomUUID() });
      }
    }
  });
});

// Resume any World ID approval left pending by a previous process (crash or
// `--watch` restart) — approvals.ts fails closed (expires + releases budget)
// for any row whose deadline already passed while the firewall was down.
resumePendingApprovalsOnBoot();

console.log(`Omamorisan firewall listening on :${PORT}`);

// WU10 fix: Bun's default HTTP idleTimeout is 10s, shorter than the SSE
// heartbeat above (15s) — every /events connection was silently killed by
// Bun before its first heartbeat could keep it alive, so the dashboard's
// EventSource looped connect -> ~10s alive -> reconnect forever instead of
// staying live. Raise it well past SSE_HEARTBEAT_MS.
export default { port: PORT, fetch: app.fetch, idleTimeout: 60 };
