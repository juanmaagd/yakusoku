// P9.2 — the promise approval-resolution path (`settlePromiseApproved`/
// `settlePromiseRefused`, promises.ts — the functions
// `resolvePromiseApprovalInBackground` calls once a poll/validate outcome is
// terminal). No network: this suite seeds an account (accounts.ts's
// `findOrCreateAccountBySubjectHash`) and a `pending_approval` `StoredPromise`
// row directly (`createPromise`, store.ts — the exact state
// `createPromiseRequest` leaves behind right before the gate resolves), then
// drives the settle functions with fabricated `FreshApprovalClaims` — same
// pattern approvals.test.ts/accounts.test.ts use, never `mock.module`.
// `promise-attestation.ts`'s signing runs for real here, against a throwaway
// `FIREWALL_PRIVATE_KEY` (never the real key).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { toHex } from "viem";
import { hashWorldIdSubject, verifyPromiseAttestation } from "@yakusoku/shared";

// store.ts opens a bun:sqlite file under FIREWALL_DATA_DIR and
// promise-attestation.ts reads FIREWALL_PRIVATE_KEY, both at module-load
// time — point both at an isolated temp dir / throwaway key before any
// import (approvals.test.ts's pattern), never the shared dev sqlite file or
// the real key.
process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-promises-test-"));
process.env.FIREWALL_PRIVATE_KEY ??= `0x${"33".repeat(32)}`;

const { createPromise, findOrCreateAccountBySubjectHash, getPromise } = await import("./store");
const { promiseAsMandate, resolveMandate, settlePromiseApproved, settlePromiseRefused } = await import("./promises");

function randomNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

let seq = 0;
function seedPendingPromise(accountId: string) {
  seq += 1;
  const promiseId = `promise_test_${seq}`;
  createPromise({
    id: promiseId,
    accountId,
    task: "Buy a $1 Amazon gift card (rehearsal)",
    budget: 1_000_000n,
    categories: ["gift_card:amazon"],
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: randomNonce(),
    spent: 0n,
    status: "pending_approval",
    summary: 'Approve "Buy a $1 Amazon gift card (rehearsal)" — up to $1.00 USDC across gift_card:amazon.',
    deviceCode: `device-${promiseId}`,
    verificationUri: "https://sandbox.auth.world.org/device",
    userCode: `USER-${promiseId}`,
    intervalSeconds: 1,
    requestedAt: new Date().toISOString(),
    gateStartedAtMs: Date.now(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return promiseId;
}

describe("settlePromiseApproved — right subject activates + attests (P9.2)", () => {
  test("the promise's own subject -> active, attestation verifies and binds this exact promise", async () => {
    const subject = "world-id-subject-promises-1";
    const subjectHash = hashWorldIdSubject(subject);
    const acct = findOrCreateAccountBySubjectHash(subjectHash);

    const promiseId = seedPendingPromise(acct.id);
    const authTime = Math.floor(Date.now() / 1000);
    await settlePromiseApproved(promiseId, { sub: subject, acr: "https://world.org/oidc/acr/orb-v3", authTime });

    const promise = getPromise(promiseId);
    expect(promise?.status).toBe("active");
    expect(promise?.reason).toBe("approved");
    const attestation = promise?.attestation;
    expect(attestation).toBeDefined();
    expect(await verifyPromiseAttestation(attestation!)).toBe(true);
    expect(attestation?.message.promiseId).toBe(promiseId);
    expect(attestation?.message.accountId).toBe(acct.id);
    expect(attestation?.message.task).toBe(promise?.task);
    expect(attestation?.message.budget).toBe(promise?.budget.toString());
    expect(attestation?.message.worldIdSubject).not.toBe(subject);
  });

  test("a mandate adapter built from the active promise carries the right fields for the pipeline", async () => {
    const subject = "world-id-subject-promises-2";
    const acct = findOrCreateAccountBySubjectHash(hashWorldIdSubject(subject));
    const promiseId = seedPendingPromise(acct.id);
    await settlePromiseApproved(promiseId, { sub: subject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const mandate = resolveMandate(promiseId);
    expect(mandate?.source).toBe("world_id");
    expect(mandate?.accountId).toBe(acct.id);
    expect(mandate?.promiseStatus).toBe("active");
    expect(mandate?.message.task).toBe("Buy a $1 Amazon gift card (rehearsal)");
    expect(mandate?.message.budget).toBe(1_000_000n);

    const promise = getPromise(promiseId)!;
    expect(promiseAsMandate(promise).promiseStatus).toBe("active");
  });
});

describe("settlePromiseApproved — wrong subject refuses fail-closed (P9.2)", () => {
  test("a valid, fresh token for a DIFFERENT human denies with reason world_id_wrong_human", async () => {
    const ownerSubject = "world-id-subject-promises-owner";
    const acct = findOrCreateAccountBySubjectHash(hashWorldIdSubject(ownerSubject));
    const promiseId = seedPendingPromise(acct.id);

    await settlePromiseApproved(promiseId, { sub: "world-id-subject-promises-intruder", acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const promise = getPromise(promiseId);
    expect(promise?.status).toBe("denied");
    expect(promise?.reason).toBe("world_id_wrong_human");
    expect(promise?.attestation).toBeUndefined();
  });
});

describe("settlePromiseRefused — never attaches an attestation (P9.2)", () => {
  test("denied -> refuses, no attestation", async () => {
    const acct = findOrCreateAccountBySubjectHash(randomNonce());
    const promiseId = seedPendingPromise(acct.id);
    await settlePromiseRefused(promiseId, "denied", "human denied the promise approval request");
    const promise = getPromise(promiseId);
    expect(promise?.status).toBe("denied");
    expect(promise?.attestation).toBeUndefined();
  });

  test("expired -> refuses, no attestation", async () => {
    const acct = findOrCreateAccountBySubjectHash(randomNonce());
    const promiseId = seedPendingPromise(acct.id);
    await settlePromiseRefused(promiseId, "expired", "World ID approval window elapsed without a response");
    const promise = getPromise(promiseId);
    expect(promise?.status).toBe("expired");
    expect(promise?.attestation).toBeUndefined();
  });

  test("a settle call on an already-resolved promise is a silent no-op (race guard)", async () => {
    const subject = "world-id-subject-promises-race";
    const acct = findOrCreateAccountBySubjectHash(hashWorldIdSubject(subject));
    const promiseId = seedPendingPromise(acct.id);
    await settlePromiseApproved(promiseId, { sub: subject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    await settlePromiseRefused(promiseId, "expired", "late real-world timeout");
    const promise = getPromise(promiseId);
    expect(promise?.status).toBe("active");
    expect(promise?.attestation).toBeDefined();
  });
});

describe("resolveMandate — unknown id (P9.2)", () => {
  test("returns undefined for an id that is neither an intent nor a promise", () => {
    expect(resolveMandate("nothing_here")).toBeUndefined();
  });
});
