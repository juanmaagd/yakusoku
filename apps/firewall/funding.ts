// P11.2 — the funding pipeline stage. Runs right after `merchant` (before
// Intercepta/Jev/World ID, pipeline.ts's `PIPELINE_STAGES`) so those more
// expensive/human-facing stages are never spent on a payment that can't
// possibly settle: resolves the payer (payer.ts), and — for a world_id
// account's smart account only — reads (or, for
// `OMAMORISAN_ACCOUNT_READER=stub`, simulates) its own on-chain rules:
// deployed code, `paused`, the recipient allow-list, `perPaymentLimit`, and
// its USDC balance. Any doubt refuses fail-closed (plan-tecnico.md §2.4),
// never a silent pass.
//
// The legacy wallet path (payer.kind === "firewall") has no on-chain
// "account" of its own to check — the firewall EOA pays directly, exactly as
// before P11.2 — so this stage is a no-op pass for it.
//
// Every refusal here reports the `policy_rejected` receipt state, not a new
// dedicated one: it's distinguished purely by its `reason` text prefix
// (`"funding: <code>: ..."`, same pattern `checkPolicy`'s own budget/expiry/
// network/asset/revoked/paused-by-owner checks already share, pipeline.ts) —
// a new top-level `ReceiptState` would break the site's exhaustive
// `plainReason` switch (apps/site/src/lib/decisionCopy.ts), out of scope here.

import { formatUnits, getAddress, type Abi, type Address } from "viem";
import { OMAMORISAN_ACCOUNT_ABI, USDC_DECIMALS, USDC_SEPOLIA_ADDRESS } from "@yakusoku/shared";
import { resolvePayer } from "./payer";
import { publicClient } from "./signer";
import { getAccount, getAccountHealthOverride } from "./store";
import type { PipelineStage, StageContext, StageVerdict } from "./pipeline";

export { resolvePayer } from "./payer";
export type { PayerKind, PayerResolution, ResolvedPayer } from "./payer";

