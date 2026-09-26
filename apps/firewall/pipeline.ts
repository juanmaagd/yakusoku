// The core decision pipeline (plan-tecnico.md §2.3):
//   idempotency -> policy -> merchant -> provenance -> Intercepta -> Jev -> World ID -> sign
// Every branch is fail-closed (plan-tecnico.md §2.4): any doubt or error
// produces `refuse`/`ask_human`, never `pay`.
//
// H1 fix (GitHub issue #1): `merchant` (merchant.ts) is a new stage, added
// right after `policy` and before `provenance` — before this, `/sign`
// trusted whatever `payTo`/`amount`/`asset`/`network`/`scheme` the agent
// forwarded from its own decode of the store's 402, so a compromised agent
// could swap `payTo` for a fresh attacker address and every other stage
// would pass it. `merchant` independently re-fetches `resourceUrl` and signs
// from ITS OWN copy of the requirement from that point on — see merchant.ts's
// file-header comment for the full mismatch-reason taxonomy.
//
// WU11 change: `ask_human` from provenance/Intercepta/Jev — or a payment
// above `HUMAN_APPROVAL_OVER_USDC` (the real `world_id` stage below) — no
// longer ends the request. It routes into the World ID approval gate
// (approvals.ts), which starts a device flow, keeps the budget reserved
// while pending, and resolves the receipt in the background. `refuse` still
// stops immediately, unchanged since WU6-WU8.
//
// HARDEN fix (refuse dominance): WU11 originally made the FIRST `ask_human`
// from any stage stop the loop and jump straight to the World ID gate, so
// later (more expensive) stages never ran. That silently defeated the
// pipeline's own ordering guarantee whenever an earlier stage escalated for
// an operational reason (e.g. Intercepta escalating every payment because
// INTERCEPTA_API_KEY isn't set yet): Jev never got to evaluate the payment,
// so KEY CASE #9 (casos-de-ataque.md — clean address, in budget, wrong item)
// would have gone to a human instead of being refused outright. The rule is
// now:
//   - `refuse` from ANY stage stops immediately and wins — refuse is final.
//   - `ask_human` from a stage is recorded (reason + timeline entry, plus its
//     jev/intercepta detail as always) but evaluation CONTINUES through the
//     remaining stages, so a later stage's `refuse` still overrides an
//     earlier stage's `ask_human`.
//   - Once every stage has run: any `refuse` already returned above; else if
//     any stage asked for a human, the combined reasons go to the World ID
//     gate; else the payment signs automatically.
// See `evaluateStages` below — pure stage-iteration logic, exported so
// pipeline.test.ts can unit-test the ordering with stubbed stages and no
// network calls.
//
// WU9 additions: every finalized receipt carries a per-stage `timeline`
// (idempotency, policy, provenance, intercepta, jev, world_id, sign) and,
// when Jev/Intercepta ran, their structured detail in `receipt.jev`/
// `receipt.intercepta` — on every evaluation, `pay` included, via
// `StageVerdict.detail` rather than string parsing (see jev.ts, intercepta.ts).
//
// WU13 additions: a persisted kill switch (store.ts's `control` row) is the
// very first thing `runSignPipelineInner` checks — before the idempotency
// cache and before any stage runs — so a paused firewall never reserves
// budget and never returns `pay`. A revoked intent (`POST
// /intents/:id/revoke`) refuses through the existing `policy` check below
// instead of a new stage. Either way, a World ID approval already in flight
// is re-checked right before it signs (approvals.ts).

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
} from "@yakusoku/shared";
import { pendingApprovalOutcome, startApprovalGate, worldIdThresholdStage } from "./approvals";
import { interceptaStage } from "./intercepta";
import { jevStage } from "./jev";
import { merchantStage } from "./merchant";
import { provenanceStage } from "./provenance";
import { resolveMandate } from "./promises";
import { finalize, type PipelineOutcome, type ReceiptContext } from "./receipts";
import {
  getCachedSignOutcome,
  getControlState,
  getOwnerControl,
  getPendingApprovalByPaymentIdentifier,
  recordSpend,
  type StoredIntent,
} from "./store";
import { signPayment } from "./signer";

export type { PipelineOutcome } from "./receipts";

export interface SignRequest {
  intentId: string;
  paymentRequired: PaymentRequired;
  resourceUrl: string;
  /** Free-form context the agent supplies for later layers (provenance/Jev). */
  context?: Record<string, unknown>;
}

// --- Pipeline stage plug-in point (WU6-WU11) --------------------------------

