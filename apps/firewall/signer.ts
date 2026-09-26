// Everything that touches the firewall's private key: verifying a user's
// signed TaskIntent (read-only, no key needed) and producing the firewall's
// own x402 payment signature (docs/research/ref-x402.md §2, §5-6).

import {
  createPublicClient,
  formatUnits,
  getAddress,
  hashTypedData,
  http,
  type Address,
  type HashTypedDataParameters,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { appendPaymentIdentifierToExtensions } from "@x402/extensions/payment-identifier";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import {
  TASK_INTENT_DOMAIN,
  TASK_INTENT_TYPES,
  USDC_DECIMALS,
  USDC_SEPOLIA_ADDRESS,
  X402_NETWORK,
  computeTransferWithAuthorizationDigest,
  encodeAccountSignature,
  type TaskIntentMessage,
} from "@yakusoku/shared";
import type { ResolvedPayer } from "./payer";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name} — set it in .env.hackathon`);
  }
  return value;
}

const account = privateKeyToAccount(requireEnv("FIREWALL_PRIVATE_KEY") as Hex);

/** Exported so account-setup.ts (P11.3a) can send the `createAccount` deploy
 * transaction from the SAME key that is every deployed account's `operator`
 * (root CLAUDE.md's funding model) — one firewall key, one meaning, never a
 * second env var to keep in sync with this one. */
export const operatorAccount = account;

// Exported so siwe.ts can reuse the same RPC-backed client for
// `verifySiweMessage` (also ERC-6492-aware) instead of standing up a second one.
export const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL),
});

/** Verifies a user-signed TaskIntent's EIP-712 signature (ref-wagmi-viem.md §5). */
export async function verifyTaskIntentSignature(
  message: TaskIntentMessage,
  signature: Hex,
  signer: Hex,
): Promise<boolean> {
  return publicClient.verifyTypedData({
    address: signer,
    domain: TASK_INTENT_DOMAIN,
    types: TASK_INTENT_TYPES,
    primaryType: "TaskIntent",
    message,
    signature,
  });
}

// --- P11.2: signing as an OmamorisanAccount smart-account payer -------------
//
// The digest x402's SDK asks us to sign for the "exact" EVM scheme is
// EIP-3009's `TransferWithAuthorization` — literally USDC's own EIP-712
// struct, not some `OmamorisanAccount`-specific domain
// (`OmamorisanAccount.sol`: `domainSeparator`/`transferWithAuthorizationTypehash`
// are cached at construction from `IFiatTokenEIP3009(token).DOMAIN_SEPARATOR()`/
// `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` — i.e. identical to reading them
// straight off the token). Reading them from USDC directly (always deployed,
// real, permanent on Base Sepolia) rather than from the smart account itself
// means this works even for a *predicted-but-undeployed* account address
// (the stub deployer's addresses, account-setup.ts) — the signature just
// can't be verified on-chain (`isValidSignature`) until the account is
// actually deployed, exactly as expected.
//
// Proven live end-to-end against a REALLY deployed account and the public
// x402.org facilitator in P11.1 (`scripts/account-payment-check.ts`, commit
// `88b121e`) — this is the same signer adapter, reused exactly: intercept
// `signTypedData`, cross-check the SDK's own digest against
// `computeTransferWithAuthorizationDigest`, sign the raw digest with the
// firewall's operator key (never `signMessage`/`signTypedData` — see
// `computeTransferWithAuthorizationDigest`'s doc comment,
// packages/shared/omamorisan-account.ts), and return the account's
// ERC-1271-decodable signature blob instead of a plain ECDSA signature.

const USDC_EIP3009_DOMAIN_ABI = [
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "TRANSFER_WITH_AUTHORIZATION_TYPEHASH", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;

async function readUsdcEip3009Domain(): Promise<{ domainSeparator: Hex; transferWithAuthorizationTypehash: Hex }> {
  const [domainSeparator, transferWithAuthorizationTypehash] = await Promise.all([
    publicClient.readContract({ address: USDC_SEPOLIA_ADDRESS, abi: USDC_EIP3009_DOMAIN_ABI, functionName: "DOMAIN_SEPARATOR" }),
    publicClient.readContract({
      address: USDC_SEPOLIA_ADDRESS,
      abi: USDC_EIP3009_DOMAIN_ABI,
      functionName: "TRANSFER_WITH_AUTHORIZATION_TYPEHASH",
    }),
  ]);
  return { domainSeparator: domainSeparator as Hex, transferWithAuthorizationTypehash: transferWithAuthorizationTypehash as Hex };
}

async function buildAccountSigner(accountAddress: Address): Promise<ClientEvmSigner> {
  const { domainSeparator, transferWithAuthorizationTypehash } = await readUsdcEip3009Domain();
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
        throw new Error(`x402 SDK asked to sign for ${from}, expected the account payer ${accountAddress}`);
      }

      const sdkDigest = hashTypedData({ domain, types, primaryType, message } as unknown as HashTypedDataParameters);
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
        throw new Error(`digest mismatch signing for account ${accountAddress}: SDK computed ${sdkDigest}, local computed ${localDigest}`);
      }

      const operatorSig = await account.sign({ hash: sdkDigest });
      return encodeAccountSignature({ to, value, validAfter, validBefore, nonce, operatorSig });
    },
  };
  return toClientEvmSigner(baseSigner, publicClient);
}

export interface SignParams {
  paymentRequired: PaymentRequired;
  /** Intent's total authorized budget (atomic USDC units) — the spendControls ceiling. */
  maxBudgetAtomic: bigint;
  paymentIdentifier: string;
  /** P11.2 — who signs/pays: the firewall's own operator key (legacy wallet
   * mandates), or a world_id account's `OmamorisanAccount` smart account
   * (payer.ts's `resolvePayer`). Required so the firewall EOA can never be
   * used, even accidentally, as payer for an account promise. */
  payer: ResolvedPayer;
}

export interface SignOutcome {
  paymentPayload: PaymentPayload;
  paymentSignatureHeader: string;
}

/**
 * Creates the signed x402 payment payload for one payment, signed by
 * `payer`. A fresh `x402Client` is built per call so the spend cap and the
 * payment-identifier hook are scoped to this exact request
 * (ref-x402.md §2.1-2.4) — `fromConfig` does no network I/O, so this is
 * cheap. `onBeforePaymentCreation` doubles as the last fail-closed guard
 * before a signature is ever produced, on top of the pipeline's own policy
 * and funding stages (pipeline.ts, funding.ts).
 */
export async function signPayment({
  paymentRequired,
  maxBudgetAtomic,
  paymentIdentifier,
  payer,
}: SignParams): Promise<SignOutcome> {
  const evmSigner = payer.kind === "smart_account" ? await buildAccountSigner(payer.address) : account;
  const guardian = x402Client
    .fromConfig({
      schemes: [{ network: X402_NETWORK, client: new ExactEvmScheme(evmSigner) }],
      // Never rely on the SDK's silent $1 default (ref-x402.md §5.5) — cap
      // every payment at the intent's total authorized budget.
      spendControls: { maxAmountPerPayment: `$${formatUnits(maxBudgetAtomic, USDC_DECIMALS)}` },
    })
    .onBeforePaymentCreation(async ({ paymentRequired: pr, selectedRequirements }) => {
      if (selectedRequirements.network !== X402_NETWORK) {
        return { abort: true, reason: `unexpected network at signing time: ${selectedRequirements.network}` };
      }
      const amount = BigInt(selectedRequirements.amount);
      if (amount > maxBudgetAtomic) {
        return { abort: true, reason: `amount ${amount} exceeds the intent's total budget ${maxBudgetAtomic}` };
      }
      if (pr.extensions) {
        appendPaymentIdentifierToExtensions(pr.extensions, paymentIdentifier);
      }
      return undefined;
    });

  const paymentPayload = await guardian.createPaymentPayload(paymentRequired);
  return { paymentPayload, paymentSignatureHeader: encodePaymentSignatureHeader(paymentPayload) };
}
