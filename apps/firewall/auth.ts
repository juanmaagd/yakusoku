// Bearer tokens/secrets — several distinct kinds share this file's crypto
// primitives but never share a prefix or a store table:
//  - the agent's mandate credential (Phase 2, WU-P1), `yk_...`. `POST
//    /intents` mints one per intent (`generateAgentKey`) and returns it
//    exactly once in its 201 response.
//  - a SIWE session token (WU-P3), `ys_...`. `POST /auth/verify` mints one
//    per successful sign-in (`generateSessionToken`) and returns it exactly
//    once too.
//  - an account credential (Phase 3 P9.1), `ya_...`. Minted once a World ID
//    `POST /connect` device flow resolves `approved` (`generateAccountKey`)
//    and delivered to `POST /connect/poll` exactly once.
//  - a connect poll secret (Phase 3 P9.1), unprefixed, high-entropy,
//    single-purpose: proves the caller polling `POST /connect/poll` is the
//    same one that started this exact `POST /connect` request, nothing more.
// Either way, the firewall only ever persists the SHA-256 hash (store.ts's
// `intents.agent_key_hash` / `sessions.token_hash` / `account_keys.key_hash`
// / `connect_requests.poll_secret_hash` columns), never the raw value. Every
// later presented credential is re-hashed and compared against stored hashes
// with `hashesEqual`, a constant-time comparison, so a timing side-channel
// can't help an attacker narrow down a valid token.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const AGENT_KEY_PREFIX = "yk_";
const AGENT_KEY_RANDOM_BYTES = 32;
const SESSION_TOKEN_PREFIX = "ys_";
const SESSION_TOKEN_RANDOM_BYTES = 32;
const ACCOUNT_KEY_PREFIX = "ya_";
const ACCOUNT_KEY_RANDOM_BYTES = 32;
const CONNECT_POLL_SECRET_RANDOM_BYTES = 32;

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

/** Generates a fresh SIWE session token: `ys_` + 32 random bytes, base64url
 * encoded — distinct prefix from `yk_` agent keys so the two token kinds are
 * never mistaken for one another even before either is hashed or looked up. */
export function generateSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${randomBytes(SESSION_TOKEN_RANDOM_BYTES).toString("base64url")}`;
}

/** SHA-256 hex digest of a session token — same algorithm as `hashAgentKey`,
 * kept as its own named function so the two token kinds stay conceptually
 * distinct in every call site that hashes one. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
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

/** Generates a fresh account credential: `ya_` + 32 random bytes, base64url
 * encoded (P9.1). Distinct prefix from `yk_`/`ys_` so all three token kinds
 * are never mistaken for one another. */
export function generateAccountKey(): string {
  return `${ACCOUNT_KEY_PREFIX}${randomBytes(ACCOUNT_KEY_RANDOM_BYTES).toString("base64url")}`;
}

/** SHA-256 hex digest of an account key — same algorithm as `hashAgentKey`,
 * kept as its own named function so the token kinds stay conceptually
 * distinct at every call site. */
export function hashAccountKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Generates a fresh, single-purpose connect poll secret (P9.1): 32 random
 * bytes, base64url encoded, no prefix (it never travels as an
 * `Authorization: Bearer` header — `POST /connect/poll` takes it in the JSON
 * body alongside `connectId`). */
export function generateConnectPollSecret(): string {
  return randomBytes(CONNECT_POLL_SECRET_RANDOM_BYTES).toString("base64url");
}

/** SHA-256 hex digest of a connect poll secret. */
export function hashConnectPollSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
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
