// The core decision pipeline (plan-tecnico.md §2.3):
//   idempotency -> policy -> provenance -> Intercepta -> Jev -> World ID -> sign
// Every branch is fail-closed (plan-tecnico.md §2.4): any doubt or error
// produces `refuse`/`ask_human`, never `pay`. World ID is still a
// pass-through stub — see PASS_THROUGH_STAGES below for the plug-in point
// WU11 replaces it at.
//
// WU9 additions: every finalized receipt carries a per-stage `timeline`
// (idempotency, policy, provenance, intercepta, jev, world_id, sign) and,
// when Jev/Intercepta ran, their structured detail in `receipt.jev`/
// `receipt.intercepta` — on every evaluation, `pay` included, via
// `StageVerdict.detail` rather than string parsing (see jev.ts, intercepta.ts).

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
  type ReceiptTimelineEntry,
  type Verdict,
} from "@yakusoku/shared";
import { interceptaStage } from "./intercepta";
import { jevStage } from "./jev";
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
  | { outcome: "pass"; detail?: Record<string, unknown> }
  | { outcome: "refuse" | "ask_human"; state: ReceiptState; reason: string; detail?: Record<string, unknown> };

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
 * - WU7 Intercepta -> real (address/token screening, see intercepta.ts)
 * - WU8 Jev        -> real (see jev.ts)
 * - WU11 World ID  -> `"world_id_denied"` / `"world_id_expired"` (real async human-approval wait)
 */
export const PASS_THROUGH_STAGES: PipelineStage[] = [
  provenanceStage,
  interceptaStage,
  jevStage,
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

/** Fields describing "what this payment is for", known as soon as the
 * request and (when resolvable) the intent are read — attached to every
 * receipt this pipeline run produces, however it ends. */
interface ReceiptContext {
  paymentIdentifier: string;
  intentId: string;
  task?: string;
  resourceUrl: string;
  amount?: string;
  payTo?: string;
}

function buildReceipt(input: {
  paymentIdentifier: string;
  intentId: string;
  task?: string;
  resourceUrl: string;
  amount?: string;
  payTo?: string;
  timeline: ReceiptTimelineEntry[];
  jev?: DecisionReceipt["jev"];
  intercepta?: DecisionReceipt["intercepta"];
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
    task: input.task,
    resourceUrl: input.resourceUrl,
    amount: input.amount,
    payTo: input.payTo,
    timeline: input.timeline,
    jev: input.jev,
    intercepta: input.intercepta,
  };
}

function finalize(input: {
  paymentIdentifier: string;
  intentId: string;
  task?: string;
  resourceUrl: string;
  amount?: string;
  payTo?: string;
  timeline: ReceiptTimelineEntry[];
  jev?: DecisionReceipt["jev"];
  intercepta?: DecisionReceipt["intercepta"];
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
  const timeline: ReceiptTimelineEntry[] = [];
  const intent = getIntent(req.intentId);
  const accepts0 = (req.paymentRequired.accepts?.[0] ?? {}) as Partial<PaymentRequirement>;
  const receiptContext: ReceiptContext = {
    paymentIdentifier,
    intentId: req.intentId,
    task: intent?.message.task,
    resourceUrl: req.resourceUrl,
    amount: accepts0.amount,
    payTo: accepts0.payTo,
  };

  const idempotencyStart = Date.now();
  const cached = getCachedSignOutcome(paymentIdentifier);
  timeline.push({ stage: "idempotency", outcome: cached ? "hit" : "pass", ms: Date.now() - idempotencyStart });
  if (cached) {
    return finalize({
      ...receiptContext,
      timeline,
      state: transition("initial", "idempotent_hit"),
      verdict: cached.verdict,
      reason: `idempotent replay of a previously processed payment (${cached.reason})`,
      paymentSignature: cached.paymentSignature,
      cache: false, // already cached under this id
    });
  }

  const requirementResult = paymentRequirementSchema.safeParse(accepts0);
  if (!requirementResult.success) {
    return finalize({
      ...receiptContext,
      timeline,
      state: transition("initial", "policy_rejected"),
      verdict: "refuse",
      reason: `malformed payment requirement: ${requirementResult.error.message}`,
      cache: true,
    });
  }
  const requirement = requirementResult.data;

  const policyStart = Date.now();
  const policyResult = checkPolicy(intent, requirement);
  timeline.push({
    stage: "policy",
    outcome: policyResult.ok ? "pass" : "refuse",
    reason: policyResult.ok ? undefined : policyResult.reason,
    ms: Date.now() - policyStart,
  });
  if (!policyResult.ok) {
    return finalize({
      ...receiptContext,
      timeline,
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
    return await runStagesAndSign(receiptContext, timeline, stageCtx, () => {
      signed = true;
    });
  } finally {
    if (!signed) recordSpend(intentId, -amount);
  }
}

async function runStagesAndSign(
  receiptContext: ReceiptContext,
  timeline: ReceiptTimelineEntry[],
  stageCtx: StageContext,
  markSigned: () => void,
): Promise<PipelineOutcome> {
  let jevDetail: DecisionReceipt["jev"];
  let interceptaDetail: DecisionReceipt["intercepta"];
  for (const stage of PASS_THROUGH_STAGES) {
    const stageStart = Date.now();
    const result = await stage.run(stageCtx);
    const ms = Date.now() - stageStart;
    if (result.detail?.jev) jevDetail = result.detail.jev as DecisionReceipt["jev"];
    if (result.detail?.intercepta) interceptaDetail = result.detail.intercepta as DecisionReceipt["intercepta"];

    if (result.outcome !== "pass") {
      timeline.push({ stage: stage.name, outcome: result.outcome, reason: result.reason, ms });
      return finalize({
        ...receiptContext,
        timeline,
        jev: jevDetail,
        intercepta: interceptaDetail,
        state: transition("initial", result.state),
        verdict: result.outcome,
        reason: `${stage.name}: ${result.reason}`,
        cache: true,
      });
    }
    timeline.push({ stage: stage.name, outcome: "pass", ms });
  }

  // Every check passed — enter the pre-signature gate. WU11 replaces the
  // world_id pass-through stage above with a real wait; until then the gate
  // resolves immediately once signing succeeds.
  const preSignState = transition("initial", "awaiting_world_id");
  const signStart = Date.now();
  try {
    const { paymentSignatureHeader } = await signPayment({
      paymentRequired: stageCtx.paymentRequired,
      maxBudgetAtomic: stageCtx.intent.message.budget,
      paymentIdentifier: receiptContext.paymentIdentifier,
    });
    markSigned();
    timeline.push({ stage: "sign", outcome: "pass", ms: Date.now() - signStart });
    return finalize({
      ...receiptContext,
      timeline,
      jev: jevDetail,
      intercepta: interceptaDetail,
      state: transition(preSignState, "signed"),
      verdict: "pay",
      reason: "all pipeline checks passed",
      paymentSignature: paymentSignatureHeader,
      cache: true,
    });
  } catch (err) {
    // createPaymentPayload/signing failed -> refuse, never pay (plan-tecnico.md §2.4).
    const reason = `signing failed: ${err instanceof Error ? err.message : String(err)}`;
    timeline.push({ stage: "sign", outcome: "refuse", reason, ms: Date.now() - signStart });
    return finalize({
      ...receiptContext,
      timeline,
      jev: jevDetail,
      intercepta: interceptaDetail,
      state: transition(preSignState, "sign_failed"),
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
      resourceUrl: req.resourceUrl,
      timeline: [],
      state: transition("initial", "error"),
      verdict: "refuse",
      reason,
      cache: false,
    });
  }
}
