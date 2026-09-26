#!/usr/bin/env bun
// P11.1 — live check: can the public x402 facilitator (https://x402.org/facilitator)
// settle a payment whose payer is our OmamorisanAccount smart contract (ERC-1271),
// instead of an EOA? This is the thing the whole "firewall signs for the account,
// never for itself" design (contracts/src/OmamorisanAccount.sol, P11.0) depends on
// working against the real hosted facilitator, not just against our own tests.
//
// What this script does, in order (see root CLAUDE.md P11.1 spec for the full
// rationale):
//   1. Reads the store's real 402 for the $1 rehearsal SKU.
//   2. Deploys (or reuses, same fixed salt) an OmamorisanAccount: owner = a
//      throwaway EOA persisted to this session's scratchpad, operator = the
//      firewall EOA, recipients = [store's payTo].
//   3. Deposits exactly 1 USDC into the account from the firewall EOA (skipped
//      if already funded).
//   4. Builds the x402 payment with the ACCOUNT as payer via a custom
//      ClientEvmSigner (@x402/evm's `signer.address`/`signTypedData` contract —
//      see node_modules/.../@x402/evm/dist/esm/signer-CJuc15ii.d.mts) whose
//      `signTypedData` returns `encodeAccountSignature(...)` instead of a plain
//      ECDSA signature, with `operatorSig` signed by the firewall EOA over the
//      EIP-3009 digest.
//   5. Sanity-checks the built payload fully locally (isValidSignature +
//      simulateContract) before ever talking to the facilitator.
//   6. Retries the store with PAYMENT-SIGNATURE and reports the real outcome:
//      settlement tx + on-chain balance deltas, or the facilitator's exact
//      rejection with a best-effort root cause from reading @x402/evm's
//      reference facilitator implementation (same package, exact/facilitator).
//
// Spend limits (enforced structurally, not just by convention): at most 1 USDC
// deposited (skipped once the account already holds >= 1 USDC) and exactly one
// 1 USDC payment attempt, plus gas. Never touches mainnet — everything here is
// Base Sepolia (chain 84532).
//
// Does NOT stop/restart the store/firewall/mcp/site dev servers — this only
// talks to the store's HTTP API and to Base Sepolia directly.

import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  keccak256,
  toHex,
  hashTypedData,
  formatUnits,
  type Address,
  type Hex,
  type Abi,
  type HashTypedDataParameters,
} from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentPayload } from "@x402/core/types";
import {
  X402_NETWORK,
  USDC_SEPOLIA_ADDRESS,
  USDC_DECIMALS,
  OMAMORISAN_ACCOUNT_ABI,
  OMAMORISAN_ACCOUNT_FACTORY_ABI,
  encodeAccountSignature,
  computeTransferWithAuthorizationDigest,
} from "@yakusoku/shared";

// --- Fixed, script-scoped config --------------------------------------------

const STORE_URL = process.env.STORE_URL ?? "http://localhost:4000";
const REHEARSAL_SKU = "amazon-1-rehearsal";
const FACTORY_ADDRESS: Address = "0xadBe165CCc90e59e38A3dE68a25E99Ec807501cc";

// Fixed salt -> deterministic account address -> idempotent across re-runs of
// this script (same owner key + same salt + same constructor args = same
// CREATE2 address; OmamorisanAccountFactory.createAccount reverts if code is
// already there, so we check first and reuse).
const ACCOUNT_SALT: Hex = keccak256(toHex("yakusoku-p11.1-account-payment-check"));
const PER_PAYMENT_LIMIT_ATOMIC = 2_000_000n; // 2 USDC
const DEPOSIT_TARGET_ATOMIC = 1_000_000n; // 1 USDC

// This session's scratchpad (see the harness's "Scratchpad directory" note) —
// not portable across sessions by design; the owner key only needs to be
// stable for the lifetime of this check.
const OWNER_KEY_PATH =
  "/private/tmp/claude-501/-Users-juanma-Desktop-eth-global/bce3f6d2-a2de-4740-870a-d7e5b7ccb8f5/scratchpad/p11-1-owner.key";

