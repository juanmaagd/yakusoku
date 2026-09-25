// Signs the StepUp EIP-712 attestation (WU12, @yakusoku/shared's step-up.ts
// has the domain/types/schema). Called from approvals.ts's `settleApproved`
// right after a World ID approval validates and right before the x402
// payment itself is signed (docs/research/world-id-implementacion.md §C:
// "inmediatamente después de... y antes de createPaymentPayload").
//
// Signed with the SAME account that signs x402 payments
// (FIREWALL_PRIVATE_KEY, signer.ts). A dedicated attestation key — separate
// from the payment-signing key — is the production-grade version of this
// (defense in depth: "who pays" vs "who attests a human approved", same
// spirit as the bonus smart-wallet level in plan-tecnico.md); out of scope
// for tonight's single-wallet hackathon MVP.

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  hashWorldIdSubject,
  STEP_UP_DOMAIN,
  STEP_UP_TYPES,
  stepUpAttestationSchema,
  toStepUpTypedDataMessage,
  type StepUpAttestation,
  type StepUpAttestationMessage,
} from "@yakusoku/shared";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name} — set it in .env.hackathon`);
  return value;
}

type Account = ReturnType<typeof privateKeyToAccount>;

let cachedAccount: Account | undefined;

/** Lazily constructed so importing this module never requires
 * FIREWALL_PRIVATE_KEY to be set — tests sign with an injected throwaway
 * account instead (step-up.test.ts), never the real key. */
function firewallAttestationAccount(): Account {
  if (!cachedAccount) cachedAccount = privateKeyToAccount(requireEnv("FIREWALL_PRIVATE_KEY") as Hex);
  return cachedAccount;
}

export interface StepUpParams {
  receiptId: string;
  intentId: string;
  paymentIdentifier: string;
  payTo: `0x${string}`;
  /** Atomic-unit amount string (e.g. USDC's 6-decimal base units). */
  amount: string;
  asset: `0x${string}`;
  network: string;
  /** ID token `sub` claim — hashed into `worldIdSubject`, never stored raw. */
  worldIdSub: string;
  acr: string;
  authTimeSeconds: number;
  /** Defaults to now — injectable for deterministic tests. */
  approvedAtSeconds?: number;
}

/**
 * Signs a StepUp attestation for one exact payment. `account` is injectable
 * (defaults to the real firewall account) so tests can sign with a
 * generated throwaway key — no network, no real `FIREWALL_PRIVATE_KEY`.
 */
export async function signStepUpAttestation(
  params: StepUpParams,
  account: Account = firewallAttestationAccount(),
): Promise<StepUpAttestation> {
  const message: StepUpAttestationMessage = {
    receiptId: params.receiptId,
    intentId: params.intentId,
    paymentIdentifier: params.paymentIdentifier,
    payTo: params.payTo,
    amount: params.amount,
    asset: params.asset,
    network: params.network,
    worldIdSubject: hashWorldIdSubject(params.worldIdSub),
    acr: params.acr,
    authTime: String(params.authTimeSeconds),
    approvedAt: String(params.approvedAtSeconds ?? Math.floor(Date.now() / 1000)),
  };
  const signature = await account.signTypedData({
    domain: STEP_UP_DOMAIN,
    types: STEP_UP_TYPES,
    primaryType: "StepUpAttestation",
    message: toStepUpTypedDataMessage(message),
  });
  return stepUpAttestationSchema.parse({ message, signature, signer: account.address });
}
