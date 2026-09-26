// Account setup (P11.3a, root CLAUDE.md's funding model) — links a human's
// own wallet as the owner of their Omamorisan account and deploys the
// per-user `OmamorisanAccount` smart account that becomes their x402 payer.
//
// Flow: `POST /accounts/setup-link` (index.ts, account-key auth) mints a
// high-entropy setup token and a `${OMAMORISAN_SITE_URL}/setup?token=...`
// link; the site reads `GET /setup/:token` (the token IS the credential — no
// further auth) to show what will be deployed, has the owner sign a plain
// text message with their own wallet (EOA or ERC-1271 smart wallet, both work
// via `publicClient.verifyMessage`'s ERC-6492 support), and posts it to
// `POST /setup/:token/owner`, which verifies the signature and deploys via
// `OmamorisanAccountFactory.createAccount` from the firewall's OWN key
// (`operatorAccount`, signer.ts) — the account's owner is always the
// caller-supplied `owner` argument, never the deployer, so this never grants
// the firewall any control (see OmamorisanAccountFactory.sol's own NatSpec).
//
// Fail-closed: a bad signature never deploys anything (401); an RPC/deploy
// error persists nothing (500) rather than a half-created account. Already
// deployed -> idempotent replay, no second transaction, no signature
// re-check (the account is already exactly what it should be).

import { createWalletClient, formatUnits, getAddress, http, keccak256, toHex, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHAIN_ID,
  OMAMORISAN_ACCOUNT_ABI,
  OMAMORISAN_ACCOUNT_FACTORY_ABI,
  OMAMORISAN_ACCOUNT_FACTORY_ADDRESS,
  USDC_DECIMALS,
  USDC_SEPOLIA_ADDRESS,
} from "@yakusoku/shared";
import { generateSetupToken, hashSetupToken } from "./auth";
import { operatorAccount, publicClient } from "./signer";
import {
  createSetupToken as persistSetupToken,
  getAccount,
  getSetupToken,
  setAccountDeployment,
  type AccountRecipient,
  type StoredAccount,
} from "./store";

const SETUP_TOKEN_TTL_MS = 30 * 60_000;
const DEFAULT_PER_PAYMENT_LIMIT_USDC = 25;

function siteUrl(): string {
  return process.env.OMAMORISAN_SITE_URL ?? "http://localhost:4321";
}

function perPaymentLimitDefaultUsdc(): number {
  const raw = Number(process.env.OMAMORISAN_DEFAULT_PER_PAYMENT_LIMIT_USDC);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PER_PAYMENT_LIMIT_USDC;
}

/** Atomic USDC units for {@link perPaymentLimitDefaultUsdc} — the exact value
 * a fresh deploy uses when the account has no `perPaymentLimitAtomic` of its
 * own yet, and the round-trip source for the `perPaymentLimitUsdc` decimal
 * STRING every API response reports (site contract: `perPaymentLimitUsdc`/
 * `balanceUsdc` are decimal strings, e.g. `"25"`/`"0.5"`, never atomic units
 * or a float). */
function perPaymentLimitDefaultAtomic(): bigint {
  return BigInt(Math.round(perPaymentLimitDefaultUsdc() * 10 ** USDC_DECIMALS));
}

/** Mirrors apps/store/index.ts's `resolveMerchantAddress` for the gift-card
 * store — the demo store's OWN payTo resolution — so the default recipient
 * allow-list actually points at the store an agent will be buying from,
 * without a build-time dependency between the two apps (each is its own bun
 * workspace package). Returns `undefined` (never throws) when neither env var
 * is set: unlike the store, a firewall with no merchant configured yet is a
 * normal boot state, not a fatal one — `defaultRecipients` below just leaves
 * the gift-card store out of the default list and warns once. */
