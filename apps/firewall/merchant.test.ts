// H1 fix unit tests — fail-closed, stubbed `fetch` only (same discipline
// intercepta.test.ts documents: apps/firewall/merchant.ts always calls the
// real merchant; this file is the one place a stub is allowed).

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PaymentRequired } from "@x402/core/types";
import { USDC_SEPOLIA_ADDRESS, X402_NETWORK, type PaymentRequirement } from "@yakusoku/shared";
import { compareRequirements, merchantStage, normalizeMerchantOrigin } from "./merchant";
import type { StageContext } from "./pipeline";
import type { StoredIntent } from "./store";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// --- normalizeMerchantOrigin -------------------------------------------------

describe("normalizeMerchantOrigin", () => {
  test("normalizes scheme://host[:port], dropping any path/query", () => {
    expect(normalizeMerchantOrigin("http://localhost:4000/giftcard/steam-1?x=1")).toEqual({
      ok: true,
      origin: "http://localhost:4000",
    });
  });

  test("omits the default port for https", () => {
    expect(normalizeMerchantOrigin("https://store.example:443/anything")).toEqual({ ok: true, origin: "https://store.example" });
  });

  test("lowercases the host", () => {
    expect(normalizeMerchantOrigin("http://Store.Example:4000")).toEqual({ ok: true, origin: "http://store.example:4000" });
  });

  test("rejects a malformed URL", () => {
    const result = normalizeMerchantOrigin("not a url");
    expect(result.ok).toBe(false);
  });

  test("rejects a non-http(s) scheme", () => {
    const result = normalizeMerchantOrigin("file:///etc/passwd");
    expect(result.ok).toBe(false);
  });
});

// --- compareRequirements -----------------------------------------------------

function requirement(overrides: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    amount: "1000000",
    asset: USDC_SEPOLIA_ADDRESS,
    payTo: "0x1111111111111111111111111111111111111111",
    ...overrides,
  };
}

