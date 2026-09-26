// P9.6 — a single World ID approval that creates an account AND its first
// promise together, for an MCP session with no credential at all yet (root
// CLAUDE.md's "Also in scope" #1). Plain `connect` then `request_promise`
// costs the human two separate World ID taps for the very first task;
// `POST /promises/first` collapses that into one device flow — on approval
// it finds-or-creates the account by World ID subject hash (the SAME helper
// accounts.ts's connect gate uses) AND activates a real `promises` row under
// it, from one human tap.
//
// No auth (nobody has a credential yet — same as `POST /connect`). Fail-
// closed throughout, the same contract as promises.ts/accounts.ts:
// denied/expired/an invalid token all resolve to "nothing was created" —
// never a fabricated account or promise. Resumable across a restart, same
// shape as every other World ID gate in this firewall.

import { toHex } from "viem";
import { hashWorldIdSubject, USDC_DECIMALS } from "@yakusoku/shared";
import { generateConnectPollSecret, hashConnectPollSecret, hashesEqual } from "./auth";
import { publish } from "./events-bus";
import { signPromiseAttestation } from "./promise-attestation";
import { buildPromiseSummary, validatePromiseInput, type CreatePromiseInput } from "./promises";
import {
  createAccountKey,
  createFirstPromiseRequest,
  createPromise,
  findOrCreateAccountBySubjectHash,
  getFirstPromiseRequest,
  getPromise,
  listFirstPromiseRequestsByStatus,
  saveFirstPromiseRequest,
  type FirstPromiseRequest,
  type FirstPromiseStatus,
  type StoredPromise,
} from "./store";
import { ACR_ORB_V3, pollUntilResolved, startDeviceAuthorization, validateIdToken, type FreshApprovalClaims } from "./world-id";

