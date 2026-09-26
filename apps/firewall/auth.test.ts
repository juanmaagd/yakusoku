// WU-P1 — agent key generation/hashing/verification. Pure functions, no
// network and no store.ts/sqlite involvement (see store.test-covering files
// for the HTTP-level scenarios, apps/firewall/scripts/scenarios.ts S16-S19).

import { describe, expect, test } from "bun:test";
import { extractBearerToken, generateAgentKey, hashAgentKey, hashesEqual } from "./auth";

describe("generateAgentKey", () => {
  test("has the yk_ prefix", () => {
    expect(generateAgentKey().startsWith("yk_")).toBe(true);
  });

  test("produces a different key on every call", () => {
    const a = generateAgentKey();
    const b = generateAgentKey();
    expect(a).not.toBe(b);
  });

  test("carries enough entropy to be unguessable (32 random bytes, base64url)", () => {
    const key = generateAgentKey();
    const body = key.slice("yk_".length);
    // base64url of 32 bytes has no padding and is 43 chars long.
    expect(body.length).toBe(43);
    expect(/^[A-Za-z0-9_-]+$/.test(body)).toBe(true);
  });
});

describe("hashAgentKey", () => {
  test("is deterministic for the same input", () => {
    const key = generateAgentKey();
    expect(hashAgentKey(key)).toBe(hashAgentKey(key));
  });

  test("differs for different inputs", () => {
    expect(hashAgentKey(generateAgentKey())).not.toBe(hashAgentKey(generateAgentKey()));
  });

  test("is a 64-char lowercase hex string (SHA-256)", () => {
    const hash = hashAgentKey(generateAgentKey());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("never reproduces the raw key inside the hash", () => {
    const key = generateAgentKey();
    expect(hashAgentKey(key)).not.toContain(key);
  });
});

describe("hashesEqual", () => {
  test("true for two equal hashes", () => {
    const hash = hashAgentKey(generateAgentKey());
    expect(hashesEqual(hash, hash)).toBe(true);
  });

  test("false for two different hashes of equal length", () => {
    const a = hashAgentKey(generateAgentKey());
    const b = hashAgentKey(generateAgentKey());
    expect(hashesEqual(a, b)).toBe(false);
  });

  test("false (not a throw) for hashes of different lengths", () => {
    const hash = hashAgentKey(generateAgentKey());
    expect(hashesEqual(hash, hash.slice(0, -2))).toBe(false);
    expect(hashesEqual(hash, `${hash}ab`)).toBe(false);
  });

  test("false for an empty string against a real hash", () => {
    const hash = hashAgentKey(generateAgentKey());
    expect(hashesEqual(hash, "")).toBe(false);
  });

  test("end-to-end: a key's own hash matches, another key's hash does not", () => {
    const keyA = generateAgentKey();
    const keyB = generateAgentKey();
    const hashA = hashAgentKey(keyA);
    expect(hashesEqual(hashA, hashAgentKey(keyA))).toBe(true);
    expect(hashesEqual(hashA, hashAgentKey(keyB))).toBe(false);
  });
});

describe("extractBearerToken", () => {
  test("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer yk_abc123")).toBe("yk_abc123");
  });

  test("is case-insensitive on the scheme", () => {
    expect(extractBearerToken("bearer yk_abc123")).toBe("yk_abc123");
  });

  test("trims surrounding whitespace", () => {
    expect(extractBearerToken("  Bearer   yk_abc123  ")).toBe("yk_abc123");
  });

  test("returns undefined for a missing header", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken(null)).toBeUndefined();
  });

  test("returns undefined for a non-Bearer scheme", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeUndefined();
  });

  test("returns undefined for an empty token", () => {
    expect(extractBearerToken("Bearer ")).toBeUndefined();
    expect(extractBearerToken("Bearer")).toBeUndefined();
  });
});
