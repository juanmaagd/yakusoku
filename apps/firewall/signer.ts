// Everything that touches the firewall's private key: verifying a user's
// signed TaskIntent (read-only, no key needed) and producing the firewall's
// own x402 payment signature (docs/research/ref-x402.md §2, §5-6).

import {
  createPublicClient,
  formatUnits,
  http,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import {
  TASK_INTENT_DOMAIN,
  TASK_INTENT_TYPES,
  USDC_DECIMALS,
  X402_NETWORK,
  type TaskIntentMessage,
} from "@yakusoku/shared";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name} — set it in .env.hackathon`);
  }
  return value;
}

const account = privateKeyToAccount(requireEnv("FIREWALL_PRIVATE_KEY") as Hex);

/** Exported so account-setup.ts (P11.3a) can send the `createAccount` deploy
 * transaction from the SAME key that is every deployed account's `operator`
 * (root CLAUDE.md's funding model) — one firewall key, one meaning, never a
 * second env var to keep in sync with this one. */
export const operatorAccount = account;

// Exported so siwe.ts can reuse the same RPC-backed client for
// `verifySiweMessage` (also ERC-6492-aware) instead of standing up a second one.
export const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL),
});

/** Verifies a user-signed TaskIntent's EIP-712 signature (ref-wagmi-viem.md §5). */
export async function verifyTaskIntentSignature(
  message: TaskIntentMessage,
  signature: Hex,
  signer: Hex,
): Promise<boolean> {
  return publicClient.verifyTypedData({
    address: signer,
    domain: TASK_INTENT_DOMAIN,
    types: TASK_INTENT_TYPES,
    primaryType: "TaskIntent",
    message,
    signature,
  });
}

export interface SignParams {
  paymentRequired: PaymentRequired;
  /** Intent's total authorized budget (atomic USDC units) — the spendControls ceiling. */
  maxBudgetAtomic: bigint;
  paymentIdentifier: string;
}

export interface SignOutcome {
  paymentPayload: PaymentPayload;
  paymentSignatureHeader: string;
}

/**
 * Creates the firewall's signed x402 payment payload for one payment. A
 * fresh `x402Client` is built per call so the spend cap and the
 * payment-identifier hook are scoped to this exact request
 * (ref-x402.md §2.1-2.4) — `fromConfig` does no network I/O, so this is
 * cheap. `onBeforePaymentCreation` doubles as the last fail-closed guard
 * before a signature is ever produced, on top of the pipeline's own policy
 * stage (pipeline.ts).
 */
export async function signPayment({
  paymentRequired,
  maxBudgetAtomic,
  paymentIdentifier,
}: SignParams): Promise<SignOutcome> {
  const guardian = x402Client
    .fromConfig({
      schemes: [{ network: X402_NETWORK, client: new ExactEvmScheme(account) }],
      // Never rely on the SDK's silent $1 default (ref-x402.md §5.5) — cap
      // every payment at the intent's total authorized budget.
      spendControls: { maxAmountPerPayment: `$${formatUnits(maxBudgetAtomic, USDC_DECIMALS)}` },
    })
    .onBeforePaymentCreation(async ({ paymentRequired: pr, selectedRequirements }) => {
      if (selectedRequirements.network !== X402_NETWORK) {
        return { abort: true, reason: `unexpected network at signing time: ${selectedRequirements.network}` };
      }
      const amount = BigInt(selectedRequirements.amount);
      if (amount > maxBudgetAtomic) {
        return { abort: true, reason: `amount ${amount} exceeds the intent's total budget ${maxBudgetAtomic}` };
      }
      if (pr.extensions) {
        appendPaymentIdentifierToExtensions(pr.extensions, paymentIdentifier);
      }
      return undefined;
    });

  const paymentPayload = await guardian.createPaymentPayload(paymentRequired);
  return { paymentPayload, paymentSignatureHeader: encodePaymentSignatureHeader(paymentPayload) };
}
