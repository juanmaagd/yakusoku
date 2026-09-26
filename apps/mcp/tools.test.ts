// T8 fix A/B regression tests (odd/tasks/dokploy-deploy.md) — multi-user
// isolation on the shared HTTP MCP server. Stubbed `fetch` only (same
// discipline apps/firewall/intercepta.test.ts documents): this file never
// talks to a real firewall.

import { afterEach, describe, expect, test } from "bun:test";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionState, noCredentialMessage, type CredentialRef } from "./session";
import { noPendingPurchaseMessage, registerTools } from "./tools";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// --- Fix A: session isolation -------------------------------------------------

describe("createSessionState — session isolation (T8 fix A)", () => {
  test("two independently created sessions never share a credential", () => {
    const sessionA = createSessionState("http://firewall.test", {}, true);
    const sessionB = createSessionState("http://firewall.test", {}, true);

    sessionA.setAgentKey("yk_test_A");

    expect(sessionA.getAgentKey()).toBe("yk_test_A");
    expect(sessionB.hasAgentKey()).toBe(false);
    expect(() => sessionB.getAgentKey()).toThrow();
  });

  test("HTTP mode's no-credential message points at connect/request_promise, not the credentials file", () => {
    expect(noCredentialMessage(true)).toContain("connect");
    expect(noCredentialMessage(true)).toContain("request_promise");
    expect(noCredentialMessage(true)).not.toContain("credentials file");
  });

  test("stdio's no-credential message still mentions the credentials file", () => {
    expect(noCredentialMessage(false)).toContain("credentials file");
  });
});

// --- Fix B: check_approval refuses a foreign session --------------------------

/** Wires one MCP session end to end (server + tools + an in-memory-connected
 * client) exactly like index.ts's `handleMcpRequest` wires one real HTTP
 * session — the only faithful way to exercise the registered tool handlers
 * themselves rather than re-implementing their logic in the test. `httpMode:
 * false` here is deliberate and orthogonal to what's under test: it keeps
 * `pay_x402`/`check_approval`'s own resource fetch on the plain (stubbed)
 * `fetch` instead of T2's SSRF guard, which would otherwise try a real DNS
 * lookup on this test's fake hostnames — the fix A/B logic under test
 * (session isolation, pendingPayments ownership) does not depend on httpMode. */
async function wireSession(agentKey: string): Promise<Client> {
  const credential: CredentialRef = { current: agentKey };
  const session = createSessionState("http://firewall.test", credential, true);
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  registerTools(server, { firewallUrl: "http://firewall.test", httpMode: false }, session);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  const first = content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`unexpected tool result content: ${JSON.stringify(result)}`);
  }
  return first.text;
}

