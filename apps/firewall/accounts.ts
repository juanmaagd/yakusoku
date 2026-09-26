// Account connect gate (P9.1, odd/tasks/yakusoku.md Phase 3) — the ONLY way
// an MCP client binds itself to a human on World ID. Mirrors approvals.ts's
// World ID device-flow shape almost exactly (start a device flow, persist a
// row with everything needed to resume, poll in the background, resolve to a
// terminal outcome) but for a different purpose: this gate mints an ACCOUNT
// and its credential, not a payment signature.
//
// Fail-closed throughout (plan-tecnico.md §2.4, same contract WU11 documents
// for approvals.ts): denied/expired/an invalid ID token/an unstartable
// device flow all resolve to "no account was connected" — never a
// fabricated account. `pollUntilResolved`/`validateIdToken` are the exact
// same world-id.ts primitives WU11 already uses; nothing there changed.

import { hashWorldIdSubject } from "@yakusoku/shared";
import { hashesEqual } from "./auth";
import { publish } from "./events-bus";
import {
  createAccountKey,
  createConnectRequest,
  findOrCreateAccountBySubjectHash,
  getConnectRequest,
  listConnectRequestsByStatus,
  saveConnectRequest,
  type ConnectRequest,
  type ConnectStatus,
} from "./store";
import { generateConnectPollSecret, hashConnectPollSecret } from "./auth";
import { pollUntilResolved, startDeviceAuthorization, validateIdToken, type FreshApprovalClaims } from "./world-id";

