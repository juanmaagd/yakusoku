import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashWorldIdSubject } from "./step-up";
import {
  promiseAttestationMessageSchema,
  promiseAttestationSchema,
  PROMISE_ATTESTATION_DOMAIN,
  PROMISE_ATTESTATION_TYPES,
  toPromiseAttestationTypedDataMessage,
  verifyPromiseAttestation,
  type PromiseAttestation,
  type PromiseAttestationMessage,
} from "./promise-attestation";

function makeMessage(overrides: Partial<PromiseAttestationMessage> = {}): PromiseAttestationMessage {
  return {
    promiseId: "promise_abc123",
    accountId: "account_abc123",
    task: "Buy a $1 Amazon gift card (rehearsal)",
    budget: "1000000",
    categories: ["gift_card:amazon"],
    expiry: "1700003600",
    nonce: `0x${"11".repeat(32)}`,
    worldIdSubject: hashWorldIdSubject("world-id-subject-1"),
    acr: "https://world.org/oidc/acr/orb-v3",
    authTime: "1700000000",
    approvedAt: "1700000010",
    ...overrides,
  };
}

/** No network — signs with a freshly generated throwaway key, never
 * FIREWALL_PRIVATE_KEY (that path is apps/firewall/promise-attestation.ts's
 * job, exercised via promises.test.ts). */
async function signMessage(
  message: PromiseAttestationMessage,
  account = privateKeyToAccount(generatePrivateKey()),
): Promise<PromiseAttestation> {
  const signature = await account.signTypedData({
    domain: PROMISE_ATTESTATION_DOMAIN,
    types: PROMISE_ATTESTATION_TYPES,
    primaryType: "PromiseAttestation",
    message: toPromiseAttestationTypedDataMessage(message),
  });
  return promiseAttestationSchema.parse({ message, signature, signer: account.address });
}

describe("PromiseAttestation — signing + independent verification", () => {
  test("a freshly signed attestation verifies", async () => {
    const attestation = await signMessage(makeMessage());
    expect(await verifyPromiseAttestation(attestation)).toBe(true);
  });

  test("worldIdSubject is a keccak256 hash, never the raw subject", () => {
    const message = makeMessage();
    expect(message.worldIdSubject).not.toBe("world-id-subject-1");
    expect(message.worldIdSubject).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(message.worldIdSubject).toBe(hashWorldIdSubject("world-id-subject-1"));
  });

  test.each([
    ["budget", { budget: "2000000" }],
    ["task", { task: "Buy something else entirely" }],
    ["categories", { categories: ["electronics"] as string[] }],
    ["expiry", { expiry: "1800000000" }],
    ["promiseId", { promiseId: "promise_someone_elses" }],
    ["accountId", { accountId: "account_different" }],
    ["worldIdSubject", { worldIdSubject: hashWorldIdSubject("a-different-human") }],
  ] as const)("tampering %s after signing fails verification", async (_field, patch) => {
    const attestation = await signMessage(makeMessage());
    const tampered: PromiseAttestation = { ...attestation, message: { ...attestation.message, ...patch } };
    expect(await verifyPromiseAttestation(tampered)).toBe(false);
  });

  test("a signature from a different key fails verification against the original signer", async () => {
    const message = makeMessage();
    const real = await signMessage(message);
    const impostor = await signMessage(message);
    const forged: PromiseAttestation = { ...real, signature: impostor.signature };
    expect(await verifyPromiseAttestation(forged)).toBe(false);
  });
});

function rawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...makeMessage(), ...overrides };
}

describe("promiseAttestationMessageSchema — rejects malformed attestations", () => {
  test("accepts a well-formed message", () => {
    expect(promiseAttestationMessageSchema.safeParse(makeMessage()).success).toBe(true);
  });

  test("rejects a malformed worldIdSubject (not a 32-byte hex string)", () => {
    expect(promiseAttestationMessageSchema.safeParse(rawMessage({ worldIdSubject: "0x1234" })).success).toBe(false);
  });

  test("rejects a non-decimal budget/expiry", () => {
    expect(promiseAttestationMessageSchema.safeParse(rawMessage({ budget: "1.5" })).success).toBe(false);
    expect(promiseAttestationMessageSchema.safeParse(rawMessage({ expiry: "0x1" })).success).toBe(false);
  });

  test("rejects an empty categories array", () => {
    expect(promiseAttestationMessageSchema.safeParse(rawMessage({ categories: [] })).success).toBe(false);
  });

  test("rejects an empty promiseId/accountId/task/acr", () => {
    expect(promiseAttestationMessageSchema.safeParse(rawMessage({ promiseId: "" })).success).toBe(false);
    expect(promiseAttestationMessageSchema.safeParse(rawMessage({ accountId: "" })).success).toBe(false);
    expect(promiseAttestationMessageSchema.safeParse(rawMessage({ task: "" })).success).toBe(false);
    expect(promiseAttestationMessageSchema.safeParse(rawMessage({ acr: "" })).success).toBe(false);
  });
});

describe("promiseAttestationSchema — rejects a malformed envelope", () => {
  test("rejects a malformed signer address", async () => {
    const attestation = await signMessage(makeMessage());
    const malformed: unknown = { ...attestation, signer: "not-an-address" };
    expect(promiseAttestationSchema.safeParse(malformed).success).toBe(false);
  });

  test("rejects a non-hex signature", async () => {
    const attestation = await signMessage(makeMessage());
    const malformed: unknown = { ...attestation, signature: "not-hex" };
    expect(promiseAttestationSchema.safeParse(malformed).success).toBe(false);
  });

  test("rejects a missing message", async () => {
    const attestation = await signMessage(makeMessage());
    const { message: _message, ...withoutMessage } = attestation;
    expect(promiseAttestationSchema.safeParse(withoutMessage).success).toBe(false);
  });
});