describe("check_approval — cross-session ownership (T8 fix B)", () => {
  test("a foreign session's check_approval is refused (not-found-style, no firewall call), and its own owner still succeeds", async () => {
    const paymentRequiredHeader = encodePaymentRequiredHeader({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount: "1000000",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 60,
        },
      ],
    } as unknown as Parameters<typeof encodePaymentRequiredHeader>[0]);

    const requestLog: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      requestLog.push(`${method} ${url}`);
      const headers = new Headers(init?.headers);

      if (url === "http://store.test/item") {
        if (headers.has("payment-signature")) {
          return new Response(JSON.stringify({ sku: "amazon-1", code: "GC-TEST-1234", amountUsdc: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader } });
      }
      if (url === "http://firewall.test/mandate") {
        return Response.json({
          id: "intent_1",
          task: "buy a $1 gift card",
          budget: "1000000",
          remainingBudget: "1000000",
          categories: ["gift_card:amazon"],
          expiry: "9999999999",
          revoked: false,
        });
      }
      if (url === "http://firewall.test/sign" && method === "POST") {
        return Response.json({
          verdict: "ask_human",
          reason: "amount above HUMAN_APPROVAL_OVER_USDC",
          receiptId: "receipt_1",
          approval: { status: "pending", verificationUri: "https://sandbox.auth.world.org/approve", userCode: "ABC-123", expiresAt: "2999-01-01T00:00:00.000Z" },
        });
      }
      if (url === "http://firewall.test/approvals/receipt_1") {
        return Response.json({ status: "approved", verdict: "pay", reason: "approved", paymentSignature: "sig_test_abc" });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }) as typeof fetch;

    const clientA = await wireSession("yk_test_A");
    const clientB = await wireSession("yk_test_B");

    // Session A buys — the firewall escalates to a human, so pay_x402
    // records the pending payment against A's own credential.
    const payResult = await clientA.callTool({
      name: "pay_x402",
      arguments: { url: "http://store.test/item", justification: "matches the human's request" },
    });
    const payBody = JSON.parse(textOf(payResult)) as { status: string; receiptId: string };
    expect(payBody.status).toBe("needs_human_approval");
    expect(payBody.receiptId).toBe("receipt_1");

    // Session B (a different credential entirely) learns/guesses the same
    // receiptId and tries to complete it — must be refused, and must never
    // even reach the firewall (no leak of whether the receipt exists).
    const requestsBeforeForeignAttempt = requestLog.length;
    const foreignResult = await clientB.callTool({ name: "check_approval", arguments: { receiptId: "receipt_1" } });
    expect(foreignResult.isError).toBe(true);
    expect(textOf(foreignResult)).toBe(noPendingPurchaseMessage("receipt_1"));
    expect(requestLog.length).toBe(requestsBeforeForeignAttempt); // no new fetch — never asked the firewall

    // Session A (the real owner) can still complete its own purchase.
    const ownResult = await clientA.callTool({ name: "check_approval", arguments: { receiptId: "receipt_1" } });
    expect(ownResult.isError ?? false).toBe(false);
    const ownBody = JSON.parse(textOf(ownResult)) as { status: string; giftCard?: { code: string } };
    expect(ownBody.status).toBe("paid");
    expect(ownBody.giftCard?.code).toBe("GC-TEST-1234");

    await Promise.all([clientA.close(), clientB.close()]);
  });
});

// --- Promise-replacement fix --------------------------------------------------

describe("request_promise — replaces passthrough (promise-replacement fix)", () => {
  test("forwards replaces to POST /promises when provided, and surfaces it once active", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://firewall.test/promises" && method === "POST") {
        requestBodies.push(JSON.parse(String(init?.body)));
        return Response.json({
          promiseId: "promise_new",
          status: "pending_approval",
          verificationUri: "https://sandbox.auth.world.org/device",
          userCode: "ABC-123",
          expiresAt: "2999-01-01T00:00:00.000Z",
          summary: 'Replaces "old task" ($1.00 USDC left). Approve "new task" — up to $2.00 USDC across gift_card:steam, at store.test.',
        });
      }
      if (url === "http://firewall.test/promises/promise_new" && method === "GET") {
        return Response.json({
          id: "promise_new",
          task: "buy a steam gift card instead",
          status: "active",
          budget: "2000000",
          remainingBudget: "2000000",
          categories: ["gift_card:steam"],
          expiry: "9999999999",
          createdAt: new Date().toISOString(),
          summary: 'Replaces "old task" ($1.00 USDC left). Approve "new task" — up to $2.00 USDC across gift_card:steam, at store.test.',
          replaces: "promise_old",
        });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }) as typeof fetch;

    const client = await wireSession("ya_test_replaces");
    const result = await client.callTool({
      name: "request_promise",
      arguments: {
        task: "buy a steam gift card instead",
        budgetUsdc: 2,
        categories: ["gift_card:steam"],
        expiresInMinutes: 60,
        merchant: "http://store.test",
        replaces: "promise_old",
      },
    });

    expect(requestBodies[0]?.replaces).toBe("promise_old");
    const body = JSON.parse(textOf(result)) as { status: string; replaces?: string };
    expect(body.status).toBe("active");
    expect(body.replaces).toBe("promise_old");
    await client.close();
  });
});

