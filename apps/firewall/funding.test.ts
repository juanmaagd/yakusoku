// P11.2 — funding pipeline stage unit tests, against the STUB account-health
// reader (`OMAMORISAN_ACCOUNT_READER=stub`) only — never the real one, which
// needs a really-deployed contract and live chain state (proven separately by
// the live E2E check). `funding.ts` transitively imports store.ts (opens a
// bun:sqlite file under FIREWALL_DATA_DIR) and signer.ts (reads
// FIREWALL_PRIVATE_KEY) at module-load time — point both at an isolated temp
// dir / throwaway key before any import, same pattern every other suite in
// this directory uses (pipeline.test.ts, merchant.test.ts). No network.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PaymentRequired } from "@x402/core/types";
import { USDC_SEPOLIA_ADDRESS, X402_NETWORK, hashWorldIdSubject, type PaymentRequirement } from "@yakusoku/shared";

process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-funding-test-"));
process.env.FIREWALL_PRIVATE_KEY ??= `0x${"44".repeat(32)}`;
process.env.OMAMORISAN_ACCOUNT_READER = "stub";

const { fundingStage } = await import("./funding");
const { operatorAccount } = await import("./signer");
const { findOrCreateAccountBySubjectHash, setAccountDeployment, setAccountHealthOverride } = await import("./store");

import type { StageContext } from "./pipeline";
import type { StoredIntent } from "./store";

const MERCHANT_PAY_TO = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
const OTHER_PAY_TO = "0x000000000000000000000000000000000000dEaD";
const AMOUNT = "1000000"; // 1 USDC

let seq = 0;
function freshAccountId(): string {
  seq += 1;
  return findOrCreateAccountBySubjectHash(hashWorldIdSubject(`world-id-subject-funding-test-${seq}`)).id;
}

/** Deploys (via the stub deployer's own bookkeeping — `setAccountDeployment`
 * directly, no network) a smart account allow-listing `MERCHANT_PAY_TO` with
 * a $25 per-payment limit, unless overridden. Never really deployed
 * on-chain; the stub reader (funding.ts) reads this recorded config instead
 * of the chain. */
function deployAccount(accountId: string, overrides: { perPaymentLimitAtomic?: bigint; recipients?: `0x${string}`[] } = {}): `0x${string}` {
  const smartAccount = privateKeyToAccount(generatePrivateKey()).address;
  setAccountDeployment(accountId, {
    smartAccount,
    owner: "0x0000000000000000000000000000000000dEaD",
    perPaymentLimitAtomic: overrides.perPaymentLimitAtomic ?? 25_000_000n,
    recipients: (overrides.recipients ?? [MERCHANT_PAY_TO]).map((address) => ({ address, label: "test" })),
  });
  return smartAccount;
}

function requirement(overrides: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    amount: AMOUNT,
    asset: USDC_SEPOLIA_ADDRESS,
    payTo: MERCHANT_PAY_TO,
    ...overrides,
  };
}

