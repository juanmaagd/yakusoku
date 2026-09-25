import { z } from "zod";
import { stepUpAttestationSchema } from "./step-up";
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
  /** WU13 kill switch: `/sign` refused because the firewall is paused
   * (`POST /control/pause`). Only reachable from `initial` — this is the
   * very first check `/sign` makes, before the idempotency cache and before
   * any pipeline stage runs. An approval already in flight when a pause
   * lands is refused at resolution time under `world_id_denied` instead
   * (approvals.ts), since that transition already exists. */
  "paused",
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
    "paused",
    "error",
  ],
  // WU11: `error` covers an invalid/unverifiable World ID token or any
  // unexpected failure while resolving the gate (fail-closed — same
  // `error` state the top-level pipeline uses for unforeseen failures).
  awaiting_world_id: ["world_id_denied", "world_id_expired", "signed", "sign_failed", "error"],
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
  paused: [],
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
  /** Structured Intercepta verdict (WU7) — attached on every evaluation this
   * stage actually ran, `pass` included, mirroring `jev`'s `detail` pattern.
   * `addressVerdict`/`tokenVerdict` are `"unavailable"`/omitted respectively
   * on a fail-closed path (missing key, timeout, network error) where no
   * trustworthy verdict was reached. */
  intercepta: z
    .object({
      addressVerdict: z.string(),
      addressScore: z.number().optional(),
      tokenVerdict: z.string().optional(),
      cached: z.boolean(),
      latencyMs: z.number(),
    })
    .optional(),
  jev: jevJudgmentSchema.optional(),
  /**
   * World ID human-approval gate result (WU11), extended in WU12 with a
   * StepUp EIP-712 attestation. All new fields are optional so a receipt
   * persisted before WU12 (bare `{ approved: true }`, no attestation) still
   * parses — `saveReceipt`/`getReceipt` (store.ts) round-trip every receipt
   * through this schema, so tightening it would break reading old rows.
   * `approved: true` receipts carry `subject`/`acr`/`authTime`/`attestation`
   * (set together in `settleApproved`, apps/firewall/approvals.ts);
   * `approved: false` receipts carry `status` (the terminal
   * `PendingApproval["status"]` — denied/expired/error/paused/revoked) and
   * never an attestation (nothing to attest — no valid approval was used).
   */
  worldId: z
    .object({
      approved: z.boolean(),
      /** `keccak256` of the World ID `sub` claim — same value as
       * `attestation.message.worldIdSubject`, never the raw claim. */
      subject: z.string().optional(),
      acr: z.string().optional(),
      authTime: z.number().optional(),
      attestation: stepUpAttestationSchema.optional(),
      status: z.string().optional(),
    })
    .optional(),
  txHash: z.string().optional(),
  explorerUrl: z.string().optional(),
  settlement: settlementSchema.optional(),
});
export type DecisionReceipt = z.infer<typeof decisionReceiptSchema>;
