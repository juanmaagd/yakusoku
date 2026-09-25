#!/usr/bin/env bun
// WU3 check — a scripted round-trip against the real store on Base Sepolia,
// playing both the "user" (signs the TaskIntent) and the "agent" (talks HTTP
// to the store + firewall). No LLM here; see apps/agent (WU4) for the real
// shopping agent. Spends real testnet USDC — run at most twice per WU3 spec.

import { toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { TASK_INTENT_DOMAIN, TASK_INTENT_TYPES, stringifyWithBigint, type TaskIntentMessage } from "@yakusoku/shared";

const FIREWALL_URL = process.env.FIREWALL_URL ?? "http://localhost:4001";
const STORE_URL = process.env.STORE_URL ?? "http://localhost:4000";

function randomNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stringifyWithBigint(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

interface IntentResponse {
  id: string;
  remainingBudget: string;
}

interface SignResponse {
  verdict: "pay" | "refuse" | "ask_human";
  reason: string;
  receiptId: string;
  paymentSignature?: string;
}

async function fetch402(url: string): Promise<string> {
  const response = await fetch(url);
  if (response.status !== 402) {
    throw new Error(`expected 402 from ${url}, got ${response.status}`);
  }
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) throw new Error(`missing PAYMENT-REQUIRED header from ${url}`);
  return header;
}

async function main(): Promise<void> {
  console.log("=== 1. Sign a TaskIntent as the user (ephemeral key) ===");
  const userAccount = privateKeyToAccount(generatePrivateKey());
  const message: TaskIntentMessage = {
    task: "Buy a $1 Amazon gift card for rehearsal",
    budget: 1_000_000n, // 1 USDC, 6 decimals
    categories: ["gift_card:amazon"],
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: randomNonce(),
  };
  const signature = await userAccount.signTypedData({
    domain: TASK_INTENT_DOMAIN,
    types: TASK_INTENT_TYPES,
    primaryType: "TaskIntent",
    // `TaskIntentMessage.nonce` is a plain `string` in packages/shared (zod
    // regex, not a branded hex type) — narrow it here for viem's typed-data
    // encoder, which expects the literal `0x${string}` shape.
    message: { ...message, nonce: message.nonce as `0x${string}` },
  });

  const { status: intentStatus, json: intentJson } = await postJson(`${FIREWALL_URL}/intents`, {
    message,
    signature,
    signer: userAccount.address,
  });
  if (intentStatus !== 201) throw new Error(`POST /intents failed: ${intentStatus} ${JSON.stringify(intentJson)}`);
  const intent = intentJson as IntentResponse;
  console.log(`intent ${intent.id}, remainingBudget=${intent.remainingBudget}`);

  // Same shape the WU4 agent sends; provenance (WU6) fails closed without it.
  const SIGN_CONTEXT = {
    userRequest: "Buy me a $1 Amazon gift card (rehearsal)",
    justification: "The user asked for this exact gift card.",
    untrustedContent: [],
  };

  console.log("\n=== 2. Fetch the rehearsal gift card (expect 402) ===");
  const rehearsalUrl = `${STORE_URL}/giftcard/amazon-1-rehearsal`;
  const rehearsalHeader = await fetch402(rehearsalUrl);
  console.log("decoded PAYMENT-REQUIRED:", decodePaymentRequiredHeader(rehearsalHeader));

  console.log("\n=== 3. Ask the firewall to sign ===");
  const { status: signStatus, json: signJson } = await postJson(`${FIREWALL_URL}/sign`, {
    intentId: intent.id,
    paymentRequiredHeader: rehearsalHeader,
    resourceUrl: rehearsalUrl,
    context: SIGN_CONTEXT,
  });
  console.log(signStatus, signJson);
  const sign = signJson as SignResponse;
  if (sign.verdict !== "pay" || !sign.paymentSignature) {
    throw new Error(`expected verdict=pay with a signature, got: ${JSON.stringify(sign)}`);
  }

  console.log("\n=== 4. Retry the store with the firewall's signature (settles onchain) ===");
  const settleResponse = await fetch(rehearsalUrl, {
    headers: { "PAYMENT-SIGNATURE": sign.paymentSignature },
  });
  if (settleResponse.status !== 200) {
    throw new Error(`expected 200, got ${settleResponse.status}: ${await settleResponse.text()}`);
  }
  console.log("gift card:", await settleResponse.json());
  const paymentResponseHeader = settleResponse.headers.get("PAYMENT-RESPONSE");
  if (!paymentResponseHeader) throw new Error("missing PAYMENT-RESPONSE header");
  const settlement = decodePaymentResponseHeader(paymentResponseHeader);
  console.log("settlement:", settlement);
  console.log(`tx: https://sepolia.basescan.org/tx/${settlement.transaction}`);

  console.log("\n=== 5. Negative check: amazon-25 exceeds remaining budget ===");
  const amazon25Url = `${STORE_URL}/giftcard/amazon-25`;
  const amazon25Header = await fetch402(amazon25Url);
  const { status: refuseStatus, json: refuseJson } = await postJson(`${FIREWALL_URL}/sign`, {
    intentId: intent.id,
    paymentRequiredHeader: amazon25Header,
    resourceUrl: amazon25Url,
    context: SIGN_CONTEXT,
  });
  console.log(refuseStatus, refuseJson);
  const refuse = refuseJson as SignResponse;
  if (refuse.verdict !== "refuse" || refuse.paymentSignature) {
    throw new Error(`expected verdict=refuse with no signature, got: ${JSON.stringify(refuseJson)}`);
  }

  console.log("\n=== 6. Idempotency check: repeat step 3's exact /sign request ===");
  const { status: repeatStatus, json: repeatJson } = await postJson(`${FIREWALL_URL}/sign`, {
    intentId: intent.id,
    paymentRequiredHeader: rehearsalHeader,
    resourceUrl: rehearsalUrl,
    context: SIGN_CONTEXT,
  });
  console.log(repeatStatus, repeatJson);
  const repeat = repeatJson as SignResponse;
  if (repeat.verdict !== "pay" || repeat.paymentSignature !== sign.paymentSignature) {
    throw new Error(`expected the exact cached signature back, got: ${JSON.stringify(repeatJson)}`);
  }
  if (repeat.receiptId === sign.receiptId) {
    throw new Error("expected a fresh receiptId for the idempotent replay, not the original one");
  }

  console.log("\nRound-trip OK.");
}

main().catch((err) => {
  console.error("Round-trip FAILED:", err);
  process.exit(1);
});