function approvalTimeoutSeconds(): number {
  // Same env knob every other World ID gate in this firewall reads.
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

// --- Creating a first-promise request -----------------------------------------

export type CreateFirstPromiseOutcome =
  | {
      ok: true;
      request: {
        id: string;
        pollSecret: string;
        verificationUri: string;
        verificationUriComplete?: string;
        userCode: string;
        expiresAt: string;
        summary: string;
      };
    }
  | { ok: false; status: 400 | 429 | 502; error: string };

/** `POST /promises/first` (index.ts, no auth). Validates the exact same caps
 * as an ordinary promise (`validatePromiseInput`, promises.ts) — minus the
 * per-account pending-promise count, since no account exists yet (a brand
 * new one always has zero) — then starts a fresh World ID device flow. */
export async function createFirstPromiseRequestOutcome(input: CreatePromiseInput): Promise<CreateFirstPromiseOutcome> {
  const validated = validatePromiseInput(input);
  if (!validated.ok) return validated;
  const merchantOrigin = validated.merchantOrigin;

  let device: Awaited<ReturnType<typeof startDeviceAuthorization>>;
  try {
    device = await startDeviceAuthorization();
  } catch (err) {
    return { ok: false, status: 502, error: `could not start World ID approval: ${err instanceof Error ? err.message : String(err)}` };
  }

  const id = `promise_${crypto.randomUUID()}`;
  const pollSecret = generateConnectPollSecret();
  const budgetAtomic = BigInt(Math.round(input.budgetUsdc * 10 ** USDC_DECIMALS));
  const expirySeconds = BigInt(Math.floor(Date.now() / 1000) + Math.floor(input.expiresInSeconds));
  const requestedAt = new Date();
  const deadlineMs = requestedAt.getTime() + Math.min(device.expiresIn, approvalTimeoutSeconds()) * 1000;
  const expiresAt = new Date(deadlineMs).toISOString();
  const summary = buildPromiseSummary(input.task, input.budgetUsdc, input.categories, expirySeconds, merchantOrigin);

  const request: FirstPromiseRequest = {
    id,
    pollSecretHash: hashConnectPollSecret(pollSecret),
    deviceCode: device.deviceCode,
    status: "pending",
    keyDelivered: false,
    task: input.task,
    budget: budgetAtomic,
    categories: input.categories,
    expiry: expirySeconds,
    nonce: randomNonce(),
    merchant: merchantOrigin,
    summary,
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
  createFirstPromiseRequest(request);
  publish("promise.requested", { promiseId: id, summary });

  void resolveFirstPromiseApprovalInBackground(id).catch((err) => {
    console.error(`[first-promise] background resolution crashed for ${id}`, err);
  });

  return {
    ok: true,
    request: {
      id,
      pollSecret,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      userCode: device.userCode,
      expiresAt,
      summary,
    },
  };
}

// --- Polling -------------------------------------------------------------------

export type PollFirstPromiseResult =
  | { ok: false; status: 404; body: { error: "first_promise_not_found" } }
  | { ok: false; status: 401; body: { error: "unauthorized" } }
  | { ok: true; status: "pending" }
  | { ok: true; status: "active"; accountId: string; promiseId: string; summary: string; remainingBudget: string; accountKey?: string }
  | { ok: true; status: "denied" | "expired" | "error"; reason?: string };

/** `POST /promises/first/:id/poll` (index.ts). Same "wrong secret never
 * leaks which id would have worked" shape as `pollConnect` (accounts.ts).
 * The account key is delivered exactly once, same one-shot pattern. */
export function pollFirstPromise(id: string, pollSecret: string): PollFirstPromiseResult {
  const request = getFirstPromiseRequest(id);
  if (!request) return { ok: false, status: 404, body: { error: "first_promise_not_found" } };
  if (!hashesEqual(request.pollSecretHash, hashConnectPollSecret(pollSecret))) {
    return { ok: false, status: 401, body: { error: "unauthorized" } };
  }

  if (request.status === "pending") return { ok: true, status: "pending" };

  if (request.status === "approved") {
    if (!request.accountId) return { ok: true, status: "error", reason: "approved first-promise request missing accountId" };
    const promise = getPromise(request.id);
    const remaining = promise ? promise.budget - promise.spent : request.budget;
    const remainingBudget = (remaining > 0n ? remaining : 0n).toString();

    if (!request.keyDelivered && request.pendingAccountKey) {
      const accountKey = request.pendingAccountKey;
      saveFirstPromiseRequest({ ...request, keyDelivered: true, pendingAccountKey: undefined, updatedAt: new Date().toISOString() });
      return { ok: true, status: "active", accountId: request.accountId, promiseId: request.id, summary: request.summary, remainingBudget, accountKey };
    }
    return { ok: true, status: "active", accountId: request.accountId, promiseId: request.id, summary: request.summary, remainingBudget };
  }

  return { ok: true, status: request.status as "denied" | "expired" | "error", reason: request.reason };
}

// --- Resolving the gate --------------------------------------------------------

/** Approved + a valid, fresh ID token: find-or-create the account (same
 * helper `accounts.ts`'s connect gate uses) AND activate a real `promises`
 * row under it, signing its `PromiseAttestation` exactly like
 * `promises.ts`'s `settlePromiseApproved` — there is no "wrong human" case
 * here (unlike an ordinary promise, this one has no pre-existing account to
 * mismatch against; whoever approves on their phone IS the account). */
async function settleFirstPromiseApproved(id: string, claims: FreshApprovalClaims): Promise<void> {
  const fresh = getFirstPromiseRequest(id);
  if (!fresh || fresh.status !== "pending") return;

  const subjectHash = hashWorldIdSubject(claims.sub);
  const account = findOrCreateAccountBySubjectHash(subjectHash);
  const accountKey = createAccountKey(account.id);

  let attestation;
  try {
    attestation = await signPromiseAttestation({
      promiseId: fresh.id,
      accountId: account.id,
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
  } catch (err) {
    await settleFirstPromiseRefused(id, "error", `signing the PromiseAttestation failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const promise: StoredPromise = {
    id: fresh.id,
    accountId: account.id,
    task: fresh.task,
    budget: fresh.budget,
    categories: fresh.categories,
    expiry: fresh.expiry,
    nonce: fresh.nonce,
    merchant: fresh.merchant,
    spent: 0n,
    status: "active",
    reason: "approved",
    summary: fresh.summary,
    attestation,
    createdAt: fresh.createdAt,
    updatedAt: new Date().toISOString(),
  };
  createPromise(promise);

  saveFirstPromiseRequest({
    ...fresh,
    status: "approved",
    accountId: account.id,
    pendingAccountKey: accountKey,
    keyDelivered: false,
    reason: "approved",
    updatedAt: new Date().toISOString(),
  });

  publish("account.connected", { accountId: account.id });
  publish("promise.approved", { promiseId: fresh.id, accountId: account.id });
}

/** Denied/expired/an invalid token — refuse. No account and no promise row
 * is ever created for a non-approved outcome. */
async function settleFirstPromiseRefused(
  id: string,
  status: Exclude<FirstPromiseStatus, "pending" | "approved">,
  reason: string,
): Promise<void> {
  const fresh = getFirstPromiseRequest(id);
  if (!fresh || fresh.status !== "pending") return;
  saveFirstPromiseRequest({ ...fresh, status, reason, updatedAt: new Date().toISOString() });
  publish("promise.denied", { promiseId: fresh.id, status, reason });
}

/** Drives one first-promise request to a terminal outcome — same shape as
 * promises.ts's `resolvePromiseApprovalInBackground`. Resumable. */
export async function resolveFirstPromiseApprovalInBackground(id: string): Promise<void> {
  const request = getFirstPromiseRequest(id);
  if (!request || request.status !== "pending") return;

  const deadlineMs = new Date(request.expiresAt).getTime();
  const outcome = await pollUntilResolved({
    deviceCode: request.deviceCode,
    initialIntervalSeconds: request.intervalSeconds,
    deadlineMs,
    onTick: (result, intervalSeconds) => {
      if (result.status !== "slow_down" || intervalSeconds === request.intervalSeconds) return;
      const fresh = getFirstPromiseRequest(id);
      if (fresh && fresh.status === "pending") {
        saveFirstPromiseRequest({ ...fresh, intervalSeconds, updatedAt: new Date().toISOString() });
      }
    },
  });

  switch (outcome.status) {
    case "approved": {
      const validation = await validateIdToken(outcome.idToken, {
        requestedAtSeconds: Math.floor(new Date(request.requestedAt).getTime() / 1000),
        maxAuthAgeSeconds: maxAuthAgeSeconds(),
      });
      if (!validation.valid) {
        await settleFirstPromiseRefused(id, "error", `invalid World ID token: ${validation.reason}`);
        return;
      }
      await settleFirstPromiseApproved(id, validation.claims);
      return;
    }
    case "denied":
      await settleFirstPromiseRefused(id, "denied", "human denied the connect+promise approval request");
      return;
    case "expired":
      await settleFirstPromiseRefused(id, "expired", "World ID approval window elapsed without a response");
      return;
    case "error":
      await settleFirstPromiseRefused(id, "error", outcome.message);
      return;
  }
}

/** Resume every still-pending first-promise request on process start — same
 * "expired resolves safely" guarantee every other resumable gate documents. */
export function resumeFirstPromiseApprovalsOnBoot(): void {
  const pending = listFirstPromiseRequestsByStatus("pending");
  for (const request of pending) {
    console.log(`[first-promise] resuming pending request ${request.id} (expires ${request.expiresAt})`);
    void resolveFirstPromiseApprovalInBackground(request.id).catch((err) => {
      console.error(`[first-promise] resume failed for ${request.id}`, err);
    });
  }
}

// --- Dev approval seam (OMAMORISAN_DEV_APPROVALS=1, index.ts) ---------------

export interface DevApproveResult {
  ok: boolean;
  error?: string;
}

/** Short-circuits a pending first-promise request straight to
 * `settleFirstPromiseApproved` with a FABRICATED subject and `acr: "dev"` —
 * never touches World ID at all. Same purpose/gating as accounts.ts's
 * `devApproveConnect` / promises.ts's `devApprovePromise`: exists only for
 * the scenarios' isolated firewall and the MCP smoke test. */
export async function devApproveFirstPromise(id: string, subject: string): Promise<DevApproveResult> {
  const request = getFirstPromiseRequest(id);
  if (!request) return { ok: false, error: "first_promise_not_found" };
  if (request.status !== "pending") return { ok: false, error: `first-promise request is not pending (status: ${request.status})` };
  await settleFirstPromiseApproved(id, { sub: subject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });
  return { ok: true };
}
