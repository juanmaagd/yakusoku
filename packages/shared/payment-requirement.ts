import { isAddress } from "viem";
import { z } from "zod";
import { X402_NETWORK } from "./constants";

const addressSchema = z.string().refine(isAddress, { message: "not a valid EVM address" });

/**
 * Loose CAIP-2 (`namespace:reference`) format check. This schema only checks
 * shape — whether the network is the one Omamorisan actually supports is a
 * policy decision the firewall pipeline makes, see `isSupportedNetwork` below
 * and plan-tecnico.md §2.4 ("red" as a policy-layer check, not a parse error).
 */
const caip2NetworkSchema = z.string().regex(/^[a-z0-9-]+:[a-zA-Z0-9]+$/, "not a CAIP-2 network id");

/**
 * Subset of the x402 v2 `exact` scheme's `PaymentRequirements` the firewall
 * needs to run its pipeline (docs/research/ref-x402.md §1.2, live-decoded
 * example in §1.2 sourced from specs/transports-v2/http.md).
 */
export const paymentRequirementSchema = z.object({
  scheme: z.literal("exact"),
  network: caip2NetworkSchema,
  /** Atomic units (e.g. USDC's 6-decimal base units), as a decimal string. */
  amount: z.string().regex(/^\d+$/, "amount must be an atomic-unit integer string"),
  asset: addressSchema,
  payTo: addressSchema,
  maxTimeoutSeconds: z.number().int().positive().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type PaymentRequirement = z.infer<typeof paymentRequirementSchema>;

/** True when `network` is the single network Omamorisan runs on (Base Sepolia). */
export function isSupportedNetwork(network: string): boolean {
  return network === X402_NETWORK;
}