function timeoutMs(): number {
  const raw = Number(process.env.OMAMORISAN_FUNDING_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4_000;
}

// --- Account health reads (real vs stub, same injectable-reader shape as
// account-setup.ts's `AccountDeployer`) ---------------------------------------

export interface AccountHealthState {
  /** `false` when `smartAccount` has no code on-chain (or, for the stub
   * reader, doesn't match this account's own recorded `smartAccount`) — every
   * other field is meaningless/zeroed in that case. */
  deployed: boolean;
  paused: boolean;
  /** Whether `payTo` is in the account's on-chain recipient allow-list. */
  recipientAllowed: boolean;
  perPaymentLimitAtomic: bigint;
  balanceAtomic: bigint;
}

export interface AccountHealthReadParams {
  smartAccount: Address;
  payTo: Address;
  /** The account's own id (store.ts) — only the stub reader uses this, to
   * look up its deployed config and any test override. */
  accountId: string;
}

export interface AccountHealthReader {
  read(params: AccountHealthReadParams): Promise<AccountHealthState>;
}

const USDC_BALANCE_OF_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

/**
 * Real reader: reads the smart account's own on-chain rules directly.
 * `paused`/`recipients`/`perPaymentLimit` are the account's own current
 * (owner-mutable) state, not just what it was deployed with — an owner
 * calling `setPaused`/`setRecipient`/`setPerPaymentLimit` on-chain must be
 * reflected here, unlike `StoredAccount`'s "what it was deployed with" record
 * (account-setup.ts). Retries transient RPC failures a couple of times
 * (public Base Sepolia RPC lag/hiccups, same class of issue
 * `scripts/account-payment-check.ts` documents) before giving up — a
 * persistent failure surfaces as a thrown error, which `fundingStage` below
 * turns into a fail-closed refuse, never a pass.
 */
const REAL_READ_RETRIES = 2;
const REAL_READ_RETRY_DELAY_MS = 400;

async function withFundingRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= REAL_READ_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < REAL_READ_RETRIES) await new Promise((resolve) => setTimeout(resolve, REAL_READ_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

/** Bounds the whole read (including its retries) to a short ceiling — an RPC
 * that hangs rather than erroring must still refuse fail-closed in bounded
 * time, not stall `/sign` indefinitely. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`funding read timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const realReader: AccountHealthReader = {
  read({ smartAccount, payTo }) {
    return withTimeout(
      withFundingRetry(async () => {
        const code = await publicClient.getCode({ address: smartAccount });
        const deployed = Boolean(code) && code !== "0x";
        if (!deployed) {
          return { deployed: false, paused: false, recipientAllowed: false, perPaymentLimitAtomic: 0n, balanceAtomic: 0n };
        }
        const [paused, recipientAllowed, perPaymentLimitAtomic, balanceAtomic] = await Promise.all([
          publicClient.readContract({ address: smartAccount, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "paused" }),
          publicClient.readContract({ address: smartAccount, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "recipients", args: [payTo] }),
          publicClient.readContract({ address: smartAccount, abi: OMAMORISAN_ACCOUNT_ABI, functionName: "perPaymentLimit" }),
          publicClient.readContract({ address: USDC_SEPOLIA_ADDRESS, abi: USDC_BALANCE_OF_ABI, functionName: "balanceOf", args: [smartAccount] }),
        ]);
        return {
          deployed: true,
          paused: paused as boolean,
          recipientAllowed: recipientAllowed as boolean,
          perPaymentLimitAtomic: perPaymentLimitAtomic as bigint,
          balanceAtomic: balanceAtomic as bigint,
        };
      }),
      timeoutMs(),
    );
  },
};

/** Generous default so a freshly stub-deployed account "just works" in a
 * scenario unless it explicitly overrides `balanceAtomic` (store.ts's
 * `setAccountHealthOverride` / the dev-only `POST /dev/accounts/:id/health`
 * route, index.ts) to test `insufficient_funds`. */
const DEFAULT_STUB_BALANCE_ATOMIC = 1_000_000_000n; // 1000 USDC

/**
 * Stub reader (`OMAMORISAN_ACCOUNT_READER=stub`): never touches the chain.
 * `recipientAllowed`/`perPaymentLimitAtomic` default to whatever this account
 * was actually (stub-)deployed with (`StoredAccount.recipients`/
 * `perPaymentLimitAtomic`, account-setup.ts) — a real simulation of on-chain
 * state for an account that was never really deployed, since the stub
 * deployer never sends a transaction that could change them. `paused`
 * defaults to `false` and `balanceAtomic` to a generous default; a scenario
 * overrides any of the four via `setAccountHealthOverride`/`POST
 * /dev/accounts/:id/health` to test a specific refusal deterministically.
 */
const stubReader: AccountHealthReader = {
  async read({ smartAccount, payTo, accountId }) {
    const account = getAccount(accountId);
    const override = getAccountHealthOverride(accountId);
    const smartAccountOnFile = account?.smartAccount;
    const deployed = smartAccountOnFile !== undefined && getAddress(smartAccountOnFile) === getAddress(smartAccount);
    const deployedRecipientAllowed = (account?.recipients ?? []).some((r) => r.address.toLowerCase() === payTo.toLowerCase());
    return {
      deployed,
      paused: override?.paused ?? false,
      recipientAllowed: override?.recipientAllowed ?? deployedRecipientAllowed,
      perPaymentLimitAtomic: override?.perPaymentLimitAtomic ?? account?.perPaymentLimitAtomic ?? 0n,
      balanceAtomic: override?.balanceAtomic ?? DEFAULT_STUB_BALANCE_ATOMIC,
    };
  },
};

export function getAccountHealthReader(): AccountHealthReader {
  return process.env.OMAMORISAN_ACCOUNT_READER === "stub" ? stubReader : realReader;
}

// --- Pipeline wiring ----------------------------------------------------------

export type FundingCheckReason =
  | "account_not_set_up"
  | "not_deployed"
  | "paused"
  | "recipient_not_registered"
  | "over_account_limit"
  | "insufficient_funds"
  | "funding_check_failed";

export const fundingStage: PipelineStage = {
  name: "funding",
  async run(ctx: StageContext): Promise<StageVerdict> {
    const resolution = resolvePayer(ctx.intent);
    if (!resolution.ok) {
      return { outcome: "refuse", state: "policy_rejected", reason: `account_not_set_up: ${resolution.detail}` };
    }
    const payer = resolution.payer;
    if (payer.kind === "firewall") {
      return { outcome: "pass" }; // legacy wallet path — no on-chain account to check.
    }

    let payTo: `0x${string}`;
    try {
      payTo = getAddress(ctx.requirement.payTo);
    } catch {
      return { outcome: "refuse", state: "policy_rejected", reason: "funding_check_failed: malformed payTo address" };
    }
    const value = BigInt(ctx.requirement.amount);
    const accountId = ctx.intent.accountId;
    if (!accountId) {
      // Unreachable in practice — `resolvePayer` only returns `kind:
      // "smart_account"` for a `source: "world_id"` mandate, which always
      // sets `accountId` (promises.ts's `promiseAsMandate`). Fail closed
      // rather than assert, matching every other stage's discipline.
      return { outcome: "refuse", state: "policy_rejected", reason: "funding_check_failed: resolved a smart-account payer with no accountId" };
    }

    let state: AccountHealthState;
    try {
      state = await getAccountHealthReader().read({ smartAccount: payer.address, payTo, accountId });
    } catch (err) {
      return {
        outcome: "refuse",
        state: "policy_rejected",
        reason: `funding_check_failed: could not read the smart account's on-chain state: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!state.deployed) {
      return { outcome: "refuse", state: "policy_rejected", reason: `not_deployed: ${payer.address} has no deployed OmamorisanAccount code` };
    }
    if (state.paused) {
      return { outcome: "refuse", state: "policy_rejected", reason: `paused: the account ${payer.address} is paused` };
    }
    if (!state.recipientAllowed) {
      return {
        outcome: "refuse",
        state: "policy_rejected",
        reason: `recipient_not_registered: the account's owner must register ${payTo} as a recipient before it can pay this merchant`,
      };
    }
    if (value > state.perPaymentLimitAtomic) {
      return {
        outcome: "refuse",
        state: "policy_rejected",
        reason: `over_account_limit: payment ${value} exceeds the account's perPaymentLimit ${state.perPaymentLimitAtomic}`,
      };
    }
    if (state.balanceAtomic < value) {
      return {
        outcome: "refuse",
        state: "policy_rejected",
        reason:
          `insufficient_funds: the account ${payer.address} holds ${formatUnits(state.balanceAtomic, USDC_DECIMALS)} USDC, ` +
          `needs ${formatUnits(value, USDC_DECIMALS)} — fund ${payer.address}`,
      };
    }
    return { outcome: "pass" };
  },
};