export interface StageContext {
  intent: StoredIntent;
  /** `requirement`/`paymentRequired` start as the agent-forwarded copy but
   * are REPLACED in place by the `merchant` stage (merchant.ts) once it
   * confirms they match the merchant's own self-fetched 402 — every stage
   * after `merchant` (and the eventual `signPayment` call below) reads
   * whichever copy is current, so signing always uses the firewall's own
   * fetch, never the agent's. */
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
 * Ordered stages. `ask_human` from any of these is recorded and evaluation
 * continues through the rest (see the HARDEN note above); once every stage
 * has run, an accumulated `ask_human` routes into the World ID gate
 * (approvals.ts). `refuse` from any stage still stops immediately and wins:
 * - H1 merchant     -> firewall self-fetch vs. the agent's forwarded copy,
 *   and (world_id promises only) bound-merchant-origin check (merchant.ts)
 * - WU6 provenance  -> deterministic recipient-traceability check (provenance.ts)
 * - WU7 Intercepta  -> address/token screening (intercepta.ts)
 * - WU8 Jev         -> semantic intent-match judgment (jev.ts)
 * - WU11 world_id    -> real amount-threshold check (approvals.ts); the actual
 *   human-approval wait happens after this loop, not as a stage itself.
 */
export const PIPELINE_STAGES: PipelineStage[] = [merchantStage, provenanceStage, interceptaStage, jevStage, worldIdThresholdStage];

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
  // P9.2: a world_id-sourced mandate (promiseAsMandate, promises.ts) must be
  // `active` — `pending_approval`/`denied`/`expired`/`revoked`/`error` all
  // refuse here, fail-closed, before any of the wallet-only checks below
  // (which a promise's placeholder `signer`/`revoked` fields would otherwise
  // pass trivially). A wallet-sourced `StoredIntent` never sets `source`, so
  // this is a no-op for the existing path.
  if (intent.source === "world_id" && intent.promiseStatus !== "active") {
    return { ok: false, reason: `promise not active (status: ${intent.promiseStatus})` };
  }
  // WU13: a revoked intent is a permanent business fact (unlike the kill
  // switch, there's no "unrevoke") — check it here so the refusal is cached
  // like any other policy rejection.
  if (intent.revoked) return { ok: false, reason: "intent revoked" };
  // WU-P3: per-owner pause — independent of the global kill switch (checked
  // separately, before this function ever runs). Checked here so it refuses
  // the same way "intent revoked" does, and is cached like any other policy
  // rejection.
  const ownerControl = getOwnerControl(intent.signer);
  if (ownerControl.paused) {
    return { ok: false, reason: ownerControl.reason ? `paused by owner: ${ownerControl.reason}` : "paused by owner" };
  }
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

// --- Orchestration -----------------------------------------------------------

async function runSignPipelineInner(req: SignRequest, paymentIdentifier: string): Promise<PipelineOutcome> {
  const timeline: ReceiptTimelineEntry[] = [];
  // P9.2: resolves either a wallet-signed intent or a world_id promise —
  // see promises.ts's `resolveMandate`/`promiseAsMandate`.
  const intent = resolveMandate(req.intentId);
  const accepts0 = (req.paymentRequired.accepts?.[0] ?? {}) as Partial<PaymentRequirement>;
  const receiptContext: ReceiptContext = {
    paymentIdentifier,
    intentId: req.intentId,
    task: intent?.message.task,
    // Same `typeof` guard jev.ts uses for the same field (jev.ts's
    // `agentContext.justification`) — an untrusted request body can put
    // anything under `context`, so this only ever carries a real string.
    justification: typeof req.context?.justification === "string" ? req.context.justification : undefined,
    resourceUrl: req.resourceUrl,
    amount: accepts0.amount,
    payTo: accepts0.payTo,
  };

  // WU13 kill switch: checked before the idempotency cache and before any
  // stage runs, so a paused firewall never reserves budget and never
  // returns `pay` — not even a cached replay of an already-signed payment.
  // Never cached (`cache: false`): the exact same request is re-evaluated
  // fresh once the operator resumes, instead of being frozen as refused
  // forever under this paymentIdentifier.
  const controlStart = Date.now();
  const control = getControlState();
  if (control.paused) {
    timeline.push({ stage: "control", outcome: "refuse", reason: "paused", ms: Date.now() - controlStart });
    return finalize({
      ...receiptContext,
      timeline,
      state: transition("initial", "paused"),
      verdict: "refuse",
      reason: control.reason ? `paused: ${control.reason}` : "paused",
      cache: false,
    });
  }

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

  // WU11: a repeat `/sign` for the same payment while a World ID device flow
  // is still pending returns that same pending approval — no second device
  // flow, no second budget reservation (approvals.ts's own idempotency
  // cache write only happens once the gate reaches a terminal outcome).
  const pendingApproval = getPendingApprovalByPaymentIdentifier(paymentIdentifier);
  if (pendingApproval?.status === "pending") {
    return pendingApprovalOutcome(pendingApproval);
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
  // between) so concurrent /sign calls cannot overspend the intent. The H1
  // `merchant` stage's own await (its self-fetch) only happens inside
  // `runStagesAndSign` below, strictly AFTER this reservation, so it never
  // reopens this window. Released in `finally` unless the payment ends up
  // signed OR a World ID approval is left pending (the gate keeps the
  // reservation open and releases it itself once it resolves — approvals.ts).
  const intentId = (intent as StoredIntent).id;
  const amount = BigInt(requirement.amount);
  recordSpend(intentId, amount);
  let signed = false;
  let pending = false;
  try {
    return await runStagesAndSign(receiptContext, timeline, stageCtx, {
      markSigned: () => {
        signed = true;
      },
      markPending: () => {
        pending = true;
      },
    });
  } finally {
    if (!signed && !pending) recordSpend(intentId, -amount);
  }
}

/** One run of `evaluateStages` through the stage list — pure stage-iteration
 * logic (no signing, no World ID gate, no receipt persistence), so it's
 * directly unit-testable with stubbed `PipelineStage`s and no network calls
 * (pipeline.test.ts). */
export interface StageEvaluation {
  /** Timeline entries for every stage that ran, in order. */
  timeline: ReceiptTimelineEntry[];
  jevDetail?: DecisionReceipt["jev"];
  interceptaDetail?: DecisionReceipt["intercepta"];
  outcome:
    | { kind: "refuse"; stageName: string; state: ReceiptState; reason: string }
    | { kind: "ask_human"; reason: string }
    | { kind: "clear" };
}

/**
 * Runs `stages` in order. A `refuse` stops immediately and wins outright. An
 * `ask_human` is recorded (its reason, and its jev/intercepta detail as
 * always) but does NOT stop evaluation — later stages still run, so a later
 * `refuse` can still override an earlier `ask_human` (the HARDEN fix — see
 * the file-header comment). Once every stage has run: `kind: "ask_human"`
 * with every escalation's reason joined, or `kind: "clear"` if nothing
 * escalated or refused.
 */
export async function evaluateStages(stages: readonly PipelineStage[], stageCtx: StageContext): Promise<StageEvaluation> {
  const timeline: ReceiptTimelineEntry[] = [];
  let jevDetail: DecisionReceipt["jev"];
  let interceptaDetail: DecisionReceipt["intercepta"];
  const askHumanReasons: string[] = [];

  for (const stage of stages) {
    const stageStart = Date.now();
    const result = await stage.run(stageCtx);
    const ms = Date.now() - stageStart;
    if (result.detail?.jev) jevDetail = result.detail.jev as DecisionReceipt["jev"];
    if (result.detail?.intercepta) interceptaDetail = result.detail.intercepta as DecisionReceipt["intercepta"];

    if (result.outcome === "refuse") {
      timeline.push({ stage: stage.name, outcome: "refuse", reason: result.reason, ms });
      return {
        timeline,
        jevDetail,
        interceptaDetail,
        outcome: { kind: "refuse", stageName: stage.name, state: result.state, reason: result.reason },
      };
    }
    if (result.outcome === "ask_human") {
      // Record the escalation but KEEP evaluating later (more expensive)
      // stages — an earlier stage's operational escalation (e.g. Intercepta
      // with no API key) must never shadow a later stage's own refuse (e.g.
      // Jev catching KEY CASE #9). See the file-header HARDEN note.
      timeline.push({ stage: stage.name, outcome: "ask_human", reason: result.reason, ms });
      askHumanReasons.push(`${stage.name}: ${result.reason}`);
      continue;
    }
    timeline.push({ stage: stage.name, outcome: "pass", ms });
  }

  if (askHumanReasons.length > 0) {
    return { timeline, jevDetail, interceptaDetail, outcome: { kind: "ask_human", reason: askHumanReasons.join("; ") } };
  }
  return { timeline, jevDetail, interceptaDetail, outcome: { kind: "clear" } };
}

async function runStagesAndSign(
  receiptContext: ReceiptContext,
  timeline: ReceiptTimelineEntry[],
  stageCtx: StageContext,
  callbacks: { markSigned: () => void; markPending: () => void },
): Promise<PipelineOutcome> {
  const evaluation = await evaluateStages(PIPELINE_STAGES, stageCtx);
  timeline.push(...evaluation.timeline);
  const { jevDetail, interceptaDetail } = evaluation;

  if (evaluation.outcome.kind === "refuse") {
    return finalize({
      ...receiptContext,
      timeline,
      jev: jevDetail,
      intercepta: interceptaDetail,
      state: transition("initial", evaluation.outcome.state),
      verdict: "refuse",
      reason: `${evaluation.outcome.stageName}: ${evaluation.outcome.reason}`,
      cache: true,
    });
  }

  if (evaluation.outcome.kind === "ask_human") {
    return startApprovalGate({
      receiptContext,
      timeline,
      stageCtx,
      jevDetail,
      interceptaDetail,
      triggerReason: evaluation.outcome.reason,
      markPending: callbacks.markPending,
    });
  }

  // Every check passed automatically — sign immediately (no human wait).
  const preSignState = transition("initial", "awaiting_world_id");
  const signStart = Date.now();
  try {
    const { paymentSignatureHeader } = await signPayment({
      paymentRequired: stageCtx.paymentRequired,
      maxBudgetAtomic: stageCtx.intent.message.budget,
      paymentIdentifier: receiptContext.paymentIdentifier,
    });
    callbacks.markSigned();
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
