// The core decision pipeline (plan-tecnico.md §2.3):
//   idempotency -> policy -> provenance -> Intercepta -> Jev -> World ID -> sign
// Every branch is fail-closed (plan-tecnico.md §2.4): any doubt or error
// produces `refuse`/`ask_human`, never `pay`. Provenance/Intercepta/Jev/World
// ID are pass-through stubs for WU3 — see PASS_THROUGH_STAGES below for the
// plug-in point WU6-WU11 replace them at.

import { createHash } from "node:crypto";
import type { PaymentRequired } from "@x402/core/types";
import {
  paymentRequirementSchema,
  transition,
  USDC_SEPOLIA_ADDRESS,
  X402_NETWORK,
  type DecisionReceipt,
  type PaymentRequirement,
  type ReceiptState,
  type Verdict,
} from "@yakusoku/shared";
import { provenanceStage } from "./provenance";
import {
  cacheSignOutcome,
  getCachedSignOutcome,
  getIntent,
  recordSpend,
  saveReceipt,
  type StoredIntent,
} from "./store";
import { signPayment } from "./signer";

export interface SignRequest {
  intentId: string;
  paymentRequired: PaymentRequired;
  resourceUrl: string;
  /** Free-form context the agent supplies for later layers (provenance/Jev). */
  context?: Record<string, unknown>;
}

export interface PipelineOutcome {
  verdict: Verdict;
  reason: string;
  receiptId: string;
  paymentSignature?: string;
}

// --- Pipeline stage plug-in point (WU6-WU11) --------------------------------

export interface StageContext {
  intent: StoredIntent;
  requirement: PaymentRequirement;
  paymentRequired: PaymentRequired;
  resourceUrl: string;
  context?: Record<string, unknown>;
}

export type StageVerdict =
  | { outcome: "pass" }
  | { outcome: "refuse" | "ask_human"; state: ReceiptState; reason: string };

export interface PipelineStage {
  name: string;
  run(ctx: StageContext): Promise<StageVerdict> | StageVerdict;
}

/**
 * Ordered stages. Each pass-through stub still resolves `{ outcome: "pass" }`
 * for now; a real implementation swaps the `run` function in place (same
 * `PipelineStage` shape, same position in the array) without touching
 * `runSignPipeline` below:
 * - WU6 provenance -> real (deterministic recipient-traceability check, see provenance.ts)
 * - WU7 Intercepta -> `"intercepta_blocked"` / `"intercepta_escalated"` (fail-closed on timeout/error)
 * - WU8 Jev        -> `"jev_refused"` / `"jev_ask_human"`
 * - WU11 World ID  -> `"world_id_denied"` / `"world_id_expired"` (real async human-approval wait)
 */
export const PASS_THROUGH_STAGES: PipelineStage[] = [
  provenanceStage,
  { name: "intercepta", run: () => ({ outcome: "pass" }) }, // TODO(WU7): address/token screening
  { name: "jev", run: () => ({ outcome: "pass" }) }, // TODO(WU8): semantic intent match
  { name: "world_id", run: () => ({ outcome: "pass" }) }, // TODO(WU11): human approval gate
];

// --- Idempotency -------------------------------------------------------------

/**
 * Deterministic id for "this exact payment request": same intentId + same
 * payment requirement + same resource always hashes to the same id, so a
 * verbatim retry of a `/sign` request is naturally idempotent without the
 * agent having to supply its own key. This id also travels onward as the
 * x402 `payment-identifier` extension value (signer.ts), so the store's own
 * settlement cache (WU2) recognizes the exact same payment.
 *
 * Deviation from the extension's general "client-supplied id" semantics
 * (ref-x402.md §1.3): here the firewall derives the id itself, so "same id,
 * different payload" is structurally unreachable — acceptable for WU3, where
 * the only actor calling `/sign` is the trusted agent process, not an
 * untrusted third party choosing its own id.
 */
export function computePaymentIdentifier(intentId: string, accepts0: unknown, resourceUrl: string): string {
  const r = (accepts0 ?? {}) as Partial<PaymentRequirement>;
  const parts = [intentId, r.scheme, r.network, r.amount, r.asset, r.payTo, resourceUrl].map((v) => String(v ?? ""));
  const hash = createHash("sha256").update(parts.join("|")).digest("hex");
  return `pay_${hash}`;
}

// --- Policy --------------------------------------------------------------

function checkPolicy(
  intent: StoredIntent | undefined,
  requirement: PaymentRequirement,
): { ok: true } | { ok: false; reason: string } {
  if (!intent) return { ok: false, reason: "unknown intentId" };
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  if (intent.message.expiry <= nowSeconds) return { ok: false, reason: "intent expired" };
  if (requirement.network !== X402_NETWORK) {
    return { ok: false, reason: `unsupported network: ${requirement.network}` };
  }
  if (requirement.asset.toLowerCase() !== USDC_SEPOLIA_ADDRESS.toLowerCase()) {
    return { ok: false, reason: `unsupported asset: ${requirement.asset}` };
  }
  const amount = BigInt(requirement.amount);
  const remaining = intent.message.budget - intent.spent;
  if (amount > remaining) {
    return { ok: false, reason: `amount ${amount} exceeds remaining budget ${remaining}` };
  }
  return { ok: true };
}

// --- Receipts --------------------------------------------------------------

function buildReceipt(input: {
  paymentIdentifier: string;
  intentId: string;
  state: ReceiptState;
  verdict: Verdict;
  reason: string;
}): DecisionReceipt {
  return {
    receiptId: `receipt_${crypto.randomUUID()}`,
    paymentIdentifier: input.paymentIdentifier,
    intentId: input.intentId,
    createdAt: new Date().toISOString(),
    state: input.state,
    verdict: input.verdict,
    reasons: [input.reason],
  };
}