// Minimal USDC (FiatTokenV2_2) surface this script needs beyond
// packages/shared/omamorisan-account.ts's account/factory ABIs. Only the
// `bytes signature` overload of transferWithAuthorization is declared (not the
// v/r/s one) since that's the only one an ERC-1271 payer can ever use.
const USDC_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name} — set it in .env.hackathon`);
  return value;
}

function basescanTx(hash: string): string {
  return `https://sepolia.basescan.org/tx/${hash}`;
}

/**
 * Base Sepolia's public RPC (sepolia.base.org) load-balances across backend
 * nodes without sticky sessions — a read right after a write's receipt has
 * been confirmed can still land on a node that hasn't caught up yet (observed
 * live: `operator()` returning "0x" immediately after a successful
 * `createAccount` receipt). Retry reads that immediately follow a write
 * instead of failing on that lag.
 */
async function withRpcLagRetry<T>(fn: () => Promise<T>, attempts = 8, delayMs = 1500): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * Same RPC-lag problem as {@link withRpcLagRetry}, but for reads that don't
 * throw on lag — they just return a stale-but-valid value (e.g. `balanceOf`
 * before the node has caught up to the block a write landed in). Retries
 * until `predicate` passes or `attempts` is exhausted, returning whatever the
 * last read was either way so the caller's own assertion produces the error.
 */
async function pollUntil<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, attempts = 8, delayMs = 1500): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const value = await fn();
    if (predicate(value) || i === attempts - 1) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("unreachable");
}

// --- EIP-3009 authorization shape the ExactEvmScheme client puts in
// PaymentPayload.payload for the "exact" scheme (see @x402/evm's
// src/exact/client/eip3009.ts, read from node_modules for this script). ---
interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}
interface Eip3009Payload {
  authorization: Eip3009Authorization;
  signature: Hex;
}

