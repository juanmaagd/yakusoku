// Promises (P9.2, odd/tasks/yakusoku.md Phase 3) — the World-ID-only
// replacement for a wallet-signed `TaskIntent` (task-intent.ts). A promise
// starts `pending_approval`, runs the SAME World ID device-flow shape
// accounts.ts's connect gate and approvals.ts's payment gate both use, and
// on a genuine approval FROM THE PROMISE'S OWN ACCOUNT becomes `active` and
// carries a firewall-signed PromiseAttestation
// (promise-attestation.ts/packages/shared/promise-attestation.ts) —
// portable evidence that a human approved exactly this task/budget/
// categories/expiry. Denied/expired/wrong-human are all terminal and never
// reusable (plan-tecnico.md §2.4 fail-closed contract).
//
// `promiseAsMandate`/`resolveMandate` below are the seam that lets
// pipeline.ts/approvals.ts treat a promise exactly like a wallet `StoredIntent`
// without knowing which table it came from — see `StoredIntent.source`
// (store.ts).

import { toHex } from "viem";
import { hashWorldIdSubject, USDC_DECIMALS } from "@yakusoku/shared";
import { publish } from "./events-bus";
import { normalizeMerchantOrigin } from "./merchant";
import { signPromiseAttestation } from "./promise-attestation";
import {
  countPendingPromisesForAccount,
  createPromise,
  getAccount,
  getIntent,
  getPromise,
  listPromisesByStatus,
  savePromise,
  type PromiseStatus,
  type StoredAccount,
  type StoredIntent,
  type StoredPromise,
} from "./store";
import { ACR_ORB_V3, pollUntilResolved, startDeviceAuthorization, validateIdToken, type FreshApprovalClaims } from "./world-id";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// --- Caps (env-configurable, fail-closed defaults) ---------------------------

const DEFAULT_MAX_PROMISE_USDC = 50;
const DEFAULT_MAX_PENDING_PROMISES = 3;
const MAX_PROMISE_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

