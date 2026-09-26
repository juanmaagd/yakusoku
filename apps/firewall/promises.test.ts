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

const { createPromise, findOrCreateAccountBySubjectHash, getPromise, savePromise } = await import("./store");
const {
  buildPromiseSummary,
  promiseAsMandate,
  resolveMandate,
  serializePromiseSummary,
  settlePromiseApproved,
  settlePromiseRefused,
  validatePromiseInput,
} = await import("./promises");

function randomNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

let seq = 0;
function seedPendingPromise(accountId: string, opts: { replaces?: string } = {}) {
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
    merchant: "http://localhost:4000",
    spent: 0n,
    status: "pending_approval",
    summary: 'Approve "Buy a $1 Amazon gift card (rehearsal)" — up to $1.00 USDC across gift_card:amazon.',
    replaces: opts.replaces,
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

/** Seeds a pending promise and immediately approves it — the exact state a
 * promise-replacement test needs as its "old, active" target. */
async function seedActivePromise(subject: string): Promise<{ promiseId: string; accountId: string }> {
  const acct = findOrCreateAccountBySubjectHash(hashWorldIdSubject(subject));
  const promiseId = seedPendingPromise(acct.id);
  await settlePromiseApproved(promiseId, { sub: subject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });
  return { promiseId, accountId: acct.id };
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
    expect(attestation?.message.merchant).toBe("http://localhost:4000");
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

describe("settlePromiseApproved — H1 fix: no bound merchant refuses fail-closed", () => {
  test("a promise created before merchant binding existed can never activate", async () => {
    const subject = "world-id-subject-promises-no-merchant";
    const acct = findOrCreateAccountBySubjectHash(hashWorldIdSubject(subject));
    seq += 1;
    const promiseId = `promise_test_${seq}`;
    createPromise({
      id: promiseId,
      accountId: acct.id,
      task: "Buy a $1 Amazon gift card (rehearsal)",
      budget: 1_000_000n,
      categories: ["gift_card:amazon"],
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: randomNonce(),
      // merchant intentionally omitted — simulates a row from before H1.
      spent: 0n,
      status: "pending_approval",
      summary: "legacy promise, no merchant bound",
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

    await settlePromiseApproved(promiseId, { sub: subject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const promise = getPromise(promiseId);
    expect(promise?.status).toBe("error");
    expect(promise?.reason).toMatch(/no bound merchant/);
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

// --- Promise-replacement fix -------------------------------------------------

const REPLACES_INPUT_BASE = {
  task: "Buy a Steam gift card instead",
  budgetUsdc: 1,
  categories: ["gift_card:steam"],
  expiresInSeconds: 3600,
  merchant: "http://localhost:4000",
};

describe("validatePromiseInput — replaces validation (promise-replacement fix)", () => {
  test("replaces_not_allowed_first_promise — no account yet (P9.6 path)", () => {
    const result = validatePromiseInput({ ...REPLACES_INPUT_BASE, replaces: "promise_whatever" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("replaces_not_allowed_first_promise");
    }
  });

  test("replaces_not_found — unknown id", async () => {
    const { accountId } = await seedActivePromise("world-id-subject-replaces-unknown");
    const result = validatePromiseInput({ ...REPLACES_INPUT_BASE, replaces: "promise_does_not_exist" }, accountId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toBe("replaces_not_found");
    }
  });

  test("replaces_not_found — belongs to a different account (never leaks existence across accounts)", async () => {
    const owner = await seedActivePromise("world-id-subject-replaces-owner");
    const intruder = findOrCreateAccountBySubjectHash(randomNonce());
    const result = validatePromiseInput({ ...REPLACES_INPUT_BASE, replaces: owner.promiseId }, intruder.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Same status/error as an unknown id — a caller can never tell "not
      // found" apart from "found, but not yours".
      expect(result.status).toBe(404);
      expect(result.error).toBe("replaces_not_found");
    }
  });

  test("replaces_not_active — target is still pending_approval", async () => {
    const acct = findOrCreateAccountBySubjectHash(randomNonce());
    const pendingId = seedPendingPromise(acct.id);
    const result = validatePromiseInput({ ...REPLACES_INPUT_BASE, replaces: pendingId }, acct.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe("replaces_not_active");
    }
  });

  test("replaces_not_active — target is revoked", async () => {
    const { accountId, promiseId } = await seedActivePromise("world-id-subject-replaces-revoked");
    const active = getPromise(promiseId)!;
    savePromise({ ...active, status: "revoked", reason: "revoked by owner", updatedAt: new Date().toISOString() });

    const result = validatePromiseInput({ ...REPLACES_INPUT_BASE, replaces: promiseId }, accountId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe("replaces_not_active");
    }
  });

  test("replaces_not_active — target is exhausted (remaining budget is zero)", async () => {
    const { accountId, promiseId } = await seedActivePromise("world-id-subject-replaces-exhausted");
    const active = getPromise(promiseId)!;
    savePromise({ ...active, spent: active.budget, updatedAt: new Date().toISOString() });

    const result = validatePromiseInput({ ...REPLACES_INPUT_BASE, replaces: promiseId }, accountId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe("replaces_not_active");
    }
  });

  test("replacement_already_pending — a second concurrent replacement for the same target is refused", async () => {
    const { accountId, promiseId } = await seedActivePromise("world-id-subject-replaces-stacked");
    seedPendingPromise(accountId, { replaces: promiseId }); // first replacement, still unresolved

    const result = validatePromiseInput({ ...REPLACES_INPUT_BASE, replaces: promiseId }, accountId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toBe("replacement_already_pending");
    }
  });

  test("a well-formed replacement of the caller's own active promise passes validation", async () => {
    const { accountId, promiseId } = await seedActivePromise("world-id-subject-replaces-valid");
    const result = validatePromiseInput({ ...REPLACES_INPUT_BASE, replaces: promiseId }, accountId);
    expect(result.ok).toBe(true);
  });
});

describe("buildPromiseSummary — replaces makes the change explicit (promise-replacement fix)", () => {
  test("prefixes the old task/budget before the new promise's own summary line", () => {
    const summary = buildPromiseSummary(
      "Buy a Steam gift card",
      2,
      ["gift_card:steam"],
      BigInt(Math.floor(Date.now() / 1000) + 3600),
      "http://localhost:4000",
      { task: "Buy an Amazon gift card", budgetUsdc: 1 },
    );
    expect(summary.startsWith('Replaces "Buy an Amazon gift card" ($1.00 USDC). Approve "Buy a Steam gift card"')).toBe(true);
  });

  test("omits the prefix entirely for an ordinary (non-replacing) promise", () => {
    const summary = buildPromiseSummary("Buy a Steam gift card", 2, ["gift_card:steam"], BigInt(Math.floor(Date.now() / 1000) + 3600), "http://localhost:4000");
    expect(summary.startsWith("Replaces")).toBe(false);
  });
});

describe("settlePromiseApproved — replacement activation (promise-replacement fix)", () => {
  test("happy path: replacement approved -> new active, old revoked, lineage recorded both ways", async () => {
    const subject = "world-id-subject-replace-happy";
    const { accountId, promiseId: oldId } = await seedActivePromise(subject);
    const newId = seedPendingPromise(accountId, { replaces: oldId });

    await settlePromiseApproved(newId, { sub: subject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const newPromise = getPromise(newId);
    const oldPromise = getPromise(oldId);
    expect(newPromise?.status).toBe("active");
    expect(newPromise?.replaces).toBe(oldId);
    expect(oldPromise?.status).toBe("revoked");
    expect(oldPromise?.replacedBy).toBe(newId);
    expect(oldPromise?.reason).toBe(`replaced by promise ${newId}`);
  });

  test("a denied replacement leaves the old promise fully untouched", async () => {
    const subject = "world-id-subject-replace-denied";
    const { accountId, promiseId: oldId } = await seedActivePromise(subject);
    const newId = seedPendingPromise(accountId, { replaces: oldId });

    await settlePromiseRefused(newId, "denied", "human denied the replacement approval request");

    const oldPromise = getPromise(oldId);
    expect(oldPromise?.status).toBe("active");
    expect(oldPromise?.replacedBy).toBeUndefined();
    expect(getPromise(newId)?.status).toBe("denied");
  });

  test("an expired replacement leaves the old promise fully untouched", async () => {
    const subject = "world-id-subject-replace-expired";
    const { accountId, promiseId: oldId } = await seedActivePromise(subject);
    const newId = seedPendingPromise(accountId, { replaces: oldId });

    await settlePromiseRefused(newId, "expired", "World ID approval window elapsed without a response");

    const oldPromise = getPromise(oldId);
    expect(oldPromise?.status).toBe("active");
    expect(oldPromise?.replacedBy).toBeUndefined();
    expect(getPromise(newId)?.status).toBe("expired");
  });

  test("atomicity: old already revoked at activation -> new still activates, old is left completely untouched", async () => {
    const subject = "world-id-subject-replace-already-revoked";
    const { accountId, promiseId: oldId } = await seedActivePromise(subject);
    const newId = seedPendingPromise(accountId, { replaces: oldId });

    // The owner revokes the old promise directly, before this replacement resolves.
    const activeOld = getPromise(oldId)!;
    savePromise({ ...activeOld, status: "revoked", reason: "revoked by owner", updatedAt: new Date().toISOString() });

    await settlePromiseApproved(newId, { sub: subject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const newPromise = getPromise(newId);
    const oldPromise = getPromise(oldId);
    expect(newPromise?.status).toBe("active");
    // Untouched by the replacement — same reason as the manual revoke above,
    // and no replacedBy stamped on it.
    expect(oldPromise?.status).toBe("revoked");
    expect(oldPromise?.reason).toBe("revoked by owner");
    expect(oldPromise?.replacedBy).toBeUndefined();
  });
});

describe("serializePromiseSummary — lineage (promise-replacement fix)", () => {
  test("replaces/replacedBy round-trip through the serialized summary once a replacement activates", async () => {
    const subject = "world-id-subject-replace-serialize";
    const { accountId, promiseId: oldId } = await seedActivePromise(subject);
    const newId = seedPendingPromise(accountId, { replaces: oldId });
    await settlePromiseApproved(newId, { sub: subject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const newSummary = serializePromiseSummary(getPromise(newId)!);
    const oldSummary = serializePromiseSummary(getPromise(oldId)!);
    expect(newSummary.replaces).toBe(oldId);
    expect(oldSummary.replacedBy).toBe(newId);
  });

  test("an ordinary promise serializes with no lineage fields", async () => {
    const { promiseId } = await seedActivePromise("world-id-subject-replace-no-lineage");
    const summary = serializePromiseSummary(getPromise(promiseId)!);
    expect(summary.replaces).toBeUndefined();
    expect(summary.replacedBy).toBeUndefined();
  });
});