async function main(): Promise<void> {
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL),
  });

  const firewallAccount = privateKeyToAccount(requireEnv("FIREWALL_PRIVATE_KEY") as Hex);
  const walletClient = createWalletClient({
    account: firewallAccount,
    chain: baseSepolia,
    transport: http(process.env.BASE_SEPOLIA_RPC_URL),
  });
  console.log(`firewall EOA (operator + depositor + gas payer): ${firewallAccount.address}`);

  console.log("\n=== 1. Fetch the store's real 402 for the rehearsal SKU ===");
  const rehearsalUrl = `${STORE_URL}/giftcard/${REHEARSAL_SKU}`;
  const initialResponse = await fetch(rehearsalUrl);
  if (initialResponse.status !== 402) {
    throw new Error(`expected 402 from ${rehearsalUrl}, got ${initialResponse.status}`);
  }
  const requiredHeader = initialResponse.headers.get("PAYMENT-REQUIRED");
  if (!requiredHeader) throw new Error("missing PAYMENT-REQUIRED header");
  const paymentRequired: PaymentRequired = decodePaymentRequiredHeader(requiredHeader);
  const requirements = paymentRequired.accepts[0];
  if (!requirements) throw new Error("402 response declared no payment requirements");
  console.log("payTo:", requirements.payTo, "amount (atomic):", requirements.amount, "asset:", requirements.asset);
  if (getAddress(requirements.asset) !== getAddress(USDC_SEPOLIA_ADDRESS)) {
    throw new Error(`store's asset ${requirements.asset} != expected USDC ${USDC_SEPOLIA_ADDRESS}`);
  }
  const merchantAddress = getAddress(requirements.payTo);

  console.log("\n=== 2. Deploy (or reuse) the OmamorisanAccount ===");
  let ownerKey: Hex;
  const ownerKeyFile = Bun.file(OWNER_KEY_PATH);
  if (await ownerKeyFile.exists()) {
    ownerKey = (await ownerKeyFile.text()).trim() as Hex;
    console.log(`reusing existing throwaway owner key at ${OWNER_KEY_PATH}`);
  } else {
    ownerKey = generatePrivateKey();
    await Bun.write(OWNER_KEY_PATH, ownerKey);
    await Bun.$`chmod 600 ${OWNER_KEY_PATH}`.quiet();
    console.log(`generated a fresh throwaway owner key, saved (mode 0600) to ${OWNER_KEY_PATH}`);
  }
  const ownerAccount = privateKeyToAccount(ownerKey);
  const recipients: Address[] = [merchantAddress];
  console.log(`owner (throwaway): ${ownerAccount.address}, operator: ${firewallAccount.address}, recipients: [${merchantAddress}]`);

  const predictedAddress = (await publicClient.readContract({
    address: FACTORY_ADDRESS,
    abi: OMAMORISAN_ACCOUNT_FACTORY_ABI,
    functionName: "predictAddress",
    args: [ownerAccount.address, firewallAccount.address, PER_PAYMENT_LIMIT_ATOMIC, recipients, ACCOUNT_SALT],
  })) as Address;
  console.log(`predicted account address: ${predictedAddress}`);

  const existingCode = await publicClient.getCode({ address: predictedAddress });
  if (existingCode && existingCode !== "0x") {
    console.log("account already deployed — reusing it.");
  } else {
    console.log("account not deployed yet — deploying via the factory...");
    const createTx = await walletClient.writeContract({
      address: FACTORY_ADDRESS,
      abi: OMAMORISAN_ACCOUNT_FACTORY_ABI,
      functionName: "createAccount",
      args: [ownerAccount.address, firewallAccount.address, PER_PAYMENT_LIMIT_ATOMIC, recipients, ACCOUNT_SALT],
    });
    console.log(`createAccount tx: ${basescanTx(createTx)}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: createTx });
    if (receipt.status !== "success") throw new Error(`createAccount tx reverted: ${createTx}`);
    console.log("deployed.");
  }
  const accountAddress = predictedAddress;

  // Fail fast with a clear message instead of a much more confusing
  // 0xffffffff from isValidSignature later, if the deployed account's rules
  // ever don't match what we asked for (e.g. a stale deployment under the
  // same salt from a previous, differently-configured run).
  const [deployedOperator, recipientAllowed, deployedLimit] = await withRpcLagRetry(() =>
    Promise.all([
      publicClient.readContract({ address: accountAddress, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "operator" }),
      publicClient.readContract({
        address: accountAddress,
        abi: OMAMORISAN_ACCOUNT_ABI,
        functionName: "recipients",
        args: [merchantAddress],
      }),
      publicClient.readContract({ address: accountAddress, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "perPaymentLimit" }),
    ]),
  );
  if (getAddress(deployedOperator as Address) !== getAddress(firewallAccount.address)) {
    throw new Error(`deployed account's operator ${deployedOperator} != firewall EOA ${firewallAccount.address}`);
  }
  if (!recipientAllowed) throw new Error(`deployed account does not allow-list merchant ${merchantAddress}`);
  if ((deployedLimit as bigint) < BigInt(requirements.amount)) {
    throw new Error(`deployed account's perPaymentLimit ${deployedLimit} < payment amount ${requirements.amount}`);
  }

  const [domainSeparator, transferWithAuthorizationTypehash] = (await withRpcLagRetry(() =>
    Promise.all([
      publicClient.readContract({ address: accountAddress, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "domainSeparator" }),
      publicClient.readContract({
        address: accountAddress,
        abi: OMAMORISAN_ACCOUNT_ABI,
        functionName: "transferWithAuthorizationTypehash",
      }),
    ]),
  )) as [Hex, Hex];

  console.log("\n=== 3. Deposit 1 USDC into the account (skipped if already funded) ===");
  let accountBalance = (await publicClient.readContract({
    address: USDC_SEPOLIA_ADDRESS,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [accountAddress],
  })) as bigint;
  console.log(`account USDC balance before: ${formatUnits(accountBalance, USDC_DECIMALS)}`);
  if (accountBalance < DEPOSIT_TARGET_ATOMIC) {
    const depositTx = await walletClient.writeContract({
      address: USDC_SEPOLIA_ADDRESS,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [accountAddress, DEPOSIT_TARGET_ATOMIC],
    });
    console.log(`deposit tx: ${basescanTx(depositTx)}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
    if (receipt.status !== "success") throw new Error(`deposit tx reverted: ${depositTx}`);
    accountBalance = await pollUntil(
      () =>
        publicClient.readContract({
          address: USDC_SEPOLIA_ADDRESS,
          abi: USDC_ABI,
          functionName: "balanceOf",
          args: [accountAddress],
        }) as Promise<bigint>,
      (balance) => balance >= DEPOSIT_TARGET_ATOMIC,
    );
    if (accountBalance < DEPOSIT_TARGET_ATOMIC) {
      throw new Error(`deposit tx confirmed but account balance is still ${accountBalance} < ${DEPOSIT_TARGET_ATOMIC} (RPC read lag?)`);
    }
  } else {
    console.log("already funded — skipping deposit.");
  }
  console.log(`account USDC balance now: ${formatUnits(accountBalance, USDC_DECIMALS)}`);

  console.log("\n=== 4. Build the x402 payment with the ACCOUNT as payer ===");
  // Custom ClientEvmSigner (@x402/evm's contract: `address` + `signTypedData`,
  // see node_modules/.../@x402/evm/dist/esm/signer-CJuc15ii.d.mts). The SDK
  // (src/exact/client/eip3009.ts: createEIP3009Payload/signEIP3009Authorization)
  // sets `authorization.from = signer.address` and calls
  // `signer.signTypedData({domain, types, primaryType: "TransferWithAuthorization", message})`
  // with the exact EIP-3009 typed data USDC itself expects — we intercept that
  // and return the account's ERC-1271 blob instead of a raw ECDSA signature.
  let capturedDigest: Hex | undefined;
  const baseSigner: Pick<ClientEvmSigner, "address" | "signTypedData"> = {
    address: accountAddress,
    async signTypedData({ domain, types, primaryType, message }) {
      const from = message.from as Address;
      const to = message.to as Address;
      const value = message.value as bigint;
      const validAfter = message.validAfter as bigint;
      const validBefore = message.validBefore as bigint;
      const nonce = message.nonce as Hex;
      if (getAddress(from) !== getAddress(accountAddress)) {
        throw new Error(`SDK asked to sign for ${from}, expected the account ${accountAddress}`);
      }

      // Cross-check: the digest the SDK is about to treat as "the thing being
      // signed" must equal what OmamorisanAccount.isValidSignature will
      // independently recompute on-chain from domainSeparator (read live
      // above, never hardcoded) — this is exactly the check P11.1 asks for.
      const sdkDigest = hashTypedData({
        domain,
        types,
        primaryType,
        message,
      } as unknown as HashTypedDataParameters);
      const localDigest = computeTransferWithAuthorizationDigest({
        domainSeparator,
        transferWithAuthorizationTypehash,
        from: accountAddress,
        to,
        value,
        validAfter,
        validBefore,
        nonce,
      });
      if (sdkDigest !== localDigest) {
        throw new Error(`digest mismatch: SDK computed ${sdkDigest}, local computed ${localDigest}`);
      }
      capturedDigest = sdkDigest;

      const operatorSig = await firewallAccount.sign({ hash: sdkDigest });
      return encodeAccountSignature({ to, value, validAfter, validBefore, nonce, operatorSig });
    },
  };
  const accountSigner = toClientEvmSigner(baseSigner, publicClient);

  const client = x402Client.fromConfig({
    schemes: [{ network: X402_NETWORK, client: new ExactEvmScheme(accountSigner) }],
    spendControls: { maxAmountPerPayment: "$1" },
  });
  const paymentPayload: PaymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentSignatureHeader = encodePaymentSignatureHeader(paymentPayload);
  const eip3009Payload = paymentPayload.payload as unknown as Eip3009Payload;
  console.log("digest signed:", capturedDigest);
  console.log("encoded account signature blob length (bytes):", (eip3009Payload.signature.length - 2) / 2);

  console.log("\n=== 5. Local sanity checks before ever hitting the facilitator ===");
  if (!capturedDigest) throw new Error("signTypedData was never called — no digest captured");
  const isValidSigResult = (await publicClient.readContract({
    address: accountAddress,
    abi: OMAMORISAN_ACCOUNT_ABI,
    functionName: "isValidSignature",
    args: [capturedDigest, eip3009Payload.signature],
  })) as Hex;
  console.log(`isValidSignature(digest, sig) -> ${isValidSigResult}`);
  if (isValidSigResult.toLowerCase() !== "0x1626ba7e") {
    throw new Error(`isValidSignature did not return the ERC-1271 magic value, got ${isValidSigResult}`);
  }
  console.log("PASS: account's own isValidSignature accepts this authorization.");

  const randomCaller = privateKeyToAccount(generatePrivateKey());
  try {
    await publicClient.simulateContract({
      account: randomCaller.address,
      address: USDC_SEPOLIA_ADDRESS,
      abi: USDC_ABI,
      functionName: "transferWithAuthorization",
      args: [
        accountAddress,
        eip3009Payload.authorization.to,
        BigInt(eip3009Payload.authorization.value),
        BigInt(eip3009Payload.authorization.validAfter),
        BigInt(eip3009Payload.authorization.validBefore),
        eip3009Payload.authorization.nonce,
        eip3009Payload.signature,
      ],
    });
    console.log("PASS: USDC.transferWithAuthorization(...,bytes) simulates successfully from a random EOA caller.");
  } catch (error) {
    console.error("FAIL: local simulateContract of transferWithAuthorization reverted:", error);
    throw error;
  }

  console.log("\n=== 6. Retry the store with PAYMENT-SIGNATURE (this is the real facilitator call) ===");
  const merchantBalanceBefore = (await publicClient.readContract({
    address: USDC_SEPOLIA_ADDRESS,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [merchantAddress],
  })) as bigint;
  const accountBalanceBefore = accountBalance;

  const settleResponse = await fetch(rehearsalUrl, {
    headers: { "PAYMENT-SIGNATURE": paymentSignatureHeader },
  });
  const settleBodyText = await settleResponse.text();

  if (settleResponse.status !== 200) {
    console.error(`\nFAIL: store/facilitator rejected the payment. HTTP ${settleResponse.status}`);
    console.error("response headers:", Object.fromEntries(settleResponse.headers.entries()));
    console.error("response body:", settleBodyText);
    explainFacilitatorFailure(settleBodyText);
    process.exitCode = 1;
    return;
  }

  console.log("store response body:", settleBodyText);
  const paymentResponseHeader = settleResponse.headers.get("PAYMENT-RESPONSE");
  if (!paymentResponseHeader) throw new Error("200 response but missing PAYMENT-RESPONSE header");
  const settlement = decodePaymentResponseHeader(paymentResponseHeader);
  console.log("decoded PAYMENT-RESPONSE:", settlement);
  console.log(`settlement tx: ${basescanTx(settlement.transaction)}`);

  console.log("\n=== 7. Verify on-chain balances moved as expected ===");
  // The facilitator broadcast+mined this, not our own walletClient — wait for
  // our RPC endpoint to agree the tx landed before trusting balance reads.
  await publicClient.waitForTransactionReceipt({ hash: settlement.transaction as Hex });
  const expectedAmount = BigInt(requirements.amount);
  const readBalances = () =>
    Promise.all([
      publicClient.readContract({
        address: USDC_SEPOLIA_ADDRESS,
        abi: USDC_ABI,
        functionName: "balanceOf",
        args: [accountAddress],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: USDC_SEPOLIA_ADDRESS,
        abi: USDC_ABI,
        functionName: "balanceOf",
        args: [merchantAddress],
      }) as Promise<bigint>,
    ]);
  const [accountBalanceAfter, merchantBalanceAfter] = await pollUntil(
    readBalances,
    ([acctAfter, merchAfter]) =>
      accountBalanceBefore - acctAfter === expectedAmount && merchAfter - merchantBalanceBefore === expectedAmount,
  );
  const accountDelta = accountBalanceBefore - accountBalanceAfter;
  const merchantDelta = merchantBalanceAfter - merchantBalanceBefore;
  console.log(`account USDC: ${formatUnits(accountBalanceBefore, USDC_DECIMALS)} -> ${formatUnits(accountBalanceAfter, USDC_DECIMALS)} (delta -${formatUnits(accountDelta, USDC_DECIMALS)})`);
  console.log(`merchant USDC: ${formatUnits(merchantBalanceBefore, USDC_DECIMALS)} -> ${formatUnits(merchantBalanceAfter, USDC_DECIMALS)} (delta +${formatUnits(merchantDelta, USDC_DECIMALS)})`);

  if (accountDelta !== BigInt(requirements.amount) || merchantDelta !== BigInt(requirements.amount)) {
    throw new Error(
      `balance deltas don't match the expected amount ${requirements.amount}: account -${accountDelta}, merchant +${merchantDelta}`,
    );
  }

  console.log("\nPASS: the public x402 facilitator settled a payment whose payer was our OmamorisanAccount smart contract.");
}

