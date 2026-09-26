// dashboard-promises (D1, odd/tasks/dashboard-promises.md) — the owner-scoping
// helpers `listAccountsByOwner`/`listOwnedMandateIds` (store.ts) that let the
// SIWE-authenticated owner dashboard see World ID promises and their
// receipts, not just legacy wallet-signed intents. No network: seeds
// accounts/intents/promises/receipts directly, same pattern
// promises.test.ts/approvals.test.ts use, never `mock.module`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { toHex } from "viem";
import { hashWorldIdSubject, type TaskIntentMessage } from "@yakusoku/shared";

// store.ts opens a bun:sqlite file under FIREWALL_DATA_DIR at module-load
// time — point it at an isolated temp dir before any import (approvals.test.ts's
// pattern), never the shared dev sqlite file.
process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-store-test-"));
process.env.FIREWALL_PRIVATE_KEY ??= `0x${"44".repeat(32)}`;

const { createIntent, createPromise, findOrCreateAccountBySubjectHash, listAccountsByOwner, listOwnedMandateIds, listReceipts, setAccountDeployment } =
  await import("./store");
const { finalize } = await import("./receipts");

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const OTHER_WALLET = "0x2222222222222222222222222222222222222222" as const;

function randomNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function makeTaskIntent(): TaskIntentMessage {
  return {
    task: "Buy a 1 USDC gift card",
    budget: 5_000_000n,
    categories: ["gift_card:amazon"],
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: randomNonce(),
  };
}

let seq = 0;
/** Seeds an `active` promise on `accountId` — the state a real promise
 * reaches after a genuine World ID approval (promises.ts's
 * `settlePromiseApproved`), skipped here since this suite only exercises
 * owner-scoping, not the approval flow itself. */
function seedActivePromise(accountId: string): string {
  seq += 1;
  const id = `promise_store_test_${seq}`;
  createPromise({
    id,
    accountId,
    task: "Buy a $1 Amazon gift card",
    budget: 1_000_000n,
    categories: ["gift_card:amazon"],
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: randomNonce(),
    merchant: "http://localhost:4000",
    spent: 0n,
    status: "active",
    summary: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}

/** Seeds a terminal `signed` receipt for `intentId` — same minimal shape
 * `approvals.test.ts` builds via `finalize` (receipts.ts), just enough to
 * satisfy `decisionReceiptSchema`. */
function seedReceipt(intentId: string): string {
  const { receiptId } = finalize({
    paymentIdentifier: `pay_test_${crypto.randomUUID()}`,
    intentId,
    resourceUrl: "http://localhost:4000/giftcard/amazon-1",
    timeline: [],
    state: "signed",
    verdict: "pay",
    reason: "test",
    cache: false,
  });
  return receiptId;
}

describe("listAccountsByOwner (dashboard-promises D1)", () => {
  test("finds an account by its linked owner, case-insensitively, and nothing for an unlinked wallet", () => {
    const acct = findOrCreateAccountBySubjectHash(hashWorldIdSubject(`subject-${crypto.randomUUID()}`));
    setAccountDeployment(acct.id, {
      smartAccount: "0x3333333333333333333333333333333333333333",
      owner: OWNER,
      perPaymentLimitAtomic: 1_000_000n,
      recipients: [],
    });

    expect(listAccountsByOwner(OWNER).map((a) => a.id)).toEqual([acct.id]);
    expect(listAccountsByOwner(OWNER.toLowerCase() as `0x${string}`).map((a) => a.id)).toEqual([acct.id]);
    expect(listAccountsByOwner(OTHER_WALLET)).toEqual([]);
  });
});

describe("listOwnedMandateIds (dashboard-promises D1)", () => {
  test("an owner sees their promise and its receipt; a different wallet sees none", () => {
    const acct = findOrCreateAccountBySubjectHash(hashWorldIdSubject(`subject-${crypto.randomUUID()}`));
    setAccountDeployment(acct.id, {
      smartAccount: "0x4444444444444444444444444444444444444444",
      owner: OWNER,
      perPaymentLimitAtomic: 1_000_000n,
      recipients: [],
    });
    const promiseId = seedActivePromise(acct.id);
    const promiseReceiptId = seedReceipt(promiseId);

    const ownedIds = listOwnedMandateIds(OWNER);
    expect(ownedIds.has(promiseId)).toBe(true);

    // GET /receipts (index.ts) applies exactly this filter.
    const ownedReceiptIds = listReceipts(50)
      .filter((r) => ownedIds.has(r.intentId))
      .map((r) => r.receiptId);
    expect(ownedReceiptIds).toContain(promiseReceiptId);

    const otherWalletIds = listOwnedMandateIds(OTHER_WALLET);
    expect(otherWalletIds.has(promiseId)).toBe(false);
    const otherWalletReceiptIds = listReceipts(50)
      .filter((r) => otherWalletIds.has(r.intentId))
      .map((r) => r.receiptId);
    expect(otherWalletReceiptIds).not.toContain(promiseReceiptId);
  });

  test("the legacy wallet-signed intent path is unchanged: owner = signer, no account involved", () => {
    const { intent } = createIntent(makeTaskIntent(), `0x${"aa".repeat(65)}`, OWNER);
    const receiptId = seedReceipt(intent.id);

    const ownedIds = listOwnedMandateIds(OWNER);
    expect(ownedIds.has(intent.id)).toBe(true);
    expect(
      listReceipts(50)
        .filter((r) => ownedIds.has(r.intentId))
        .map((r) => r.receiptId),
    ).toContain(receiptId);

    const otherWalletIds = listOwnedMandateIds(OTHER_WALLET);
    expect(otherWalletIds.has(intent.id)).toBe(false);
  });

  test("unions a wallet's own legacy intents with the promise ids of every account it owns", () => {
    const { intent } = createIntent(makeTaskIntent(), `0x${"bb".repeat(65)}`, OWNER);

    const acctA = findOrCreateAccountBySubjectHash(hashWorldIdSubject(`subject-${crypto.randomUUID()}`));
    setAccountDeployment(acctA.id, {
      smartAccount: "0x5555555555555555555555555555555555555555",
      owner: OWNER,
      perPaymentLimitAtomic: 1_000_000n,
      recipients: [],
    });
    const promiseA = seedActivePromise(acctA.id);

    // A second account owned by the SAME wallet — both accounts' promises
    // must show up, not just the first match.
    const acctB = findOrCreateAccountBySubjectHash(hashWorldIdSubject(`subject-${crypto.randomUUID()}`));
    setAccountDeployment(acctB.id, {
      smartAccount: "0x6666666666666666666666666666666666666666",
      owner: OWNER,
      perPaymentLimitAtomic: 1_000_000n,
      recipients: [],
    });
    const promiseB = seedActivePromise(acctB.id);

    // An account owned by someone else must never leak in.
    const acctStranger = findOrCreateAccountBySubjectHash(hashWorldIdSubject(`subject-${crypto.randomUUID()}`));
    setAccountDeployment(acctStranger.id, {
      smartAccount: "0x7777777777777777777777777777777777777777",
      owner: OTHER_WALLET,
      perPaymentLimitAtomic: 1_000_000n,
      recipients: [],
    });
    const strangerPromise = seedActivePromise(acctStranger.id);

    const ownedIds = listOwnedMandateIds(OWNER);
    expect(ownedIds.has(intent.id)).toBe(true);
    expect(ownedIds.has(promiseA)).toBe(true);
    expect(ownedIds.has(promiseB)).toBe(true);
    expect(ownedIds.has(strangerPromise)).toBe(false);
  });
});
