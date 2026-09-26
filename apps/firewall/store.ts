// Persistent state for the firewall: signed intents, decision receipts, and
// the idempotency cache keyed by the computed x402 payment-identifier
// (pipeline.ts). Backed by `bun:sqlite` (WU9) so a `--watch` restart or crash
// doesn't lose intents/receipts/spend mid-demo — everything here is a
// synchronous call, so the atomic budget-reservation window in pipeline.ts
// (no `await` between the policy check and `recordSpend`) still holds.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateSiweNonce } from "viem/siwe";
import {
  decisionReceiptSchema,
  stringifyWithBigint,
  taskIntentMessageSchema,
  type DecisionReceipt,
  type TaskIntentMessage,
  type Verdict,
} from "@yakusoku/shared";
import { generateAgentKey, generateSessionToken, hashAgentKey, hashSessionToken, hashesEqual } from "./auth";

export interface StoredIntent {
  id: string;
  message: TaskIntentMessage;
  signature: `0x${string}`;
  signer: `0x${string}`;
  /** Atomic USDC units already committed by successful `pay` verdicts. */
  spent: bigint;
  createdAt: string;
  /** WU13 — set by `POST /intents/:id/revoke`. `checkPolicy` (pipeline.ts)
   * refuses any future `/sign` for a revoked intent, and the World ID
   * approval resolver (approvals.ts) re-checks this right before signing so
   * an approval already in flight can't slip a payment through afterward. */
  revoked: boolean;
  revokedAt?: string;
  /** WU-P1 — SHA-256 hash of the mandate credential handed to the agent once
   * (`POST /intents`' 201 response). `undefined` for an intent created
   * before this column existed — such an intent can never authenticate an
   * agent request again (see `findIntentByAgentKey`). Never serialized back
   * to a client (index.ts's `serializeIntent` omits it). */
  agentKeyHash?: string;
}

/** WU13 kill switch — a single persisted row (store.ts's `control` table).
 * `GET /control` reflects it verbatim; `/sign` refuses immediately while
 * `paused` is true (pipeline.ts), before any stage runs and before any
 * budget is reserved. */
export interface ControlState {
  paused: boolean;
  pausedAt?: string;
  reason?: string;
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
  status: PendingApprovalStatus;
  reason?: string;
  paymentSignature?: string;
  /** `JSON.stringify(PaymentRequired)` — resolving the gate re-signs against this exact requirement. */
  paymentRequiredJson: string;
  createdAt: string;
  updatedAt: string;
}

/** WU13 adds `paused`/`revoked` — resolved at signing time (approvals.ts's
 * `resolveApprovalInBackground`) when the kill switch or an intent revoke
 * lands while a World ID approval was still in flight. */
export type PendingApprovalStatus = "pending" | "approved" | "denied" | "expired" | "error" | "paused" | "revoked";

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
    created_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT,
    agent_key_hash TEXT
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
  CREATE TABLE IF NOT EXISTS control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    paused INTEGER NOT NULL DEFAULT 0,
    paused_at TEXT,
    reason TEXT
  );
  CREATE TABLE IF NOT EXISTS siwe_nonces (
    nonce TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS sessions_address ON sessions (address);
  CREATE TABLE IF NOT EXISTS owner_control (
    address TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    paused_at TEXT,
    reason TEXT
  );
`);

// WU13 migration: `intents` may already exist from before the `revoked`
// columns did (the live dev sqlite file under data/) — `CREATE TABLE IF NOT
// EXISTS` above is a no-op for those, so add the columns by hand when
// they're missing. Safe to run on every boot.
{
  const existingColumns = new Set(
    (db.prepare(`PRAGMA table_info(intents)`).all() as { name: string }[]).map((row) => row.name),
  );
  if (!existingColumns.has("revoked")) {
    db.exec(`ALTER TABLE intents ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0`);
  }
  if (!existingColumns.has("revoked_at")) {
    db.exec(`ALTER TABLE intents ADD COLUMN revoked_at TEXT`);
  }
  // WU-P1 migration: same story for the mandate-credential hash — NULL for
  // any intent created before agent keys existed.
  if (!existingColumns.has("agent_key_hash")) {
    db.exec(`ALTER TABLE intents ADD COLUMN agent_key_hash TEXT`);
  }
}

// Exactly one control row, ever — `INSERT OR IGNORE` makes this idempotent
// across restarts instead of erroring on a re-run.
db.exec(`INSERT OR IGNORE INTO control (id, paused, paused_at, reason) VALUES (1, 0, NULL, NULL)`);

// --- Statements ----------------------------------------------------------

const insertIntentStmt = db.prepare(
  `INSERT INTO intents (id, message_json, signature, signer, spent, created_at, agent_key_hash) VALUES ($id, $message, $signature, $signer, $spent, $createdAt, $agentKeyHash)`,
);
const getIntentStmt = db.prepare(`SELECT * FROM intents WHERE id = $id`);
const listIntentsStmt = db.prepare(`SELECT * FROM intents ORDER BY created_at DESC`);
const updateSpentStmt = db.prepare(`UPDATE intents SET spent = $spent WHERE id = $id`);
const revokeIntentStmt = db.prepare(`UPDATE intents SET revoked = 1, revoked_at = $revokedAt WHERE id = $id`);

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

const getControlStmt = db.prepare(`SELECT paused, paused_at, reason FROM control WHERE id = 1`);
const setControlStmt = db.prepare(
  `UPDATE control SET paused = $paused, paused_at = $pausedAt, reason = $reason WHERE id = 1`,
);

// --- Row <-> domain mapping ----------------------------------------------

interface IntentRow {
  id: string;
  message_json: string;
  signature: string;
  signer: string;
  spent: string;
  created_at: string;
  revoked: number;
  revoked_at: string | null;
  agent_key_hash: string | null;
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
    revoked: Boolean(row.revoked),
    revokedAt: row.revoked_at ?? undefined,
    agentKeyHash: row.agent_key_hash ?? undefined,
  };
}