function resolveDefaultMerchantAddress(): `0x${string}` | undefined {
  const override = process.env.MERCHANT_ADDRESS;
  if (override) return override as `0x${string}`;
  const key = process.env.MERCHANT_KEY;
  if (!key) return undefined;
  try {
    return privateKeyToAccount(key as Hex).address;
  } catch {
    return undefined;
  }
}

// Local-dev fallback payTo addresses for the Data & APIs and Cloud Credits
// stores (odd/tasks/multi-store.md's "Stores" table) — mirrors
// apps/store/catalog.ts's own fallback constants for the same two stores.
// Unlike the gift-card store, these two always resolve to SOME address, so a
// fresh account's default recipient list always includes all three demo
// stores even with no env configured at all.
const DEFAULT_MERCHANT_ADDRESS_DATA = "0xbDc31ea7520D358c3932600499e546385E649394" as const;
const DEFAULT_MERCHANT_ADDRESS_CLOUD = "0xAbDCC40aFf5772F32A54C452D68E1F23A128e173" as const;

function resolveDataMerchantAddress(): `0x${string}` {
  return (process.env.MERCHANT_ADDRESS_DATA as `0x${string}` | undefined) ?? DEFAULT_MERCHANT_ADDRESS_DATA;
}

function resolveCloudMerchantAddress(): `0x${string}` {
  return (process.env.MERCHANT_ADDRESS_CLOUD as `0x${string}` | undefined) ?? DEFAULT_MERCHANT_ADDRESS_CLOUD;
}

let warnedNoGiftCardDefault = false;

/** `OMAMORISAN_DEFAULT_RECIPIENTS` (JSON `[{address,label}]`) if set and
 * well-formed; otherwise the three demo stores: the gift-card store's own
 * merchant address (see `resolveDefaultMerchantAddress`) when configured,
 * plus the Data & APIs and Cloud Credits stores (always present, via their
 * own env override or local-dev fallback) — so local dev and a freshly
 * created account both get all three stores by default (odd/tasks/multi-store.md).
 * Never throws: a gift-card store left unconfigured is simply left out,
 * warned once, rather than emptying the whole list. */
function defaultRecipients(): AccountRecipient[] {
  const raw = process.env.OMAMORISAN_DEFAULT_RECIPIENTS;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((r) => r && typeof r === "object" && typeof (r as { address?: unknown }).address === "string")) {
        return (parsed as { address: string; label?: string }[]).map((r) => ({
          address: getAddress(r.address),
          label: r.label ?? r.address,
        }));
      }
      console.warn(
        "[account-setup] OMAMORISAN_DEFAULT_RECIPIENTS is set but is not a valid [{address,label}] JSON array — falling back to the demo store defaults",
      );
    } catch {
      console.warn("[account-setup] OMAMORISAN_DEFAULT_RECIPIENTS is set but is not valid JSON — falling back to the demo store defaults");
    }
  }
  const recipients: AccountRecipient[] = [];
  const giftCardMerchant = resolveDefaultMerchantAddress();
  if (giftCardMerchant) {
    recipients.push({ address: giftCardMerchant, label: "Gift Cards store" });
  } else if (!warnedNoGiftCardDefault) {
    warnedNoGiftCardDefault = true;
    console.warn(
      "[account-setup] neither MERCHANT_ADDRESS nor MERCHANT_KEY is set — the default recipient list will not include the gift-card store",
    );
  }
  recipients.push({ address: resolveDataMerchantAddress(), label: "Data & APIs store" });
  recipients.push({ address: resolveCloudMerchantAddress(), label: "Cloud Credits store" });
  return recipients;
}

// --- On-chain reads/writes ----------------------------------------------------

const ERC20_BALANCE_OF_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

async function readUsdcBalanceAtomic(address: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: USDC_SEPOLIA_ADDRESS,
    abi: ERC20_BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [address],
  });
}

export interface DeployAccountParams {
  owner: `0x${string}`;
  operator: `0x${string}`;
  perPaymentLimitAtomic: bigint;
  recipients: `0x${string}`[];
  salt: `0x${string}`;
}

