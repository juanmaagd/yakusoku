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
  promiseAttestationSchema,
  stringifyWithBigint,
  taskIntentMessageSchema,
  type DecisionReceipt,
  type PromiseAttestation,
  type TaskIntentMessage,
  type Verdict,
} from "@yakusoku/shared";
import {
  generateAccountKey,
  generateAgentKey,
  generateSessionToken,
  hashAccountKey,
  hashAgentKey,
  hashSessionToken,
  hashesEqual,
} from "./auth";

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
  /**
   * P9.2 — set only on the `StoredIntent`-shaped adapter `promises.ts`'s
   * `promiseAsMandate` builds from a `StoredPromise` row, never on a real row
   * in the `intents` table. Lets pipeline.ts's `checkPolicy` and
   * approvals.ts's `settleApproved` tell "this mandate is a World-ID-only
   * promise" apart from "this mandate is a wallet-signed intent" without a
   * second parameter threaded through every call site — a plain wallet
   * intent from `getIntent` never sets these, so every existing check
   * (`intent.revoked`, `getOwnerControl(intent.signer)`, ...) is unaffected.
   */
  source?: "wallet" | "world_id";
  /** The owning account's id, only set for a `source: "world_id"` mandate. */
  accountId?: string;
  /** The backing promise's own status, only set for a `source: "world_id"`
   * mandate — `checkPolicy` refuses any promise that isn't `"active"`
   * (fail-closed), independent of the (always-`false`) `revoked` flag above. */
  promiseStatus?: PromiseStatus;
  /** H1 fix — the normalized origin (`scheme://host[:port]`) this
   * `source: "world_id"` promise is bound to (`StoredPromise.merchant`
   * below); `undefined` for a wallet-sourced `StoredIntent` (no merchant
   * concept — see README's limitations) AND for a promise created before
   * merchant binding existed. The `merchant` pipeline stage
   * (apps/firewall/merchant.ts) refuses fail-closed in either case. */
  merchant?: string;
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
 * lands while a World ID approval was still in flight. P9.2 adds
 * `world_id_wrong_human`: a doubtful-payment approval on a world_id-sourced
 * promise resolved with a real, valid, fresh World ID token — but for a
 * DIFFERENT human than the promise's own account (approvals.ts's
 * `settleApproved`). Fail-closed: the payment refuses under the existing
 * `world_id_denied` receipt state, this status just names the reason. */
export type PendingApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "error"
  | "paused"
  | "revoked"
  | "world_id_wrong_human";

// --- Accounts / connect / promises shared types (Phase 3, P9.1/P9.2) --------

/** A payment recipient this account's smart account allow-lists at deploy
 * time (P11.3a) — `label` is display-only, never sent on-chain. */
export interface AccountRecipient {
  address: `0x${string}`;
  label: string;
}

export interface StoredAccount {
  id: string;
  /** `keccak256` of the World ID ID token's `sub` claim — never the raw
   * subject (see `hashWorldIdSubject`, packages/shared/step-up.ts). */
  subjectHash: `0x${string}`;
  createdAt: string;
  /** P11.3a — set once `POST /setup/:token/owner` deploys this account's
   * `OmamorisanAccount`. `undefined` until then. */
  smartAccount?: `0x${string}`;
  /** The wallet that linked itself as this account's owner (verified by
   * signature over the setup message, account-setup.ts) — same value as
   * `smartAccount`'s on-chain `owner()`. */
  owner?: `0x${string}`;
  /** Atomic USDC units — the `perPaymentLimit` this account's smart account
   * was actually deployed with (recorded here so `GET /account`/`GET
   * /setup/:token` keep reporting the real deployed value even if the
   * `OMAMORISAN_DEFAULT_PER_PAYMENT_LIMIT_USDC` env default changes later).
   * `undefined` before deployment. */
  perPaymentLimitAtomic?: bigint;
  /** The recipient allow-list this account's smart account was actually
   * deployed with — same "freeze what was deployed" reasoning as
   * `perPaymentLimitAtomic`. `undefined` before deployment. */
  recipients?: AccountRecipient[];
  /** The `createAccount` deployment transaction hash — `undefined` before
   * deployment, and also `undefined` for a `stub` deployer (no transaction
   * was ever sent; see `account-setup.ts`'s `AccountDeployer`). */
  deployTxHash?: `0x${string}`;
}

/**
 * P11.2 — test/scenario-only overrides for the funding stage's STUB
 * account-health reader (`funding.ts`, `OMAMORISAN_ACCOUNT_READER=stub`).
 * Never read by the `real` reader (which always reads live on-chain state)
 * and never set outside a test or the dev-only `POST /dev/accounts/:id/health`
 * route (index.ts, itself gated on the same env var) — lets a scenario force
 * paused/recipient/limit/balance states deterministically without a real
 * deployed contract or any chain state. `undefined` fields fall back to the
 * stub reader's own defaults (see funding.ts).
 */
export interface AccountHealthOverride {
  paused?: boolean;
  recipientAllowed?: boolean;
  perPaymentLimitAtomic?: bigint;
  balanceAtomic?: bigint;
}

export type ConnectStatus = "pending" | "approved" | "denied" | "expired" | "error";

