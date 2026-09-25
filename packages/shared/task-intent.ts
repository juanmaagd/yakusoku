import { isAddress } from "viem";
import { z } from "zod";
import { CHAIN_ID } from "./constants";

/**
 * EIP-712 domain for TaskIntent signatures. No `verifyingContract`: nothing
 * onchain validates this — the firewall itself is the trust boundary
 * (plan-tecnico.md §2.2). The `nonce` field on the message covers replay.
 */
export const TASK_INTENT_DOMAIN = {
  name: "Yakusoku",
  version: "1",
  chainId: CHAIN_ID,
} as const;

/**
 * EIP-712 types, declared `as const` so viem/wagmi infer the typed-data shape
 * from this object directly (docs/research/ref-wagmi-viem.md §3).
 */
export const TASK_INTENT_TYPES = {
  TaskIntent: [
    { name: "task", type: "string" },
    { name: "budget", type: "uint256" },
    { name: "categories", type: "string[]" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const addressSchema = z.string().refine(isAddress, { message: "not a valid EVM address" });
const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "not a 32-byte hex string");
const signatureSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "not a hex signature")
  .refine((value) => value.length % 2 === 0, { message: "odd-length hex signature" });

/**
 * Shape validation only. Freshness (`expiry` in the past) and network match
 * are policy decisions the firewall pipeline makes (plan-tecnico.md §2.3/§2.4),
 * not schema concerns — a schema can't know "now".
 */
export const taskIntentMessageSchema = z.object({
  task: z.string().min(1, "task cannot be empty"),
  budget: z.coerce.bigint().positive("budget must be greater than zero"),
  categories: z.array(z.string().min(1)).min(1, "at least one category required"),
  expiry: z.coerce.bigint().positive("expiry must be a positive unix timestamp"),
  nonce: bytes32Schema,
});
export type TaskIntentMessage = z.infer<typeof taskIntentMessageSchema>;

/** A `TaskIntent` after the user signed it in `apps/web` (wagmi `signTypedDataAsync`). */
export const signedTaskIntentSchema = z.object({
  message: taskIntentMessageSchema,
  signature: signatureSchema,
  signer: addressSchema,
});
export type SignedTaskIntent = z.infer<typeof signedTaskIntentSchema>;
