// Wallet plumbing for the /app onboarding flow (P5). Plain viem, no wagmi —
// one injected EIP-1193 provider (`window.ethereum`), one chain (Base
// Sepolia). See root CLAUDE.md and docs/research/ref-wagmi-viem.md for why
// viem's own `createWalletClient` + `custom()` transport is preferred here.

import { createPublicClient, createWalletClient, custom, http, type EIP1193Provider } from "viem";
import { baseSepolia } from "viem/chains";

export const TARGET_CHAIN = baseSepolia;

/** Read-only client over the chain's own default public RPC (no wallet, no
 * injected provider needed) — used by the P6 dashboard to independently
 * confirm a settlement tx on-chain instead of only trusting the firewall's
 * own `settlement` record. Cheap to construct — same pattern as
 * `createTargetWalletClient` below. */
export function createPublicReadClient() {
  return createPublicClient({ chain: TARGET_CHAIN, transport: http() });
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

/** `undefined` when no injected wallet is present, or during SSR. */
export function getInjectedProvider(): EIP1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  return window.ethereum;
}

/** A fresh wallet client bound to Base Sepolia over the injected provider.
 * Cheap to construct — callers make one per action rather than caching it. */
export function createTargetWalletClient(provider: EIP1193Provider) {
  return createWalletClient({ chain: TARGET_CHAIN, transport: custom(provider) });
}

/** Digs an EIP-1193 numeric error code out of whatever shape the provider (or
 * viem's own error wrapping) throws it in — a plain `{code}`, a `{cause}`
 * chain, or a viem `BaseError`'s `.walk()`. */
function providerErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "number") return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "number") return causeCode;
  }
  const walk = (err as { walk?: (fn: (e: unknown) => boolean) => unknown }).walk;
  if (typeof walk === "function") {
    const found = walk((e) => typeof (e as { code?: unknown })?.code === "number") as { code?: number } | undefined;
    if (typeof found?.code === "number") return found.code;
  }
  return undefined;
}

/** EIP-1193 4001: the human rejected the request in their wallet. */
export function isUserRejection(err: unknown): boolean {
  return providerErrorCode(err) === 4001;
}

/** EIP-1193 4902: the wallet doesn't know this chain yet — needs `addChain` first. */
function isUnrecognizedChain(err: unknown): boolean {
  return providerErrorCode(err) === 4902;
}

/** Switches the connected wallet to Base Sepolia, registering the chain first
 * if the wallet has never seen it. */
export async function ensureTargetChain(provider: EIP1193Provider): Promise<void> {
  const client = createTargetWalletClient(provider);
  try {
    await client.switchChain({ id: TARGET_CHAIN.id });
  } catch (err) {
    if (!isUnrecognizedChain(err)) throw err;
    await client.addChain({ chain: TARGET_CHAIN });
    await client.switchChain({ id: TARGET_CHAIN.id });
  }
}

/** A short, human-readable message for a failed wallet call — never a raw
 * stack trace (P5 brief: every error path stays visible and recoverable). */
export function describeWalletError(err: unknown, fallback: string): string {
  if (isUserRejection(err)) return "Request was rejected in your wallet.";
  if (err instanceof Error && err.message) return err.message.split("\n")[0]!.slice(0, 200);
  return fallback;
}