describe("compareRequirements", () => {
  test("passes when every stable field matches", () => {
    expect(compareRequirements(requirement(), requirement())).toEqual({ ok: true });
  });

  test("payTo differing is payee_mismatch, even if only casing differs elsewhere", () => {
    const fetched = requirement({ payTo: "0x1111111111111111111111111111111111111111" });
    const forwarded = requirement({ payTo: "0x000000000000000000000000000000000000dEaD" });
    const result = compareRequirements(fetched, forwarded);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("payee_mismatch");
  });

  test("payTo comparison is case-insensitive", () => {
    const fetched = requirement({ payTo: "0xABCDEF0000000000000000000000000000000A" });
    const forwarded = requirement({ payTo: "0xabcdef0000000000000000000000000000000a" });
    expect(compareRequirements(fetched, forwarded)).toEqual({ ok: true });
  });

  test("amount differing is requirement_mismatch", () => {
    const result = compareRequirements(requirement({ amount: "1000000" }), requirement({ amount: "2000000" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("requirement_mismatch");
  });

  test("asset differing is requirement_mismatch", () => {
    const result = compareRequirements(requirement(), requirement({ asset: "0x0000000000000000000000000000000000dEaD" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("requirement_mismatch");
  });

  test("network differing is requirement_mismatch", () => {
    const result = compareRequirements(requirement(), requirement({ network: "eip155:1" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("requirement_mismatch");
  });
});

// --- merchantStage ------------------------------------------------------------

function baseIntent(overrides: Partial<StoredIntent> = {}): StoredIntent {
  return {
    id: "intent_test",
    message: {
      task: "Buy a $1 Amazon gift card (rehearsal)",
      budget: 1_000_000n,
      categories: ["gift_card:amazon"],
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${"11".repeat(32)}`,
    },
    signature: "0x00",
    signer: "0x0000000000000000000000000000000000dEaD",
    spent: 0n,
    createdAt: new Date().toISOString(),
    revoked: false,
    ...overrides,
  };
}

function stageContext(overrides: Partial<StageContext> = {}): StageContext {
  return {
    intent: baseIntent(),
    requirement: requirement(),
    paymentRequired: { x402Version: 1, accepts: [requirement()] } as unknown as PaymentRequired,
    resourceUrl: "http://localhost:4000/giftcard/amazon-1-rehearsal",
    ...overrides,
  };
}

function encodedHeader(req: PaymentRequirement): string {
  const paymentRequired = { x402Version: 1, accepts: [req] };
  return Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64");
}

function stubFetchOnce(response: Response | (() => Response)) {
  const fn = mock(async () => (typeof response === "function" ? response() : response));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("merchantStage — wallet-signed intent (no merchant binding)", () => {
  test("passes and swaps ctx to the firewall's own fetch when the merchant's 402 matches", async () => {
    const fetched = requirement();
    stubFetchOnce(
      new Response(null, {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodedHeader(fetched) },
      }),
    );
    const ctx = stageContext({ requirement: requirement(), paymentRequired: { some: "agent-copy" } as unknown as PaymentRequired });
    const result = await merchantStage.run(ctx);
    expect(result.outcome).toBe("pass");
    // ctx.requirement/paymentRequired were replaced with the self-fetched copy.
    expect(ctx.requirement).toEqual(fetched);
    expect((ctx.paymentRequired as unknown as { accepts: unknown[] }).accepts).toBeDefined();
  });

  test("refuses payee_mismatch when the agent forwarded a different payTo than the merchant's own 402", async () => {
    const merchantTruth = requirement({ payTo: "0x1111111111111111111111111111111111111111" });
    stubFetchOnce(new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": encodedHeader(merchantTruth) } }));
    const forwarded = requirement({ payTo: "0x000000000000000000000000000000000000dEaD" });
    const ctx = stageContext({ requirement: forwarded });
    const result = await merchantStage.run(ctx);
    expect(result.outcome).toBe("refuse");
    if (result.outcome === "refuse") {
      expect(result.state).toBe("merchant_blocked");
      expect(result.reason).toContain("payee_mismatch");
    }
  });

  test("refuses requirement_mismatch on an amount difference", async () => {
    const merchantTruth = requirement({ amount: "1000000" });
    stubFetchOnce(new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": encodedHeader(merchantTruth) } }));
    const ctx = stageContext({ requirement: requirement({ amount: "9999999" }) });
    const result = await merchantStage.run(ctx);
    expect(result.outcome).toBe("refuse");
    if (result.outcome === "refuse") expect(result.reason).toContain("requirement_mismatch");
  });

  test("refuses requirement_mismatch on a non-402 response", async () => {
    stubFetchOnce(new Response("ok", { status: 200 }));
    const result = await merchantStage.run(stageContext());
    expect(result.outcome).toBe("refuse");
    if (result.outcome === "refuse") expect(result.reason).toContain("requirement_mismatch");
  });

  test("refuses requirement_mismatch when the merchant's 402 has no PAYMENT-REQUIRED header", async () => {
    stubFetchOnce(new Response(null, { status: 402 }));
    const result = await merchantStage.run(stageContext());
    expect(result.outcome).toBe("refuse");
    if (result.outcome === "refuse") expect(result.reason).toContain("requirement_mismatch");
  });

  test("refuses merchant_unreachable when the fetch itself fails", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const result = await merchantStage.run(stageContext());
    expect(result.outcome).toBe("refuse");
    if (result.outcome === "refuse") {
      expect(result.reason).toContain("merchant_unreachable");
      expect(result.reason).toContain("connection refused");
    }
  });

  test("refuses merchant_unreachable on a redirect response, without following it", async () => {
    const fetchSpy = stubFetchOnce(new Response(null, { status: 302, headers: { location: "http://attacker.example/402" } }));
    const result = await merchantStage.run(stageContext());
    expect(result.outcome).toBe("refuse");
    if (result.outcome === "refuse") expect(result.reason).toContain("merchant_unreachable");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("merchantStage — world_id promise (merchant-bound)", () => {
  test("refuses merchant_mismatch, with no network call, when resourceUrl's origin isn't the bound merchant", async () => {
    const fetchSpy = stubFetchOnce(new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": encodedHeader(requirement()) } }));
    const ctx = stageContext({
      intent: baseIntent({ source: "world_id", merchant: "http://localhost:4000" }),
      resourceUrl: "http://attacker.example/giftcard/amazon-1-rehearsal",
    });
    const result = await merchantStage.run(ctx);
    expect(result.outcome).toBe("refuse");
    if (result.outcome === "refuse") {
      expect(result.state).toBe("merchant_blocked");
      expect(result.reason).toContain("merchant_mismatch");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("refuses merchant_mismatch fail-closed when the promise has no bound merchant at all", async () => {
    const ctx = stageContext({ intent: baseIntent({ source: "world_id", merchant: undefined }) });
    const result = await merchantStage.run(ctx);
    expect(result.outcome).toBe("refuse");
    if (result.outcome === "refuse") expect(result.reason).toContain("merchant_mismatch");
  });

  test("self-fetches only the bound origin and passes when it matches", async () => {
    const fetched = requirement();
    const fetchSpy = stubFetchOnce(new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": encodedHeader(fetched) } }));
    const ctx = stageContext({
      intent: baseIntent({ source: "world_id", merchant: "http://localhost:4000" }),
      resourceUrl: "http://localhost:4000/giftcard/amazon-1-rehearsal",
      requirement: fetched,
    });
    const result = await merchantStage.run(ctx);
    expect(result.outcome).toBe("pass");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
