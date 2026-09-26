// WU12: the World ID approval-resolution path (`settleApproved`/
// `settleRefused`, approvals.ts — the functions `resolveApprovalInBackground`
// calls once a poll/validate outcome is terminal) attaches a StepUp
// attestation only on a genuine approval — never on denied/expired/invalid
// -token. No network: this suite calls `settleApproved`/`settleRefused`
// directly with fabricated `FreshApprovalClaims`/outcomes instead of
// mocking `world-id.ts`'s poll/validate primitives — `mock.module` replaces
// a module process-wide for the rest of the `bun test` run, which would
// otherwise clobber world-id.test.ts's own no-network unit tests of those
// same functions. `signer.ts`'s `signPayment` runs for real here (it never
// touches the network — EIP-3009 authorization signing is fully local),
// and step-up.ts's own signing runs for real too, against a throwaway
// `FIREWALL_PRIVATE_KEY` (never the real key).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "viem";
import { hashWorldIdSubject, type TaskIntentMessage } from "@yakusoku/shared";

// store.ts opens a bun:sqlite file under FIREWALL_DATA_DIR at module-load
// time, and signer.ts/step-up.ts read FIREWALL_PRIVATE_KEY at module-load
// time — point both at an isolated temp dir / throwaway key before any
// import (pipeline.test.ts's pattern), never the shared dev sqlite file or
// the real key.
process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-approvals-test-"));
process.env.FIREWALL_PRIVATE_KEY ??= `0x${"22".repeat(32)}`;
// Read back whatever value actually won the `??=` above — another test
// file's module-scope assignment may have run first in this shared `bun
// test` process, so the literal above is not necessarily what's live.
const FIREWALL_KEY = process.env.FIREWALL_PRIVATE_KEY as `0x${string}`;
const EXPECTED_SIGNER = privateKeyToAccount(FIREWALL_KEY).address;

const {
  createIntent,
  createPromise,
  findOrCreateAccountBySubjectHash,
  getCachedSignOutcome,
  getIntent,
  getPromise,
  getReceipt,
  recordSpend,
  savePendingApproval,
  savePromise,
  setAccountDeployment,
} = await import("./store");
const { finalize } = await import("./receipts");
const { settleApproved, settleRefused } = await import("./approvals");

const PAY_TO = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532";
const AMOUNT = "1000000";

function makeTaskIntent(): TaskIntentMessage {
  return {
    task: "Buy a 1 USDC gift card",
    budget: 5_000_000n,
    categories: ["gift_card:amazon"],
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: `0x${"11".repeat(32)}`,
  };
}

/** Seeds an intent + an `awaiting_world_id` receipt + a `pending`
 * PendingApproval row — the exact state `startApprovalGate` leaves behind
 * right before the gate resolves (`settleApproved`/`settleRefused` below).
 * WU: purchase ref — `overrides.paymentIdentifier`/`overrides.baseIdentifier`
 * let a caller simulate a purchaseRef-bearing request (a purchase identifier
 * distinct from its base); every pre-existing call site omits them, so this
 * is unchanged for them (`baseIdentifier` stays `undefined`, exactly like a
 * `PendingApproval` row persisted before that field existed). */
function seedPendingApproval(overrides: { paymentIdentifier?: string; baseIdentifier?: string; intentId?: string } = {}) {
  const intentId =
    overrides.intentId ??
    createIntent(makeTaskIntent(), `0x${"aa".repeat(65)}`, "0x1111111111111111111111111111111111111111").intent.id;
  const paymentIdentifier = overrides.paymentIdentifier ?? `pay_test_${crypto.randomUUID()}`;
  const { receiptId } = finalize({
    paymentIdentifier,
    intentId,
    resourceUrl: "http://localhost:4000/giftcard/amazon-1",
    amount: AMOUNT,
    payTo: PAY_TO,
    timeline: [],
    state: "awaiting_world_id",
    verdict: "ask_human",
    reason: "test setup",
    cache: false,
  });
  const approval = {
    receiptId,
    paymentIdentifier,
    baseIdentifier: overrides.baseIdentifier,
    intentId,
    amountAtomic: AMOUNT,
    deviceCode: "device-1",
    userCode: "USER-1",
    verificationUri: "https://sandbox.auth.world.org/device",
    intervalSeconds: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requestedAt: new Date().toISOString(),
    gateStartedAtMs: Date.now(),
    status: "pending" as const,
    reason: "test setup",
    // Complete enough for the REAL signer.ts to sign locally (no network):
    // `extra`'s EIP-712 domain + `maxTimeoutSeconds` are what a real x402
    // store response always includes (apps/store/index.ts) and what
    // @x402/evm's EIP-3009 signer requires.
    paymentRequiredJson: JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: NETWORK,
          amount: AMOUNT,
          asset: ASSET,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { name: "USDC", version: "2" },
        },
      ],
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  savePendingApproval(approval);
  return { approval, receiptId };
}