export interface DeployAccountResult {
  smartAccount: `0x${string}`;
  /** `undefined` for the `stub` deployer — no transaction was ever sent. */
  txHash?: `0x${string}`;
}

export interface AccountDeployer {
  deploy(params: DeployAccountParams): Promise<DeployAccountResult>;
}

async function predictAccountAddress(params: DeployAccountParams): Promise<`0x${string}`> {
  return publicClient.readContract({
    address: OMAMORISAN_ACCOUNT_FACTORY_ADDRESS,
    abi: OMAMORISAN_ACCOUNT_FACTORY_ABI,
    functionName: "predictAddress",
    args: [params.owner, params.operator, params.perPaymentLimitAtomic, params.recipients, params.salt],
  });
}

/** Sends a real `createAccount` transaction, paid by the firewall's own
 * operator EOA (root CLAUDE.md: "will be the x402 payer; ... operator = the
 * firewall EOA"). The deployed address is re-derived via `predictAddress`
 * (CREATE2 is deterministic in the arguments+salt alone) rather than parsed
 * out of the receipt's logs — simpler, and just as trustworthy once the
 * receipt's own `status` is confirmed `success`. */
const realDeployer: AccountDeployer = {
  async deploy(params) {
    const walletClient = createWalletClient({
      account: operatorAccount,
      chain: baseSepolia,
      transport: http(process.env.BASE_SEPOLIA_RPC_URL),
    });
    const hash = await walletClient.writeContract({
      address: OMAMORISAN_ACCOUNT_FACTORY_ADDRESS,
      abi: OMAMORISAN_ACCOUNT_FACTORY_ABI,
      functionName: "createAccount",
      args: [params.owner, params.operator, params.perPaymentLimitAtomic, params.recipients, params.salt],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`createAccount transaction ${hash} did not succeed (status: ${receipt.status})`);
    }
    const smartAccount = await predictAccountAddress(params);
    return { smartAccount, txHash: hash };
  },
};

/** Never sends a transaction — reads the factory's own `predictAddress` view
 * function for the exact address `createAccount` WOULD deploy to. Selected
 * via `OMAMORISAN_ACCOUNT_DEPLOYER=stub` so unit tests/scenarios never spend
 * gas (root CLAUDE.md's "injectable deployer" requirement). */
const stubDeployer: AccountDeployer = {
  async deploy(params) {
    const smartAccount = await predictAccountAddress(params);
    return { smartAccount, txHash: undefined };
  },
};

export function getAccountDeployer(): AccountDeployer {
  return process.env.OMAMORISAN_ACCOUNT_DEPLOYER === "stub" ? stubDeployer : realDeployer;
}

// --- Setup message -------------------------------------------------------------

/** The exact text `GET /setup/:token` hands back, `{owner}` left as a literal
 * placeholder (root API contract) for the client to fill with the
 * checksummed address it's about to sign with — this lets the site show the
 * message BEFORE the owner has picked/connected a wallet. */
export function setupMessageTemplate(accountId: string, token: string): string {
  return `Omamorisan: link wallet {owner} as the owner of account ${accountId}. Token: ${token}`;
}

export function fillSetupMessage(template: string, owner: `0x${string}`): string {
  return template.replace("{owner}", getAddress(owner));
}

// --- POST /accounts/setup-link ------------------------------------------------

export interface SetupLinkResult {
  setupUrl: string;
  token: string;
  expiresAt: string;
}

/** Mints a FRESH token every call — cheap, and simpler than making the
 * account's setup link itself idempotent; an old, unused token is simply
 * abandoned (still valid until its own 30-minute TTL, just never shown to
 * the human again). */
export function createSetupLink(accountId: string): SetupLinkResult {
  const token = generateSetupToken();
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_TTL_MS).toISOString();
  persistSetupToken(hashSetupToken(token), accountId, expiresAt);
  return { setupUrl: `${siteUrl()}/setup?token=${token}`, token, expiresAt };
}

