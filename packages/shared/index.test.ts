import { describe, expect, test } from "bun:test";
import {
  paymentRequirementSchema,
  signedTaskIntentSchema,
  taskIntentMessageSchema,
  transition,
} from "./index";

const validAddress = "0x1234567890123456789012345678901234567890";

const validIntent = {
  task: "Buy a 25 USDC Amazon gift card",
  budget: 25_000_000n,
  categories: ["gift_card:amazon"],
  expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
  nonce: `0x${"11".repeat(32)}`,
};

describe("taskIntentMessageSchema", () => {
  test("accepts a valid TaskIntent", () => {
    expect(taskIntentMessageSchema.safeParse(validIntent).success).toBe(true);
  });

  test("rejects a zero or negative budget", () => {
    expect(taskIntentMessageSchema.safeParse({ ...validIntent, budget: 0n }).success).toBe(false);
    expect(taskIntentMessageSchema.safeParse({ ...validIntent, budget: -1n }).success).toBe(false);
  });
});

describe("signedTaskIntentSchema", () => {
  test("rejects a malformed signer address", () => {
    const signed = {
      message: validIntent,
      signature: `0x${"aa".repeat(65)}`,
      signer: "not-an-address",
    };
    expect(signedTaskIntentSchema.safeParse(signed).success).toBe(false);
  });
});

describe("paymentRequirementSchema", () => {
  test("rejects a malformed (non-CAIP-2) network id", () => {
    const requirement = {
      scheme: "exact",
      network: "wrongchain",
      amount: "1000",
      asset: validAddress,
      payTo: validAddress,
    };
    expect(paymentRequirementSchema.safeParse(requirement).success).toBe(false);
  });
});

describe("receipt transition()", () => {
  test("allows a valid pipeline transition", () => {
    expect(transition("initial", "awaiting_world_id")).toBe("awaiting_world_id");
    expect(transition("awaiting_world_id", "signed")).toBe("signed");
  });

  test("throws on an illegal transition", () => {
    expect(() => transition("policy_rejected", "signed")).toThrow();
    expect(() => transition("initial", "settled")).toThrow();
  });

  test("allows sign_failed from awaiting_world_id and error from initial (WU9 fix)", () => {
    expect(transition("awaiting_world_id", "sign_failed")).toBe("sign_failed");
    expect(transition("initial", "error")).toBe("error");
  });
});
