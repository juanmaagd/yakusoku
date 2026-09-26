import { describe, expect, test } from "bun:test";
import { getAddress, keccak256, toHex } from "viem";
import {
  computeTransferWithAuthorizationDigest,
  decodeAccountSignature,
  encodeAccountSignature,
} from "./omamorisan-account";

// Fixed test vector, cross-checked independently against Foundry's `cast`
// (abi-encode + keccak, not this package's own code) — see the P11.0 report
// for the exact commands. This is what actually proves the TS encoding
// matches Solidity's `abi.encode`/`abi.decode`, rather than just proving the
// encode/decode pair in this file agree with each other.
const TYPEHASH = "0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267" as const;
const FROM = "0x0000000000000000000000000000000000000001" as const;
const TO = "0x0000000000000000000000000000000000000002" as const;
const VALUE = 1_000_000n;
const VALID_AFTER = 0n;
const VALID_BEFORE = 2_000_000_000n;
const NONCE = "0x0000000000000000000000000000000000000000000000000000000000000001" as const;
const DOMAIN_SEPARATOR = "0x34a63641b78652cdd53505da4f32cac6058bd148e3ff543f39f75997a89c2815" as const;
const EXPECTED_DIGEST = "0x602a8b3188b69b697b9c38abdd3b96c2e113e1ef8d6a53bb0d5dbc53b53e7c35" as const;

const OPERATOR_SIG = "0xaabbcc" as const;
const EXPECTED_ENCODED_SIGNATURE =
  "0x000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000077359400000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000003aabbcc0000000000000000000000000000000000000000000000000000000000" as const;

describe("computeTransferWithAuthorizationDigest", () => {
  test("matches the domain separator produced independently by `cast keccak`", () => {
    expect(keccak256(toHex("test-domain"))).toBe(DOMAIN_SEPARATOR);
  });

  test("matches the digest cast independently computed via abi-encode + keccak", () => {
    const digest = computeTransferWithAuthorizationDigest({
      domainSeparator: DOMAIN_SEPARATOR,
      transferWithAuthorizationTypehash: TYPEHASH,
      from: FROM,
      to: TO,
      value: VALUE,
      validAfter: VALID_AFTER,
      validBefore: VALID_BEFORE,
      nonce: NONCE,
    });
    expect(digest).toBe(EXPECTED_DIGEST);
  });

  test("changing any field changes the digest (no accidental field aliasing)", () => {
    const base = {
      domainSeparator: DOMAIN_SEPARATOR,
      transferWithAuthorizationTypehash: TYPEHASH,
      from: FROM,
      to: TO,
      value: VALUE,
      validAfter: VALID_AFTER,
      validBefore: VALID_BEFORE,
      nonce: NONCE,
    };
    const baseline = computeTransferWithAuthorizationDigest(base);

    expect(computeTransferWithAuthorizationDigest({ ...base, value: VALUE + 1n })).not.toBe(baseline);
    expect(computeTransferWithAuthorizationDigest({ ...base, to: FROM })).not.toBe(baseline);
    expect(
      computeTransferWithAuthorizationDigest({
        ...base,
        nonce: "0x0000000000000000000000000000000000000000000000000000000000000002",
      }),
    ).not.toBe(baseline);
  });
});

describe("encodeAccountSignature / decodeAccountSignature", () => {
  test("encodes to the exact bytes Solidity's abi.encode produces (verified via `cast abi-encode`)", () => {
    const encoded = encodeAccountSignature({
      to: TO,
      value: VALUE,
      validAfter: VALID_AFTER,
      validBefore: VALID_BEFORE,
      nonce: NONCE,
      operatorSig: OPERATOR_SIG,
    });
    expect(encoded).toBe(EXPECTED_ENCODED_SIGNATURE);
  });

  test("round-trips arbitrary fields, including a realistic 65-byte operator signature", () => {
    const fields = {
      to: getAddress(`0x${keccak256(toHex("round-trip-recipient")).slice(2, 42)}`),
      value: 42_000_000n,
      validAfter: 1_700_000_000n,
      validBefore: 1_800_000_000n,
      nonce: `0x${"11".repeat(32)}` as `0x${string}`,
      operatorSig: `0x${"ab".repeat(65)}` as `0x${string}`,
    };

    const encoded = encodeAccountSignature(fields);
    const decoded = decodeAccountSignature(encoded);

    expect(decoded.to.toLowerCase()).toBe(fields.to.toLowerCase());
    expect(decoded.value).toBe(fields.value);
    expect(decoded.validAfter).toBe(fields.validAfter);
    expect(decoded.validBefore).toBe(fields.validBefore);
    expect(decoded.nonce).toBe(fields.nonce);
    expect(decoded.operatorSig).toBe(fields.operatorSig);
  });

  test("decoding an empty blob throws (matches Solidity's abi.decode failing closed)", () => {
    expect(() => decodeAccountSignature("0x")).toThrow();
  });
});
