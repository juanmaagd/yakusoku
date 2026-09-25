import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PaymentRequired } from "@x402/core/types";
import { USDC_MAINNET_ADDRESS, USDC_SEPOLIA_ADDRESS, X402_NETWORK, type PaymentRequirement } from "@yakusoku/shared";
import { __clearInterceptaCachesForTests, deepScanAddress, interceptaStage, mapAssetForScreening, scanToken } from "./intercepta";
import type { StageContext } from "./pipeline";
import type { StoredIntent } from "./store";

// Fail-closed unit tests, stubbed `fetch` only (track rule: no mocks/bypass
// flags in runtime code — apps/firewall/intercepta.ts always calls the real
// API; this file is the one place a stub is allowed).

const ENV_KEYS = ["INTERCEPTA_API_KEY", "INTERCEPTA_BASE_URL", "INTERCEPTA_TIMEOUT_MS"] as const;
const ORIGINAL_FETCH = globalThis.fetch;
let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as typeof savedEnv;
  process.env.INTERCEPTA_API_KEY = "test-key";
  process.env.INTERCEPTA_TIMEOUT_MS = "50"; // fast fail-closed timeout in tests
  delete process.env.INTERCEPTA_BASE_URL;
  __clearInterceptaCachesForTests();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = ORIGINAL_FETCH;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Handler = (url: string) => Response | Promise<Response> | "hang";

