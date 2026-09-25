// Yakusoku firewall — the only process holding the signing key. Verifies
// signed TaskIntents, runs the pre-signature decision pipeline, and signs
// x402 payments on the agent's behalf (root CLAUDE.md, plan-tecnico.md §2).

import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { Hex } from "viem";
import { signedTaskIntentSchema } from "@yakusoku/shared";
import { createIntent, getIntent, getReceipt, remainingBudget, type StoredIntent } from "./store";
import { verifyTaskIntentSignature } from "./signer";
import { runSignPipeline } from "./pipeline";

const PORT = Number(process.env.PORT) || 4001;

const app = new Hono();
app.use("/*", cors());

app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "internal_error", message: err instanceof Error ? err.message : String(err) }, 500);
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
  };
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
  return c.json({ id: intent.id, remainingBudget: remainingBudget(intent).toString() }, 201);
});

// --- GET /intents/:id ----------------------------------------------------

app.get("/intents/:id", (c) => {
  const intent = getIntent(c.req.param("id"));
  if (!intent) return c.json({ error: "intent_not_found" }, 404);
  return c.json(serializeIntent(intent));
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

  // runSignPipeline is itself fail-closed end-to-end; this catch is a last
  // resort net so a bug here still never surfaces a `pay` verdict.
  try {
    const outcome = await runSignPipeline({ intentId, paymentRequired, resourceUrl, context });
    return c.json(outcome);
  } catch (err) {
    console.error("sign pipeline error", err);
    return c.json(
      { verdict: "refuse", reason: err instanceof Error ? err.message : String(err), receiptId: "unavailable" },
      200,
    );
  }
});

// --- GET /receipts/:id ---------------------------------------------------

app.get("/receipts/:id", (c) => {
  const receipt = getReceipt(c.req.param("id"));
  if (!receipt) return c.json({ error: "receipt_not_found" }, 404);
  return c.json(receipt);
});

console.log(`Yakusoku firewall listening on :${PORT}`);

export default { port: PORT, fetch: app.fetch };
