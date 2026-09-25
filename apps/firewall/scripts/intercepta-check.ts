#!/usr/bin/env bun
// WU7 live check — run once INTERCEPTA_API_KEY exists (arrives by email,
// intercepta.io/ethglobal). Calls the real Intercepta API through the same
// `interceptaStage` the pipeline uses in production — no stubs, no mocks
// (track requirement: "Mocked or hard-coded responses don't qualify").
// Free-tier budget is 1,000 requests; this script costs ~3 live calls
// total (the token-risk scan is shared/cached across scenarios since every
// scenario screens the same demo asset), safe to run a handful of times.

import type { PaymentRequired } from "@x402/core/types";
import { USDC_SEPOLIA_ADDRESS, X402_NETWORK, type PaymentRequirement } from "@yakusoku/shared";
import { interceptaStage } from "../intercepta";
import type { StageContext } from "../pipeline";
import type { StoredIntent } from "../store";

// Given directly for this WU7 check — a plain merchant-style address with no
// known risk signals.
const CLEAN_MERCHANT_ADDRESS = "0x245645c634B00227af425eCe6f180D2D9E75F24F";

// Roman Semenov (Tornado Cash co-founder), sanctioned by OFAC under
// DPRK3/CYBER2 for his role in Lazarus Group-linked laundering — confirmed
// still sanctioned as of the 2025-03-21 SDN update
// (docs/research/intercepta-implementacion.md §6). RE-VERIFY against
// https://sanctionssearch.ofac.treas.gov the day of the demo: OFAC listings
// can change, and this is the only publicly documented known-risk address
// available (the sponsor's own test-address list is Discord-only and was
// not published in time for this check).
const KNOWN_RISK_ADDRESS = "0xdcbEfFBECcE100cCE9E4b153C4e15cB885643193";

// A third, distinct address so the "unreachable base URL" scenario always
// performs a real (uncached) address-scan attempt.
const OUTAGE_CHECK_ADDRESS = "0x3737373737373737373737373737373737abcd";

function makeIntent(): StoredIntent {
  return {
    id: "intent_intercepta_live_check",
    message: {
      task: "Intercepta live check (WU7)",
      budget: 25_000_000n,
      categories: ["gift_card:amazon"],
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${"22".repeat(32)}`,
    },
    signature: `0x${"bb".repeat(65)}`,
    signer: "0x2222222222222222222222222222222222222222",
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
    paymentRequired: {} as unknown as PaymentRequired, // unused by interceptaStage
    resourceUrl: "http://localhost:4000/giftcard/amazon-25",
    context: {},
  };
}

async function main(): Promise<void> {
  if (!process.env.INTERCEPTA_API_KEY) {
    console.log("INTERCEPTA_API_KEY missing — WU7 live check pending");
    process.exit(2);
  }

  let failed = false;

  console.log(`=== 1. Clean merchant address (${CLEAN_MERCHANT_ADDRESS}) — expect pass ===`);
  const cleanResult = await interceptaStage.run(makeCtx(CLEAN_MERCHANT_ADDRESS));
  console.log(cleanResult);
  if (cleanResult.outcome !== "pass") {
    console.error(`FAIL: expected pass, got "${cleanResult.outcome}"`);
    failed = true;
  }

  console.log(`\n=== 2. Known-risk (OFAC-sanctioned) address (${KNOWN_RISK_ADDRESS}) — expect refuse ===`);
  const riskResult = await interceptaStage.run(makeCtx(KNOWN_RISK_ADDRESS));
  console.log(riskResult);
  if (riskResult.outcome !== "refuse") {
    console.error(`FAIL: expected refuse, got "${riskResult.outcome}"`);
    failed = true;
  }

  console.log("\n=== 3. Unreachable INTERCEPTA_BASE_URL — expect ask_human, never pass ===");
  const originalBaseUrl = process.env.INTERCEPTA_BASE_URL;
  process.env.INTERCEPTA_BASE_URL = "http://127.0.0.1:9";
  let outageResult: Awaited<ReturnType<typeof interceptaStage.run>>;
  try {
    outageResult = await interceptaStage.run(makeCtx(OUTAGE_CHECK_ADDRESS));
  } finally {
    if (originalBaseUrl === undefined) delete process.env.INTERCEPTA_BASE_URL;
    else process.env.INTERCEPTA_BASE_URL = originalBaseUrl;
  }
  console.log(outageResult);
  if (outageResult.outcome !== "ask_human") {
    console.error(`FAIL: expected ask_human, got "${outageResult.outcome}"`);
    failed = true;
  }

  if (failed) {
    console.error("\nFAILED: at least one Intercepta live scenario did not match its expected outcome.");
    process.exit(1);
  }
  console.log("\nOK: all Intercepta live scenarios matched expectations.");
}

main().catch((err) => {
  console.error("intercepta-check script crashed:", err);
  process.exit(1);
});
