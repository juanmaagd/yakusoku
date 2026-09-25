import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  hashWorldIdSubject,
  stepUpAttestationMessageSchema,
  stepUpAttestationSchema,
  STEP_UP_DOMAIN,
  STEP_UP_TYPES,
  toStepUpTypedDataMessage,
  verifyStepUpAttestation,
  type StepUpAttestation,
  type StepUpAttestationMessage,
} from "./step-up";

const PAY_TO = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function makeMessage(overrides: Partial<StepUpAttestationMessage> = {}): StepUpAttestationMessage {
  return {
    receiptId: "receipt_abc123",
    intentId: "intent_abc123",
    paymentIdentifier: "pay_abc123",
    payTo: PAY_TO,
    amount: "1000000",
    asset: ASSET,
    network: "eip155:84532",
    worldIdSubject: hashWorldIdSubject("world-id-subject-1"),
    acr: "https://world.org/oidc/acr/orb-v3",
    authTime: "1700000000",
    approvedAt: "1700000010",
    ...overrides,
  };
}

/** No network — signs with a freshly generated throwaway key, never
 * FIREWALL_PRIVATE_KEY (that path is apps/firewall/step-up.ts's job,
 * exercised via approvals.test.ts). */
async function signMessage(
  message: StepUpAttestationMessage,
  account = privateKeyToAccount(generatePrivateKey()),
): Promise<StepUpAttestation> {
  const signature = await account.signTypedData({
    domain: STEP_UP_DOMAIN,
    types: STEP_UP_TYPES,
    primaryType: "StepUpAttestation",
    message: toStepUpTypedDataMessage(message),
  });
  return stepUpAttestationSchema.parse({ message, signature, signer: account.address });
}

describe("StepUp attestation — signing + independent verification", () => {
  test("a freshly signed attestation verifies", async () => {
    const attestation = await signMessage(makeMessage());
    expect(await verifyStepUpAttestation(attestation)).toBe(true);
  });

  test("worldIdSubject is a keccak256 hash, never the raw subject", () => {
    const message = makeMessage();
    expect(message.worldIdSubject).not.toBe("world-id-subject-1");
    expect(message.worldIdSubject).toMatch(/^0x[0-9a-fA-F]{64}$/);
    // Deterministic — same subject always hashes the same way.
    expect(message.worldIdSubject).toBe(hashWorldIdSubject("world-id-subject-1"));
  });

  test.each([
    ["amount", { amount: "2000000" }],
    ["payTo", { payTo: "0x0000000000000000000000000000000000dead" }],
    ["receiptId", { receiptId: "receipt_someone_elses_payment" }],
    ["paymentIdentifier", { paymentIdentifier: "pay_different" }],
    ["asset", { asset: "0x0000000000000000000000000000000000dEaD" }],
    ["network", { network: "eip155:1" }],
    ["worldIdSubject", { worldIdSubject: hashWorldIdSubject("a-different-human") }],
  ] as const)("tampering %s after signing fails verification", async (_field, patch) => {
    const attestation = await signMessage(makeMessage());
    const tampered: StepUpAttestation = { ...attestation, message: { ...attestation.message, ...patch } };
    expect(await verifyStepUpAttestation(tampered)).toBe(false);
  });

  test("a signature from a different key fails verification against the original signer", async () => {
    const message = makeMessage();
    const real = await signMessage(message);
    const impostor = await signMessage(message);
    // Swap in a signature produced by a different account, keeping the
    // original (honest) `signer` field — this is exactly the forgery
    // `verifyStepUpAttestation` exists to catch.
    const forged: StepUpAttestation = { ...real, signature: impostor.signature };
    expect(await verifyStepUpAttestation(forged)).toBe(false);
  });
});

// Deliberately-invalid values for a `0x${string}`-typed field (`payTo`,
// `asset`, `worldIdSubject`) can't be expressed as a `Partial<
// StepUpAttestationMessage>` override without fighting the compiler — that
// narrower type is exactly what a valid value looks like. `rawMessage`
// widens to `Record<string, unknown>`, the same "untrusted input" shape
// `safeParse` actually validates against at runtime.
function rawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...makeMessage(), ...overrides };
}

describe("stepUpAttestationMessageSchema — rejects malformed attestations", () => {
  test("accepts a well-formed message", () => {
    expect(stepUpAttestationMessageSchema.safeParse(makeMessage()).success).toBe(true);
  });

  test("rejects a non-address payTo", () => {
    expect(stepUpAttestationMessageSchema.safeParse(rawMessage({ payTo: "not-an-address" })).success).toBe(false);
  });

  test("rejects a non-address asset", () => {
    expect(stepUpAttestationMessageSchema.safeParse(rawMessage({ asset: "0xnothex" })).success).toBe(false);
  });

  test("rejects a malformed worldIdSubject (not a 32-byte hex string)", () => {
    expect(stepUpAttestationMessageSchema.safeParse(rawMessage({ worldIdSubject: "0x1234" })).success).toBe(false);
  });

  test("rejects a non-decimal amount", () => {
    expect(stepUpAttestationMessageSchema.safeParse(rawMessage({ amount: "1.5" })).success).toBe(false);
    expect(stepUpAttestationMessageSchema.safeParse(rawMessage({ amount: "0x1" })).success).toBe(false);
  });

  test("rejects an empty receiptId/intentId/paymentIdentifier/acr", () => {
    expect(stepUpAttestationMessageSchema.safeParse(rawMessage({ receiptId: "" })).success).toBe(false);
    expect(stepUpAttestationMessageSchema.safeParse(rawMessage({ intentId: "" })).success).toBe(false);
    expect(stepUpAttestationMessageSchema.safeParse(rawMessage({ paymentIdentifier: "" })).success).toBe(false);
    expect(stepUpAttestationMessageSchema.safeParse(rawMessage({ acr: "" })).success).toBe(false);
  });
});

describe("stepUpAttestationSchema — rejects a malformed envelope", () => {
  test("rejects a malformed signer address", async () => {
    const attestation = await signMessage(makeMessage());
    // Widened to `unknown` on purpose — this constructs a deliberately
    // malformed value to check the RUNTIME schema rejects it, not something
    // that should type-check against `StepUpAttestation` itself.
    const malformed: unknown = { ...attestation, signer: "not-an-address" };
    expect(stepUpAttestationSchema.safeParse(malformed).success).toBe(false);
  });

  test("rejects a non-hex signature", async () => {
    const attestation = await signMessage(makeMessage());
    const malformed: unknown = { ...attestation, signature: "not-hex" };
    expect(stepUpAttestationSchema.safeParse(malformed).success).toBe(false);
  });

  test("rejects a missing message", async () => {
    const attestation = await signMessage(makeMessage());
    const { message: _message, ...withoutMessage } = attestation;
    expect(stepUpAttestationSchema.safeParse(withoutMessage).success).toBe(false);
  });
});