function walletIntent(): StoredIntent {
  return {
    id: "intent_wallet",
    message: {
      task: "Buy a $1 Amazon gift card (rehearsal)",
      budget: 1_000_000n,
      categories: ["gift_card:amazon"],
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${"11".repeat(32)}`,
    },
    signature: `0x${"aa".repeat(65)}`,
    signer: "0x1111111111111111111111111111111111111111",
    spent: 0n,
    createdAt: new Date().toISOString(),
    revoked: false,
  };
}

function promiseIntent(accountId: string | undefined): StoredIntent {
  return {
    ...walletIntent(),
    id: "promise_test",
    signature: "0x00",
    signer: "0x0000000000000000000000000000000000dEaD",
    source: "world_id",
    accountId,
    promiseStatus: "active",
    merchant: "http://localhost:4000",
  };
}

function stageContext(intent: StoredIntent, req: PaymentRequirement = requirement()): StageContext {
  return {
    intent,
    requirement: req,
    paymentRequired: { x402Version: 1, accepts: [req] } as unknown as PaymentRequired,
    resourceUrl: "http://localhost:4000/giftcard/amazon-1-rehearsal",
  };
}

describe("fundingStage — legacy wallet mandate", () => {
  test("passes through untouched — no on-chain account to check", async () => {
    const result = await fundingStage.run(stageContext(walletIntent()));
    expect(result).toEqual({ outcome: "pass" });
  });
});

describe("fundingStage — world_id account mandate, refusals", () => {
  test("no smart account deployed yet -> refuse account_not_set_up", async () => {
    const accountId = freshAccountId();
    const result = await fundingStage.run(stageContext(promiseIntent(accountId)));
    expect(result.outcome).toBe("refuse");
    if (result.outcome !== "refuse") return;
    expect(result.reason).toMatch(/^account_not_set_up:/);
  });

  test("paused -> refuse paused (checked before recipient/limit/balance)", async () => {
    const accountId = freshAccountId();
    const smartAccount = deployAccount(accountId);
    setAccountHealthOverride(accountId, { paused: true });

    const result = await fundingStage.run(stageContext(promiseIntent(accountId)));
    expect(result.outcome).toBe("refuse");
    if (result.outcome !== "refuse") return;
    expect(result.reason).toBe(`paused: the account ${smartAccount} is paused`);
  });

  test("merchant not in the deployed recipient allow-list -> refuse recipient_not_registered", async () => {
    const accountId = freshAccountId();
    // Deployed allow-listing a DIFFERENT recipient than the one being paid.
    deployAccount(accountId, { recipients: [OTHER_PAY_TO] });

    const result = await fundingStage.run(stageContext(promiseIntent(accountId)));
    expect(result.outcome).toBe("refuse");
    if (result.outcome !== "refuse") return;
    expect(result.reason).toMatch(/^recipient_not_registered:/);
  });

  test("payment exceeds the account's per-payment limit -> refuse over_account_limit", async () => {
    const accountId = freshAccountId();
    deployAccount(accountId, { perPaymentLimitAtomic: 500_000n }); // 0.5 USDC < the 1 USDC payment
    setAccountHealthOverride(accountId, { recipientAllowed: true });

    const result = await fundingStage.run(stageContext(promiseIntent(accountId)));
    expect(result.outcome).toBe("refuse");
    if (result.outcome !== "refuse") return;
    expect(result.reason).toMatch(/^over_account_limit:/);
  });

  test("account balance is short -> refuse insufficient_funds", async () => {
    const accountId = freshAccountId();
    const smartAccount = deployAccount(accountId);
    setAccountHealthOverride(accountId, { recipientAllowed: true, balanceAtomic: 100_000n }); // 0.1 USDC < the 1 USDC payment

    const result = await fundingStage.run(stageContext(promiseIntent(accountId)));
    expect(result.outcome).toBe("refuse");
    if (result.outcome !== "refuse") return;
    expect(result.reason).toContain("insufficient_funds:");
    expect(result.reason).toContain(smartAccount);
  });
});

describe("fundingStage — world_id account mandate, happy path", () => {
  test("deployed, unpaused, allow-listed recipient, within limit, funded -> pass", async () => {
    const accountId = freshAccountId();
    deployAccount(accountId); // allow-lists MERCHANT_PAY_TO, $25 limit — default stub balance is generous.

    const result = await fundingStage.run(stageContext(promiseIntent(accountId)));
    expect(result).toEqual({ outcome: "pass" });
  });

  test("never resolves the firewall EOA as payer for an account promise", async () => {
    const accountId = freshAccountId();
    const smartAccount = deployAccount(accountId);
    expect(smartAccount.toLowerCase()).not.toBe(operatorAccount.address.toLowerCase());

    const result = await fundingStage.run(stageContext(promiseIntent(accountId)));
    expect(result.outcome).toBe("pass");
  });
});
