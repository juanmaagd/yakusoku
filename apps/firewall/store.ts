// Persistent state for the firewall: signed intents, decision receipts, and
// the idempotency cache keyed by the computed x402 payment-identifier
// (pipeline.ts). Backed by `bun:sqlite` (WU9) so a `--watch` restart or crash
// doesn't lose intents/receipts/spend mid-demo — everything here is a
// synchronous call, so the atomic budget-reservation window in pipeline.ts
// (no `await` between the policy check and `recordSpend`) still holds.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  decisionReceiptSchema,
  stringifyWithBigint,
  taskIntentMessageSchema,
  type DecisionReceipt,
  type TaskIntentMessage,
  type Verdict,
} from "@yakusoku/shared";

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

/**
 * A World ID approval gate in flight (WU11, approvals.ts). Persisted so a
 * `--watch` restart can resume polling instead of losing the pending human
 * approval — `deviceCode`/`intervalSeconds`/`expiresAt` are everything the
 * RFC 8628 device flow needs to resume, and `paymentRequiredJson` is
 * everything `signPayment` needs to actually sign once approved.
 */
export interface PendingApproval {
  receiptId: string;
  paymentIdentifier: string;
  intentId: string;
  /** Reserved amount, atomic units — precise release on a non-`approved` outcome. */
  amountAtomic: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  /** ISO — min(World's own `expires_in`, `WORLD_ID_APPROVAL_TIMEOUT_S`) from creation. */
  expiresAt: string;
  /** ISO — when the device flow was requested; the ID token's `auth_time` must be at/after this. */
  requestedAt: string;
  /** epoch ms the gate started at — base for the `world_id` timeline entry's `ms`. */
  gateStartedAtMs: number;
  status: "pending" | "approved" | "denied" | "expired" | "error";
  reason?: string;
  paymentSignature?: string;
  /** `JSON.stringify(PaymentRequired)` — resolving the gate re-signs against this exact requirement. */
  paymentRequiredJson: string;
  createdAt: string;
  updatedAt: string;
}

// --- Database setup ----------------------------------------------------------

