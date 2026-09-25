import { isAddress, keccak256, toHex, verifyTypedData } from "viem";
import { z } from "zod";
import { CHAIN_ID } from "./constants";

/**
 * StepUp EIP-712 attestation (WU12, plan-tecnico.md's `worldId` receipt field
 * + docs/research/world-id-implementacion.md §C, adapted from HumanMandate's
 * ETHGlobal Lisboa showcase project — docs/23-inspiracion.md). The human
 * never signs this directly: they approve via the World ID device flow
 * (world-id.ts), and the firewall — right after validating that approval and
 * right before signing the x402 payment itself — signs this struct as
 * portable, independently verifiable evidence that "a human freshly approved
 * via World ID" is bound to this EXACT payment. Stored on the receipt
 * (`DecisionReceipt.worldId.attestation`, receipt.ts) and re-servable on its
 * own (`GET /receipts/:id/attestation`) for a third party who trusts neither
 * the firewall's database nor its say-so — same "an application is never its
 * own oracle" principle as the independent post-hoc verifier (WU14).
 *
 * Domain intentionally reuses `TASK_INTENT_DOMAIN`'s exact values (same app,
 * same chain) — EIP-712 struct hashes are namespaced by `primaryType`, so a
 * `StepUpAttestation` and a `TaskIntent` sharing one domain never collide.
 * No `verifyingContract`: this is off-chain evidence in the MVP (no contract
 * checks it), ready to be verified on-chain if the bonus smart-wallet level
 * (plan-tecnico.md) is ever built.
 */
export const STEP_UP_DOMAIN = {
  name: "Yakusoku",
  version: "1",
  chainId: CHAIN_ID,
} as const;

/**
 * Binds the approval to the exact payment it applies to: `receiptId` +
 * `intentId` + `paymentIdentifier` tie it to one firewall decision,
 * `payTo`/`amount`/`asset`/`network` tie it to one x402 payment requirement
 * (so it can't be silently replayed against a different payment), and
 * `worldIdSubject`/`acr`/`authTime` carry the World ID proof's own claims.
 * `approvedAt` is when the firewall itself signed this attestation.
 */
export const STEP_UP_TYPES = {
  StepUpAttestation: [
    { name: "receiptId", type: "string" },
    { name: "intentId", type: "string" },
    { name: "paymentIdentifier", type: "string" },
    { name: "payTo", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "asset", type: "address" },
    { name: "network", type: "string" },
    { name: "worldIdSubject", type: "bytes32" },
    { name: "acr", type: "string" },
    { name: "authTime", type: "uint256" },
    { name: "approvedAt", type: "uint256" },
  ],
} as const;

// Small local duplicates of task-intent.ts's address/bytes32/signature
// schemas — kept here (not exported/shared) so this WU's diff stays scoped
// to step-up.ts instead of touching WU1's file for a one-line export.
const addressSchema = z.string().refine(isAddress, { message: "not a valid EVM address" });
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "not a 32-byte hex string");
const signatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "not a hex signature")
  .refine((value) => value.length % 2 === 0, { message: "odd-length hex signature" });
const decimalStringSchema = z.string().regex(/^\d+$/, "must be a decimal integer string");

/**
 * JSON-safe shape: `uint256` fields travel as decimal strings, never a raw
 * `bigint` (`JSON.stringify` throws on those — same constraint `json.ts`
 * documents for `TaskIntentMessage`). This is the shape stored on
 * `DecisionReceipt.worldId.attestation.message` (store.ts's `saveReceipt`
 * uses plain `JSON.stringify`, not `stringifyWithBigint`). Use
 * `toStepUpTypedDataMessage` to get the `bigint`-typed message
 * `signTypedData`/`verifyTypedData` need.
 */
export const stepUpAttestationMessageSchema = z.object({
  receiptId: z.string().min(1),
  intentId: z.string().min(1),
  paymentIdentifier: z.string().min(1),
  payTo: addressSchema,
  amount: decimalStringSchema,
  asset: addressSchema,
  network: z.string().min(1),
  /** `keccak256` of the World ID ID token's `sub` claim — never the raw
   * subject or the raw ID token (see `hashWorldIdSubject` below). */
  worldIdSubject: bytes32Schema,
  acr: z.string().min(1),
  authTime: decimalStringSchema,
  approvedAt: decimalStringSchema,
});
export type StepUpAttestationMessage = z.infer<typeof stepUpAttestationMessageSchema>;

/** A signed StepUp attestation, as returned by `signStepUpAttestation`
 * (apps/firewall/step-up.ts) and served by `GET /receipts/:id/attestation`. */
export const stepUpAttestationSchema = z.object({
  message: stepUpAttestationMessageSchema,
  signature: signatureSchema,
  signer: addressSchema,
});
export type StepUpAttestation = z.infer<typeof stepUpAttestationSchema>;

/** Converts the JSON-safe message into the shape `signTypedData`/
 * `verifyTypedData` require: `bigint` for `uint256` fields, and `0x${string}`
 * (not plain `string`) for the `address`/`bytes32` fields — explicit here
 * because `addressSchema`/`bytes32Schema` (above) validate the shape at
 * runtime via `.refine`/`.regex` but don't all narrow the static zod-inferred
 * type the same way (viem's own `isAddress` is a type predicate zod v4
 * picks up on; a plain `.regex` check isn't), so `worldIdSubject` would
 * otherwise stay `string` and fail viem's stricter typed-data overloads. */
export function toStepUpTypedDataMessage(message: StepUpAttestationMessage) {
  return {
    receiptId: message.receiptId,
    intentId: message.intentId,
    paymentIdentifier: message.paymentIdentifier,
    payTo: message.payTo as `0x${string}`,
    amount: BigInt(message.amount),
    asset: message.asset as `0x${string}`,
    network: message.network,
    worldIdSubject: message.worldIdSubject as `0x${string}`,
    acr: message.acr,
    authTime: BigInt(message.authTime),
    approvedAt: BigInt(message.approvedAt),
  };
}

/** `keccak256` of the World ID ID token's `sub` claim (UTF-8 bytes) — turns
 * an arbitrary-length subject identifier into a fixed `bytes32` EIP-712
 * field without ever putting the raw claim (or the ID token itself) into a
 * signed struct, a receipt, or an API response. */
export function hashWorldIdSubject(sub: string): `0x${string}` {
  return keccak256(toHex(sub));
}

/**
 * Independent signature verification — no firewall database, no network
 * call, just EIP-712 recovery (viem's `verifyTypedData` utility, EOA-only,
 * docs/research/world-id-implementacion.md §C). Confirms the signature was
 * produced by `attestation.signer` for exactly this `message`; it does NOT
 * by itself confirm `attestation.signer` is the firewall's own wallet — a
 * caller who knows the expected firewall address (apps/verifier/index.ts,
 * WU14's independent verifier) must compare that separately, the same way a
 * recovered ECDSA address is only meaningful once compared to who was
 * expected to sign.
 *
 * Never throws: a malformed field (e.g. a tampered `payTo` that fails
 * viem's own EIP-55 checksum validation before it ever gets to signature
 * recovery) means this attestation cannot be verified, which is exactly the
 * same outcome as a wrong signature — fail closed, return `false`.
 */
export async function verifyStepUpAttestation(attestation: StepUpAttestation): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: attestation.signer as `0x${string}`,
      domain: STEP_UP_DOMAIN,
      types: STEP_UP_TYPES,
      primaryType: "StepUpAttestation",
      message: toStepUpTypedDataMessage(attestation.message),
      signature: attestation.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}
