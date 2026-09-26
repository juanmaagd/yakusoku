import { concatHex, decodeAbiParameters, encodeAbiParameters, keccak256 } from "viem";
import type { Abi, Hex } from "viem";

/**
 * ABIs + encoding helpers for `OmamorisanAccount`/`OmamorisanAccountFactory`
 * (contracts/src/*.sol, P11.0). Hand-written rather than imported from the
 * forge build artifacts so this package has no build-order dependency on
 * `contracts/` (bun workspaces don't run `forge build` as part of
 * `typecheck`/`test`) — kept minimal and limited to what the firewall/agent
 * actually need to call. `contracts/test/*.t.sol` is the source of truth for
 * on-chain behavior; if a signature here drifts from the deployed contract,
 * `forge build`'s ABI (`contracts/out/OmamorisanAccount.sol/OmamorisanAccount.json`)
 * is the tie-breaker.
 */

/** Minimal ABI for a deployed `OmamorisanAccount`. */
export const OMAMORISAN_ACCOUNT_ABI = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "operator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "perPaymentLimit",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "recipients",
    stateMutability: "view",
    inputs: [{ name: "recipient", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "domainSeparator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "transferWithAuthorizationTypehash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "setOperator",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOperator", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setPerPaymentLimit",
    stateMutability: "nonpayable",
    inputs: [{ name: "newLimit", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setRecipient",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setRecipients",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipientList", type: "address[]" },
      { name: "allowedList", type: "bool[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setPaused",
    stateMutability: "nonpayable",
    inputs: [{ name: "newPaused", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "transferOwnership",
    stateMutability: "nonpayable",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes4" }],
  },
  {
    type: "function",
    name: "decodeAccountSignature",
    stateMutability: "pure",
    inputs: [{ name: "signature", type: "bytes" }],
    outputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "operatorSig", type: "bytes" },
    ],
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "OperatorUpdated",
    inputs: [
      { name: "previousOperator", type: "address", indexed: true },
      { name: "newOperator", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "PerPaymentLimitUpdated",
    inputs: [
      { name: "previousLimit", type: "uint256", indexed: false },
      { name: "newLimit", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RecipientUpdated",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "allowed", type: "bool", indexed: false },
    ],
  },
  { type: "event", name: "PausedUpdated", inputs: [{ name: "paused", type: "bool", indexed: false }] },
  {
    type: "event",
    name: "Withdrawn",
    inputs: [
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

/** Minimal ABI for the `OmamorisanAccountFactory`. */
export const OMAMORISAN_ACCOUNT_FACTORY_ABI = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "createAccount",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner_", type: "address" },
      { name: "operator_", type: "address" },
      { name: "perPaymentLimit_", type: "uint256" },
      { name: "initialRecipients", type: "address[]" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "account", type: "address" }],
  },
  {
    type: "function",
    name: "predictAddress",
    stateMutability: "view",
    inputs: [
      { name: "owner_", type: "address" },
      { name: "operator_", type: "address" },
      { name: "perPaymentLimit_", type: "uint256" },
      { name: "initialRecipients", type: "address[]" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "predicted", type: "address" }],
  },
  {
    type: "event",
    name: "AccountCreated",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "operator", type: "address", indexed: true },
      { name: "salt", type: "bytes32", indexed: false },
    ],
  },
] as const satisfies Abi;

/** ABI parameter shape shared by {@link encodeAccountSignature} and
 * {@link decodeAccountSignature} — must stay byte-for-byte in sync with
 * `OmamorisanAccount.decodeAccountSignature`'s `abi.decode` call
 * (contracts/src/OmamorisanAccount.sol). */
const ACCOUNT_SIGNATURE_PARAMS = [
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "bytes32" },
  { type: "bytes" },
] as const;

/** The fields `OmamorisanAccount.isValidSignature` decodes out of the
 * `signature` blob it receives from USDC's `transferWithAuthorization`. */
export interface AccountSignatureFields {
  /** Payment recipient — must be in the account's `recipients` allow-list. */
  to: Hex;
  /** USDC value (6 decimals) — must not exceed the account's `perPaymentLimit`. */
  value: bigint;
  /** EIP-3009 authorization validity window start (unix seconds). */
  validAfter: bigint;
  /** EIP-3009 authorization validity window end (unix seconds). */
  validBefore: bigint;
  /** EIP-3009 nonce — replay protection lives entirely in USDC's own
   * `authorizationState(from, nonce)`, not in `OmamorisanAccount`. */
  nonce: Hex;
  /** 65-byte (r, s, v) ECDSA signature over the EIP-3009 digest, produced by
   * the firewall's operator key — see the module-level doc comment below for
   * how to produce this correctly. */
  operatorSig: Hex;
}

/**
 * Encodes the blob the firewall passes as the `signature` argument of USDC's
 * `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce,
 * signature)` when `from` is an `OmamorisanAccount`. Must exactly match
 * `OmamorisanAccount.decodeAccountSignature`'s `abi.decode(signature,
 * (address, uint256, uint256, uint256, bytes32, bytes))` — verified by the
 * round-trip test in `omamorisan-account.test.ts`.
 */
export function encodeAccountSignature(fields: AccountSignatureFields): Hex {
  return encodeAbiParameters(ACCOUNT_SIGNATURE_PARAMS, [
    fields.to,
    fields.value,
    fields.validAfter,
    fields.validBefore,
    fields.nonce,
    fields.operatorSig,
  ]);
}

/** Inverse of {@link encodeAccountSignature} — decodes a blob back into its
 * fields. Mainly useful for tests and for inspecting an authorization that
 * was rejected on-chain. */
export function decodeAccountSignature(encoded: Hex): AccountSignatureFields {
  const [to, value, validAfter, validBefore, nonce, operatorSig] = decodeAbiParameters(
    ACCOUNT_SIGNATURE_PARAMS,
    encoded,
  );
  return { to, value, validAfter, validBefore, nonce, operatorSig };
}

/**
 * Recomputes the EIP-3009 `TransferWithAuthorization` digest exactly the way
 * both USDC (`EIP3009._requireValidSignature`) and `OmamorisanAccount.isValidSignature`
 * do: `keccak256("\x19\x01" || domainSeparator || structHash)` where
 * `structHash = keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
 * from, to, value, validAfter, validBefore, nonce))`. `from` must be the
 * `OmamorisanAccount` address (never an EOA) for this project.
 *
 * `domainSeparator`/`transferWithAuthorizationTypehash` should be read live
 * from the token (`DOMAIN_SEPARATOR()`/`TRANSFER_WITH_AUTHORIZATION_TYPEHASH()`)
 * or from the deployed account (`domainSeparator()`/
 * `transferWithAuthorizationTypehash()`, which cached the same values at
 * construction) — never hardcoded, so a wrong guess fails closed instead of
 * silently signing the wrong digest.
 *
 * HOW THE FIREWALL SIGNS: call this to get `digest`, then sign it with
 * `operatorAccount.sign({ hash: digest })` (viem's `PrivateKeyAccount.sign`,
 * from `privateKeyToAccount(FIREWALL_OPERATOR_PRIVATE_KEY)`) — NOT
 * `signMessage` (adds an EIP-191 `"\x19Ethereum Signed Message:\n32"`
 * prefix) and NOT `signTypedData` (would need to reconstruct the token's own
 * EIP-712 domain object, including its exact on-chain `name` string, just to
 * re-derive a digest we already have here). `sign({ hash })` signs the raw
 * 32-byte digest directly, matching what `ECDSA.tryRecover(hash,
 * operatorSig)` expects in `OmamorisanAccount.isValidSignature` — the same
 * thing `vm.sign(operatorPk, digest)` does in the Foundry tests
 * (contracts/test/OmamorisanAccount.t.sol / OmamorisanAccount.fork.t.sol).
 */
export function computeTransferWithAuthorizationDigest(params: {
  domainSeparator: Hex;
  transferWithAuthorizationTypehash: Hex;
  from: Hex;
  to: Hex;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [
        params.transferWithAuthorizationTypehash,
        params.from,
        params.to,
        params.value,
        params.validAfter,
        params.validBefore,
        params.nonce,
      ],
    ),
  );
  return keccak256(concatHex(["0x1901", params.domainSeparator, structHash]));
}