const DATA_DIR = process.env.FIREWALL_DATA_DIR ?? join(import.meta.dir, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "firewall.sqlite"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS intents (
    id TEXT PRIMARY KEY,
    message_json TEXT NOT NULL,
    signature TEXT NOT NULL,
    signer TEXT NOT NULL,
    spent TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS receipts (
    receipt_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS receipts_created_at ON receipts (created_at);
  CREATE TABLE IF NOT EXISTS idempotency_cache (
    payment_identifier TEXT PRIMARY KEY,
    data_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_approvals (
    receipt_id TEXT PRIMARY KEY,
    payment_identifier TEXT NOT NULL,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pending_approvals_payment_identifier ON pending_approvals (payment_identifier);
  CREATE INDEX IF NOT EXISTS pending_approvals_status ON pending_approvals (status);
`);

// --- Statements ----------------------------------------------------------

const insertIntentStmt = db.prepare(
  `INSERT INTO intents (id, message_json, signature, signer, spent, created_at) VALUES ($id, $message, $signature, $signer, $spent, $createdAt)`,
);
const getIntentStmt = db.prepare(`SELECT * FROM intents WHERE id = $id`);
const listIntentsStmt = db.prepare(`SELECT * FROM intents ORDER BY created_at DESC`);
const updateSpentStmt = db.prepare(`UPDATE intents SET spent = $spent WHERE id = $id`);

const upsertReceiptStmt = db.prepare(
  `INSERT INTO receipts (receipt_id, created_at, data_json) VALUES ($id, $createdAt, $data)
   ON CONFLICT(receipt_id) DO UPDATE SET data_json = excluded.data_json`,
);
const getReceiptStmt = db.prepare(`SELECT data_json FROM receipts WHERE receipt_id = $id`);
const listReceiptsStmt = db.prepare(`SELECT data_json FROM receipts ORDER BY created_at DESC LIMIT $limit`);

const getCachedOutcomeStmt = db.prepare(`SELECT data_json FROM idempotency_cache WHERE payment_identifier = $id`);
const setCachedOutcomeStmt = db.prepare(
  `INSERT INTO idempotency_cache (payment_identifier, data_json) VALUES ($id, $data)
   ON CONFLICT(payment_identifier) DO UPDATE SET data_json = excluded.data_json`,
);

const upsertPendingApprovalStmt = db.prepare(
  `INSERT INTO pending_approvals (receipt_id, payment_identifier, status, data_json)
   VALUES ($receiptId, $paymentIdentifier, $status, $data)
   ON CONFLICT(receipt_id) DO UPDATE SET status = excluded.status, data_json = excluded.data_json`,
);
const getPendingApprovalByReceiptIdStmt = db.prepare(`SELECT data_json FROM pending_approvals WHERE receipt_id = $id`);
// Most recent row for a payment identifier — in practice at most one pending
// approval ever exists per identifier (the gate is only entered once), but
// ORDER BY guards against a hypothetical stale duplicate.
const getPendingApprovalByPaymentIdentifierStmt = db.prepare(
  `SELECT data_json FROM pending_approvals WHERE payment_identifier = $paymentIdentifier ORDER BY rowid DESC LIMIT 1`,
);
const listPendingApprovalsByStatusStmt = db.prepare(`SELECT data_json FROM pending_approvals WHERE status = $status`);

// --- Row <-> domain mapping ----------------------------------------------

interface IntentRow {
  id: string;
  message_json: string;
  signature: string;
  signer: string;
  spent: string;
  created_at: string;
}

function rowToIntent(row: IntentRow): StoredIntent {
  // `message_json` was written with `stringifyWithBigint` (bigint -> string);
  // re-parsing through the schema coerces those strings back to bigint.
  const message = taskIntentMessageSchema.parse(JSON.parse(row.message_json));
  return {
    id: row.id,
    message,
    signature: row.signature as `0x${string}`,
    signer: row.signer as `0x${string}`,
    spent: BigInt(row.spent),
    createdAt: row.created_at,
  };
}

// --- Intents ---------------------------------------------------------------

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
  insertIntentStmt.run({
    $id: intent.id,
    $message: stringifyWithBigint(message),
    $signature: signature,
    $signer: signer,
    $spent: "0",
    $createdAt: intent.createdAt,
  });
  return intent;
}

export function getIntent(id: string): StoredIntent | undefined {
  const row = getIntentStmt.get({ $id: id }) as IntentRow | null;
  return row ? rowToIntent(row) : undefined;
}

export function listIntents(): StoredIntent[] {
  const rows = listIntentsStmt.all() as IntentRow[];
  return rows.map(rowToIntent);
}

/** Never negative — a successful spend can't exceed what policy already allowed. */
export function remainingBudget(intent: StoredIntent): bigint {
  const remaining = intent.message.budget - intent.spent;
  return remaining > 0n ? remaining : 0n;
}

/**
 * Reserves (positive `amount`) or releases (negative `amount`) spend against
 * an intent. Synchronous read-modify-write over `bun:sqlite` — safe against
 * concurrent `/sign` calls only because callers never `await` between reading
 * the intent for the policy check and calling this (see pipeline.ts), so no
 * other request's JS can interleave in between.
 */
export function recordSpend(intentId: string, amount: bigint): void {
  const row = getIntentStmt.get({ $id: intentId }) as IntentRow | null;
  if (!row) throw new Error(`recordSpend: unknown intentId ${intentId}`);
  const newSpent = BigInt(row.spent) + amount;
  updateSpentStmt.run({ $spent: newSpent.toString(), $id: intentId });
}

// --- Receipts --------------------------------------------------------------

export function saveReceipt(receipt: DecisionReceipt): void {
  upsertReceiptStmt.run({
    $id: receipt.receiptId,
    $createdAt: receipt.createdAt,
    $data: JSON.stringify(receipt),
  });
}

export function getReceipt(id: string): DecisionReceipt | undefined {
  const row = getReceiptStmt.get({ $id: id }) as { data_json: string } | null;
  return row ? decisionReceiptSchema.parse(JSON.parse(row.data_json)) : undefined;
}

/** Latest-first, for the dashboard's initial load (WU9/WU10). */
export function listReceipts(limit = 50): DecisionReceipt[] {
  const rows = listReceiptsStmt.all({ $limit: limit }) as { data_json: string }[];
  return rows.map((row) => decisionReceiptSchema.parse(JSON.parse(row.data_json)));
}

// --- Idempotency cache -------------------------------------------------------

export function getCachedSignOutcome(paymentIdentifier: string): CachedSignOutcome | undefined {
  const row = getCachedOutcomeStmt.get({ $id: paymentIdentifier }) as { data_json: string } | null;
  return row ? (JSON.parse(row.data_json) as CachedSignOutcome) : undefined;
}

export function cacheSignOutcome(paymentIdentifier: string, outcome: CachedSignOutcome): void {
  setCachedOutcomeStmt.run({ $id: paymentIdentifier, $data: JSON.stringify(outcome) });
}

// --- Pending World ID approvals (WU11) --------------------------------------

export function savePendingApproval(approval: PendingApproval): void {
  upsertPendingApprovalStmt.run({
    $receiptId: approval.receiptId,
    $paymentIdentifier: approval.paymentIdentifier,
    $status: approval.status,
    $data: JSON.stringify(approval),
  });
}

export function getPendingApprovalByReceiptId(receiptId: string): PendingApproval | undefined {
  const row = getPendingApprovalByReceiptIdStmt.get({ $id: receiptId }) as { data_json: string } | null;
  return row ? (JSON.parse(row.data_json) as PendingApproval) : undefined;
}

export function getPendingApprovalByPaymentIdentifier(paymentIdentifier: string): PendingApproval | undefined {
  const row = getPendingApprovalByPaymentIdentifierStmt.get({ $paymentIdentifier: paymentIdentifier }) as
    | { data_json: string }
    | null;
  return row ? (JSON.parse(row.data_json) as PendingApproval) : undefined;
}

/** Every approval still awaiting a human, for resuming on boot (approvals.ts). */
export function listPendingApprovalsByStatus(status: PendingApproval["status"]): PendingApproval[] {
  const rows = listPendingApprovalsByStatusStmt.all({ $status: status }) as { data_json: string }[];
  return rows.map((row) => JSON.parse(row.data_json) as PendingApproval);
}