function connectTimeoutSeconds(): number {
  // Reuses the SAME env knob approvals.ts's `firewallTimeoutSeconds` reads —
  // one operator-facing "how long do we wait for a human" ceiling for every
  // World ID gate this firewall runs (connect, promise approval, payment
  // approval), rather than three independently-tunable ones.
  const raw = Number(process.env.WORLD_ID_APPROVAL_TIMEOUT_S);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

function maxAuthAgeSeconds(): number {
  const raw = Number(process.env.WORLD_ID_MAX_AUTH_AGE_S);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

// --- Starting a connect request ----------------------------------------------

export interface StartConnectResult {
  connectId: string;
  pollSecret: string;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
}

/** `POST /connect` (index.ts, no auth — nobody is authenticated yet, that's
 * the whole point). Starts a fresh World ID device flow and persists a
 * `pending` connect request; resolution happens in the background. */
export async function startConnect(): Promise<StartConnectResult> {
  const device = await startDeviceAuthorization(); // throws on an unstartable flow — index.ts turns that into a 502.
  const connectId = `connect_${crypto.randomUUID()}`;
  const pollSecret = generateConnectPollSecret();
  const requestedAt = new Date();
  const deadlineMs = requestedAt.getTime() + Math.min(device.expiresIn, connectTimeoutSeconds()) * 1000;
  const expiresAt = new Date(deadlineMs).toISOString();

  const request: ConnectRequest = {
    id: connectId,
    pollSecretHash: hashConnectPollSecret(pollSecret),
    deviceCode: device.deviceCode,
    status: "pending",
    keyDelivered: false,
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
  createConnectRequest(request);

  void resolveConnectInBackground(connectId).catch((err) => {
    console.error(`[accounts] background resolution crashed for ${connectId}`, err);
  });

  return {
    connectId,
    pollSecret,
    verificationUri: device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
    userCode: device.userCode,
    expiresAt,
    intervalSeconds: device.interval,
  };
}

// --- Polling ------------------------------------------------------------------

export type PollConnectResult =
  | { ok: false; status: 404; body: { error: "connect_not_found" } }
  | { ok: false; status: 401; body: { error: "unauthorized" } }
  | { ok: true; status: "pending" }
  | { ok: true; status: "approved"; accountId: string; accountKey?: string }
  | { ok: true; status: "denied"; reason?: string }
  | { ok: true; status: "expired"; reason?: string }
  | { ok: true; status: "error"; reason?: string };

/** `POST /connect/poll` (index.ts). Wrong `connectId` -> 404; a real
 * `connectId` with the wrong poll secret -> 401 — neither leaks whether a
 * DIFFERENT connectId+secret pair would have worked. The account key is
 * delivered exactly once: the first poll to observe `status: "approved"`
 * consumes and clears `pendingAccountKey`; every poll after that still
 * reports `approved` but with no `accountKey` field at all. */
export function pollConnect(connectId: string, pollSecret: string): PollConnectResult {
  const request = getConnectRequest(connectId);
  if (!request) return { ok: false, status: 404, body: { error: "connect_not_found" } };
  if (!hashesEqual(request.pollSecretHash, hashConnectPollSecret(pollSecret))) {
    return { ok: false, status: 401, body: { error: "unauthorized" } };
  }

  if (request.status === "pending") return { ok: true, status: "pending" };

  if (request.status === "approved") {
    if (!request.accountId) return { ok: true, status: "error", reason: "approved connect request missing accountId" };
    if (!request.keyDelivered && request.pendingAccountKey) {
      const accountKey = request.pendingAccountKey;
      const delivered: ConnectRequest = {
        ...request,
        keyDelivered: true,
        pendingAccountKey: undefined,
        updatedAt: new Date().toISOString(),
      };
      saveConnectRequest(delivered);
      return { ok: true, status: "approved", accountId: request.accountId, accountKey };
    }
    return { ok: true, status: "approved", accountId: request.accountId };
  }

  return { ok: true, status: request.status as "denied" | "expired" | "error", reason: request.reason };
}

// --- Resolving the gate --------------------------------------------------------

/** Approved + a valid, fresh ID token: find-or-create the account by
 * subject hash and mint a fresh account key. Re-fetches the row and bails
 * (no-op) if it is no longer `pending` — guards against a real World ID
 * resolution racing the operator-only dev-approval seam (index.ts) for the
 * same connect request; whichever settles first wins, the second is silent.
 * Exported so accounts.test.ts can drive it directly with fabricated claims
 * (no network), same pattern approvals.test.ts uses for `settleApproved`. */
export async function settleConnectApproved(connectId: string, claims: FreshApprovalClaims): Promise<void> {
  const fresh = getConnectRequest(connectId);
  if (!fresh || fresh.status !== "pending") return;

  const subjectHash = hashWorldIdSubject(claims.sub);
  const account = findOrCreateAccountBySubjectHash(subjectHash);
  const accountKey = createAccountKey(account.id);

  saveConnectRequest({
    ...fresh,
    status: "approved",
    accountId: account.id,
    pendingAccountKey: accountKey,
    keyDelivered: false,
    reason: "approved",
    updatedAt: new Date().toISOString(),
  });
  publish("account.connected", { accountId: account.id });
}

/** Denied/expired/an invalid token — refuse, same re-fetch-and-check-pending
 * race guard as `settleConnectApproved`. Exported for the same testing
 * reason as `settleConnectApproved`. */
export async function settleConnectRefused(connectId: string, status: Exclude<ConnectStatus, "pending" | "approved">, reason: string): Promise<void> {
  const fresh = getConnectRequest(connectId);
  if (!fresh || fresh.status !== "pending") return;
  saveConnectRequest({ ...fresh, status, reason, updatedAt: new Date().toISOString() });
}

/** Drives one connect request to a terminal outcome — same shape as
 * approvals.ts's `resolveApprovalInBackground`. Resumable: called both right
 * after `startConnect` and again on boot (`resumeConnectRequestsOnBoot`). */
export async function resolveConnectInBackground(connectId: string): Promise<void> {
  const request = getConnectRequest(connectId);
  if (!request || request.status !== "pending") return;

  const deadlineMs = new Date(request.expiresAt).getTime();
  const outcome = await pollUntilResolved({
    deviceCode: request.deviceCode,
    initialIntervalSeconds: request.intervalSeconds,
    deadlineMs,
    onTick: (result, intervalSeconds) => {
      if (result.status !== "slow_down" || intervalSeconds === request.intervalSeconds) return;
      const fresh = getConnectRequest(connectId);
      if (fresh && fresh.status === "pending") {
        saveConnectRequest({ ...fresh, intervalSeconds, updatedAt: new Date().toISOString() });
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
        await settleConnectRefused(connectId, "error", `invalid World ID token: ${validation.reason}`);
        return;
      }
      await settleConnectApproved(connectId, validation.claims);
      return;
    }
    case "denied":
      await settleConnectRefused(connectId, "denied", "human denied the connect approval request");
      return;
    case "expired":
      await settleConnectRefused(connectId, "expired", "World ID connect window elapsed without a response");
      return;
    case "error":
      await settleConnectRefused(connectId, "error", outcome.message);
      return;
  }
}

/** Resume every still-pending connect request on process start — same
 * "expired resolves safely" guarantee `resumePendingApprovalsOnBoot`
 * documents. */
export function resumeConnectRequestsOnBoot(): void {
  const pending = listConnectRequestsByStatus("pending");
  for (const request of pending) {
    console.log(`[accounts] resuming pending connect ${request.id} (expires ${request.expiresAt})`);
    void resolveConnectInBackground(request.id).catch((err) => {
      console.error(`[accounts] resume failed for ${request.id}`, err);
    });
  }
}

// --- Dev approval seam (OMAMORISAN_DEV_APPROVALS=1, index.ts) ---------------

export interface DevApproveResult {
  ok: boolean;
  error?: string;
}

/** Short-circuits a pending connect request straight to `settleConnectApproved`
 * with a FABRICATED subject and `acr: "dev"` — never touches World ID at
 * all. Exists only for the scenarios' isolated firewall (index.ts gates the
 * route this calls behind `OMAMORISAN_DEV_APPROVALS=1` + the operator
 * loopback/admin-header check); the real sandbox device flow still runs
 * underneath (`startConnect` already called it), so this only replaces "wait
 * for a human to actually approve on their phone". */
export async function devApproveConnect(connectId: string, subject: string): Promise<DevApproveResult> {
  const request = getConnectRequest(connectId);
  if (!request) return { ok: false, error: "connect_not_found" };
  if (request.status !== "pending") return { ok: false, error: `connect request is not pending (status: ${request.status})` };
  await settleConnectApproved(connectId, { sub: subject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });
  return { ok: true };
}
