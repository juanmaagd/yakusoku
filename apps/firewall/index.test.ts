// P9 — `GET /approvals/:receiptId`'s mandate-credential path used to answer
// "this approval exists but belongs to a DIFFERENT mandate" (403 forbidden)
// differently from "this receiptId doesn't exist at all" (404
// approval_not_found) — an existence leak a caller could use to learn
// whether some other mandate's receiptId is real. This suite boots the
// actual Hono app on a real (ephemeral, ports-0) Bun server and drives it
// over real HTTP to prove both cases now answer identically — a bare
// `app.fetch(request)` call can't exercise this route at all: it goes
// through `isLocalAdminRequest`, which reads Hono's Bun `getConnInfo(c)`,
// and that throws unless `c.env.server` is a real `Bun.serve()` instance.
//
// Importing index.ts also runs its `resume*OnBoot()` calls once, over
// whatever this shared `bun test` process's sqlite db already holds (other
// test files' own leftover `pending`/`pending_approval` rows, if this file
// happens to load after them) — same as a real firewall restart. Those are
// `void ... .catch()` fire-and-forget background polls against the World ID
// sandbox (world-id.ts), exactly like production; a failed/unreachable
// network call there never blocks or fails THIS suite, it only logs. This
// file's own fixtures are never left pending (created and read synchronously
// within one test, never polled).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashWorldIdSubject, USDC_SEPOLIA_ADDRESS, X402_NETWORK, type TaskIntentMessage } from "@yakusoku/shared";

// store.ts opens a bun:sqlite file under FIREWALL_DATA_DIR and signer.ts
// reads FIREWALL_PRIVATE_KEY, both at module-load time — same isolated-temp-
// dir / throwaway-key pattern every other test file in this suite uses.
// account-setup.test.ts's own stub-deployer / fixed-recipients env vars, so
// this file's owner-account-panel tests (A2) deploy for free too — no gas,
// no dependency on MERCHANT_KEY/MERCHANT_ADDRESS being set in this shell.
process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-index-test-"));
process.env.FIREWALL_PRIVATE_KEY ??= `0x${"44".repeat(32)}`;
process.env.OMAMORISAN_ACCOUNT_DEPLOYER = "stub";
process.env.OMAMORISAN_DEFAULT_RECIPIENTS ??= JSON.stringify([
  { address: "0x000000000000000000000000000000000000dEaD", label: "Test recipient" },
]);

const { FIREWALL_DB_PATH, createIntent, createSession, findOrCreateAccountBySubjectHash, savePendingApproval, saveReceipt } = await import("./store");
const { createSetupLink, fillSetupMessage, linkOwner, setupMessageTemplate } = await import("./account-setup");
const firewallConfig = (await import("./index")).default;
const server = Bun.serve({ ...firewallConfig, port: 0 });
const BASE_URL = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
});

function makeTaskIntent(nonceByte: string): TaskIntentMessage {
  return {
    task: "Buy a 1 USDC gift card",
    budget: 5_000_000n,
    categories: ["gift_card:amazon"],
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: `0x${nonceByte.repeat(32)}` as `0x${string}`,
  };
}

/** Seeds a `pending` `PendingApproval` row for `intentId` — no underlying
 * receipt needed, `GET /approvals/:receiptId` only ever reads this table. */