// --- Intents ---------------------------------------------------------------

/** Mints the intent AND its mandate credential (WU-P1) in one step — the
 * agent key is generated here, its hash is what's actually persisted, and
 * the raw key is returned alongside the intent so the caller (`POST
 * /intents`) can hand it to the human exactly once. Nothing after this
 * function ever sees the raw key again. */
export function createIntent(
  message: TaskIntentMessage,
  signature: `0x${string}`,
  signer: `0x${string}`,
): { intent: StoredIntent; agentKey: string } {
  const agentKey = generateAgentKey();
  const agentKeyHash = hashAgentKey(agentKey);
  const intent: StoredIntent = {
    id: `intent_${crypto.randomUUID()}`,
    message,
    signature,
    signer,
    spent: 0n,
    createdAt: new Date().toISOString(),
    revoked: false,
    agentKeyHash,
  };
  insertIntentStmt.run({
    $id: intent.id,
    $message: stringifyWithBigint(message),
    $signature: signature,
    $signer: signer,
    $spent: "0",
    $createdAt: intent.createdAt,
    $agentKeyHash: agentKeyHash,
  });
  return { intent, agentKey };
}

export function getIntent(id: string): StoredIntent | undefined {
  const row = getIntentStmt.get({ $id: id }) as IntentRow | null;
  return row ? rowToIntent(row) : undefined;
}

export function listIntents(): StoredIntent[] {
  const rows = listIntentsStmt.all() as IntentRow[];
  return rows.map(rowToIntent);
}

/** Looks up the intent whose mandate credential's hash matches `agentKey`'s
 * hash (WU-P1 auth, index.ts). Compares against every intent that has a key
 * (dataset stays small for this hackathon demo) using a constant-time
 * comparison per candidate (`hashesEqual`), rather than an indexed SQL
 * equality lookup, so no timing side-channel — however small — is tied to
 * the secret key material. Returns `undefined` for an unknown key or a
 * legacy intent with no `agentKeyHash` at all. */
export function findIntentByAgentKey(agentKey: string): StoredIntent | undefined {
  const providedHash = hashAgentKey(agentKey);
  for (const intent of listIntents()) {
    if (intent.agentKeyHash && hashesEqual(intent.agentKeyHash, providedHash)) return intent;
  }
  return undefined;
}

/** WU13 — `POST /intents/:id/revoke`. Idempotent: revoking an already-revoked
 * intent just returns its current (unchanged) `revokedAt`. Returns
 * `undefined` for an unknown id so the route can 404. */
export function revokeIntent(id: string): StoredIntent | undefined {
  const existing = getIntent(id);
  if (!existing) return undefined;
  if (!existing.revoked) {
    revokeIntentStmt.run({ $id: id, $revokedAt: new Date().toISOString() });
  }
  return getIntent(id);
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

// --- Kill switch (WU13) -----------------------------------------------------

interface ControlRow {
  paused: number;
  paused_at: string | null;
  reason: string | null;
}

export function getControlState(): ControlState {
  const row = getControlStmt.get() as ControlRow | null;
  if (!row) return { paused: false };
  return {
    paused: Boolean(row.paused),
    pausedAt: row.paused_at ?? undefined,
    reason: row.reason ?? undefined,
  };
}

/** Persists the kill switch. Pausing stamps `pausedAt`/`reason`; resuming
 * clears both, so a later pause never inherits a stale reason from a
 * previous one. */
export function setControlState(paused: boolean, reason?: string): ControlState {
  setControlStmt.run({
    $paused: paused ? 1 : 0,
    $pausedAt: paused ? new Date().toISOString() : null,
    $reason: paused ? (reason ?? null) : null,
  });
  return getControlState();
}

// --- SIWE nonces (WU-P3) -----------------------------------------------------

const SIWE_NONCE_TTL_MS = 5 * 60_000;

const insertNonceStmt = db.prepare(
  `INSERT INTO siwe_nonces (nonce, created_at, expires_at, used) VALUES ($nonce, $createdAt, $expiresAt, 0)`,
);
const getNonceStmt = db.prepare(`SELECT expires_at, used FROM siwe_nonces WHERE nonce = $nonce`);
const markNonceUsedStmt = db.prepare(`UPDATE siwe_nonces SET used = 1 WHERE nonce = $nonce`);

/** Mints a single-use SIWE (EIP-4361) nonce, valid for 5 minutes. */
export function createNonce(): { nonce: string; expiresAt: string } {
  const nonce = generateSiweNonce();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SIWE_NONCE_TTL_MS);
  insertNonceStmt.run({ $nonce: nonce, $createdAt: createdAt.toISOString(), $expiresAt: expiresAt.toISOString() });
  return { nonce, expiresAt: expiresAt.toISOString() };
}

