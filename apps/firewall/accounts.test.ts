// P9.1 — the connect gate's approval-resolution path (`settleConnectApproved`/
// `settleConnectRefused`, accounts.ts — the functions `resolveConnectInBackground`
// calls once a poll/validate outcome is terminal). No network: this suite
// seeds a `pending` `ConnectRequest` row directly (`createConnectRequest`,
// store.ts — the exact state `startConnect` leaves behind right before the
// gate resolves) and drives the settle functions with fabricated
// `FreshApprovalClaims`, same pattern approvals.test.ts uses for
// `settleApproved`/`settleRefused` — never `mock.module`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// store.ts opens a bun:sqlite file under FIREWALL_DATA_DIR at module-load
// time — point it at an isolated temp dir before any import, never the
// shared dev sqlite file (same rationale approvals.test.ts documents).
process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-accounts-test-"));

const { createConnectRequest, findAccountByAccountKey, getAccount, getConnectRequest } = await import("./store");
const { pollConnect, settleConnectApproved, settleConnectRefused } = await import("./accounts");

let seq = 0;
function seedPendingConnect() {
  seq += 1;
  const connectId = `connect_test_${seq}`;
  createConnectRequest({
    id: connectId,
    pollSecretHash: `poll-secret-hash-${seq}`,
    deviceCode: `device-${seq}`,
    status: "pending",
    keyDelivered: false,
    verificationUri: "https://sandbox.auth.world.org/device",
    userCode: `USER-${seq}`,
    intervalSeconds: 1,
    requestedAt: new Date().toISOString(),
    gateStartedAtMs: Date.now(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return connectId;
}

describe("settleConnectApproved — binds/reuses the account by subject hash (P9.1)", () => {
  test("a fresh subject mints a new account and delivers the key exactly once", async () => {
    const connectId = seedPendingConnect();
    await settleConnectApproved(connectId, { sub: "world-id-subject-accounts-1", acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const request = getConnectRequest(connectId);
    expect(request?.status).toBe("approved");
    expect(request?.accountId).toBeDefined();

    const account = getAccount(request!.accountId!);
    expect(account).toBeDefined();
    expect(account?.subjectHash).not.toBe("world-id-subject-accounts-1"); // never the raw subject

    // pollConnect can't authenticate without the real poll secret — call the
    // store row directly to confirm the raw key is staged for delivery.
    expect(request?.pendingAccountKey).toBeDefined();
    expect(request?.keyDelivered).toBe(false);
  });

  test("the SAME subject reconnecting reuses the existing account, not a new one", async () => {
    const connectIdA = seedPendingConnect();
    const connectIdB = seedPendingConnect();
    const claims = { sub: "world-id-subject-accounts-2", acr: "dev", authTime: Math.floor(Date.now() / 1000) };

    await settleConnectApproved(connectIdA, claims);
    await settleConnectApproved(connectIdB, claims);

    const requestA = getConnectRequest(connectIdA);
    const requestB = getConnectRequest(connectIdB);
    expect(requestA?.accountId).toBeDefined();
    expect(requestA?.accountId).toBe(requestB?.accountId);
  });

  test("a DIFFERENT subject mints a DIFFERENT account", async () => {
    const connectIdA = seedPendingConnect();
    const connectIdB = seedPendingConnect();

    await settleConnectApproved(connectIdA, { sub: "world-id-subject-accounts-3a", acr: "dev", authTime: Math.floor(Date.now() / 1000) });
    await settleConnectApproved(connectIdB, { sub: "world-id-subject-accounts-3b", acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const requestA = getConnectRequest(connectIdA);
    const requestB = getConnectRequest(connectIdB);
    expect(requestA?.accountId).toBeDefined();
    expect(requestB?.accountId).toBeDefined();
    expect(requestA?.accountId).not.toBe(requestB?.accountId);
  });
});

describe("POST /connect/poll semantics (pollConnect) — P9.1", () => {
  test("wrong poll secret is rejected without leaking status", () => {
    const connectId = seedPendingConnect();
    const result = pollConnect(connectId, "wrong-secret");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  test("an unknown connectId 404s", () => {
    const result = pollConnect("connect_does_not_exist", "whatever");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  test("the account key is delivered exactly once", async () => {
    seq += 1;
    const connectId = `connect_test_poll_${seq}`;
    const pollSecret = `plain-secret-${seq}`;
    // hashConnectPollSecret is the same SHA-256 auth.ts uses for every other
    // token kind here — recomputed inline so this test seeds a row whose
    // hash actually matches `pollSecret`.
    const { hashConnectPollSecret } = await import("./auth");
    createConnectRequest({
      id: connectId,
      pollSecretHash: hashConnectPollSecret(pollSecret),
      deviceCode: `device-poll-${seq}`,
      status: "pending",
      keyDelivered: false,
      verificationUri: "https://sandbox.auth.world.org/device",
      userCode: `USER-POLL-${seq}`,
      intervalSeconds: 1,
      requestedAt: new Date().toISOString(),
      gateStartedAtMs: Date.now(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const pending = pollConnect(connectId, pollSecret);
    expect(pending).toEqual({ ok: true, status: "pending" });

    await settleConnectApproved(connectId, { sub: "world-id-subject-accounts-poll", acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const first = pollConnect(connectId, pollSecret);
    expect(first.ok).toBe(true);
    if (first.ok && first.status === "approved") {
      expect(first.accountKey).toBeDefined();
      expect(findAccountByAccountKey(first.accountKey!)?.id).toBe(first.accountId);
    } else {
      throw new Error(`expected an approved poll with a key, got ${JSON.stringify(first)}`);
    }

    const second = pollConnect(connectId, pollSecret);
    expect(second).toEqual({ ok: true, status: "approved", accountId: first.accountId });
  });
});

describe("settleConnectRefused — never creates an account (P9.1)", () => {
  test("denied leaves no account behind", async () => {
    const connectId = seedPendingConnect();
    await settleConnectRefused(connectId, "denied", "human denied the connect approval request");
    const request = getConnectRequest(connectId);
    expect(request?.status).toBe("denied");
    expect(request?.accountId).toBeUndefined();
  });

  test("expired leaves no account behind", async () => {
    const connectId = seedPendingConnect();
    await settleConnectRefused(connectId, "expired", "World ID connect window elapsed without a response");
    const request = getConnectRequest(connectId);
    expect(request?.status).toBe("expired");
    expect(request?.accountId).toBeUndefined();
  });

  test("a settle call on an already-resolved request is a silent no-op (race guard)", async () => {
    const connectId = seedPendingConnect();
    await settleConnectApproved(connectId, { sub: "world-id-subject-accounts-race", acr: "dev", authTime: Math.floor(Date.now() / 1000) });
    const approvedAccountId = getConnectRequest(connectId)?.accountId;

    // A late "expired" resolution (e.g. the real background poller, after
    // the dev-approval seam already settled this request) must not overwrite it.
    await settleConnectRefused(connectId, "expired", "late real-world timeout");
    const request = getConnectRequest(connectId);
    expect(request?.status).toBe("approved");
    expect(request?.accountId).toBe(approvedAccountId);
  });
});
