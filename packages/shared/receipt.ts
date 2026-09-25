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
  "signed",
  "settled",
  "settlement_failed",
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
  ],
  awaiting_world_id: ["world_id_denied", "world_id_expired", "signed"],
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
  settled: [],
  settlement_failed: [],
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

/** Receipt shape per plan-tecnico.md §2.2. */
export const decisionReceiptSchema = z.object({
  receiptId: z.string().min(1),
  /** x402 `payment-identifier` extension value — the idempotency key. */
  paymentIdentifier: z.string().min(1),
  intentId: z.string().min(1),
  createdAt: z.string().min(1),
  state: receiptStateSchema,
  verdict: verdictSchema,
  reasons: z.array(z.string()),
  intercepta: z
    .object({
      addressVerdict: z.string(),
      tokenVerdict: z.string(),
    })
    .optional(),
  jev: z
    .object({
      matchesIntent: z.number(),
      risk: z.number(),
      action: z.string(),
      confidence: z.number(),
    })
    .optional(),
  worldId: z
    .object({
      approved: z.boolean(),
      nullifierHash: z.string().optional(),
      stepUpAttestation: z.string().optional(),
    })
    .optional(),
  txHash: z.string().optional(),
  explorerUrl: z.string().optional(),
});
export type DecisionReceipt = z.infer<typeof decisionReceiptSchema>;
