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
import type { TaskIntentMessage } from "@yakusoku/shared";

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

const { createIntent, getReceipt, savePendingApproval } = await import("./store");
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
 * right before the gate resolves (`settleApproved`/`settleRefused` below). */
function seedPendingApproval() {
  const { intent } = createIntent(makeTaskIntent(), `0x${"aa".repeat(65)}`, "0x1111111111111111111111111111111111111111");
  const paymentIdentifier = `pay_test_${crypto.randomUUID()}`;
  const { receiptId } = finalize({
    paymentIdentifier,
    intentId: intent.id,
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
    intentId: intent.id,
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
