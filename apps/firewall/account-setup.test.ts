// P11.3a — setup-link token lifecycle, signature verification (throwaway
// EOA wallets — never a real key), idempotent redeploy, and the stub
// deployer. Real Base Sepolia RPC reads happen here (`predictAddress` and
// `verifyMessage` are free view calls, no gas) — same "no mocks" discipline
// as every other suite in this directory (world-id.test.ts hits the real
// sandbox, promises.test.ts signs real attestations); only the actual
// `createAccount` WRITE transaction is skipped, via
// `OMAMORISAN_ACCOUNT_DEPLOYER=stub`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// store.ts opens a bun:sqlite file under FIREWALL_DATA_DIR and signer.ts
// reads FIREWALL_PRIVATE_KEY, both at module-load time — point both at an
// isolated temp dir / throwaway key before any import (promises.test.ts's
// pattern), never the shared dev sqlite file or the real key. Every test in
// this file deploys via the stub deployer — no gas, no real transaction —
// and a fixed default recipient, so tests never depend on
// MERCHANT_KEY/MERCHANT_ADDRESS being set in this process's environment.
process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-account-setup-test-"));
process.env.FIREWALL_PRIVATE_KEY ??= `0x${"44".repeat(32)}`;
process.env.OMAMORISAN_ACCOUNT_DEPLOYER = "stub";
process.env.OMAMORISAN_DEFAULT_RECIPIENTS = JSON.stringify([
  { address: "0x000000000000000000000000000000000000dEaD", label: "Test recipient" },
]);

const { findOrCreateAccountBySubjectHash, getAccount } = await import("./store");
const { createSetupLink, fillSetupMessage, getSetupStatus, linkOwner, setupMessageTemplate } = await import("./account-setup");
const { hashWorldIdSubject } = await import("@yakusoku/shared");

let seq = 0;
function freshAccount() {
  seq += 1;
  return findOrCreateAccountBySubjectHash(hashWorldIdSubject(`world-id-subject-account-setup-${seq}`));
}

async function signSetupMessage(accountId: string, token: string, owner: ReturnType<typeof privateKeyToAccount>): Promise<`0x${string}`> {
  const message = fillSetupMessage(setupMessageTemplate(accountId, token), owner.address);
  return owner.signMessage({ message });
}

describe("setup token lifecycle", () => {
  test("needs_owner before deployment, with the {owner} placeholder and live defaults", async () => {
    const account = freshAccount();
    const link = createSetupLink(account.id);
    expect(link.setupUrl).toContain(`/setup?token=${link.token}`);

    const status = await getSetupStatus(link.token);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status).toBe("needs_owner");
    expect(status.accountId).toBe(account.id);
    expect(status.message).toBe(setupMessageTemplate(account.id, link.token));
    expect(status.message).toContain("{owner}");
    expect(status.recipients).toEqual([{ address: "0x000000000000000000000000000000000000dEaD", label: "Test recipient" }]);
    // Decimal USDC STRING (site contract), never atomic units or a float.
    expect(typeof status.perPaymentLimitUsdc).toBe("string");
    expect(Number(status.perPaymentLimitUsdc)).toBeGreaterThan(0);
  });

  test("an unknown token is not found", async () => {
    const status = await getSetupStatus("yt_definitely-not-a-real-token");
    expect(status.ok).toBe(false);
  });
});

describe("signature verification (throwaway EOA)", () => {
  test("a valid signature over the exact filled message deploys the account", async () => {
    const account = freshAccount();
    const link = createSetupLink(account.id);
    const owner = privateKeyToAccount(generatePrivateKey());
    const signature = await signSetupMessage(account.id, link.token, owner);

    const outcome = await linkOwner(link.token, owner.address, signature);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.owner.toLowerCase()).toBe(owner.address.toLowerCase());
    expect(outcome.smartAccount).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const stored = getAccount(account.id);
    expect(stored?.smartAccount).toBe(outcome.smartAccount);
    expect(stored?.owner?.toLowerCase()).toBe(owner.address.toLowerCase());
  });

  test("a signature from a different wallet than the claimed owner is rejected", async () => {
    const account = freshAccount();
    const link = createSetupLink(account.id);
    const owner = privateKeyToAccount(generatePrivateKey());
    const impostor = privateKeyToAccount(generatePrivateKey());
    const message = fillSetupMessage(setupMessageTemplate(account.id, link.token), owner.address);
    const wrongSignature = await impostor.signMessage({ message });

    const outcome = await linkOwner(link.token, owner.address, wrongSignature);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("invalid_signature");
    expect(getAccount(account.id)?.smartAccount).toBeUndefined();
  });

  test("a signature over a different token's message is rejected", async () => {
    const account = freshAccount();
    const link = createSetupLink(account.id);
    const otherLink = createSetupLink(account.id); // same account, a second (different) token
    const owner = privateKeyToAccount(generatePrivateKey());
    const signatureForOtherToken = await signSetupMessage(account.id, otherLink.token, owner);

    const outcome = await linkOwner(link.token, owner.address, signatureForOtherToken);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("invalid_signature");
  });
});

describe("idempotency", () => {
  test("POSTing owner twice returns the exact same record, no signature re-check", async () => {
    const account = freshAccount();
    const link = createSetupLink(account.id);
    const owner = privateKeyToAccount(generatePrivateKey());
    const signature = await signSetupMessage(account.id, link.token, owner);

    const first = await linkOwner(link.token, owner.address, signature);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // A second POST — even with a garbage signature — still succeeds and
    // returns the identical record: an already-deployed account never
    // re-verifies a signature or sends a second transaction (root API
    // contract's idempotency requirement).
    const second = await linkOwner(link.token, owner.address, "0xdeadbeef");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.smartAccount).toBe(first.smartAccount);
    expect(second.owner).toBe(first.owner);
    expect(second.txHash).toBe(first.txHash);
  });

  test("GET /setup/:token after deployment reports status deployed with the same smartAccount", async () => {
    const account = freshAccount();
    const link = createSetupLink(account.id);
    const owner = privateKeyToAccount(generatePrivateKey());
    const signature = await signSetupMessage(account.id, link.token, owner);
    const deployed = await linkOwner(link.token, owner.address, signature);
    expect(deployed.ok).toBe(true);
    if (!deployed.ok) return;

    const status = await getSetupStatus(link.token);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.status).toBe("deployed");
    if (status.status !== "deployed") return;
    expect(status.smartAccount).toBe(deployed.smartAccount);
    expect(status.owner.toLowerCase()).toBe(owner.address.toLowerCase());
    // Decimal USDC STRING (site contract) — a fresh, unfunded account reads "0".
    expect(status.balanceUsdc).toBe("0");
  });
});

describe("stub deployer", () => {
  test("never sends a transaction — predicts the address, leaves txHash undefined", async () => {
    const account = freshAccount();
    const link = createSetupLink(account.id);
    const owner = privateKeyToAccount(generatePrivateKey());
    const signature = await signSetupMessage(account.id, link.token, owner);

    const outcome = await linkOwner(link.token, owner.address, signature);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.txHash).toBeUndefined();
  });
});