describe("pay_x402 — Jev intent-mismatch refusal hint (promise-replacement fix)", () => {
  /** Wires one session with an already-active promise (`promise_1`, task
   * "buy a $1 amazon gift card") and a `/sign` stub that refuses with the
   * given reason — every test below only differs in that reason. */
  async function payAndRefuseWithReason(reason: string): Promise<{ status: string; reason: string; actionableHint?: string }> {
    const paymentRequiredHeader = encodePaymentRequiredHeader({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:84532",
          amount: "1000000",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 60,
        },
      ],
    } as unknown as Parameters<typeof encodePaymentRequiredHeader>[0]);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://store.test/item") {
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": paymentRequiredHeader } });
      }
      if (url === "http://firewall.test/promises/promise_1") {
        return Response.json({
          id: "promise_1",
          task: "buy a $1 amazon gift card",
          status: "active",
          budget: "1000000",
          remainingBudget: "1000000",
          categories: ["gift_card:amazon"],
          expiry: "9999999999",
          createdAt: new Date().toISOString(),
          summary: 'Approve "buy a $1 amazon gift card" — up to $1.00 USDC across gift_card:amazon, at store.test.',
        });
      }
      if (url === "http://firewall.test/sign" && method === "POST") {
        return Response.json({ verdict: "refuse", reason, receiptId: "receipt_jev" });
      }
      if (url === "http://firewall.test/accounts/setup-link" && method === "POST") {
        // Only reached by the funding-hint case's best-effort setupUrl fetch.
        return Response.json({ setupUrl: "http://setup.test/x", token: "t", expiresAt: "2999-01-01T00:00:00.000Z" });
      }
      throw new Error(`unexpected fetch in test: ${method} ${url}`);
    }) as typeof fetch;

    const client = await wireSession("ya_test_jev");
    const result = await client.callTool({
      name: "pay_x402",
      arguments: { url: "http://store.test/item", justification: "matches the human's request", promiseId: "promise_1" },
    });
    const body = JSON.parse(textOf(result)) as { status: string; reason: string; actionableHint?: string };
    await client.close();
    return body;
  }

  test("present, and points at request_promise/replaces, for the exact Jev intent-mismatch reason", async () => {
    const body = await payAndRefuseWithReason("jev: does not match the signed intent");
    expect(body.status).toBe("refused");
    expect(body.actionableHint).toBeDefined();
    expect(body.actionableHint).toContain("request_promise");
    expect(body.actionableHint).toContain('replaces="promise_1"');
    expect(body.actionableHint).toContain("buy a $1 amazon gift card");
  });

  test("absent for Jev's OTHER refuse reason (a general action judgment, not specifically an intent mismatch)", async () => {
    const body = await payAndRefuseWithReason("jev: model recommends refuse with high confidence");
    expect(body.actionableHint).toBeUndefined();
  });

  test("absent for a provenance refusal", async () => {
    const body = await payAndRefuseWithReason("provenance: resourceUrl host does not match the PAYMENT-REQUIRED response");
    expect(body.actionableHint).toBeUndefined();
  });

  test("absent for an intercepta refusal", async () => {
    const body = await payAndRefuseWithReason("intercepta: recipient flagged high risk");
    expect(body.actionableHint).toBeUndefined();
  });

  test("absent for a policy refusal", async () => {
    const body = await payAndRefuseWithReason("policy: amount exceeds remaining budget");
    expect(body.actionableHint).toBeUndefined();
  });

  test("a funding refusal still gets its OWN hint, never the promise-replacement one", async () => {
    const body = await payAndRefuseWithReason("funding: insufficient_funds: balance too low");
    expect(body.actionableHint).toBeDefined();
    expect(body.actionableHint).not.toContain("request_promise");
  });
});
