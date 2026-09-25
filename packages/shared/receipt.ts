import { z } from "zod";
import { verdictSchema } from "./verdict";

/**
 * DecisionReceipt state machine — named states inspired by ClearIntent's
 * pattern (plan-tecnico.md §2.2). Every branch of the pipeline
 * (idempotency → policy → provenance → Intercepta → Jev → World ID → sign,
 * plan-tecnico.md §2.3) writes exactly one of these as the receipt's outcome,
 * or `awaiting_world_id` while it waits on the last human-approval gate.
 */
export const RECEIPT_STATES = [
  "idempotent_hit",
  "policy_rejected",
  "provenance_blocked",
  "intercepta_blocked",
  "intercepta_escalated",
  "jev_refused",
  "jev_ask_human",
  "awaiting_world_id",
  "world_id_denied",
  "world_id_expired",
  /** The pre-signature gate cleared but `createPaymentPayload`/signing itself
   * failed (WU9 fix — previously misfiled under `world_id_denied`, since the
   * enum had no dedicated sign-failure state). */
  "sign_failed",
  "signed",
  "settled",
  "settlement_failed",
  /** An unexpected error anywhere in the pipeline, before any real decision
   * was reached (WU9 fix — previously misfiled under `policy_rejected`). */
  "error",
] as const;
export type ReceiptState = (typeof RECEIPT_STATES)[number];
const receiptStateSchema = z.enum(RECEIPT_STATES);

/**
 * `"initial"` stands for "receipt not created yet". plan-tecnico.md's `state`
 * union has no separate "received"/"pending" value — a receipt is created
 * directly with its first real state (whichever pipeline stage stopped it, or
 * `awaiting_world_id` once every check passed) — so creation is itself
 * modeled as a transition from `"initial"`.
 */
type TransitionSource = ReceiptState | "initial";

const RECEIPT_TRANSITIONS: Record<TransitionSource, readonly ReceiptState[]> = {
  initial: [
    "idempotent_hit",
    "policy_rejected",
    "provenance_blocked",
    "intercepta_blocked",
    "intercepta_escalated",
    "jev_refused",
    "jev_ask_human",
    "awaiting_world_id",
    "error",
  ],
  awaiting_world_id: ["world_id_denied", "world_id_expired", "signed", "sign_failed"],
  signed: ["settled", "settlement_failed"],
  // Every other state is terminal for this MVP's receipt lifecycle. A state
  // reached by manual review (e.g. `POST /approvals/:receiptId` resolving
  // `jev_ask_human`) is a new receipt/side-channel update, not a further
  // transition of this one — keeps the table simple for the hackathon scope.
  idempotent_hit: [],
  policy_rejected: [],
  provenance_blocked: [],
  intercepta_blocked: [],
  intercepta_escalated: [],
  jev_refused: [],
  jev_ask_human: [],
  world_id_denied: [],
  world_id_expired: [],
  sign_failed: [],
  settled: [],
  settlement_failed: [],
  error: [],
};

/**
 * Fail-closed by construction: an illegal transition throws instead of
 * silently writing an inconsistent receipt state (plan-tecnico.md §2.4).
 */
export function transition(from: TransitionSource, to: ReceiptState): ReceiptState {
  const allowed = RECEIPT_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(`illegal receipt transition: ${from} -> ${to}`);
  }
  return to;
}

/** One entry of a receipt's per-stage timeline (WU9), in pipeline order. */
export const receiptTimelineEntrySchema = z.object({
  stage: z.string(),
  outcome: z.enum(["pass", "refuse", "ask_human", "hit"]),
  reason: z.string().optional(),
  /** Wall-clock time spent in this stage, in milliseconds. */
  ms: z.number(),
});
export type ReceiptTimelineEntry = z.infer<typeof receiptTimelineEntrySchema>;

/** Structured Jev judgment (WU9) — every field `judgeIntent` (jev.ts)
 * produces, attached on every evaluation, `pay` included, not just blocks. */
const jevJudgmentSchema = z.object({
  matchesIntent: z.number(),
  looksLikeSocialEngineering: z.number(),
  paymentSourceIsUntrustedContent: z.number(),
  actionChoice: z.string(),
  actionConfidence: z.number(),
  riskScore: z.number(),
  riskConfidence: z.number(),
  riskNormalized: z.number(),
  verdict: verdictSchema,
  model: z.string(),
  latencyMs: z.number(),
});

const settlementSchema = z.object({
  txHash: z.string(),
  network: z.string(),
  reportedAt: z.string(),
});

/** Receipt shape per plan-tecnico.md §2.2, extended in WU9 for the dashboard
 * (WU10): requested-payment summary fields, a per-stage timeline, structured
 * Jev probabilities, and settlement reporting. */
export const decisionReceiptSchema = z.object({
  receiptId: z.string().min(1),
  /** x402 `payment-identifier` extension value — the idempotency key. */
  paymentIdentifier: z.string().min(1),
  intentId: z.string().min(1),
  createdAt: z.string().min(1),
  state: receiptStateSchema,
  verdict: verdictSchema,
  reasons: z.array(z.string()),
  /** The signed intent's task text, when the intent was resolved. */
  task: z.string().optional(),
  /** The x402 resource URL this payment was for. */
  resourceUrl: z.string().optional(),
  /** Atomic-unit amount string, when the payment requirement parsed. */
  amount: z.string().optional(),
  payTo: z.string().optional(),
  timeline: z.array(receiptTimelineEntrySchema),
  intercepta: z
    .object({
      addressVerdict: z.string(),
      tokenVerdict: z.string(),
    })
    .optional(),
  jev: jevJudgmentSchema.optional(),
  worldId: z
    .object({
      approved: z.boolean(),
      nullifierHash: z.string().optional(),
      stepUpAttestation: z.string().optional(),
    })
    .optional(),
  txHash: z.string().optional(),
  explorerUrl: z.string().optional(),
  settlement: settlementSchema.optional(),
});
export type DecisionReceipt = z.infer<typeof decisionReceiptSchema>;