// --- Shared account-deployment description (GET /setup/:token, GET /account) -

export interface SetupRecipientDto {
  address: string;
  label: string;
}

export interface AccountDeploymentInfo {
  /** Decimal USDC string (e.g. `"25"`) — never atomic units, never a float. */
  perPaymentLimitUsdc: string;
  recipients: SetupRecipientDto[];
  smartAccount?: `0x${string}`;
  owner?: `0x${string}`;
  /** Decimal USDC string, same convention as `perPaymentLimitUsdc`. */
  balanceUsdc?: string;
}

/**
 * Describes an account's smart-account configuration, whether deployed yet
 * or not — the single source of truth `GET /setup/:token` and `GET /account`
 * (index.ts) both build their responses from, so the two routes can never
 * report different numbers for the same account. Before deployment, shows
 * what WOULD be deployed (live env defaults); after, shows exactly what WAS
 * deployed (frozen on the account row by `setAccountDeployment`).
 */
export async function describeAccountDeployment(account: StoredAccount): Promise<AccountDeploymentInfo> {
  if (account.smartAccount && account.owner) {
    const balanceAtomic = await readUsdcBalanceAtomic(account.smartAccount);
    return {
      perPaymentLimitUsdc: formatUnits(account.perPaymentLimitAtomic ?? perPaymentLimitDefaultAtomic(), USDC_DECIMALS),
      recipients: (account.recipients ?? defaultRecipients()).map((r) => ({ address: r.address, label: r.label })),
      smartAccount: account.smartAccount,
      owner: account.owner,
      balanceUsdc: formatUnits(balanceAtomic, USDC_DECIMALS),
    };
  }
  return {
    perPaymentLimitUsdc: formatUnits(perPaymentLimitDefaultAtomic(), USDC_DECIMALS),
    recipients: defaultRecipients().map((r) => ({ address: r.address, label: r.label })),
  };
}

// --- Known merchants (multi-store M2) ------------------------------------------
// `GET /setup/:token`'s `knownMerchants` list: the demo stores this
// deployment knows about (`defaultRecipients()` — the config-level canonical
// list, NOT `account.recipients`, so a store added after this account was
// deployed still shows up here for the owner to register), each annotated
// with whether the account's OWN on-chain recipient allow-list currently
// accepts it. Lets `/setup`'s "Registered merchants" card offer a "Register"
// button for a known store the account hasn't been given yet.

export interface KnownMerchantDto {
  address: `0x${string}`;
  label: string;
  /** `true`/`false` from a live on-chain read of `recipients(address)`;
   * `null` when there's nothing to read yet (not deployed) or the read
   * itself failed — never asserted `true` on a doubtful read. */
  registered: boolean | null;
}

export interface MerchantRegistrationReadParams {
  smartAccount: Address;
  merchant: Address;
  /** Only the stub reader uses this, to look up the account's own recorded
   * recipients (same shape as funding.ts's `AccountHealthReader`). */
  accountId: string;
}

export interface MerchantRegistrationReader {
  isRegistered(params: MerchantRegistrationReadParams): Promise<boolean | null>;
}

/** Real reader: a live `recipients(address)` view call against the deployed
 * `OmamorisanAccount` (same ABI/`publicClient` funding.ts's `AccountHealthReader`
 * already uses for the same view function). A failed read — no code at that
 * address, a flaky RPC, anything — reports `null`, never a wrong `true`. */
const realMerchantRegistrationReader: MerchantRegistrationReader = {
  async isRegistered({ smartAccount, merchant }) {
    try {
      return await publicClient.readContract({
        address: smartAccount,
        abi: OMAMORISAN_ACCOUNT_ABI,
        functionName: "recipients",
        args: [merchant],
      });
    } catch {
      return null;
    }
  },
};