function stubFetch(handler: Handler) {
  const fn = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const result = handler(url);
    if (result === "hang") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    return result;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const CLEAN_ADDRESS_SCAN = { toxicScore: 5, traits: [] };
const CLEAN_TOKEN_SCAN = { riskScore: 5, riskLevel: "neutral", category: "info", trust: "neutral", action: "info" };
const HIGH_RISK_ADDRESS_SCAN = {
  toxicScore: 92,
  traits: [{ risk: 90, name: "sanction_address", txsCount: 3, description: "sanctioned" }],
};
const MEDIUM_ADDRESS_SCAN = { toxicScore: 45, traits: [] };
const BLOCKED_TOKEN_SCAN = { riskScore: 90, riskLevel: "high", category: "malicious", trust: "blocklist", action: "block" };

function isAddressUrl(url: string): boolean {
  return url.includes("/account/") && url.includes("/toxic-score");
}
function isTokenUrl(url: string): boolean {
  return url.includes("/token-intelligence/token/");
}

function makeIntent(): StoredIntent {
  return {
    id: "intent_intercepta_test",
    message: {
      task: "Buy a $25 Amazon gift card",
      budget: 25_000_000n,
      categories: ["gift_card:amazon"],
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${"11".repeat(32)}`,
    },
    signature: `0x${"aa".repeat(65)}`,
    signer: "0x1111111111111111111111111111111111111111",
    spent: 0n,
    createdAt: new Date().toISOString(),
  };
}

function makeRequirement(payTo: string): PaymentRequirement {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    amount: "25000000",
    asset: USDC_SEPOLIA_ADDRESS,
    payTo: payTo as `0x${string}`,
  };
}

function makeCtx(payTo: string): StageContext {
  return {
    intent: makeIntent(),
    requirement: makeRequirement(payTo),
    paymentRequired: {} as unknown as PaymentRequired,
    resourceUrl: "http://localhost:4000/giftcard/amazon-25",
    context: {},
  };
}

describe("interceptaStage", () => {
  test("clean address + clean token -> pass", async () => {
    stubFetch((url) => (isAddressUrl(url) ? jsonResponse(CLEAN_ADDRESS_SCAN) : jsonResponse(CLEAN_TOKEN_SCAN)));
    const result = await interceptaStage.run(makeCtx("0xaaaa000000000000000000000000000000aaaa"));
    expect(result.outcome).toBe("pass");
    expect(result.detail?.intercepta).toMatchObject({ addressVerdict: "clean", tokenVerdict: "clean" });
  });

  test("high-risk address (sanction_address trait) -> refuse / intercepta_blocked", async () => {
    stubFetch((url) => (isAddressUrl(url) ? jsonResponse(HIGH_RISK_ADDRESS_SCAN) : jsonResponse(CLEAN_TOKEN_SCAN)));
    const result = await interceptaStage.run(makeCtx("0xbbbb000000000000000000000000000000bbbb"));
    expect(result.outcome).toBe("refuse");
    if (result.outcome !== "pass") expect(result.state).toBe("intercepta_blocked");
  });

  test("medium-risk address -> ask_human / intercepta_escalated", async () => {
    stubFetch((url) => (isAddressUrl(url) ? jsonResponse(MEDIUM_ADDRESS_SCAN) : jsonResponse(CLEAN_TOKEN_SCAN)));
    const result = await interceptaStage.run(makeCtx("0xcccc000000000000000000000000000000cccc"));
    expect(result.outcome).toBe("ask_human");
    if (result.outcome !== "pass") expect(result.state).toBe("intercepta_escalated");
  });

  test("blocked token risk (clean address) -> refuse / intercepta_blocked", async () => {
    stubFetch((url) => (isAddressUrl(url) ? jsonResponse(CLEAN_ADDRESS_SCAN) : jsonResponse(BLOCKED_TOKEN_SCAN)));
    const result = await interceptaStage.run(makeCtx("0xdddd000000000000000000000000000000dddd"));
    expect(result.outcome).toBe("refuse");
    if (result.outcome !== "pass") expect(result.state).toBe("intercepta_blocked");
  });

  test("timeout on the address scan -> ask_human / intercepta_escalated", async () => {
    stubFetch((url) => (isAddressUrl(url) ? "hang" : jsonResponse(CLEAN_TOKEN_SCAN)));
    const result = await interceptaStage.run(makeCtx("0xeeee000000000000000000000000000000eeee"));
    expect(result.outcome).toBe("ask_human");
    if (result.outcome !== "pass") expect(result.state).toBe("intercepta_escalated");
  });

  test("HTTP 500 from Intercepta -> ask_human / intercepta_escalated", async () => {
    stubFetch((url) => (isAddressUrl(url) ? jsonResponse({ error: "boom" }, 500) : jsonResponse(CLEAN_TOKEN_SCAN)));
    const result = await interceptaStage.run(makeCtx("0xffff000000000000000000000000000000ffff"));
    expect(result.outcome).toBe("ask_human");
    if (result.outcome !== "pass") expect(result.state).toBe("intercepta_escalated");
  });

  test("malformed (non-JSON) response body -> ask_human / intercepta_escalated", async () => {
    stubFetch((url) =>
      isAddressUrl(url) ? new Response("not-json", { status: 200 }) : jsonResponse(CLEAN_TOKEN_SCAN),
    );
    const result = await interceptaStage.run(makeCtx("0x1234000000000000000000000000000000abcd"));
    expect(result.outcome).toBe("ask_human");
    if (result.outcome !== "pass") expect(result.state).toBe("intercepta_escalated");
  });

  test("unexpected response schema -> ask_human / intercepta_escalated", async () => {
    stubFetch((url) =>
      isAddressUrl(url) ? jsonResponse({ notToxicScore: true }) : jsonResponse(CLEAN_TOKEN_SCAN),
    );
    const result = await interceptaStage.run(makeCtx("0x5678000000000000000000000000000000abcd"));
    expect(result.outcome).toBe("ask_human");
    if (result.outcome !== "pass") expect(result.state).toBe("intercepta_escalated");
  });

  test("missing INTERCEPTA_API_KEY -> ask_human / intercepta_escalated, reason 'Intercepta not configured'", async () => {
    delete process.env.INTERCEPTA_API_KEY;
    const fetchSpy = stubFetch(() => jsonResponse(CLEAN_ADDRESS_SCAN));
    const result = await interceptaStage.run(makeCtx("0x9999000000000000000000000000000000abcd"));
    expect(result.outcome).toBe("ask_human");
    if (result.outcome !== "pass") {
      expect(result.state).toBe("intercepta_escalated");
      expect(result.reason).toBe("Intercepta not configured");
    }
    expect(fetchSpy.mock.calls.length).toBe(0);
  });

  test("mainnet USDC token mapping is applied for the token scan", async () => {
    let tokenUrlSeen: string | undefined;
    stubFetch((url) => {
      if (isTokenUrl(url)) tokenUrlSeen = url;
      return isAddressUrl(url) ? jsonResponse(CLEAN_ADDRESS_SCAN) : jsonResponse(CLEAN_TOKEN_SCAN);
    });
    await interceptaStage.run(makeCtx("0x2222000000000000000000000000000000abcd"));
    expect(tokenUrlSeen).toContain(`/token/${USDC_MAINNET_ADDRESS}/risks`);
    expect(tokenUrlSeen).toContain("chainId=8453");
  });
});

describe("mapAssetForScreening", () => {
  test("maps Base Sepolia USDC to Base mainnet USDC", () => {
    expect(mapAssetForScreening(USDC_SEPOLIA_ADDRESS)).toEqual({ address: USDC_MAINNET_ADDRESS, chainId: "8453" });
  });

  test("is case-insensitive", () => {
    expect(mapAssetForScreening(USDC_SEPOLIA_ADDRESS.toLowerCase())).toEqual({
      address: USDC_MAINNET_ADDRESS,
      chainId: "8453",
    });
  });

  test("returns null for an unmapped asset", () => {
    expect(mapAssetForScreening("0x0000000000000000000000000000000000dead")).toBeNull();
  });
});

describe("caching", () => {
  test("a cache hit avoids a second fetch for the same address", async () => {
    const fetchSpy = stubFetch((url) => (isAddressUrl(url) ? jsonResponse(CLEAN_ADDRESS_SCAN) : jsonResponse(CLEAN_TOKEN_SCAN)));
    const address = "0x3333000000000000000000000000000000cafe";

    await deepScanAddress(address);
    const callsAfterFirst = fetchSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await deepScanAddress(address);
    const callsAfterSecond = fetchSpy.mock.calls.length;

    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  test("a cache hit avoids a second fetch for the same token", async () => {
    // A chainId/address pair not touched by any other test in this file, so
    // the first call below is guaranteed to be a real (uncached) fetch.
    const fetchSpy = stubFetch((url) => (isTokenUrl(url) ? jsonResponse(CLEAN_TOKEN_SCAN) : jsonResponse(CLEAN_ADDRESS_SCAN)));
    const tokenAddress = "0x4444000000000000000000000000000000cafe";

    await scanToken(tokenAddress, "1");
    const callsAfterFirst = fetchSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await scanToken(tokenAddress, "1");
    const callsAfterSecond = fetchSpy.mock.calls.length;

    expect(callsAfterSecond).toBe(callsAfterFirst);
  });
});