/**
 * A `POST /connect` device flow in flight or resolved (P9.1) — same
 * "persist everything the device flow needs to resume" shape as
 * `PendingApproval` above, plus the account-issuance bookkeeping specific to
 * connect: `pendingAccountKey` holds the freshly minted RAW account key
 * (P9.1's `ya_...`) only until the first successful `POST /connect/poll`
 * delivers it (`keyDelivered` flips to `true` and the raw value is cleared —
 * see accounts.ts's `deliverConnectAccountKey`), so a later poll can report
 * `status:"approved"` forever without ever handing the key out again.
 */
export interface ConnectRequest {
  id: string;
  pollSecretHash: string;
  deviceCode: string;
  status: ConnectStatus;
  accountId?: string;
  pendingAccountKey?: string;
  keyDelivered: boolean;
  reason?: string;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  intervalSeconds: number;
  requestedAt: string;
  gateStartedAtMs: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export type PromiseStatus = "pending_approval" | "active" | "denied" | "expired" | "revoked" | "error";

/**
 * A promise (P9.2) — the World-ID-only replacement for a wallet-signed
 * `TaskIntent` (`StoredIntent` above). Deliberately its OWN table rather than
 * extra nullable columns bolted onto `intents`: the wallet path's `signature`
 * / `signer` columns are `NOT NULL` and pervasively assumed non-empty
 * throughout this file and index.ts's owner-scoping routes, so reusing that
 * table would mean loosening those constraints for every existing wallet
 * mandate too. `promises.ts`'s `promiseAsMandate` adapts a `StoredPromise`
 * into the SAME `StoredIntent` shape pipeline.ts/jev.ts/provenance.ts already
 * read, so the pipeline itself never needs to know which table a mandate
 * came from — see `StoredIntent.source` above.
 */
export interface StoredPromise {
  id: string;
  accountId: string;
  task: string;
  budget: bigint;
  categories: string[];
  expiry: bigint;
  nonce: `0x${string}`;
  /** H1 fix (GitHub issue #1) — the normalized origin
   * (`scheme://host[:port]`, `merchant.ts`'s `normalizeMerchantOrigin`) this
   * promise may pay; set once at creation (`POST /promises`) and never
   * changed. `undefined` only for a promise row created before this column
   * existed — the pipeline's `merchant` stage refuses those fail-closed
   * rather than treating a missing bind as "any origin". */
  merchant?: string;
  /** Atomic USDC units already committed/reserved — same semantics as
   * `StoredIntent.spent`, updated through the same `recordSpend`. */
  spent: bigint;
  status: PromiseStatus;
  reason?: string;
  /** Firewall-generated human-readable one-liner shown while approving
   * (`POST /promises`' response, `GET /promises/:id` while pending). */
  summary: string;
  deviceCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  userCode?: string;
  intervalSeconds?: number;
  requestedAt?: string;
  gateStartedAtMs?: number;
  /** Approval-window deadline while `status === "pending_approval"`. */
  expiresAt?: string;
  attestation?: PromiseAttestation;
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
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    subject_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    smart_account TEXT,
    owner TEXT,
    per_payment_limit_atomic TEXT,
    recipients_json TEXT,
    deploy_tx_hash TEXT
  );
  CREATE TABLE IF NOT EXISTS account_keys (
    key_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS account_keys_account_id ON account_keys (account_id);
  CREATE TABLE IF NOT EXISTS connect_requests (
    id TEXT PRIMARY KEY,
    poll_secret_hash TEXT NOT NULL,
    device_code TEXT NOT NULL,
    status TEXT NOT NULL,
    account_id TEXT,
    pending_account_key TEXT,
    key_delivered INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    verification_uri TEXT NOT NULL,
    verification_uri_complete TEXT,
    user_code TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    gate_started_at_ms INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS connect_requests_status ON connect_requests (status);
  CREATE TABLE IF NOT EXISTS promises (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    task TEXT NOT NULL,
    budget TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    expiry TEXT NOT NULL,
    nonce TEXT NOT NULL,
    merchant TEXT,
    spent TEXT NOT NULL DEFAULT '0',
    status TEXT NOT NULL,
    reason TEXT,
    summary TEXT NOT NULL,
    device_code TEXT,
    verification_uri TEXT,
    verification_uri_complete TEXT,
    user_code TEXT,
    interval_seconds INTEGER,
    requested_at TEXT,
    gate_started_at_ms INTEGER,
    expires_at TEXT,
    attestation_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS promises_account_id ON promises (account_id);
  CREATE INDEX IF NOT EXISTS promises_status ON promises (status);
  CREATE TABLE IF NOT EXISTS setup_tokens (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS setup_tokens_account_id ON setup_tokens (account_id);
  CREATE TABLE IF NOT EXISTS first_promise_requests (
    id TEXT PRIMARY KEY,
    poll_secret_hash TEXT NOT NULL,
    device_code TEXT NOT NULL,
    status TEXT NOT NULL,
    account_id TEXT,
    pending_account_key TEXT,
    key_delivered INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    task TEXT NOT NULL,
    budget TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    expiry TEXT NOT NULL,
    nonce TEXT NOT NULL,
    merchant TEXT NOT NULL,
    summary TEXT NOT NULL,
    verification_uri TEXT NOT NULL,
    verification_uri_complete TEXT,
    user_code TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    gate_started_at_ms INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS first_promise_requests_status ON first_promise_requests (status);
  CREATE TABLE IF NOT EXISTS account_health_overrides (
    account_id TEXT PRIMARY KEY,
    paused INTEGER,
    recipient_allowed INTEGER,
    per_payment_limit_atomic TEXT,
    balance_atomic TEXT,
    updated_at TEXT NOT NULL
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

// H1 fix migration: `promises` may already exist from before the `merchant`
// column did (the live dev sqlite file under data/) — add it by hand,
// nullable, when missing. A pre-existing promise row then reads back with
// `merchant: undefined`, which the pipeline's `merchant` stage refuses
// fail-closed rather than treating as "any origin".
{
  const existingPromiseColumns = new Set(
    (db.prepare(`PRAGMA table_info(promises)`).all() as { name: string }[]).map((row) => row.name),
  );
  if (!existingPromiseColumns.has("merchant")) {
    db.exec(`ALTER TABLE promises ADD COLUMN merchant TEXT`);
  }
}

// P11.3a migration: `accounts` may already exist from before the deployment
// columns did (a live dev sqlite file under data/) — add them by hand,
// nullable, when missing. A pre-existing account row then reads back with
// every deployment field `undefined`, exactly like an account that has
// simply never been set up yet.
{
  const existingAccountColumns = new Set(
    (db.prepare(`PRAGMA table_info(accounts)`).all() as { name: string }[]).map((row) => row.name),
  );
  for (const column of ["smart_account", "owner", "per_payment_limit_atomic", "recipients_json", "deploy_tx_hash"]) {
    if (!existingAccountColumns.has(column)) {
      db.exec(`ALTER TABLE accounts ADD COLUMN ${column} TEXT`);
    }
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

// P9.1 accounts / account keys.
const insertAccountStmt = db.prepare(`INSERT INTO accounts (id, subject_hash, created_at) VALUES ($id, $subjectHash, $createdAt)`);
const getAccountBySubjectHashStmt = db.prepare(`SELECT * FROM accounts WHERE subject_hash = $subjectHash`);
const getAccountStmt = db.prepare(`SELECT * FROM accounts WHERE id = $id`);
// P11.3a — the ONLY writer of the deployment columns; every other account
// write (`insertAccountStmt`) leaves them NULL.
const setAccountDeploymentStmt = db.prepare(
  `UPDATE accounts SET
     smart_account = $smartAccount, owner = $owner, per_payment_limit_atomic = $perPaymentLimitAtomic,
     recipients_json = $recipientsJson, deploy_tx_hash = $deployTxHash
   WHERE id = $id`,
);
// P11.2 — stub account-health overrides (funding.ts). `upsert...` merges by
// reading-then-writing at the call site (`setAccountHealthOverride` below),
// not via SQL `ON CONFLICT`, since a partial override (e.g. only `paused`)
// must never clobber a previously-set field (e.g. `balanceAtomic`).
const upsertAccountHealthOverrideStmt = db.prepare(
  `INSERT INTO account_health_overrides (account_id, paused, recipient_allowed, per_payment_limit_atomic, balance_atomic, updated_at)
   VALUES ($accountId, $paused, $recipientAllowed, $perPaymentLimitAtomic, $balanceAtomic, $updatedAt)
   ON CONFLICT(account_id) DO UPDATE SET
     paused = excluded.paused, recipient_allowed = excluded.recipient_allowed,
     per_payment_limit_atomic = excluded.per_payment_limit_atomic, balance_atomic = excluded.balance_atomic,
     updated_at = excluded.updated_at`,
);
const getAccountHealthOverrideStmt = db.prepare(`SELECT * FROM account_health_overrides WHERE account_id = $accountId`);

const insertAccountKeyStmt = db.prepare(
  `INSERT INTO account_keys (key_hash, account_id, created_at, revoked) VALUES ($keyHash, $accountId, $createdAt, 0)`,
);
// Only unrevoked keys can ever authenticate — same dataset-stays-small
// constant-time-scan tradeoff `findIntentByAgentKey` documents.
const listActiveAccountKeysStmt = db.prepare(`SELECT * FROM account_keys WHERE revoked = 0`);

// P9.1 connect requests.
const insertConnectRequestStmt = db.prepare(
  `INSERT INTO connect_requests (
     id, poll_secret_hash, device_code, status, account_id, pending_account_key, key_delivered, reason,
     verification_uri, verification_uri_complete, user_code, interval_seconds, requested_at, gate_started_at_ms,
     expires_at, created_at, updated_at
   ) VALUES (
     $id, $pollSecretHash, $deviceCode, $status, $accountId, $pendingAccountKey, $keyDelivered, $reason,
     $verificationUri, $verificationUriComplete, $userCode, $intervalSeconds, $requestedAt, $gateStartedAtMs,
     $expiresAt, $createdAt, $updatedAt
   )`,
);
const updateConnectRequestStmt = db.prepare(
  `UPDATE connect_requests SET
     status = $status, account_id = $accountId, pending_account_key = $pendingAccountKey,
     key_delivered = $keyDelivered, reason = $reason, interval_seconds = $intervalSeconds, updated_at = $updatedAt
   WHERE id = $id`,
);
const getConnectRequestStmt = db.prepare(`SELECT * FROM connect_requests WHERE id = $id`);
const listConnectRequestsByStatusStmt = db.prepare(`SELECT * FROM connect_requests WHERE status = $status`);

// P9.2 promises.
const insertPromiseStmt = db.prepare(
  `INSERT INTO promises (
     id, account_id, task, budget, categories_json, expiry, nonce, merchant, spent, status, reason, summary,
     device_code, verification_uri, verification_uri_complete, user_code, interval_seconds, requested_at,
     gate_started_at_ms, expires_at, attestation_json, created_at, updated_at
   ) VALUES (
     $id, $accountId, $task, $budget, $categoriesJson, $expiry, $nonce, $merchant, $spent, $status, $reason, $summary,
     $deviceCode, $verificationUri, $verificationUriComplete, $userCode, $intervalSeconds, $requestedAt,
     $gateStartedAtMs, $expiresAt, $attestationJson, $createdAt, $updatedAt
   )`,
);
// Full-row update for every mutable field — same "rewrite everything on each
// transition" pattern `savePendingApproval` uses for a `PendingApproval`.
const updatePromiseStmt = db.prepare(
  `UPDATE promises SET
     status = $status, reason = $reason, spent = $spent, device_code = $deviceCode,
     verification_uri = $verificationUri, verification_uri_complete = $verificationUriComplete,
     user_code = $userCode, interval_seconds = $intervalSeconds, expires_at = $expiresAt,
     attestation_json = $attestationJson, updated_at = $updatedAt
   WHERE id = $id`,
);
// Narrow statement `recordSpend` uses so a budget reservation/release never
// has to round-trip every other promise column.
const updatePromiseSpentStmt = db.prepare(`UPDATE promises SET spent = $spent WHERE id = $id`);
const getPromiseStmt = db.prepare(`SELECT * FROM promises WHERE id = $id`);
const listPromisesByAccountStmt = db.prepare(`SELECT * FROM promises WHERE account_id = $accountId ORDER BY created_at DESC`);
const countPromisesByAccountAndStatusStmt = db.prepare(
  `SELECT COUNT(*) as count FROM promises WHERE account_id = $accountId AND status = $status`,
);
const listPromisesByStatusStmt = db.prepare(`SELECT * FROM promises WHERE status = $status`);

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
  if (row) {
    const newSpent = BigInt(row.spent) + amount;
    updateSpentStmt.run({ $spent: newSpent.toString(), $id: intentId });
    return;
  }
  // P9.2: a world_id-sourced mandate's budget lives on its OWN row in the
  // `promises` table (there is no corresponding `intents` row for it —
  // `promiseAsMandate`, promises.ts, only ever builds an in-memory adapter),
  // so a miss above falls through here instead of throwing. Same reserve
  // (positive)/release (negative) semantics as the wallet path above.
  const promiseRow = getPromiseStmt.get({ $id: intentId }) as PromiseRow | null;
  if (promiseRow) {
    const newSpent = BigInt(promiseRow.spent) + amount;
    updatePromiseSpentStmt.run({ $spent: newSpent.toString(), $id: intentId });
    return;
  }
  throw new Error(`recordSpend: unknown intentId ${intentId}`);
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

// --- Accounts (Phase 3, P9.1) ------------------------------------------------
//
// One account per human, identified by the `keccak256` hash of their World
// ID `sub` claim (never the raw subject — `hashWorldIdSubject`,
// packages/shared/step-up.ts). `accounts.ts` finds-or-creates one every time
// a `POST /connect` device flow resolves `approved`, so reconnecting the
// same human (a second agent, a reinstalled MCP client, ...) reuses their
// existing account and mints a fresh account key rather than a duplicate.

interface AccountRow {
  id: string;
  subject_hash: string;
  created_at: string;
  smart_account: string | null;
  owner: string | null;
  per_payment_limit_atomic: string | null;
  recipients_json: string | null;
  deploy_tx_hash: string | null;
}

function rowToAccount(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    subjectHash: row.subject_hash as `0x${string}`,
    createdAt: row.created_at,
    smartAccount: (row.smart_account as `0x${string}` | null) ?? undefined,
    owner: (row.owner as `0x${string}` | null) ?? undefined,
    perPaymentLimitAtomic: row.per_payment_limit_atomic ? BigInt(row.per_payment_limit_atomic) : undefined,
    recipients: row.recipients_json ? (JSON.parse(row.recipients_json) as AccountRecipient[]) : undefined,
    deployTxHash: (row.deploy_tx_hash as `0x${string}` | null) ?? undefined,
  };
}

export function findOrCreateAccountBySubjectHash(subjectHash: `0x${string}`): StoredAccount {
  const existing = getAccountBySubjectHashStmt.get({ $subjectHash: subjectHash }) as AccountRow | null;
  if (existing) return rowToAccount(existing);
  const account: StoredAccount = { id: `account_${crypto.randomUUID()}`, subjectHash, createdAt: new Date().toISOString() };
  insertAccountStmt.run({ $id: account.id, $subjectHash: subjectHash, $createdAt: account.createdAt });
  return account;
}

export function getAccount(id: string): StoredAccount | undefined {
  const row = getAccountStmt.get({ $id: id }) as AccountRow | null;
  return row ? rowToAccount(row) : undefined;
}

/** P11.3a — `POST /setup/:token/owner`'s only write path. Persists exactly
 * what was actually deployed (never the live env defaults, which may drift
 * later) so `GET /account`/`GET /setup/:token` keep reporting the true
 * on-chain configuration forever after. */
export function setAccountDeployment(
  accountId: string,
  deployment: {
    smartAccount: `0x${string}`;
    owner: `0x${string}`;
    perPaymentLimitAtomic: bigint;
    recipients: AccountRecipient[];
    deployTxHash?: `0x${string}`;
  },
): void {
  setAccountDeploymentStmt.run({
    $id: accountId,
    $smartAccount: deployment.smartAccount,
    $owner: deployment.owner,
    $perPaymentLimitAtomic: deployment.perPaymentLimitAtomic.toString(),
    $recipientsJson: JSON.stringify(deployment.recipients),
    $deployTxHash: deployment.deployTxHash ?? null,
  });
}

interface AccountHealthOverrideRow {
  account_id: string;
  paused: number | null;
  recipient_allowed: number | null;
  per_payment_limit_atomic: string | null;
  balance_atomic: string | null;
  updated_at: string;
}

/** P11.2 — reads this account's stub-reader override, if any (funding.ts). */
export function getAccountHealthOverride(accountId: string): AccountHealthOverride | undefined {
  const row = getAccountHealthOverrideStmt.get({ $accountId: accountId }) as AccountHealthOverrideRow | null;
  if (!row) return undefined;
  return {
    paused: row.paused === null ? undefined : row.paused === 1,
    recipientAllowed: row.recipient_allowed === null ? undefined : row.recipient_allowed === 1,
    perPaymentLimitAtomic: row.per_payment_limit_atomic ? BigInt(row.per_payment_limit_atomic) : undefined,
    balanceAtomic: row.balance_atomic ? BigInt(row.balance_atomic) : undefined,
  };
}

/** P11.2 — merges `override` onto whatever's already set for `accountId`
 * (never clobbers a field the caller left `undefined`), for the stub
 * account-health reader only. Test-only / dev-seam-only writer — see
 * `AccountHealthOverride`'s doc comment. */
export function setAccountHealthOverride(accountId: string, override: AccountHealthOverride): void {
  const merged: AccountHealthOverride = { ...getAccountHealthOverride(accountId), ...override };
  upsertAccountHealthOverrideStmt.run({
    $accountId: accountId,
    $paused: merged.paused === undefined ? null : merged.paused ? 1 : 0,
    $recipientAllowed: merged.recipientAllowed === undefined ? null : merged.recipientAllowed ? 1 : 0,
    $perPaymentLimitAtomic: merged.perPaymentLimitAtomic?.toString() ?? null,
    $balanceAtomic: merged.balanceAtomic?.toString() ?? null,
    $updatedAt: new Date().toISOString(),
  });
}

/** Mints a fresh account credential (`ya_...`) bound to `accountId` — the raw
 * key is returned so the caller (accounts.ts) can deliver it exactly once via
 * `POST /connect/poll`; only its SHA-256 hash is persisted. */
export function createAccountKey(accountId: string): string {
  const accountKey = generateAccountKey();
  insertAccountKeyStmt.run({
    $keyHash: hashAccountKey(accountKey),
    $accountId: accountId,
    $createdAt: new Date().toISOString(),
  });
  return accountKey;
}

interface AccountKeyRow {
  account_id: string;
  key_hash: string;
}

/** Constant-time scan against every unrevoked account key — same
 * dataset-stays-small tradeoff `findIntentByAgentKey` documents, chosen for
 * the same reason (no timing side-channel tied to key material). */
export function findAccountByAccountKey(accountKey: string): StoredAccount | undefined {
  const providedHash = hashAccountKey(accountKey);
  const rows = listActiveAccountKeysStmt.all() as AccountKeyRow[];
  for (const row of rows) {
    if (hashesEqual(row.key_hash, providedHash)) return getAccount(row.account_id);
  }
  return undefined;
}

// --- Connect requests (Phase 3, P9.1) ---------------------------------------

interface ConnectRequestRow {
  id: string;
  poll_secret_hash: string;
  device_code: string;
  status: string;
  account_id: string | null;
  pending_account_key: string | null;
  key_delivered: number;
  reason: string | null;
  verification_uri: string;
  verification_uri_complete: string | null;
  user_code: string;
  interval_seconds: number;
  requested_at: string;
  gate_started_at_ms: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function rowToConnectRequest(row: ConnectRequestRow): ConnectRequest {
  return {
    id: row.id,
    pollSecretHash: row.poll_secret_hash,
    deviceCode: row.device_code,
    status: row.status as ConnectStatus,
    accountId: row.account_id ?? undefined,
    pendingAccountKey: row.pending_account_key ?? undefined,
    keyDelivered: Boolean(row.key_delivered),
    reason: row.reason ?? undefined,
    verificationUri: row.verification_uri,
    verificationUriComplete: row.verification_uri_complete ?? undefined,
    userCode: row.user_code,
    intervalSeconds: row.interval_seconds,
    requestedAt: row.requested_at,
    gateStartedAtMs: row.gate_started_at_ms,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createConnectRequest(request: ConnectRequest): void {
  insertConnectRequestStmt.run({
    $id: request.id,
    $pollSecretHash: request.pollSecretHash,
    $deviceCode: request.deviceCode,
    $status: request.status,
    $accountId: request.accountId ?? null,
    $pendingAccountKey: request.pendingAccountKey ?? null,
    $keyDelivered: request.keyDelivered ? 1 : 0,
    $reason: request.reason ?? null,
    $verificationUri: request.verificationUri,
    $verificationUriComplete: request.verificationUriComplete ?? null,
    $userCode: request.userCode,
    $intervalSeconds: request.intervalSeconds,
    $requestedAt: request.requestedAt,
    $gateStartedAtMs: request.gateStartedAtMs,
    $expiresAt: request.expiresAt,
    $createdAt: request.createdAt,
    $updatedAt: request.updatedAt,
  });
}

/** Full-row update for every mutable field (status/account/key-delivery/
 * reason/interval) — the same "rewrite on each transition" pattern
 * `savePendingApproval` uses. */
export function saveConnectRequest(request: ConnectRequest): void {
  updateConnectRequestStmt.run({
    $id: request.id,
    $status: request.status,
    $accountId: request.accountId ?? null,
    $pendingAccountKey: request.pendingAccountKey ?? null,
    $keyDelivered: request.keyDelivered ? 1 : 0,
    $reason: request.reason ?? null,
    $intervalSeconds: request.intervalSeconds,
    $updatedAt: request.updatedAt,
  });
}

export function getConnectRequest(id: string): ConnectRequest | undefined {
  const row = getConnectRequestStmt.get({ $id: id }) as ConnectRequestRow | null;
  return row ? rowToConnectRequest(row) : undefined;
}

/** Every connect request still awaiting a human, for resuming on boot
 * (accounts.ts's `resumeConnectRequestsOnBoot`). */
export function listConnectRequestsByStatus(status: ConnectStatus): ConnectRequest[] {
  const rows = listConnectRequestsByStatusStmt.all({ $status: status }) as ConnectRequestRow[];
  return rows.map(rowToConnectRequest);
}

// --- Promises (Phase 3, P9.2) ------------------------------------------------

interface PromiseRow {
  id: string;
  account_id: string;
  task: string;
  budget: string;
  categories_json: string;
  expiry: string;
  nonce: string;
  merchant: string | null;
  spent: string;
  status: string;
  reason: string | null;
  summary: string;
  device_code: string | null;
  verification_uri: string | null;
  verification_uri_complete: string | null;
  user_code: string | null;
  interval_seconds: number | null;
  requested_at: string | null;
  gate_started_at_ms: number | null;
  expires_at: string | null;
  attestation_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToPromise(row: PromiseRow): StoredPromise {
  return {
    id: row.id,
    accountId: row.account_id,
    task: row.task,
    budget: BigInt(row.budget),
    categories: JSON.parse(row.categories_json) as string[],
    expiry: BigInt(row.expiry),
    nonce: row.nonce as `0x${string}`,
    merchant: row.merchant ?? undefined,
    spent: BigInt(row.spent),
    status: row.status as PromiseStatus,
    reason: row.reason ?? undefined,
    summary: row.summary,
    deviceCode: row.device_code ?? undefined,
    verificationUri: row.verification_uri ?? undefined,
    verificationUriComplete: row.verification_uri_complete ?? undefined,
    userCode: row.user_code ?? undefined,
    intervalSeconds: row.interval_seconds ?? undefined,
    requestedAt: row.requested_at ?? undefined,
    gateStartedAtMs: row.gate_started_at_ms ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    attestation: row.attestation_json ? promiseAttestationSchema.parse(JSON.parse(row.attestation_json)) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPromise(promise: StoredPromise): void {
  insertPromiseStmt.run({
    $id: promise.id,
    $accountId: promise.accountId,
    $task: promise.task,
    $budget: promise.budget.toString(),
    $categoriesJson: JSON.stringify(promise.categories),
    $expiry: promise.expiry.toString(),
    $nonce: promise.nonce,
    $merchant: promise.merchant ?? null,
    $spent: promise.spent.toString(),
    $status: promise.status,
    $reason: promise.reason ?? null,
    $summary: promise.summary,
    $deviceCode: promise.deviceCode ?? null,
    $verificationUri: promise.verificationUri ?? null,
    $verificationUriComplete: promise.verificationUriComplete ?? null,
    $userCode: promise.userCode ?? null,
    $intervalSeconds: promise.intervalSeconds ?? null,
    $requestedAt: promise.requestedAt ?? null,
    $gateStartedAtMs: promise.gateStartedAtMs ?? null,
    $expiresAt: promise.expiresAt ?? null,
    $attestationJson: promise.attestation ? JSON.stringify(promise.attestation) : null,
    $createdAt: promise.createdAt,
    $updatedAt: promise.updatedAt,
  });
}

/** Full-row update for every mutable field — promises.ts's approval resolver
 * rewrites this on each transition, same pattern `savePendingApproval` uses
 * for a `PendingApproval`. Budget (`spent`) is included so a caller can use
 * either this or the narrower `recordSpend` (store.ts) interchangeably. */
export function savePromise(promise: StoredPromise): void {
  updatePromiseStmt.run({
    $id: promise.id,
    $status: promise.status,
    $reason: promise.reason ?? null,
    $spent: promise.spent.toString(),
    $deviceCode: promise.deviceCode ?? null,
    $verificationUri: promise.verificationUri ?? null,
    $verificationUriComplete: promise.verificationUriComplete ?? null,
    $userCode: promise.userCode ?? null,
    $intervalSeconds: promise.intervalSeconds ?? null,
    $expiresAt: promise.expiresAt ?? null,
    $attestationJson: promise.attestation ? JSON.stringify(promise.attestation) : null,
    $updatedAt: promise.updatedAt,
  });
}

export function getPromise(id: string): StoredPromise | undefined {
  const row = getPromiseStmt.get({ $id: id }) as PromiseRow | null;
  return row ? rowToPromise(row) : undefined;
}

/** Latest-first, for `GET /promises` (index.ts) and `GET /account`'s
 * `promises` summaries. */
export function listPromisesByAccount(accountId: string): StoredPromise[] {
  const rows = listPromisesByAccountStmt.all({ $accountId: accountId }) as PromiseRow[];
  return rows.map(rowToPromise);
}

/** How many of this account's promises are currently awaiting a human —
 * `OMAMORISAN_MAX_PENDING_PROMISES` (promises.ts) caps this. */
export function countPendingPromisesForAccount(accountId: string): number {
  const row = countPromisesByAccountAndStatusStmt.get({ $accountId: accountId, $status: "pending_approval" }) as
    | { count: number }
    | null;
  return row?.count ?? 0;
}

/** Every promise still awaiting a human, for resuming on boot
 * (promises.ts's `resumePromiseApprovalsOnBoot`). */
export function listPromisesByStatus(status: PromiseStatus): StoredPromise[] {
  const rows = listPromisesByStatusStmt.all({ $status: status }) as PromiseRow[];
  return rows.map(rowToPromise);
}

// --- Setup tokens (P11.3a) ----------------------------------------------------
//
// `POST /accounts/setup-link` mints one of these; the RAW token is the
// credential a browser presents to `GET /setup/:token` / `POST
// /setup/:token/owner` (account-setup.ts) — only its SHA-256 hash is ever
// persisted, same discipline as every other bearer secret in this file
// (`hashAccountKey`/`hashSessionToken`/`hashConnectPollSecret`, auth.ts).

export interface SetupToken {
  accountId: string;
  createdAt: string;
  expiresAt: string;
}

const insertSetupTokenStmt = db.prepare(
  `INSERT INTO setup_tokens (token_hash, account_id, created_at, expires_at) VALUES ($tokenHash, $accountId, $createdAt, $expiresAt)`,
);
const getSetupTokenStmt = db.prepare(`SELECT account_id, created_at, expires_at FROM setup_tokens WHERE token_hash = $tokenHash`);

export function createSetupToken(tokenHash: string, accountId: string, expiresAt: string): void {
  insertSetupTokenStmt.run({ $tokenHash: tokenHash, $accountId: accountId, $createdAt: new Date().toISOString(), $expiresAt: expiresAt });
}

/** Looks up a setup token by the SHA-256 hash of its raw value. Returns
 * `undefined` for an unknown token — account-setup.ts's callers treat that
 * identically to an expired one (404, never confirms whether some OTHER
 * token would have worked). Expiry itself is deliberately NOT checked here:
 * once an account is deployed the token stays a valid (idempotent) credential
 * forever after (root API contract: "reusable until the account is
 * deployed") — account-setup.ts checks `expiresAt` only for an account that
 * hasn't deployed yet. */
export function getSetupToken(tokenHash: string): SetupToken | undefined {
  const row = getSetupTokenStmt.get({ $tokenHash: tokenHash }) as { account_id: string; created_at: string; expires_at: string } | null;
  return row ? { accountId: row.account_id, createdAt: row.created_at, expiresAt: row.expires_at } : undefined;
}

// --- First promise requests (P9.6) --------------------------------------------
//
// `POST /promises/first` (first-promise.ts) — the single-World-ID-approval
// path that creates an account AND its first promise together, for an MCP
// session that has no credential at all yet. Same device-flow-resumption
// shape as `ConnectRequest`/`PendingApproval`/`StoredPromise` above, plus the
// promise fields needed to build the real `StoredPromise` row once approved
// (there is no account yet to hang a `promises` row off of until then).

export type FirstPromiseStatus = "pending" | "approved" | "denied" | "expired" | "error";

export interface FirstPromiseRequest {
  id: string;
  pollSecretHash: string;
  deviceCode: string;
  status: FirstPromiseStatus;
  accountId?: string;
  /** Raw account key, held only until the first successful poll after
   * approval delivers it — same one-time-delivery pattern as
   * `ConnectRequest.pendingAccountKey`. */
  pendingAccountKey?: string;
  keyDelivered: boolean;
  reason?: string;
  task: string;
  budget: bigint;
  categories: string[];
  expiry: bigint;
  nonce: `0x${string}`;
  merchant: string;
  summary: string;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  intervalSeconds: number;
  requestedAt: string;
  gateStartedAtMs: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

const insertFirstPromiseRequestStmt = db.prepare(
  `INSERT INTO first_promise_requests (
     id, poll_secret_hash, device_code, status, account_id, pending_account_key, key_delivered, reason,
     task, budget, categories_json, expiry, nonce, merchant, summary,
     verification_uri, verification_uri_complete, user_code, interval_seconds, requested_at,
     gate_started_at_ms, expires_at, created_at, updated_at
   ) VALUES (
     $id, $pollSecretHash, $deviceCode, $status, $accountId, $pendingAccountKey, $keyDelivered, $reason,
     $task, $budget, $categoriesJson, $expiry, $nonce, $merchant, $summary,
     $verificationUri, $verificationUriComplete, $userCode, $intervalSeconds, $requestedAt,
     $gateStartedAtMs, $expiresAt, $createdAt, $updatedAt
   )`,
);
const updateFirstPromiseRequestStmt = db.prepare(
  `UPDATE first_promise_requests SET
     status = $status, account_id = $accountId, pending_account_key = $pendingAccountKey,
     key_delivered = $keyDelivered, reason = $reason, interval_seconds = $intervalSeconds, updated_at = $updatedAt
   WHERE id = $id`,
);
const getFirstPromiseRequestStmt = db.prepare(`SELECT * FROM first_promise_requests WHERE id = $id`);
const listFirstPromiseRequestsByStatusStmt = db.prepare(`SELECT * FROM first_promise_requests WHERE status = $status`);

interface FirstPromiseRequestRow {
  id: string;
  poll_secret_hash: string;
  device_code: string;
  status: string;
  account_id: string | null;
  pending_account_key: string | null;
  key_delivered: number;
  reason: string | null;
  task: string;
  budget: string;
  categories_json: string;
  expiry: string;
  nonce: string;
  merchant: string;
  summary: string;
  verification_uri: string;
  verification_uri_complete: string | null;
  user_code: string;
  interval_seconds: number;
  requested_at: string;
  gate_started_at_ms: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

function rowToFirstPromiseRequest(row: FirstPromiseRequestRow): FirstPromiseRequest {
  return {
    id: row.id,
    pollSecretHash: row.poll_secret_hash,
    deviceCode: row.device_code,
    status: row.status as FirstPromiseStatus,
    accountId: row.account_id ?? undefined,
    pendingAccountKey: row.pending_account_key ?? undefined,
    keyDelivered: Boolean(row.key_delivered),
    reason: row.reason ?? undefined,
    task: row.task,
    budget: BigInt(row.budget),
    categories: JSON.parse(row.categories_json) as string[],
    expiry: BigInt(row.expiry),
    nonce: row.nonce as `0x${string}`,
    merchant: row.merchant,
    summary: row.summary,
    verificationUri: row.verification_uri,
    verificationUriComplete: row.verification_uri_complete ?? undefined,
    userCode: row.user_code,
    intervalSeconds: row.interval_seconds,
    requestedAt: row.requested_at,
    gateStartedAtMs: row.gate_started_at_ms,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFirstPromiseRequest(request: FirstPromiseRequest): void {
  insertFirstPromiseRequestStmt.run({
    $id: request.id,
    $pollSecretHash: request.pollSecretHash,
    $deviceCode: request.deviceCode,
    $status: request.status,
    $accountId: request.accountId ?? null,
    $pendingAccountKey: request.pendingAccountKey ?? null,
    $keyDelivered: request.keyDelivered ? 1 : 0,
    $reason: request.reason ?? null,
    $task: request.task,
    $budget: request.budget.toString(),
    $categoriesJson: JSON.stringify(request.categories),
    $expiry: request.expiry.toString(),
    $nonce: request.nonce,
    $merchant: request.merchant,
    $summary: request.summary,
    $verificationUri: request.verificationUri,
    $verificationUriComplete: request.verificationUriComplete ?? null,
    $userCode: request.userCode,
    $intervalSeconds: request.intervalSeconds,
    $requestedAt: request.requestedAt,
    $gateStartedAtMs: request.gateStartedAtMs,
    $expiresAt: request.expiresAt,
    $createdAt: request.createdAt,
    $updatedAt: request.updatedAt,
  });
}

/** Full-row update for every mutable field — same "rewrite on each
 * transition" pattern `saveConnectRequest` uses for a `ConnectRequest`. */
export function saveFirstPromiseRequest(request: FirstPromiseRequest): void {
  updateFirstPromiseRequestStmt.run({
    $id: request.id,
    $status: request.status,
    $accountId: request.accountId ?? null,
    $pendingAccountKey: request.pendingAccountKey ?? null,
    $keyDelivered: request.keyDelivered ? 1 : 0,
    $reason: request.reason ?? null,
    $intervalSeconds: request.intervalSeconds,
    $updatedAt: request.updatedAt,
  });
}

export function getFirstPromiseRequest(id: string): FirstPromiseRequest | undefined {
  const row = getFirstPromiseRequestStmt.get({ $id: id }) as FirstPromiseRequestRow | null;
  return row ? rowToFirstPromiseRequest(row) : undefined;
}

/** Every first-promise request still awaiting a human, for resuming on boot
 * (first-promise.ts's `resumeFirstPromiseApprovalsOnBoot`). */
export function listFirstPromiseRequestsByStatus(status: FirstPromiseStatus): FirstPromiseRequest[] {
  const rows = listFirstPromiseRequestsByStatusStmt.all({ $status: status }) as FirstPromiseRequestRow[];
  return rows.map(rowToFirstPromiseRequest);
}