/** Stub reader (`OMAMORISAN_ACCOUNT_READER=stub` — the same dev seam
 * funding.ts's `AccountHealthReader` uses, since both read the same kind of
 * on-chain smart-account state): never touches the chain, simulates
 * "registered" as membership in this account's own recorded `recipients`
 * (`StoredAccount.recipients`) — a real simulation of on-chain state for an
 * account whose stub deploy never sent a transaction that could change it. */
const stubMerchantRegistrationReader: MerchantRegistrationReader = {
  async isRegistered({ accountId, merchant }) {
    const account = getAccount(accountId);
    return (account?.recipients ?? []).some((r) => r.address.toLowerCase() === merchant.toLowerCase());
  },
};

export function getMerchantRegistrationReader(): MerchantRegistrationReader {
  return process.env.OMAMORISAN_ACCOUNT_READER === "stub" ? stubMerchantRegistrationReader : realMerchantRegistrationReader;
}

/** Builds `knownMerchants` for `GET /setup/:token`. Before deployment there's
 * no smart account to read `recipients(address)` from at all, so every entry
 * reports `registered: null` (never a guessed `false`) rather than skipping
 * the list. */
export async function getKnownMerchants(account: StoredAccount): Promise<KnownMerchantDto[]> {
  const merchants = defaultRecipients();
  if (!account.smartAccount) {
    return merchants.map((m) => ({ address: m.address, label: m.label, registered: null }));
  }
  const smartAccount = account.smartAccount;
  const reader = getMerchantRegistrationReader();
  return Promise.all(
    merchants.map(async (m) => ({
      address: m.address,
      label: m.label,
      registered: await reader.isRegistered({ smartAccount, merchant: m.address, accountId: account.id }),
    })),
  );
}

// --- GET /setup/:token ---------------------------------------------------------

interface SetupStatusCommon {
  accountId: string;
  chainId: number;
  usdc: string;
  factory: string;
  operator: string;
  /** Decimal USDC string — see {@link AccountDeploymentInfo}. */
  perPaymentLimitUsdc: string;
  /** Kept for compatibility — this account's OWN recorded (or, pre-deploy,
   * would-be) recipients. See {@link KnownMerchantDto}/`knownMerchants` for
   * the config-level list with live on-chain registration status. */
  recipients: SetupRecipientDto[];
  /** Every demo store this deployment knows about, each with its live
   * on-chain registration status against THIS account. */
  knownMerchants: KnownMerchantDto[];
  message: string;
  /** ISO 8601 — the setup token's own expiry. */
  expiresAt: string;
}

export type SetupStatusOutcome =
  | { ok: false }
  | ({ ok: true; status: "needs_owner" } & SetupStatusCommon)
  | ({ ok: true; status: "deployed"; smartAccount: `0x${string}`; owner: `0x${string}`; balanceUsdc: string } & SetupStatusCommon);

/** `undefined`/`{ok:false}` for an unknown token OR one that expired before
 * ever being used to deploy — the same "never confirm which token would have
 * worked" shape every other credential lookup in this codebase uses (404,
 * never a more specific error). A token that DID lead to a deployment stays
 * valid (and keeps answering `status:"deployed"`) past its own `expiresAt` —
 * root API contract's "reusable until the account is deployed". */