/** Marks a nonce used iff it exists, is unused, and hasn't expired —
 * synchronous read-then-write, so no `await` can interleave another request
 * in between (same concurrency model `recordSpend` relies on above). Returns
 * `false` for an unknown, already-used, or expired nonce, so `POST
 * /auth/verify` rejects a replay of an already-consumed nonce (S22). */
export function consumeNonce(nonce: string): boolean {
  const row = getNonceStmt.get({ $nonce: nonce }) as { expires_at: string; used: number } | null;
  if (!row || row.used) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  markNonceUsedStmt.run({ $nonce: nonce });
  return true;
}

// --- SIWE sessions (WU-P3) ---------------------------------------------------

const SESSION_TTL_MS = 8 * 60 * 60_000;

const insertSessionStmt = db.prepare(
  `INSERT INTO sessions (token_hash, address, created_at, expires_at, revoked) VALUES ($tokenHash, $address, $createdAt, $expiresAt, 0)`,
);
const getSessionStmt = db.prepare(`SELECT address, expires_at, revoked FROM sessions WHERE token_hash = $tokenHash`);
const revokeSessionStmt = db.prepare(`UPDATE sessions SET revoked = 1 WHERE token_hash = $tokenHash`);

export interface Session {
  address: `0x${string}`;
  expiresAt: string;
}

/** Mints a fresh SIWE session (8h TTL) for an address that just proved
 * control of its wallet (`siwe.ts`'s `verifySiweSignIn`). The raw token is
 * returned exactly once (`POST /auth/verify`'s response); only its SHA-256
 * hash is persisted — same pattern as the WU-P1 agent key. */
export function createSession(address: `0x${string}`): { token: string; expiresAt: string } {
  const token = generateSessionToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
  insertSessionStmt.run({
    $tokenHash: hashSessionToken(token),
    $address: address,
    $createdAt: createdAt.toISOString(),
    $expiresAt: expiresAt.toISOString(),
  });
  return { token, expiresAt: expiresAt.toISOString() };
}

/** Looks up a session by its raw token — hashes it and looks the hash up by
 * its indexed primary key (sessions are short-lived and per-login, unlike
 * the small fixed set of mandate keys `findIntentByAgentKey` scans with a
 * constant-time loop). Returns `undefined` for an unknown, revoked, or
 * expired session, so every caller gets a single "not a valid session" outcome. */
export function getSessionByToken(token: string): Session | undefined {
  const row = getSessionStmt.get({ $tokenHash: hashSessionToken(token) }) as
    | { address: string; expires_at: string; revoked: number }
    | null;
  if (!row || row.revoked) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now()) return undefined;
  return { address: row.address as `0x${string}`, expiresAt: row.expires_at };
}

/** Idempotent: revoking an unknown or already-revoked token is a no-op. */
export function revokeSession(token: string): void {
  revokeSessionStmt.run({ $tokenHash: hashSessionToken(token) });
}

// --- Per-owner pause (WU-P3) --------------------------------------------------
//
// Independent of the global kill switch (`getControlState`/`setControlState`
// above): a paused owner blocks only their own mandates' `/sign` calls
// (pipeline.ts's `checkPolicy`), while every other owner keeps signing
// normally. Keyed by lowercased address so a checksum-cased and lowercase
// lookup for the same wallet always hit the same row.

export interface OwnerControlState {
  paused: boolean;
  pausedAt?: string;
  reason?: string;
}

const getOwnerControlStmt = db.prepare(`SELECT paused, paused_at, reason FROM owner_control WHERE address = $address`);
const upsertOwnerControlStmt = db.prepare(
  `INSERT INTO owner_control (address, paused, paused_at, reason) VALUES ($address, $paused, $pausedAt, $reason)
   ON CONFLICT(address) DO UPDATE SET paused = excluded.paused, paused_at = excluded.paused_at, reason = excluded.reason`,
);

/** Defaults to not-paused for an owner with no row yet. */
export function getOwnerControl(address: string): OwnerControlState {
  const row = getOwnerControlStmt.get({ $address: address.toLowerCase() }) as
    | { paused: number; paused_at: string | null; reason: string | null }
    | null;
  if (!row) return { paused: false };
  return { paused: Boolean(row.paused), pausedAt: row.paused_at ?? undefined, reason: row.reason ?? undefined };
}

export function setOwnerControl(address: string, paused: boolean, reason?: string): OwnerControlState {
  upsertOwnerControlStmt.run({
    $address: address.toLowerCase(),
    $paused: paused ? 1 : 0,
    $pausedAt: paused ? new Date().toISOString() : null,
    $reason: paused ? (reason ?? null) : null,
  });
  return getOwnerControl(address);
}
