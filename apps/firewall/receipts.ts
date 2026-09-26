// Receipt-building + finalization helpers, split out of pipeline.ts (WU11)
// so both pipeline.ts (the main decision loop) and approvals.ts (the World
// ID gate's background resolver) can finalize a `DecisionReceipt` without
// either module importing the other. `finalize` supports updating an
// existing receipt in place via `receiptId`/`createdAt` — the World ID gate
// creates one interim `awaiting_world_id` receipt and later resolves it to
// its terminal state, rather than minting a second receiptId.

import type { DecisionReceipt, ReceiptState, ReceiptTimelineEntry, Verdict } from "@yakusoku/shared";
import { cacheSignOutcome, saveReceipt, type PendingApproval } from "./store";

/** Fields describing "what this payment is for", known as soon as the
 * request and (when resolvable) the intent are read — attached to every
 * receipt a pipeline run produces, however it ends. */
export interface ReceiptContext {
  paymentIdentifier: string;
  intentId: string;
  task?: string;
  /** P6 dashboard's "justified by" field — see `DecisionReceipt.justification` (packages/shared/receipt.ts). */
  justification?: string;
  resourceUrl: string;
  amount?: string;
  payTo?: string;
  /** WU: purchase ref — the caller's own reference for this exact purchase,
   * carried onto every receipt this request produces (see
   * `packages/shared/receipt.ts`'s `purchaseRefSchema`). `undefined` when
   * the caller sent none. */
  purchaseRef?: string;
}

export interface ApprovalInfo {
  /** WU13 adds `paused`/`revoked` — see `PendingApprovalStatus` (store.ts). */
  status: PendingApproval["status"];
  verificationUri?: string;
  userCode?: string;
  expiresAt?: string;
}

export interface PipelineOutcome {
  verdict: Verdict;
  reason: string;
  receiptId: string;
  paymentSignature?: string;
  /** Present only while `verdict === "ask_human"` and a World ID device flow
   * is in flight (WU11) — the agent polls `GET /approvals/:receiptId` with it. */
  approval?: ApprovalInfo;
}

export interface FinalizeInput {
  paymentIdentifier: string;
  intentId: string;
  task?: string;
  justification?: string;
  resourceUrl: string;
  amount?: string;
  payTo?: string;
  purchaseRef?: string;
  timeline: ReceiptTimelineEntry[];
  jev?: DecisionReceipt["jev"];
  intercepta?: DecisionReceipt["intercepta"];
  worldId?: DecisionReceipt["worldId"];
  state: ReceiptState;
  verdict: Verdict;
  reason: string;
  paymentSignature?: string;
  /** P11.2 — who actually paid, set once at signing time (pipeline.ts,
   * approvals.ts); `undefined` for a receipt that never resolved a payer. */
  payer?: string;
  payerKind?: DecisionReceipt["payerKind"];
  cache: boolean;
  /** WU: purchase ref — where `cache` writes to when true. `undefined`
   * defaults to `paymentIdentifier` itself (every pre-existing call site,
   * and every `pay`/`sign_failed`-immediate outcome under a purchaseRef,
   * which is meant to be replayed only for that exact purchase). A refusal
   * cached under a purchaseRef instead sets this to the BASE identifier
   * (pipeline.ts/approvals.ts) — a refused or human-denied purchase of that
   * exact item under that promise can never be re-rolled with a new
   * purchaseRef. Ignored when `cache` is false. */
  cacheIdentifier?: string;
  /** Reuse an existing receiptId/createdAt instead of minting a new one — set
   * by the World ID gate when it resolves a receipt it already returned to
   * the caller in `awaiting_world_id`. */
  receiptId?: string;
  createdAt?: string;
}

export function buildReceipt(input: FinalizeInput): DecisionReceipt {
  return {
    receiptId: input.receiptId ?? `receipt_${crypto.randomUUID()}`,
    paymentIdentifier: input.paymentIdentifier,
    intentId: input.intentId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    state: input.state,
    verdict: input.verdict,
    reasons: [input.reason],
    task: input.task,
    justification: input.justification,
    resourceUrl: input.resourceUrl,
    amount: input.amount,
    payTo: input.payTo,
    purchaseRef: input.purchaseRef,
    timeline: input.timeline,
    jev: input.jev,
    intercepta: input.intercepta,
    worldId: input.worldId,
    payer: input.payer,
    payerKind: input.payerKind,
  };
}

export function finalize(input: FinalizeInput): PipelineOutcome {
  const receipt = buildReceipt(input);
  saveReceipt(receipt);
  if (input.cache) {
    cacheSignOutcome(input.cacheIdentifier ?? input.paymentIdentifier, {
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
