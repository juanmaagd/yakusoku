// Signs the PromiseAttestation EIP-712 struct (P9.2,
// packages/shared/promise-attestation.ts has the domain/types/schema).
// Called from promises.ts's approval resolver right after a World ID
// approval validates AND its subject is confirmed to match the promise's own
// account — never before that check, so a promise can never end up attested
// under the wrong human's approval.
//
// Signed with the SAME account that signs x402 payments and StepUp
// attestations (FIREWALL_PRIVATE_KEY, signer.ts/step-up.ts) — a dedicated
// attestation key is the production-grade version of this, same documented
// tradeoff as step-up.ts.

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  hashWorldIdSubject,
  PROMISE_ATTESTATION_DOMAIN,
  PROMISE_ATTESTATION_TYPES,
  promiseAttestationSchema,
  toPromiseAttestationTypedDataMessage,
  type PromiseAttestation,
  type PromiseAttestationMessage,
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
 * account instead (promises.test.ts), never the real key. */
function firewallAttestationAccount(): Account {
  if (!cachedAccount) cachedAccount = privateKeyToAccount(requireEnv("FIREWALL_PRIVATE_KEY") as Hex);
  return cachedAccount;
}

export interface PromiseAttestationParams {
  promiseId: string;
  accountId: string;
  task: string;
  /** Atomic-unit budget string. */
  budget: string;
  categories: string[];
  /** Unix-seconds expiry, as a decimal string. */
  expiry: string;
  nonce: `0x${string}`;
  /** ID token `sub` claim — hashed into `worldIdSubject`, never stored raw. */
  worldIdSub: string;
  acr: string;
  authTimeSeconds: number;
  /** Defaults to now — injectable for deterministic tests. */
  approvedAtSeconds?: number;
}

/**
 * Signs a PromiseAttestation for one exact promise. `account` is injectable
 * (defaults to the real firewall account) so tests can sign with a generated
 * throwaway key — no network, no real `FIREWALL_PRIVATE_KEY`.
 */
export async function signPromiseAttestation(
  params: PromiseAttestationParams,
  account: Account = firewallAttestationAccount(),
): Promise<PromiseAttestation> {
  const message: PromiseAttestationMessage = {
    promiseId: params.promiseId,
    accountId: params.accountId,
    task: params.task,
    budget: params.budget,
    categories: params.categories,
    expiry: params.expiry,
    nonce: params.nonce,
    worldIdSubject: hashWorldIdSubject(params.worldIdSub),
    acr: params.acr,
    authTime: String(params.authTimeSeconds),
    approvedAt: String(params.approvedAtSeconds ?? Math.floor(Date.now() / 1000)),
  };
  const signature = await account.signTypedData({
    domain: PROMISE_ATTESTATION_DOMAIN,
    types: PROMISE_ATTESTATION_TYPES,
    primaryType: "PromiseAttestation",
    message: toPromiseAttestationTypedDataMessage(message),
  });
  return promiseAttestationSchema.parse({ message, signature, signer: account.address });
}