export async function getSetupStatus(token: string): Promise<SetupStatusOutcome> {
  const record = getSetupToken(hashSetupToken(token));
  if (!record) return { ok: false };
  const account = getAccount(record.accountId);
  if (!account) return { ok: false }; // unreachable in practice — the token's own FK always resolves

  if (!(account.smartAccount && account.owner) && new Date(record.expiresAt).getTime() < Date.now()) {
    return { ok: false };
  }

  const message = setupMessageTemplate(account.id, token);
  const knownMerchants = await getKnownMerchants(account);
  const common = {
    accountId: account.id,
    chainId: CHAIN_ID,
    usdc: USDC_SEPOLIA_ADDRESS,
    factory: OMAMORISAN_ACCOUNT_FACTORY_ADDRESS,
    operator: operatorAccount.address,
    message,
    expiresAt: record.expiresAt,
    knownMerchants,
  };

  const deployment = await describeAccountDeployment(account);
  if (deployment.smartAccount && deployment.owner && deployment.balanceUsdc !== undefined) {
    return {
      ok: true,
      status: "deployed",
      ...common,
      perPaymentLimitUsdc: deployment.perPaymentLimitUsdc,
      recipients: deployment.recipients,
      smartAccount: deployment.smartAccount,
      owner: deployment.owner,
      balanceUsdc: deployment.balanceUsdc,
    };
  }

  return {
    ok: true,
    status: "needs_owner",
    ...common,
    perPaymentLimitUsdc: deployment.perPaymentLimitUsdc,
    recipients: deployment.recipients,
  };
}

// --- POST /setup/:token/owner --------------------------------------------------

export type LinkOwnerOutcome =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid_signature" }
  | { ok: false; reason: "deploy_failed"; message: string }
  | { ok: true; smartAccount: `0x${string}`; owner: `0x${string}`; txHash?: `0x${string}` };

/**
 * Verifies the owner's signature over the exact setup message, deploys via
 * the configured {@link AccountDeployer}, and persists the result. Already
 * deployed -> returns the existing record verbatim, no signature check, no
 * second transaction (root API contract's idempotency requirement) — checked
 * FIRST, before touching the token's expiry or the caller's signature at
 * all, so a retried/late POST after a successful deploy always succeeds.
 */
export async function linkOwner(token: string, owner: `0x${string}`, signature: `0x${string}`): Promise<LinkOwnerOutcome> {
  const record = getSetupToken(hashSetupToken(token));
  if (!record) return { ok: false, reason: "not_found" };
  const account = getAccount(record.accountId);
  if (!account) return { ok: false, reason: "not_found" };

  if (account.smartAccount && account.owner) {
    return { ok: true, smartAccount: account.smartAccount, owner: account.owner, txHash: account.deployTxHash };
  }

  if (new Date(record.expiresAt).getTime() < Date.now()) return { ok: false, reason: "not_found" };

  let checksummedOwner: `0x${string}`;
  try {
    checksummedOwner = getAddress(owner);
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }

  const message = fillSetupMessage(setupMessageTemplate(account.id, token), checksummedOwner);
  let validSignature: boolean;
  try {
    validSignature = await publicClient.verifyMessage({ address: checksummedOwner, message, signature });
  } catch (err) {
    // Fail-closed — an RPC/verification error is never treated as a valid signature.
    return { ok: false, reason: "deploy_failed", message: `signature verification failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!validSignature) return { ok: false, reason: "invalid_signature" };

  const recipients = account.recipients ?? defaultRecipients();
  const perPaymentLimitAtomic = account.perPaymentLimitAtomic ?? perPaymentLimitDefaultAtomic();
  const salt = keccak256(toHex(account.id));

  let deployed: DeployAccountResult;
  try {
    deployed = await getAccountDeployer().deploy({
      owner: checksummedOwner,
      operator: operatorAccount.address,
      perPaymentLimitAtomic,
      recipients: recipients.map((r) => r.address),
      salt,
    });
  } catch (err) {
    // Fail-closed — nothing is persisted on a failed deploy.
    return { ok: false, reason: "deploy_failed", message: err instanceof Error ? err.message : String(err) };
  }

  setAccountDeployment(account.id, {
    smartAccount: deployed.smartAccount,
    owner: checksummedOwner,
    perPaymentLimitAtomic,
    recipients,
    deployTxHash: deployed.txHash,
  });

  return { ok: true, smartAccount: deployed.smartAccount, owner: checksummedOwner, txHash: deployed.txHash };
}