/**
 * Best-effort root-cause hints for a facilitator rejection, based on reading
 * @x402/evm's reference facilitator implementation
 * (node_modules/.../@x402/evm/dist/esm/exact/facilitator/index.mjs — same
 * package version this script's client side uses) rather than guessing. The
 * hosted x402.org facilitator may or may not run exactly this code, so these
 * are hypotheses to check next, not a diagnosis.
 */
function explainFacilitatorFailure(bodyText: string): void {
  console.error("\n--- possible root causes (from reading @x402/evm's reference facilitator) ---");
  const body = bodyText.toLowerCase();
  const hints: Array<[substrings: string[], explanation: string]> = [
    [
      ["invalidsignature", "invalid signature"],
      "verifyEIP3009 -> verifyTypedDataSignature -> verifyERC1271 calls " +
        "signer.readContract({ isValidSignature(hash, signature) }) on the payer address and requires the " +
        "0x1626ba7e magic value. If the facilitator's own RPC/node returns something else than our local " +
        "eth_call did (different block, different RPC provider), or it hashes the domain differently " +
        "(e.g. doesn't read name/version from requirements.extra), this fires even though our local check passed.",
    ],
    [
      ["missingeip712domain", "eip-712 domain"],
      "requirements.extra.name/version were missing when the facilitator verified — check that the store's " +
        "402 declared extra:{name,version} (it does, confirmed via curl above) and that nothing strips it in transit.",
    ],
    [
      ["recipientmismatch"],
      "authorization.to didn't match requirements.payTo bit-for-bit (case/checksum) at verification time.",
    ],
    [
      ["validbeforeexpired", "validafterinfuture"],
      "the signed validBefore/validAfter window (set from maxTimeoutSeconds=60 by the SDK) expired before the " +
        "facilitator verified — a slow deposit tx or network round-trip before this retry could do it.",
    ],
    [
      ["authorizationvaluemismatch"],
      "authorization.value didn't equal requirements.amount exactly.",
    ],
    [
      ["factorynotallowed"],
      "the facilitator treated our signature as ERC-6492 (counterfactual/undeployed-account) rather than a " +
        "plain signature for an already-deployed contract — shouldn't happen since we deploy before paying, " +
        "but would mean the facilitator's own getCode() call disagrees with ours (different RPC/finality).",
    ],
    [
      ["v, r, s", "signature length", "invalid arraylen", "invalid signature length"],
      "the facilitator assumed a 65-byte ECDSA (v,r,s) signature and rejected our longer ABI-encoded blob — " +
        "this is exactly the risk this WU exists to rule out. @x402/evm's own executeTransferWithAuthorization " +
        "already branches on signature length (130 hex chars = ECDSA vs anything else = bytes overload), so if " +
        "the hosted facilitator does NOT do the same branching, this is the real incompatibility to report.",
    ],
    [
      ["transactionfailed", "execution reverted"],
      "the on-chain transferWithAuthorization call itself reverted at settlement time even though our local " +
        "simulateContract (step 5, from a different caller) passed — check paused/perPaymentLimit/recipients " +
        "didn't change between steps 5 and 6, and that USDC's own authorizationState(account, nonce) wasn't " +
        "already used.",
    ],
  ];
  let matched = false;
  for (const [needles, explanation] of hints) {
    if (needles.some((needle) => body.includes(needle))) {
      matched = true;
      console.error(`- ${explanation}`);
    }
  }
  if (!matched) {
    console.error(
      "- no known error string matched; re-read exact/facilitator/index.mjs's verifyEIP3009/settleEIP3009 " +
        "(same node_modules path as above) against the raw response body printed above, and check " +
        "docs.x402.org for facilitator-specific behavior not covered by the local reference package.",
    );
  }
}

main().catch((err) => {
  console.error("\naccount-payment-check FAILED:", err);
  process.exitCode = 1;
});
