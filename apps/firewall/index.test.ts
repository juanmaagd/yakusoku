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
import type { TaskIntentMessage } from "@yakusoku/shared";

// store.ts opens a bun:sqlite file under FIREWALL_DATA_DIR and signer.ts
// reads FIREWALL_PRIVATE_KEY, both at module-load time — same isolated-temp-
// dir / throwaway-key pattern every other test file in this suite uses.
process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-index-test-"));
process.env.FIREWALL_PRIVATE_KEY ??= `0x${"44".repeat(32)}`;

const { createIntent, savePendingApproval } = await import("./store");
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
