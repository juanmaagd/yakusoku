// In-memory state for the firewall: signed intents, decision receipts, and
// the idempotency cache keyed by the computed x402 payment-identifier
// (pipeline.ts). A hackathon MVP — no persistence, single process.

import type { DecisionReceipt, TaskIntentMessage, Verdict } from "@yakusoku/shared";

export interface StoredIntent {
  id: string;
  message: TaskIntentMessage;
  signature: `0x${string}`;
  signer: `0x${string}`;
  /** Atomic USDC units already committed by successful `pay` verdicts. */
  spent: bigint;
  createdAt: string;
}

export interface CachedSignOutcome {
  verdict: Verdict;
  reason: string;
  paymentSignature?: string;
}

const intents = new Map<string, StoredIntent>();
const receipts = new Map<string, DecisionReceipt>();
const idempotencyCache = new Map<string, CachedSignOutcome>();

export function createIntent(
  message: TaskIntentMessage,
  signature: `0x${string}`,
  signer: `0x${string}`,
): StoredIntent {
  const intent: StoredIntent = {
    id: `intent_${crypto.randomUUID()}`,
    message,
    signature,
    signer,
    spent: 0n,
    createdAt: new Date().toISOString(),
  };
  intents.set(intent.id, intent);
  return intent;
}

export function getIntent(id: string): StoredIntent | undefined {
  return intents.get(id);
}

/** Never negative — a successful spend can't exceed what policy already allowed. */
export function remainingBudget(intent: StoredIntent): bigint {
  const remaining = intent.message.budget - intent.spent;
  return remaining > 0n ? remaining : 0n;
}

export function recordSpend(intentId: string, amount: bigint): void {
  const intent = intents.get(intentId);
  if (!intent) throw new Error(`recordSpend: unknown intentId ${intentId}`);
  intent.spent += amount;
}

export function saveReceipt(receipt: DecisionReceipt): void {
  receipts.set(receipt.receiptId, receipt);
}

export function getReceipt(id: string): DecisionReceipt | undefined {
  return receipts.get(id);
}

export function getCachedSignOutcome(paymentIdentifier: string): CachedSignOutcome | undefined {
  return idempotencyCache.get(paymentIdentifier);
}

export function cacheSignOutcome(paymentIdentifier: string, outcome: CachedSignOutcome): void {
  idempotencyCache.set(paymentIdentifier, outcome);
}
