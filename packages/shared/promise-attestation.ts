import { isAddress, verifyTypedData } from "viem";
import { z } from "zod";
import { CHAIN_ID } from "./constants";

/**
 * PromiseAttestation EIP-712 struct (Phase 3 P9.2, odd/tasks/yakusoku.md).
 * Where StepUp (step-up.ts) attests "a human freshly approved THIS EXACT
 * PAYMENT", PromiseAttestation attests "a human freshly approved THIS EXACT
 * PROMISE" — the World-ID-only replacement for a wallet-signed `TaskIntent`
 * (task-intent.ts). The human never signs this directly: they approve via
 * the World ID device flow (world-id.ts, reused unchanged from WU11), and
 * the firewall — right after validating that approval — signs this struct as
 * portable, independently verifiable evidence that the promise's owner
 * (identified by `worldIdSubject`, never the raw `sub`) authorized exactly
 * this task/budget/categories/expiry. Stored on the promise
 * (`GET /promises/:id/attestation`) and re-verifiable on its own by anyone
 * who trusts neither the firewall's database nor its say-so, same "an
 * application is never its own oracle" principle as `verifyStepUpAttestation`.
 *
 * Same domain as `TASK_INTENT_DOMAIN`/`STEP_UP_DOMAIN` (same app, same
 * chain) — EIP-712 struct hashes are namespaced by `primaryType`, so this
 * never collides with either.
 */
export const PROMISE_ATTESTATION_DOMAIN = {
  name: "Omamorisan",
  version: "1",
  chainId: CHAIN_ID,
} as const;

/**
 * `promiseId`/`accountId`/`nonce` bind this to one exact promise row (so it
 * can't be replayed against a different one); `task`/`budget`/`categories`/
 * `expiry` mirror `TaskIntentMessage`'s fields so the pipeline (pipeline.ts's
 * `checkPolicy`, jev.ts, provenance.ts) can treat a promise exactly like a
 * wallet-signed intent; `merchant` is the normalized origin
 * (`scheme://host[:port]`) the human approved this promise to pay — H1 fix
 * (GitHub issue #1): the merchant pipeline stage
 * (apps/firewall/merchant.ts) refuses any `resourceUrl` whose origin isn't
 * exactly this, so a promise approved for one store can never be spent
 * against another; `worldIdSubject`/`acr`/`authTime` carry the World ID
 * proof's own claims; `approvedAt` is when the firewall itself signed this.
 */
export const PROMISE_ATTESTATION_TYPES = {
  PromiseAttestation: [
    { name: "promiseId", type: "string" },
    { name: "accountId", type: "string" },
    { name: "task", type: "string" },
    { name: "budget", type: "uint256" },
    { name: "categories", type: "string[]" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "merchant", type: "string" },
    { name: "worldIdSubject", type: "bytes32" },
    { name: "acr", type: "string" },
    { name: "authTime", type: "uint256" },
    { name: "approvedAt", type: "uint256" },
  ],
} as const;

// Small local duplicates of task-intent.ts's/step-up.ts's address/bytes32/
// signature/decimal-string schemas — same "kept here, not exported/shared"
// rationale step-up.ts documents, so this file's diff stays self-contained.
const addressSchema = z.string().refine(isAddress, { message: "not a valid EVM address" });
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "not a 32-byte hex string");
const signatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "not a hex signature")
  .refine((value) => value.length % 2 === 0, { message: "odd-length hex signature" });
const decimalStringSchema = z.string().regex(/^\d+$/, "must be a decimal integer string");

/** JSON-safe shape: `uint256` fields travel as decimal strings, same
 * constraint `stepUpAttestationMessageSchema` documents. */
export const promiseAttestationMessageSchema = z.object({
  promiseId: z.string().min(1),
  accountId: z.string().min(1),
  task: z.string().min(1),
  budget: decimalStringSchema,
  categories: z.array(z.string().min(1)).min(1),
  expiry: decimalStringSchema,
  nonce: bytes32Schema,
  /** Normalized origin (`scheme://host[:port]`) this promise may pay —
   * `apps/firewall/merchant.ts`'s `normalizeMerchantOrigin`, same value
   * `StoredPromise.merchant` (store.ts) holds. */
  merchant: z.string().min(1),
  /** `keccak256` of the World ID ID token's `sub` claim — never the raw
   * subject (see `hashWorldIdSubject`, step-up.ts). */
  worldIdSubject: bytes32Schema,
  acr: z.string().min(1),
  authTime: decimalStringSchema,
  approvedAt: decimalStringSchema,
});
export type PromiseAttestationMessage = z.infer<typeof promiseAttestationMessageSchema>;

/** A signed PromiseAttestation, as returned by `signPromiseAttestation`
 * (apps/firewall/promise-attestation.ts) and served by
 * `GET /promises/:id/attestation`. */
export const promiseAttestationSchema = z.object({
  message: promiseAttestationMessageSchema,
  signature: signatureSchema,
  signer: addressSchema,
});
export type PromiseAttestation = z.infer<typeof promiseAttestationSchema>;

/** Converts the JSON-safe message into the shape `signTypedData`/
 * `verifyTypedData` require — same rationale as `toStepUpTypedDataMessage`. */
export function toPromiseAttestationTypedDataMessage(message: PromiseAttestationMessage) {
  return {
    promiseId: message.promiseId,
    accountId: message.accountId,
    task: message.task,
    budget: BigInt(message.budget),
    categories: message.categories,
    expiry: BigInt(message.expiry),
    nonce: message.nonce as `0x${string}`,
    merchant: message.merchant,
    worldIdSubject: message.worldIdSubject as `0x${string}`,
    acr: message.acr,
    authTime: BigInt(message.authTime),
    approvedAt: BigInt(message.approvedAt),
  };
}

/** Independent signature verification — no firewall database, no network
 * call, just EIP-712 recovery. Same fail-closed contract as
 * `verifyStepUpAttestation`: never throws, a malformed field or wrong
 * signature both resolve to `false`. Does NOT by itself confirm
 * `attestation.signer` is the firewall's own wallet — a caller who knows the
 * expected firewall address must compare that separately. */
export async function verifyPromiseAttestation(attestation: PromiseAttestation): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: attestation.signer as `0x${string}`,
      domain: PROMISE_ATTESTATION_DOMAIN,
      types: PROMISE_ATTESTATION_TYPES,
      primaryType: "PromiseAttestation",
      message: toPromiseAttestationTypedDataMessage(attestation.message),
      signature: attestation.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}