function finalize(input: {
  paymentIdentifier: string;
  intentId: string;
  state: ReceiptState;
  verdict: Verdict;
  reason: string;
  paymentSignature?: string;
  cache: boolean;
}): PipelineOutcome {
  const receipt = buildReceipt(input);
  saveReceipt(receipt);
  if (input.cache) {
    cacheSignOutcome(input.paymentIdentifier, {
      verdict: input.verdict,
      reason: input.reason,
      paymentSignature: input.paymentSignature,
    });
  }
  return {
    verdict: input.verdict,
    reason: input.reason,
    receiptId: receipt.receiptId,
    paymentSignature: input.paymentSignature,
  };
}

// --- Orchestration -----------------------------------------------------------

async function runSignPipelineInner(req: SignRequest, paymentIdentifier: string): Promise<PipelineOutcome> {
  const cached = getCachedSignOutcome(paymentIdentifier);
  if (cached) {
    return finalize({
      paymentIdentifier,
      intentId: req.intentId,
      state: transition("initial", "idempotent_hit"),
      verdict: cached.verdict,
      reason: `idempotent replay of a previously processed payment (${cached.reason})`,
      paymentSignature: cached.paymentSignature,
      cache: false, // already cached under this id
    });
  }

  const accepts0 = req.paymentRequired.accepts?.[0];
  const requirementResult = paymentRequirementSchema.safeParse(accepts0);
  if (!requirementResult.success) {
    return finalize({
      paymentIdentifier,
      intentId: req.intentId,
      state: transition("initial", "policy_rejected"),
      verdict: "refuse",
      reason: `malformed payment requirement: ${requirementResult.error.message}`,
      cache: true,
    });
  }
  const requirement = requirementResult.data;

  const intent = getIntent(req.intentId);
  const policyResult = checkPolicy(intent, requirement);
  if (!policyResult.ok) {
    return finalize({
      paymentIdentifier,
      intentId: req.intentId,
      state: transition("initial", "policy_rejected"),
      verdict: "refuse",
      reason: policyResult.reason,
      cache: true,
    });
  }
  // policyResult.ok guarantees `intent` is defined (checkPolicy's first check).
  const stageCtx: StageContext = {
    intent: intent as StoredIntent,
    requirement,
    paymentRequired: req.paymentRequired,
    resourceUrl: req.resourceUrl,
    context: req.context,
  };

  // Reserve the amount in the same tick as the policy check (no await in
  // between) so concurrent /sign calls cannot overspend the intent. Released
  // in `finally` unless the payment ends up signed.
  const intentId = (intent as StoredIntent).id;
  const amount = BigInt(requirement.amount);
  recordSpend(intentId, amount);
  let signed = false;
  try {
    return await runStagesAndSign(req, paymentIdentifier, stageCtx, () => {
      signed = true;
    });
  } finally {
    if (!signed) recordSpend(intentId, -amount);
  }
}

async function runStagesAndSign(
  req: SignRequest,
  paymentIdentifier: string,
  stageCtx: StageContext,
  markSigned: () => void,
): Promise<PipelineOutcome> {
  for (const stage of PASS_THROUGH_STAGES) {
    const result = await stage.run(stageCtx);
    if (result.outcome !== "pass") {
      return finalize({
        paymentIdentifier,
        intentId: req.intentId,
        state: transition("initial", result.state),
        verdict: result.outcome,
        reason: `${stage.name}: ${result.reason}`,
        cache: true,
      });
    }
  }

  // Every check passed — enter the pre-signature gate. WU11 replaces the
  // world_id pass-through stage above with a real wait; for WU3 the gate
  // resolves immediately once signing succeeds.
  const preSignState = transition("initial", "awaiting_world_id");
  try {
    const { paymentSignatureHeader } = await signPayment({
      paymentRequired: req.paymentRequired,
      maxBudgetAtomic: stageCtx.intent.message.budget,
      paymentIdentifier,
    });
    markSigned();
    return finalize({
      paymentIdentifier,
      intentId: req.intentId,
      state: transition(preSignState, "signed"),
      verdict: "pay",
      reason: "all pipeline checks passed",
      paymentSignature: paymentSignatureHeader,
      cache: true,
    });
  } catch (err) {
    // createPaymentPayload/signing failed -> refuse, never pay (plan-tecnico.md
    // §2.4). WU1's ReceiptState enum has no dedicated sign-failure state;
    // `world_id_denied` is the closest fail-closed exit from the pre-signature
    // gate ("did not clear the last gate before signing").
    const reason = `signing failed: ${err instanceof Error ? err.message : String(err)}`;
    return finalize({
      paymentIdentifier,
      intentId: req.intentId,
      state: transition(preSignState, "world_id_denied"),
      verdict: "refuse",
      reason,
      cache: true,
    });
  }
}

/** Top-level entry point — always fail-closed, always returns a usable receiptId. */
export async function runSignPipeline(req: SignRequest): Promise<PipelineOutcome> {
  const paymentIdentifier = computePaymentIdentifier(req.intentId, req.paymentRequired.accepts?.[0], req.resourceUrl);
  try {
    return await runSignPipelineInner(req, paymentIdentifier);
  } catch (err) {
    const reason = `unexpected pipeline error: ${err instanceof Error ? err.message : String(err)}`;
    return finalize({
      paymentIdentifier,
      intentId: req.intentId,
      state: transition("initial", "policy_rejected"),
      verdict: "refuse",
      reason,
      cache: false,
    });
  }
}