describe("settleApproved — StepUp attestation attachment (WU12)", () => {
  test("valid claims -> pays, and the receipt carries a matching attestation", async () => {
    const { approval, receiptId } = seedPendingApproval();
    const authTime = Math.floor(Date.now() / 1000);

    await settleApproved(approval, {
      sub: "world-id-subject-1",
      acr: "https://world.org/oidc/acr/orb-v3",
      authTime,
    });

    const receipt = getReceipt(receiptId);
    expect(receipt?.verdict).toBe("pay");
    expect(receipt?.state).toBe("signed");
    expect(receipt?.worldId?.approved).toBe(true);
    expect(receipt?.worldId?.authTime).toBe(authTime);
    const attestation = receipt?.worldId?.attestation;
    expect(attestation).toBeDefined();
    expect(attestation?.signer.toLowerCase()).toBe(EXPECTED_SIGNER.toLowerCase());
    expect(attestation?.message.receiptId).toBe(receiptId);
    expect(attestation?.message.paymentIdentifier).toBe(receipt?.paymentIdentifier);
    expect(attestation?.message.intentId).toBe(approval.intentId);
    expect(attestation?.message.payTo.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(attestation?.message.amount).toBe(AMOUNT);
    expect(attestation?.message.asset.toLowerCase()).toBe(ASSET.toLowerCase());
    expect(attestation?.message.network).toBe(NETWORK);
    expect(attestation?.message.authTime).toBe(String(authTime));
    // The receipt's `subject` is the SAME hash as the attestation's
    // `worldIdSubject` — never the raw `sub` claim.
    expect(receipt?.worldId?.subject).toBe(attestation?.message.worldIdSubject);
    expect(receipt?.worldId?.subject).not.toBe("world-id-subject-1");
  });

  test("acr falls back to ACR_ORB_V3 when the claim omits it", async () => {
    const { approval, receiptId } = seedPendingApproval();
    await settleApproved(approval, { sub: "world-id-subject-2", authTime: Math.floor(Date.now() / 1000) });

    const receipt = getReceipt(receiptId);
    expect(receipt?.worldId?.attestation?.message.acr).toBe("https://world.org/oidc/acr/orb-v3");
  });
});

describe("settleRefused — only a human \"no\" is cached for the payment", () => {
  test("denied is cached: the same promise + item replays the refusal", async () => {
    const { approval } = seedPendingApproval();
    await settleRefused(approval, "denied", "human denied the World ID approval request", "world_id_denied");
    expect(getCachedSignOutcome(approval.paymentIdentifier)?.verdict).toBe("refuse");
  });

  for (const status of ["expired", "paused", "error"] as const) {
    test(`${status} is not cached: the next attempt is re-evaluated`, async () => {
      const { approval } = seedPendingApproval();
      await settleRefused(approval, status, `transient: ${status}`, status === "expired" ? "world_id_expired" : "error");
      expect(getCachedSignOutcome(approval.paymentIdentifier)).toBeUndefined();
    });
  }
});

// --- WU: purchase ref — base identifier caches a refusal/denial, purchase
// identifier caches a pay (odd/tasks/standing-rules.md T7) -----------------
//
// `paymentIdentifier` above is the pre-existing single identifier — with no
// purchaseRef, base and purchase are the same value, so every test above is
// unaffected. These tests simulate a purchaseRef-bearing request by seeding
// a `baseIdentifier` distinct from `paymentIdentifier` (exactly what
// pipeline.ts's `computePurchaseIdentifier` would derive for two different
// purchaseRefs of the same item), then drive `settleApproved`/`settleRefused`
// directly — no PIPELINE_STAGES, no network, same discipline every other
// test in this file already uses.

describe("purchaseRef — a refusal/denial caches on the BASE identifier, never the purchase one", () => {
  test("settleRefused (a human denial) caches under baseIdentifier, not under paymentIdentifier", async () => {
    const baseIdentifier = `pay_test_base_${crypto.randomUUID()}`;
    const { approval } = seedPendingApproval({ baseIdentifier, paymentIdentifier: `${baseIdentifier}_ref_a` });
    expect(approval.paymentIdentifier).not.toBe(baseIdentifier);

    await settleRefused(approval, "denied", "human denied the World ID approval request", "world_id_denied");

    expect(getCachedSignOutcome(baseIdentifier)?.verdict).toBe("refuse");
    expect(getCachedSignOutcome(approval.paymentIdentifier)).toBeUndefined();
  });

  test("a DIFFERENT purchaseRef (purchase identifier) of the same item finds that same base-cached denial", async () => {
    const baseIdentifier = `pay_test_base_${crypto.randomUUID()}`;
    const { approval: approvalA } = seedPendingApproval({ baseIdentifier, paymentIdentifier: `${baseIdentifier}_ref_a` });
    await settleRefused(approvalA, "denied", "human denied the World ID approval request", "world_id_denied");

    // pipeline.ts's own top-of-pipeline lookup (pipeline.test.ts covers the
    // full runSignPipeline path) checks the BASE identifier first, before
    // ref B's own purchase identifier — asserted here at the store level:
    // the exact same base identifier a ref-B request would look up already
    // carries the refusal ref A's settlement wrote.
    const purchaseIdentifierB = `${baseIdentifier}_ref_b`;
    expect(purchaseIdentifierB).not.toBe(approvalA.paymentIdentifier);
    expect(getCachedSignOutcome(baseIdentifier)?.verdict).toBe("refuse");
    expect(getCachedSignOutcome(purchaseIdentifierB)).toBeUndefined(); // never itself cached
  });

  test("a PendingApproval row with no baseIdentifier (pre-existing behavior) falls back to caching under paymentIdentifier itself", async () => {
    const { approval } = seedPendingApproval(); // no overrides -> baseIdentifier undefined, same as every pre-existing test
    await settleRefused(approval, "denied", "human denied the World ID approval request", "world_id_denied");
    expect(getCachedSignOutcome(approval.paymentIdentifier)?.verdict).toBe("refuse");
  });
});

describe("purchaseRef — a pay caches on the PURCHASE identifier; two purchaseRefs of one item settle independently", () => {
  test("settleApproved caches under paymentIdentifier (the purchase identifier), never under the shared baseIdentifier", async () => {
    const baseIdentifier = `pay_test_base_${crypto.randomUUID()}`;
    const { approval } = seedPendingApproval({ baseIdentifier, paymentIdentifier: `${baseIdentifier}_ref_a` });

    await settleApproved(approval, { sub: "world-id-subject-purchase-ref-a", acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    expect(getCachedSignOutcome(approval.paymentIdentifier)?.verdict).toBe("pay");
    expect(getCachedSignOutcome(baseIdentifier)).toBeUndefined();
  });

  test("two purchaseRefs of the SAME item settle as two independent pay outcomes with distinct signatures and independent budget reservations", async () => {
    const intentId = createIntent(
      makeTaskIntent(),
      `0x${"aa".repeat(65)}`,
      "0x5555555555555555555555555555555555555555",
    ).intent.id;
    const baseIdentifier = `pay_test_base_${crypto.randomUUID()}`;
    const { approval: approvalA, receiptId: receiptIdA } = seedPendingApproval({
      intentId,
      baseIdentifier,
      paymentIdentifier: `${baseIdentifier}_ref_a`,
    });
    const { approval: approvalB, receiptId: receiptIdB } = seedPendingApproval({
      intentId,
      baseIdentifier,
      paymentIdentifier: `${baseIdentifier}_ref_b`,
    });

    // Simulates pipeline.ts's own reservation (recordSpend right before
    // running the stages, pipeline.ts's `runSignPipelineInner`) — two
    // separate purchases of the SAME item each reserve their own amount.
    recordSpend(intentId, BigInt(AMOUNT));
    recordSpend(intentId, BigInt(AMOUNT));

    await settleApproved(approvalA, { sub: "world-id-subject-purchase-ref", acr: "dev", authTime: Math.floor(Date.now() / 1000) });
    await settleApproved(approvalB, { sub: "world-id-subject-purchase-ref", acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const receiptA = getReceipt(receiptIdA);
    const receiptB = getReceipt(receiptIdB);
    expect(receiptA?.verdict).toBe("pay");
    expect(receiptB?.verdict).toBe("pay");

    // The receipt itself doesn't carry the payment signature (DecisionReceipt
    // has no such field) — it lives in the idempotency cache, keyed by each
    // purchase's own identifier (`CachedSignOutcome.paymentSignature`).
    const signatureA = getCachedSignOutcome(approvalA.paymentIdentifier)?.paymentSignature;
    const signatureB = getCachedSignOutcome(approvalB.paymentIdentifier)?.paymentSignature;
    expect(signatureA).toBeDefined();
    expect(signatureB).toBeDefined();
    // Two distinct EIP-3009 nonces (signer.ts's real, local, non-network
    // signing) -> two distinct signatures, so these settle as two separate
    // on-chain transactions instead of one idempotent replay.
    expect(signatureA).not.toBe(signatureB);
    // Neither pay outcome leaks into the shared BASE identifier's cache.
    expect(getCachedSignOutcome(baseIdentifier)).toBeUndefined();

    // Both reservations persist independently — never merged/collapsed into
    // a single one (settleApproved never releases spend on success).
    expect(getIntent(intentId)?.spent).toBe(2n * BigInt(AMOUNT));
  });
});

describe("settleRefused — never attaches an attestation (WU12)", () => {
  test("denied -> refuses, releases the budget, no attestation", async () => {
    const { approval, receiptId } = seedPendingApproval();

    await settleRefused(approval, "denied", "human denied the World ID approval request", "world_id_denied");

    const receipt = getReceipt(receiptId);
    expect(receipt?.verdict).toBe("refuse");
    expect(receipt?.state).toBe("world_id_denied");
    expect(receipt?.worldId).toEqual({ approved: false, status: "denied" });
  });

  test("expired -> refuses, no attestation", async () => {
    const { approval, receiptId } = seedPendingApproval();

    await settleRefused(approval, "expired", "World ID approval window elapsed without a response", "world_id_expired");

    const receipt = getReceipt(receiptId);
    expect(receipt?.verdict).toBe("refuse");
    expect(receipt?.worldId).toEqual({ approved: false, status: "expired" });
  });

  test("invalid/stale token (mapped by the caller to an error refusal) -> no attestation", async () => {
    const { approval, receiptId } = seedPendingApproval();

    await settleRefused(approval, "error", "invalid World ID token: auth_time predates the approval request", "error");

    const receipt = getReceipt(receiptId);
    expect(receipt?.verdict).toBe("refuse");
    expect(receipt?.worldId).toEqual({ approved: false, status: "error" });
  });
});

// --- P9.2: a doubtful-payment approval on a world_id-sourced promise -------
//
// Same `settleApproved` entry point as the WU12 tests above, but the
// resolved mandate (approvals.ts's `resolveMandate`) is a world_id promise
// instead of a wallet intent — so a valid, fresh World ID token for a human
// OTHER than the promise's own account must still refuse, fail-closed,
// exactly like promises.ts's own approval gate requires to activate a
// promise in the first place (promises.test.ts covers that gate directly;
// this covers the SEPARATE doubtful-payment gate reusing the same check).

function randomNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Seeds an ACTIVE promise (as if `settlePromiseApproved` already ran) owned
 * by an account bound to `ownerSubject`, plus the same `awaiting_world_id`
 * receipt + pending `PendingApproval` row `seedPendingApproval` above seeds
 * for a wallet intent — but with `intentId` naming the promise. */
function seedPendingApprovalOnPromise(ownerSubject: string) {
  const account = findOrCreateAccountBySubjectHash(hashWorldIdSubject(ownerSubject));
  // P11.2 — `settleApproved` now pays from the account's own smart account
  // (payer.ts's `resolvePayer`), so this fixture must have one deployed;
  // never really deployed on-chain (a fake but well-formed address) — fine
  // here since `settleApproved` never re-runs the funding health check
  // (paused/recipient/limit/balance), only `resolvePayer`'s "does this
  // account have a smart account at all" check. `signer.ts`'s account-signer
  // reads USDC's own (always-real) EIP-3009 domain, not anything from this
  // address, so signing still works for real.
  setAccountDeployment(account.id, {
    smartAccount: "0x2222222222222222222222222222222222222222",
    owner: "0x0000000000000000000000000000000000dEaD",
    perPaymentLimitAtomic: 25_000_000n,
    recipients: [{ address: PAY_TO, label: "test recipient" }],
  });
  const promiseId = `promise_approvals_test_${crypto.randomUUID()}`;
  createPromise({
    id: promiseId,
    accountId: account.id,
    task: "Buy a $1 Amazon gift card (rehearsal)",
    budget: 5_000_000n,
    categories: ["gift_card:amazon"],
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: randomNonce(),
    spent: BigInt(AMOUNT), // simulates the reservation pipeline.ts would have made
    status: "active",
    summary: "test setup",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const paymentIdentifier = `pay_test_${crypto.randomUUID()}`;
  const { receiptId } = finalize({
    paymentIdentifier,
    intentId: promiseId,
    resourceUrl: "http://localhost:4000/giftcard/amazon-1",
    amount: AMOUNT,
    payTo: PAY_TO,
    timeline: [],
    state: "awaiting_world_id",
    verdict: "ask_human",
    reason: "test setup",
    cache: false,
  });
  const approval = {
    receiptId,
    paymentIdentifier,
    intentId: promiseId,
    amountAtomic: AMOUNT,
    deviceCode: "device-1",
    userCode: "USER-1",
    verificationUri: "https://sandbox.auth.world.org/device",
    intervalSeconds: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requestedAt: new Date().toISOString(),
    gateStartedAtMs: Date.now(),
    status: "pending" as const,
    reason: "test setup",
    paymentRequiredJson: JSON.stringify({
      x402Version: 2,
      accepts: [{ scheme: "exact", network: NETWORK, amount: AMOUNT, asset: ASSET, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  savePendingApproval(approval);
  return { approval, receiptId, promiseId, account };
}

describe("settleApproved — a world_id promise requires the SAME human (P9.2)", () => {
  test("the promise's own subject -> pays normally, budget reserved stays spent", async () => {
    const ownerSubject = "world-id-subject-approvals-owner";
    const { approval, receiptId, promiseId } = seedPendingApprovalOnPromise(ownerSubject);

    await settleApproved(approval, { sub: ownerSubject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const receipt = getReceipt(receiptId);
    expect(receipt?.verdict).toBe("pay");
    expect(getPromise(promiseId)?.spent).toBe(BigInt(AMOUNT));
  });

  test("a DIFFERENT (but valid, fresh) human refuses with world_id_wrong_human and releases the budget", async () => {
    const ownerSubject = "world-id-subject-approvals-owner-2";
    const { approval, receiptId, promiseId } = seedPendingApprovalOnPromise(ownerSubject);

    await settleApproved(approval, { sub: "world-id-subject-approvals-intruder", acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const receipt = getReceipt(receiptId);
    expect(receipt?.verdict).toBe("refuse");
    expect(receipt?.state).toBe("world_id_denied");
    expect(receipt?.worldId).toEqual({ approved: false, status: "world_id_wrong_human" });
    // The reservation `seedPendingApprovalOnPromise` simulated is released
    // back to 0, same as every other `settleRefused` path.
    expect(getPromise(promiseId)?.spent).toBe(0n);
  });

  // P6 fix — `intent.revoked` (the generic wallet-mandate re-check just below
  // this describe block's own SUT) is ALWAYS `false` for a promise-backed
  // mandate (`promiseAsMandate`, promises.ts hardcodes it), so before this
  // fix a promise revoked by its owner WHILE this exact approval sat waiting
  // on the phone would still pay out on a genuine, fresh, correct-human
  // approval. `intent.promiseStatus` is what actually catches it now.
  test("the promise's owner revokes it while the approval is in flight -> the SAME correct human's approval still refuses", async () => {
    const ownerSubject = "world-id-subject-approvals-owner-revoked-in-flight";
    const { approval, receiptId, promiseId } = seedPendingApprovalOnPromise(ownerSubject);
    const active = getPromise(promiseId)!;
    savePromise({ ...active, status: "revoked", reason: "revoked by owner", updatedAt: new Date().toISOString() });

    await settleApproved(approval, { sub: ownerSubject, acr: "dev", authTime: Math.floor(Date.now() / 1000) });

    const receipt = getReceipt(receiptId);
    expect(receipt?.verdict).toBe("refuse");
    expect(receipt?.state).toBe("world_id_denied");
    expect(receipt?.worldId).toEqual({ approved: false, status: "revoked" });
    // Released back to 0, same as every other `settleRefused` path — never
    // signed, despite a genuine, fresh, correct-human World ID approval.
    expect(getPromise(promiseId)?.spent).toBe(0n);
  });
});
