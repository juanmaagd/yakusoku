// Mandate credential — the agent's bearer key (Phase 2, WU-P1). `POST
// /intents` mints one per intent (`generateAgentKey`) and returns it exactly
// once in its 201 response; the firewall only ever persists its SHA-256
// hash (`hashAgentKey`, store.ts's `intents.agent_key_hash` column), never
// the raw value. Every later `Authorization: Bearer <agentKey>` request
// re-hashes the presented key and compares it against stored hashes with
// `hashesEqual`, a constant-time comparison, so a timing side-channel can't
// help an attacker narrow down a valid key.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const AGENT_KEY_PREFIX = "yk_";
const AGENT_KEY_RANDOM_BYTES = 32;

/** Generates a fresh mandate credential: `yk_` + 32 random bytes, base64url
 * encoded. Never logged or persisted in plaintext — see the file header. */
export function generateAgentKey(): string {
  return `${AGENT_KEY_PREFIX}${randomBytes(AGENT_KEY_RANDOM_BYTES).toString("base64url")}`;
}

/** SHA-256 hex digest of an agent key — what's actually persisted and
 * compared against on every authenticated request. Not reversible. */
export function hashAgentKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Constant-time comparison of two hex-encoded SHA-256 hashes. Different
 * lengths are never fed to `timingSafeEqual` (which throws on a length
 * mismatch) — they're simply not equal. */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Extracts the bearer token from an `Authorization: Bearer <token>` header
 * value. Returns `undefined` for a missing header, a different auth scheme,
 * or an empty token. */
export function extractBearerToken(headerValue: string | undefined | null): string | undefined {
  if (!headerValue) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}
