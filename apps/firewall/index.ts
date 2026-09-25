// Yakusoku firewall — the only process holding the signing key. Verifies
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
  getControlState,
  getIntent,
  getPendingApprovalByReceiptId,
  getReceipt,
  listIntents,
  listReceipts,
  remainingBudget,
  revokeIntent,
  saveReceipt,
  setControlState,
  type StoredIntent,
} from "./store";
import { verifyTaskIntentSignature } from "./signer";
import { computePaymentIdentifier, runSignPipeline } from "./pipeline";
import { approvalStatusResponse, resumePendingApprovalsOnBoot } from "./approvals";
import { publish, subscribe } from "./events-bus";

const PORT = Number(process.env.PORT) || 4001;
const SSE_HEARTBEAT_MS = 15_000;

const app = new Hono();
app.use("/*", cors());

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
function requireLocalAdmin(c: Context, next: Next) {
  const address = getConnInfo(c).remote.address ?? "";
  const isLoopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
  if (!isLoopback || c.req.header("x-yakusoku-admin") !== "1") {
    return c.json({ error: "forbidden" }, 403);
  }
  return next();
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

  const intent = createIntent(message, signature as Hex, signer as Hex);
  publish("intent.created", serializeIntent(intent));
  return c.json({ id: intent.id, remainingBudget: remainingBudget(intent).toString() }, 201);
});

// --- GET /intents ----------------------------------------------------------

app.get("/intents", (c) => c.json(listIntents().map(serializeIntent)));

// --- GET /intents/:id ----------------------------------------------------

app.get("/intents/:id", (c) => {
  const intent = getIntent(c.req.param("id"));
  if (!intent) return c.json({ error: "intent_not_found" }, 404);
  return c.json(serializeIntent(intent));
});

// --- POST /intents/:id/revoke (WU13) ----------------------------------------
// Permanent: no "unrevoke". Future `/sign` for this intent refuses through
// the existing `policy` check (pipeline.ts's `checkPolicy`) with reason
// "intent revoked"; a World ID approval already in flight for it is
// re-checked right before signing (approvals.ts) instead of slipping
// through late.

app.post("/intents/:id/revoke", requireLocalAdmin, (c) => {
  // The untyped `Context` in `requireLocalAdmin`'s signature widens Hono's
  // route-param inference here, so `param("id")` types as possibly
  // undefined even though the route can't match without it.
  const id = c.req.param("id");
  const intent = id ? revokeIntent(id) : undefined;
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

// --- POST /sign --------------------------------------------------------------

const signRequestSchema = z
  .object({
    intentId: z.string().min(1),
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
  const body = await c.req.json().catch(() => undefined);
  const parsed = signRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_sign_request", issues: parsed.error.issues }, 400);
  }
  const { intentId, paymentRequiredHeader, resourceUrl, context } = parsed.data;

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

// --- GET /receipts -----------------------------------------------------------

app.get("/receipts", (c) => {
  const limitParam = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;
  return c.json(listReceipts(limit));
});

// --- GET /receipts/:id ---------------------------------------------------

app.get("/receipts/:id", (c) => {
  const receipt = getReceipt(c.req.param("id"));
  if (!receipt) return c.json({ error: "receipt_not_found" }, 404);
  return c.json(receipt);
});

// --- POST /receipts/:id/settlement ------------------------------------------

const settlementRequestSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex transaction hash"),
});

app.post("/receipts/:id/settlement", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => undefined);
  const parsed = settlementRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_settlement", issues: parsed.error.issues }, 400);
  }

  const receipt = getReceipt(id);
  if (!receipt) return c.json({ error: "receipt_not_found" }, 404);
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

// --- GET /approvals/:receiptId (WU11) -----------------------------------------

app.get("/approvals/:receiptId", (c) => {
  const approval = getPendingApprovalByReceiptId(c.req.param("receiptId"));
  if (!approval) return c.json({ error: "approval_not_found" }, 404);
  return c.json(approvalStatusResponse(approval));
});

// --- GET /events (SSE) --------------------------------------------------------

app.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    const unsubscribe = subscribe((evt) => {
      void stream.writeSSE({ data: JSON.stringify(evt.payload), event: evt.event, id: evt.id });
    });
    stream.onAbort(unsubscribe);
    while (!stream.aborted) {
      await stream.sleep(SSE_HEARTBEAT_MS);
      if (!stream.aborted) {
        await stream.writeSSE({ event: "heartbeat", data: "", id: crypto.randomUUID() });
      }
    }
  }),
);

// Resume any World ID approval left pending by a previous process (crash or
// `--watch` restart) — approvals.ts fails closed (expires + releases budget)
// for any row whose deadline already passed while the firewall was down.
resumePendingApprovalsOnBoot();

console.log(`Yakusoku firewall listening on :${PORT}`);

// WU10 fix: Bun's default HTTP idleTimeout is 10s, shorter than the SSE
// heartbeat above (15s) — every /events connection was silently killed by
// Bun before its first heartbeat could keep it alive, so the dashboard's
// EventSource looped connect -> ~10s alive -> reconnect forever instead of
// staying live. Raise it well past SSE_HEARTBEAT_MS.
export default { port: PORT, fetch: app.fetch, idleTimeout: 60 };