function seedApproval(intentId: string, receiptId: string) {
  savePendingApproval({
    receiptId,
    paymentIdentifier: `pay_${receiptId}`,
    intentId,
    amountAtomic: "1000000",
    deviceCode: `device-${receiptId}`,
    userCode: "USER-1",
    verificationUri: "https://sandbox.auth.world.org/device",
    intervalSeconds: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requestedAt: new Date().toISOString(),
    gateStartedAtMs: Date.now(),
    status: "pending",
    reason: "test setup",
    paymentRequiredJson: "{}",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe("GET /approvals/:receiptId — no existence leak across mandates (P9)", () => {
  test("a foreign mandate's approval and a genuinely unknown receipt answer identically", async () => {
    const { intent: owned, agentKey: ownerKey } = createIntent(
      makeTaskIntent("aa"),
      `0x${"aa".repeat(65)}`,
      "0x1111111111111111111111111111111111111111",
    );
    const { agentKey: strangerKey } = createIntent(
      makeTaskIntent("bb"),
      `0x${"aa".repeat(65)}`,
      "0x2222222222222222222222222222222222222222",
    );
    seedApproval(owned.id, "receipt_p9_owned");

    const foreign = await fetch(`${BASE_URL}/approvals/receipt_p9_owned`, {
      headers: { authorization: `Bearer ${strangerKey}` },
    });
    const unknown = await fetch(`${BASE_URL}/approvals/receipt_p9_does_not_exist`, {
      headers: { authorization: `Bearer ${strangerKey}` },
    });

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());

    // Sanity: the OWNING mandate's own key still reads it fine — the fix
    // only collapses the MISMATCH case into 404, never a legitimate read.
    const own = await fetch(`${BASE_URL}/approvals/receipt_p9_owned`, {
      headers: { authorization: `Bearer ${ownerKey}` },
    });
    expect(own.status).toBe(200);
  });

  test("no credential at all -> 401, before any existence check ever runs", async () => {
    const res = await fetch(`${BASE_URL}/approvals/receipt_p9_does_not_exist`);
    expect(res.status).toBe(401);
  });
});

// --- WU: purchase ref — /sign request validation (odd/tasks/standing-rules.md T7) --
//
// `POST /sign`'s own `signRequestSchema` (this file) validates `purchaseRef`
// before ever reaching `runSignPipeline` — a malformed one never reaches the
// pipeline at all. The "valid purchaseRef" case below deliberately requests
// an over-budget amount so the request refuses at `checkPolicy`, strictly
// before the `merchant` stage's real self-fetch of `resourceUrl` — this
// worktree must never make that fetch hit `localhost:4000`/`4001` for real
// (those ports belong to the main checkout's live dev servers).

function makeSignBody(purchaseRef: unknown, amount = "1000000") {
  return {
    paymentRequired: {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: X402_NETWORK,
          amount,
          asset: USDC_SEPOLIA_ADDRESS,
          payTo: "0x1111111111111111111111111111111111111111",
        },
      ],
    },
    resourceUrl: "http://localhost:4000/giftcard/amazon-1-purchase-ref-index-test",
    purchaseRef,
  };
}

describe("POST /sign — purchaseRef validation (WU: purchase ref)", () => {
  test("a malformed purchaseRef -> 400 invalid_sign_request, never reaches the pipeline", async () => {
    const { agentKey } = createIntent(makeTaskIntent("dd"), `0x${"aa".repeat(65)}`, "0x4444444444444444444444444444444444444444");
    const res = await fetch(`${BASE_URL}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentKey}` },
      body: JSON.stringify(makeSignBody("not a valid ref!")),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_sign_request");
  });

  test("a well-formed purchaseRef passes validation and reaches the pipeline (refuses at policy, not 400)", async () => {
    const { agentKey } = createIntent(makeTaskIntent("ee"), `0x${"aa".repeat(65)}`, "0x5555555555555555555555555555555555555555");
    const res = await fetch(`${BASE_URL}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentKey}` },
      // $50 > the $5 budget makeTaskIntent grants -> policy_rejected, well
      // before the merchant stage's own self-fetch would ever run.
      body: JSON.stringify(makeSignBody("valid-ref-1", "50000000")),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdict?: string; reason?: string };
    expect(body.verdict).toBe("refuse");
    expect(body.reason).toContain("exceeds remaining budget");
  });
});

