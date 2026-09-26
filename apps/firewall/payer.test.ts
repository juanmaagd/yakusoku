// P11.2 — `resolvePayer` unit tests. `payer.ts` transitively imports
// signer.ts (reads FIREWALL_PRIVATE_KEY at module-load time to build the
// firewall's operator account) and store.ts (opens a bun:sqlite file under
// FIREWALL_DATA_DIR) — point both at a throwaway key / isolated temp dir
// before any import, same pattern account-setup.test.ts / pipeline.test.ts
// use. No network: `resolvePayer` is a pure lookup, never a chain read.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-payer-test-"));
process.env.FIREWALL_PRIVATE_KEY ??= `0x${"33".repeat(32)}`;

const { resolvePayer } = await import("./payer");
const { operatorAccount } = await import("./signer");
const { findOrCreateAccountBySubjectHash, setAccountDeployment } = await import("./store");
const { hashWorldIdSubject } = await import("@yakusoku/shared");

import type { StoredIntent } from "./store";

let seq = 0;
function freshAccountId(): string {
  seq += 1;
  return findOrCreateAccountBySubjectHash(hashWorldIdSubject(`world-id-subject-payer-test-${seq}`)).id;
}

function walletIntent(overrides: Partial<StoredIntent> = {}): StoredIntent {
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
    ...overrides,
  };
}

function promiseMandate(accountId: string | undefined, overrides: Partial<StoredIntent> = {}): StoredIntent {
  return {
    ...walletIntent({
      id: "promise_test",
      signature: "0x00",
      signer: "0x0000000000000000000000000000000000dEaD",
      source: "world_id",
      accountId,
      promiseStatus: "active",
      merchant: "http://localhost:4000",
    }),
    ...overrides,
  };
}

describe("resolvePayer — legacy wallet mandate (source unset)", () => {
  test("always pays from the firewall's own operator EOA", () => {
    const result = resolvePayer(walletIntent());
    expect(result).toEqual({ ok: true, payer: { kind: "firewall", address: operatorAccount.address } });
  });
});

describe("resolvePayer — world_id account mandate", () => {
  test("no smart account deployed yet -> account_not_set_up, never the firewall EOA", () => {
    const accountId = freshAccountId();
    const result = resolvePayer(promiseMandate(accountId));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("account_not_set_up");
    expect(result.detail).toContain("setup_account");
  });

  test("accountId pointing at a nonexistent account -> account_not_set_up", () => {
    const result = resolvePayer(promiseMandate("account_does_not_exist"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("account_not_set_up");
  });

  test("no accountId at all -> account_not_set_up, fails closed rather than throwing", () => {
    const result = resolvePayer(promiseMandate(undefined));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("account_not_set_up");
  });

  test("a deployed smart account -> pays from it, never the firewall EOA", () => {
    const accountId = freshAccountId();
    const smartAccount = privateKeyToAccount(generatePrivateKey()).address;
    setAccountDeployment(accountId, {
      smartAccount,
      owner: "0x0000000000000000000000000000000000dEaD",
      perPaymentLimitAtomic: 25_000_000n,
      recipients: [{ address: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef", label: "test" }],
    });

    const result = resolvePayer(promiseMandate(accountId));
    expect(result).toEqual({ ok: true, payer: { kind: "smart_account", address: smartAccount } });
    expect(result.ok && result.payer.address).not.toBe(operatorAccount.address);
  });
});