function maxPromiseUsdc(): number {
  const raw = Number(process.env.OMAMORISAN_MAX_PROMISE_USDC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PROMISE_USDC;
}

function maxPendingPromises(): number {
  const raw = Number(process.env.OMAMORISAN_MAX_PENDING_PROMISES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_PENDING_PROMISES;
}

function approvalTimeoutSeconds(): number {
  // Same env knob as approvals.ts/accounts.ts — one operator-facing ceiling
  // for every World ID gate this firewall runs.
  const raw = Number(process.env.WORLD_ID_APPROVAL_TIMEOUT_S);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

function maxAuthAgeSeconds(): number {
  const raw = Number(process.env.WORLD_ID_MAX_AUTH_AGE_S);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

function randomNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// --- pipeline.ts/approvals.ts adapter ----------------------------------------

/** Adapts a `StoredPromise` into the SAME `StoredIntent` shape pipeline.ts,
 * jev.ts and provenance.ts already read — `source`/`accountId`/
 * `promiseStatus` are the only fields a wallet-sourced `StoredIntent` never
 * sets (store.ts). `signature`/`signer` are unused placeholders: nothing
 * downstream verifies a wallet signature for a world_id promise (there is
 * none to verify — the promise's authority is the World ID approval +
 * PromiseAttestation instead), and `signer` being the zero address means
 * `getOwnerControl(intent.signer)` (a wallet-only per-owner pause concept)
 * simply never matches any real owner for a promise-backed mandate. */
export function promiseAsMandate(promise: StoredPromise): StoredIntent {
  return {
    id: promise.id,
    message: {
      task: promise.task,
      budget: promise.budget,
      categories: promise.categories,
      expiry: promise.expiry,
      nonce: promise.nonce,
    },
    signature: "0x00",
    signer: ZERO_ADDRESS,
    spent: promise.spent,
    createdAt: promise.createdAt,
    revoked: false,
    source: "world_id",
    accountId: promise.accountId,
    promiseStatus: promise.status,
    merchant: promise.merchant,
  };
}

/** Resolves a mandate id to either a wallet `StoredIntent` or a
 * promise-backed adapter — pipeline.ts/approvals.ts use this instead of
 * `getIntent` directly so a `/sign`/approval-resolution call never needs to
 * know in advance which table a given id lives in. */
export function resolveMandate(id: string): StoredIntent | undefined {
  const intent = getIntent(id);
  if (intent) return intent;
  const promise = getPromise(id);
  return promise ? promiseAsMandate(promise) : undefined;
}

// --- Creating a promise -------------------------------------------------------

export interface CreatePromiseInput {
  task: string;
  /** Decimal USDC amount (e.g. `1.5`), already coerced from the request's
   * string/number `budgetUsdc` field by index.ts's zod schema. */
  budgetUsdc: number;
  categories: string[];
  expiresInSeconds: number;
  /** H1 fix — the store's URL (e.g. `http://localhost:4000`, path ignored);
   * normalized to its origin and stored as `StoredPromise.merchant`. The
   * merchant pipeline stage (merchant.ts) refuses any `resourceUrl` whose
   * origin isn't exactly this one. */
  merchant: string;
}

export type CreatePromiseOutcome =
  | { ok: true; promise: StoredPromise }
  | { ok: false; status: 400 | 429 | 502; error: string };

/** Exported so `first-promise.ts` (P9.6) builds the identical human-facing
 * approval text for its combined account+promise flow. */
export function buildPromiseSummary(
  task: string,
  budgetUsdc: number,
  categories: string[],
  expirySeconds: bigint,
  merchantOrigin: string,
): string {
  const expiryIso = new Date(Number(expirySeconds) * 1000).toISOString();
  // `merchantOrigin` is already validated http(s) (see `createPromiseRequest`),
  // so `new URL` here never throws; `.host` drops the scheme for a shorter,
  // human-facing "…at localhost:4000" (task text per the H1 fix).
  const merchantHost = new URL(merchantOrigin).host;
  return `Approve "${task}" — up to $${budgetUsdc.toFixed(2)} USDC across ${categories.join(", ")}, expiring ${expiryIso}, at ${merchantHost}.`;
}

export type ValidatedPromiseInput = { ok: true; merchantOrigin: string } | { ok: false; status: 400 | 429; error: string };

/**
 * Shared cap/shape validation for a promise request — budget bounds,
 * category count, expiry bounds, and merchant-origin normalization (H1 fix).
 * Exported so `first-promise.ts` (P9.6's single-World-ID-approval combined
 * account+promise flow) validates its own input identically, rather than
 * duplicating these constants and rules. `accountId` is optional: the P9.6
 * flow calls this BEFORE an account exists yet, so it has no pending-promise
 * count to check against (a brand-new account can only ever have zero).
 */
export function validatePromiseInput(input: CreatePromiseInput, accountId?: string): ValidatedPromiseInput {
  if (!Number.isFinite(input.budgetUsdc) || input.budgetUsdc <= 0) {
    return { ok: false, status: 400, error: "budgetUsdc must be a positive number" };
  }
  const maxUsdc = maxPromiseUsdc();
  if (input.budgetUsdc > maxUsdc) {
    return { ok: false, status: 400, error: `budgetUsdc exceeds the ${maxUsdc} USDC per-promise cap` };
  }
  if (input.categories.length < 1 || input.categories.length > 5) {
    return { ok: false, status: 400, error: "categories must have between 1 and 5 entries" };
  }
  if (!Number.isFinite(input.expiresInSeconds) || input.expiresInSeconds <= 0 || input.expiresInSeconds > MAX_PROMISE_EXPIRY_SECONDS) {
    return { ok: false, status: 400, error: `expiresInSeconds must be between 1 and ${MAX_PROMISE_EXPIRY_SECONDS} (7 days)` };
  }
  // H1 fix — bind this promise to one merchant origin up front; the pipeline
  // (merchant.ts) fail-closed refuses any resourceUrl outside it.
  const merchantResult = normalizeMerchantOrigin(input.merchant);
  if (!merchantResult.ok) {
    return { ok: false, status: 400, error: `invalid merchant: ${merchantResult.reason}` };
  }

  if (accountId !== undefined) {
    const pendingCount = countPendingPromisesForAccount(accountId);
    const maxPending = maxPendingPromises();
    if (pendingCount >= maxPending) {
      return { ok: false, status: 429, error: `too many pending promises for this account (max ${maxPending})` };
    }
  }

  return { ok: true, merchantOrigin: merchantResult.origin };
}

/** `POST /promises` (index.ts, account-key auth). Validates the caps
 * (per-promise budget, max pending promises per account, max expiry), then
 * starts a fresh World ID device flow bound to this exact promise — the
 * SAME device-authorization/poll/validate primitives (world-id.ts) WU11
 * already uses for payment approvals and accounts.ts uses for connect,
 * unmodified. */
export async function createPromiseRequest(account: StoredAccount, input: CreatePromiseInput): Promise<CreatePromiseOutcome> {
  const validated = validatePromiseInput(input, account.id);
  if (!validated.ok) return validated;
  const merchantOrigin = validated.merchantOrigin;

  let device: Awaited<ReturnType<typeof startDeviceAuthorization>>;
  try {
    device = await startDeviceAuthorization();
  } catch (err) {
    return { ok: false, status: 502, error: `could not start World ID approval: ${err instanceof Error ? err.message : String(err)}` };
  }

  const promiseId = `promise_${crypto.randomUUID()}`;
  const budgetAtomic = BigInt(Math.round(input.budgetUsdc * 10 ** USDC_DECIMALS));
  const expirySeconds = BigInt(Math.floor(Date.now() / 1000) + Math.floor(input.expiresInSeconds));
  const requestedAt = new Date();
  const deadlineMs = requestedAt.getTime() + Math.min(device.expiresIn, approvalTimeoutSeconds()) * 1000;
  const expiresAt = new Date(deadlineMs).toISOString();

  const promise: StoredPromise = {
    id: promiseId,
    accountId: account.id,
    task: input.task,
    budget: budgetAtomic,
    categories: input.categories,
    expiry: expirySeconds,
    nonce: randomNonce(),
    merchant: merchantOrigin,
    spent: 0n,
    status: "pending_approval",
    summary: buildPromiseSummary(input.task, input.budgetUsdc, input.categories, expirySeconds, merchantOrigin),
    deviceCode: device.deviceCode,
    verificationUri: device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
    userCode: device.userCode,
    intervalSeconds: device.interval,
    requestedAt: requestedAt.toISOString(),
    gateStartedAtMs: Date.now(),
    expiresAt,
    createdAt: requestedAt.toISOString(),
    updatedAt: requestedAt.toISOString(),
  };
  createPromise(promise);
  publish("promise.requested", { promiseId, accountId: account.id, summary: promise.summary });

  void resolvePromiseApprovalInBackground(promiseId).catch((err) => {
    console.error(`[promises] background resolution crashed for ${promiseId}`, err);
  });

  return { ok: true, promise };
}

// --- Resolving the gate --------------------------------------------------------

/** Approved + a valid, fresh ID token whose subject matches the promise's
 * OWN account: signs the PromiseAttestation and activates the promise. A
 * valid token for a DIFFERENT human is fail-closed `denied` with reason
 * `"world_id_wrong_human"` — the whole point of binding a promise to one
 * account (odd/tasks/yakusoku.md Phase 3 goal: "must be the account's own
 * sub"). Re-fetches the row and bails if it's no longer `pending_approval` —
 * guards the same real-vs-dev-seam race `accounts.ts` documents. */
export async function settlePromiseApproved(promiseId: string, claims: FreshApprovalClaims): Promise<void> {
  const fresh = getPromise(promiseId);
  if (!fresh || fresh.status !== "pending_approval") return;

  const account = getAccount(fresh.accountId);
  if (!account) {
    await settlePromiseRefused(promiseId, "error", "account no longer available when the promise resolved");
    return;
  }

  const subjectHash = hashWorldIdSubject(claims.sub);
  if (subjectHash.toLowerCase() !== account.subjectHash.toLowerCase()) {
    await settlePromiseRefused(promiseId, "denied", "world_id_wrong_human");
    return;
  }

  // H1 fix — a promise created before merchant binding existed can never
  // complete approval: there's no human-approved origin to attest to, and
  // the pipeline's `merchant` stage would refuse it fail-closed anyway.
  if (!fresh.merchant) {
    await settlePromiseRefused(promiseId, "error", "promise has no bound merchant (created before merchant binding existed)");
    return;
  }

  try {
    const attestation = await signPromiseAttestation({
      promiseId: fresh.id,
      accountId: fresh.accountId,
      task: fresh.task,
      budget: fresh.budget.toString(),
      categories: fresh.categories,
      expiry: fresh.expiry.toString(),
      nonce: fresh.nonce,
      merchant: fresh.merchant,
      worldIdSub: claims.sub,
      acr: claims.acr ?? ACR_ORB_V3,
      authTimeSeconds: claims.authTime,
    });
    savePromise({ ...fresh, status: "active", reason: "approved", attestation, updatedAt: new Date().toISOString() });
    publish("promise.approved", { promiseId: fresh.id, accountId: fresh.accountId });
  } catch (err) {
    await settlePromiseRefused(promiseId, "error", `signing the PromiseAttestation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Denied/expired/an invalid token/wrong human — refuse. Same re-fetch race
 * guard as `settlePromiseApproved`. Always publishes `promise.denied`
 * (P9.2's SSE list has no separate expired/error event — the dashboard
 * treats every non-approved terminal outcome the same way). */
export async function settlePromiseRefused(
  promiseId: string,
  status: Exclude<PromiseStatus, "pending_approval" | "active">,
  reason: string,
): Promise<void> {
  const fresh = getPromise(promiseId);
  if (!fresh || fresh.status !== "pending_approval") return;
  savePromise({ ...fresh, status, reason, updatedAt: new Date().toISOString() });
  publish("promise.denied", { promiseId: fresh.id, accountId: fresh.accountId, status, reason });
}

/** Drives one promise to a terminal outcome — same shape as
 * approvals.ts's `resolveApprovalInBackground` and accounts.ts's
 * `resolveConnectInBackground`. Resumable. */
export async function resolvePromiseApprovalInBackground(promiseId: string): Promise<void> {
  const promise = getPromise(promiseId);
  if (!promise || promise.status !== "pending_approval") return;
  if (!promise.deviceCode || !promise.intervalSeconds || !promise.expiresAt || !promise.requestedAt) {
    console.error(`[promises] promise ${promiseId} is pending_approval but missing device-flow fields — refusing`);
    await settlePromiseRefused(promiseId, "error", "malformed pending promise (missing device-flow fields)");
    return;
  }

  const deviceCode = promise.deviceCode;
  const deadlineMs = new Date(promise.expiresAt).getTime();
  const outcome = await pollUntilResolved({
    deviceCode,
    initialIntervalSeconds: promise.intervalSeconds,
    deadlineMs,
    onTick: (result, intervalSeconds) => {
      if (result.status !== "slow_down" || intervalSeconds === promise.intervalSeconds) return;
      const fresh = getPromise(promiseId);
      if (fresh && fresh.status === "pending_approval") {
        savePromise({ ...fresh, intervalSeconds, updatedAt: new Date().toISOString() });
      }
    },
  });

  switch (outcome.status) {
    case "approved": {
      const validation = await validateIdToken(outcome.idToken, {
        requestedAtSeconds: Math.floor(new Date(promise.requestedAt).getTime() / 1000),
        maxAuthAgeSeconds: maxAuthAgeSeconds(),
      });
      if (!validation.valid) {
        await settlePromiseRefused(promiseId, "error", `invalid World ID token: ${validation.reason}`);
        return;
      }
      await settlePromiseApproved(promiseId, validation.claims);
      return;
    }
    case "denied":
      await settlePromiseRefused(promiseId, "denied", "human denied the promise approval request");
      return;
    case "expired":
      await settlePromiseRefused(promiseId, "expired", "World ID approval window elapsed without a response");
      return;
    case "error":
      await settlePromiseRefused(promiseId, "error", outcome.message);
      return;
  }
}

/** Resume every still-pending promise on process start. */
export function resumePromiseApprovalsOnBoot(): void {
  const pending = listPromisesByStatus("pending_approval");
  for (const promise of pending) {
    console.log(`[promises] resuming pending promise ${promise.id} (expires ${promise.expiresAt})`);
    void resolvePromiseApprovalInBackground(promise.id).catch((err) => {
      console.error(`[promises] resume failed for ${promise.id}`, err);
    });
  }
}

// --- Revoking ------------------------------------------------------------------

/** `POST /promises/:id/revoke` (index.ts, account-key auth, own only).
 * Revoking only reduces power: an already-terminal promise (denied/expired/
 * revoked/error) is an idempotent no-op, never re-activated. */
export function revokePromiseRequest(promiseId: string, accountId: string): StoredPromise | undefined {
  const promise = getPromise(promiseId);
  if (!promise || promise.accountId !== accountId) return undefined;
  if (promise.status !== "active" && promise.status !== "pending_approval") return promise;
  const updated: StoredPromise = { ...promise, status: "revoked", reason: "revoked by owner", updatedAt: new Date().toISOString() };
  savePromise(updated);
  return updated;
}

// --- Response shaping ----------------------------------------------------------

export interface PromiseSummaryDto {
  id: string;
  task: string;
  status: PromiseStatus;
  budget: string;
  remainingBudget: string;
  categories: string[];
  expiry: string;
  createdAt: string;
  /** H1 fix — the normalized origin this promise may pay; `undefined` only
   * for a promise created before merchant binding existed. */
  merchant?: string;
}

export function serializePromiseSummary(promise: StoredPromise): PromiseSummaryDto {
  const remaining = promise.budget - promise.spent;
  return {
    id: promise.id,
    task: promise.task,
    status: promise.status,
    budget: promise.budget.toString(),
    remainingBudget: (remaining > 0n ? remaining : 0n).toString(),
    categories: promise.categories,
    expiry: promise.expiry.toString(),
    merchant: promise.merchant,
    createdAt: promise.createdAt,
  };
}

export interface PromiseDetailDto extends PromiseSummaryDto {
  summary: string;
  reason?: string;
  pendingApproval?: { verificationUri: string; userCode?: string; expiresAt?: string };
}

export function serializePromiseDetail(promise: StoredPromise): PromiseDetailDto {
  return {
    ...serializePromiseSummary(promise),
    summary: promise.summary,
    reason: promise.reason,
    pendingApproval:
      promise.status === "pending_approval"
        ? {
            verificationUri: promise.verificationUriComplete ?? promise.verificationUri ?? "",
            userCode: promise.userCode,
            expiresAt: promise.expiresAt,
          }
        : undefined,
  };
}

// --- Dev approval seam (OMAMORISAN_DEV_APPROVALS=1, index.ts) ---------------

export interface DevApproveResult {
  ok: boolean;
  error?: string;
}

/** Short-circuits a pending promise straight to `settlePromiseApproved` with
 * a FABRICATED subject and `acr: "dev"` — never touches World ID at all.
 * Same purpose/gating as accounts.ts's `devApproveConnect`: exists only for
 * the scenarios' isolated firewall. */
export async function devApprovePromise(promiseId: string, subject: string): Promise<DevApproveResult> {
  const promise = getPromise(promiseId);
  if (!promise) return { ok: false, error: "promise_not_found" };
  if (promise.status !== "pending_approval") return { ok: false, error: `promise is not pending_approval (status: ${promise.status})` };
  await settlePromiseApproved(promiseId, { sub: subject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });
  return { ok: true };
}
