// Builds and signs a TaskIntent the way the firewall expects it (P5). Reuses
// the shared EIP-712 domain/types/serializer instead of redefining them —
// root CLAUDE.md: "Use them; do not redefine the typed data."

import { toHex, type Address, type EIP1193Provider, type Hex } from "viem";
import { TASK_INTENT_DOMAIN, TASK_INTENT_TYPES, stringifyWithBigint } from "@yakusoku/shared";
import { createTargetWalletClient } from "./wallet";

export interface MandateDraft {
  task: string;
  budgetUsdc: number;
  categories: string[];
  expirySeconds: number;
}

export interface PreparedTaskIntent {
  task: string;
  budget: bigint;
  categories: string[];
  expiry: bigint;
  nonce: Hex;
}

const USDC_DECIMALS_FACTOR = 1_000_000;

/** Freezes a draft into the exact values that will be signed (and later
 * shown in the preview) — computed once, right before showing the preview,
 * so the preview is a true "what you sign", not a re-derived approximation. */
export function prepareTaskIntent(draft: MandateDraft): PreparedTaskIntent {
  return {
    task: draft.task.trim(),
    budget: BigInt(Math.round(draft.budgetUsdc * USDC_DECIMALS_FACTOR)),
    categories: draft.categories,
    expiry: BigInt(Math.floor(Date.now() / 1000) + draft.expirySeconds),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
}

/** `eth_signTypedData_v4` via viem's wallet client — it derives the
 * `EIP712Domain` type array and serializes the JSON-RPC payload itself, so
 * there's no hand-rolled typed-data JSON here. */
export async function signTaskIntent(
  provider: EIP1193Provider,
  address: Address,
  intent: PreparedTaskIntent,
): Promise<Hex> {
  const client = createTargetWalletClient(provider);
  return client.signTypedData({
    account: address,
    domain: TASK_INTENT_DOMAIN,
    types: TASK_INTENT_TYPES,
    primaryType: "TaskIntent",
    message: intent,
  });
}

/** Body for `POST /intents` — `stringifyWithBigint` because `budget`/`expiry`
 * are real bigints here (packages/shared/json.ts). */
export function serializeSignedIntent(intent: PreparedTaskIntent, signature: Hex, signer: Address): string {
  return stringifyWithBigint({ message: intent, signature, signer });
}
