// SIWE (EIP-4361) sign-in verification (WU-P3). The site (or any other origin
// listed in OMAMORISAN_SIWE_DOMAINS) proves control of a wallet by signing a
// nonce-bound message; the firewall never sees a private key. Nonce
// single-use tracking and session issuance live in store.ts — this file only
// verifies the message itself and enforces the domain/chain allow-list.
//
// Fail-closed throughout: any check failing returns `ok: false`, never a
// half-verified session.

import type { Hex } from "viem";
import { parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { CHAIN_ID } from "@yakusoku/shared";
import { publicClient } from "./signer";
import { consumeNonce } from "./store";

function allowedSiweDomains(): string[] {
  const raw = process.env.OMAMORISAN_SIWE_DOMAINS ?? "localhost:4321,localhost:4001";
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

export type SiweVerifyResult = { ok: true; address: `0x${string}` } | { ok: false; reason: string };

/**
 * Verifies a signed EIP-4361 message end to end: well-formed, domain in the
 * allow-list, chain id matches (`CHAIN_ID`, 84532), nonce single-use and
 * unexpired, and the signature recovers to the address embedded in the
 * message (viem's `verifySiweMessage`, which also covers ERC-6492 smart
 * accounts via the shared `publicClient` — same RPC path `signer.ts` already
 * uses for TaskIntent signatures).
 */
export async function verifySiweSignIn(message: string, signature: Hex): Promise<SiweVerifyResult> {
  const parsed = parseSiweMessage(message);
  if (!parsed.address) return { ok: false, reason: "message missing an address" };
  if (!parsed.nonce) return { ok: false, reason: "message missing a nonce" };
  if (!parsed.domain || !allowedSiweDomains().includes(parsed.domain)) {
    return { ok: false, reason: `domain ${parsed.domain ?? "(missing)"} is not allowed` };
  }
  if (parsed.chainId !== CHAIN_ID) {
    return { ok: false, reason: `unsupported chain id ${parsed.chainId ?? "(missing)"}` };
  }
  // Single-use, consumed before the signature check: a nonce can never
  // authenticate twice regardless of what else about the message changes.
  if (!consumeNonce(parsed.nonce)) {
    return { ok: false, reason: "nonce is invalid, already used, or expired" };
  }

  const valid = await verifySiweMessage(publicClient, { message, signature, time: new Date() });
  if (!valid) return { ok: false, reason: "signature verification failed" };

  return { ok: true, address: parsed.address as `0x${string}` };
}