test("gift card code is delivered only to the signed-in receipt owner", async () => {
  const owner = "0x3333333333333333333333333333333333333333" as const;
  const stranger = "0x4444444444444444444444444444444444444444" as const;
  const { intent, agentKey } = createIntent(makeTaskIntent("cc"), `0x${"aa".repeat(65)}`, owner);
  const receiptId = `receipt_gift_card_${crypto.randomUUID()}`;
  const code = "GC-OWNER-ONLY-1234";
  const txHash = `0x${"12".repeat(32)}`;
  saveReceipt({
    receiptId,
    paymentIdentifier: `payment_${receiptId}`,
    intentId: intent.id,
    createdAt: new Date().toISOString(),
    state: "signed",
    verdict: "pay",
    reasons: ["approved"],
    resourceUrl: "http://store.test/giftcard/amazon-1-rehearsal",
    amount: "1000000",
    timeline: [],
  });

  const settlement = await fetch(`${BASE_URL}/receipts/${receiptId}/settlement`, {
    method: "POST",
    headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" },
    body: JSON.stringify({ txHash, giftCard: { sku: "amazon-1-rehearsal", code, amountUsdc: 1 } }),
  });
  expect(settlement.status).toBe(200);
  const reported = await settlement.json() as { revealUrl: string };
  expect(reported.revealUrl).toContain(`receipt=${receiptId}`);
  expect(JSON.stringify(reported)).not.toContain(code);

  const ownerToken = createSession(owner).token;
  const strangerToken = createSession(stranger).token;
  const giftCardUrl = `${BASE_URL}/receipts/${receiptId}/gift-card`;
  expect((await fetch(giftCardUrl)).status).toBe(401);
  expect((await fetch(giftCardUrl, { headers: { authorization: `Bearer ${agentKey}` } })).status).toBe(401);
  expect((await fetch(giftCardUrl, { headers: { authorization: `Bearer ${strangerToken}` } })).status).toBe(404);

  const ownerResponse = await fetch(giftCardUrl, { headers: { authorization: `Bearer ${ownerToken}` } });
  expect(ownerResponse.status).toBe(200);
  expect(ownerResponse.headers.get("cache-control")).toContain("no-store");
  expect((await ownerResponse.json() as { code: string }).code).toBe(code);

  // The store's own file, not this file's FIREWALL_DATA_DIR: in the full
  // suite another test file opened the shared connection first.
  const database = new Database(FIREWALL_DB_PATH, { readonly: true });
  const stored = database.prepare("SELECT encrypted_code FROM gift_card_fulfillments WHERE receipt_id = ?").get(receiptId) as { encrypted_code: string };
  expect(stored.encrypted_code).not.toContain(code);
  database.close();

  const ordinaryReceipt = await fetch(`${BASE_URL}/receipts/${receiptId}`, { headers: { authorization: `Bearer ${ownerToken}` } });
  const publicReceipt = await ordinaryReceipt.json() as { giftCardAvailable: boolean };
  expect(publicReceipt.giftCardAvailable).toBe(true);
  expect(JSON.stringify(publicReceipt)).not.toContain(code);
});

// --- GET /owner/accounts — owner account panel (A2) -------------------------
// Same "boot the real Hono app, drive it over real HTTP" style as the P9
// suite above. Deploys via the stub deployer (account-setup.test.ts's own
// pattern) — no gas, no real transaction — so this only ever proves the
// route's own auth/scoping, never anything about a live deploy.

describe("GET /owner/accounts (owner account panel A2)", () => {
  async function deployOwnedAccount() {
    const owner = privateKeyToAccount(generatePrivateKey());
    const account = findOrCreateAccountBySubjectHash(hashWorldIdSubject(`owner-accounts-test-${crypto.randomUUID()}`));
    const link = createSetupLink(account.id);
    const message = fillSetupMessage(setupMessageTemplate(account.id, link.token), owner.address);
    const signature = await owner.signMessage({ message });
    const outcome = await linkOwner(link.token, owner.address, signature);
    if (!outcome.ok) throw new Error(`test setup: linkOwner failed (${outcome.reason})`);
    return { owner, smartAccount: outcome.smartAccount };
  }

  test("no credential at all -> 401", async () => {
    const res = await fetch(`${BASE_URL}/owner/accounts`);
    expect(res.status).toBe(401);
  });

  test("an owner who never linked an account sees an empty list, not an error", async () => {
    const { token } = createSession(`0x${"99".repeat(20)}`);
    const res = await fetch(`${BASE_URL}/owner/accounts`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("an owner sees their own deployed account, never a different owner's", async () => {
    const mine = await deployOwnedAccount();
    const theirs = await deployOwnedAccount();

    const { token } = createSession(mine.owner.address);
    const res = await fetch(`${BASE_URL}/owner/accounts`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      smartAccount: string;
      owner: string;
      operator: string;
      perPaymentLimitUsdc: string;
      knownMerchants: unknown[];
    }[];
    expect(body).toHaveLength(1);
    expect(body[0]?.smartAccount.toLowerCase()).toBe(mine.smartAccount.toLowerCase());
    expect(body[0]?.owner.toLowerCase()).toBe(mine.owner.address.toLowerCase());
    expect(typeof body[0]?.perPaymentLimitUsdc).toBe("string");
    expect(Array.isArray(body[0]?.knownMerchants)).toBe(true);
    // Never leaks a different owner's account into this owner's list.
    expect(body.some((a) => a.smartAccount.toLowerCase() === theirs.smartAccount.toLowerCase())).toBe(false);
  });
});
