#!/usr/bin/env bun
// Dev helper — plays the "user" without going through the site's /app mandate
// wizard: signs a TaskIntent with an ephemeral key and registers it with the
// firewall, so apps/agent has a real intentId to buy against. Not for
// production use: the ephemeral key only exists for this script's process
// lifetime and is never persisted.

import { toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TASK_INTENT_DOMAIN, TASK_INTENT_TYPES, stringifyWithBigint, type TaskIntentMessage } from "@yakusoku/shared";

const FIREWALL_URL = process.env.FIREWALL_URL ?? "http://localhost:4001";
const USDC_DECIMALS_MULTIPLIER = 1_000_000n; // 6 decimals, matches USDC_DECIMALS in packages/shared

function randomNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

interface ParsedArgs {
  task: string;
  budgetUsdc: number;
  categories: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [task, budgetArg, ...categoryArgs] = argv;
  if (!task || !budgetArg || categoryArgs.length === 0) {
    console.error('Usage: bun run dev-intent -- "<task text>" <budgetUsdc> <category[,category2...]>');
    console.error('Example: bun run dev-intent -- "Buy a $1 Amazon gift card" 1 gift_card:amazon');
    process.exit(1);
  }
  const budgetUsdc = Number(budgetArg);
  if (!Number.isFinite(budgetUsdc) || budgetUsdc <= 0) {
    console.error(`Invalid budget (must be a positive number of USDC): ${budgetArg}`);
    process.exit(1);
  }
  const categories = categoryArgs
    .join(" ")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return { task, budgetUsdc, categories };
}

async function main(): Promise<void> {
  const { task, budgetUsdc, categories } = parseArgs(process.argv.slice(2));

  const account = privateKeyToAccount(generatePrivateKey());
  const message: TaskIntentMessage = {
    task,
    budget: BigInt(Math.round(budgetUsdc * Number(USDC_DECIMALS_MULTIPLIER))),
    categories,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), // now + 1h
    nonce: randomNonce(),
  };

  const signature = await account.signTypedData({
    domain: TASK_INTENT_DOMAIN,
    types: TASK_INTENT_TYPES,
    primaryType: "TaskIntent",
    // TaskIntentMessage.nonce is a plain `string` in packages/shared (zod regex,
    // not a branded hex type) — narrow it here for viem's typed-data encoder.
    message: { ...message, nonce: message.nonce as `0x${string}` },
  });

  console.log(`[dev-intent] signer: ${account.address}`);
  console.log(`[dev-intent] task: "${task}"`);
  console.log(`[dev-intent] budget: ${budgetUsdc} USDC (${message.budget} atomic units)`);
  console.log(`[dev-intent] categories: ${categories.join(", ")}`);

  const res = await fetch(`${FIREWALL_URL}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stringifyWithBigint({ message, signature, signer: account.address }),
  });
  const body = (await res.json()) as { id?: string; remainingBudget?: string; agentKey?: string; error?: string };
  if (res.status !== 201 || !body.id || !body.agentKey) {
    console.error(`[dev-intent] POST /intents failed: ${res.status}`, body);
    process.exit(1);
  }
  console.log(`\n[dev-intent] intent id: ${body.id}`);
  console.log(`[dev-intent] remaining budget: ${body.remainingBudget}`);
  console.log(`[dev-intent] agent key (shown once — store it in your agent's config): ${body.agentKey}`);
  console.log("\n[dev-intent] run the agent against this intent:");
  console.log(`  bun run agent -- --intent ${body.id} --key ${body.agentKey} "${task}"`);
}

main().catch((err) => {
  console.error("[dev-intent] failed:", err);
  process.exit(1);
});
