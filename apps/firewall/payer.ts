// P11.2 — resolves who pays: the account's own smart account
// (`OmamorisanAccount`, world_id promises) or the firewall's own operator EOA
// (legacy wallet-signed intents, unchanged since P0). Single source of truth
// for both the funding pipeline stage (funding.ts, which needs to know WHAT
// to health-check) and signer.ts (which needs to know HOW to sign) — a pure,
// cheap, deterministic lookup from the mandate alone, so it's simply
// recomputed wherever it's needed rather than threaded through
// `StageContext`: pipeline.ts's own signing step, and approvals.ts's
// `settleApproved`, which resolves a fresh `StoredIntent` from scratch long
// after the original `StageContext` that ran the funding stage is gone.
//
// root CLAUDE.md's payer-selection rule: "the firewall EOA must never be used
// as payer for an account promise" — `resolvePayer` makes that structurally
// true rather than merely conventional: a `source: "world_id"` mandate can
// only ever resolve to `kind: "smart_account"` or the explicit
// `account_not_set_up` refusal below, never `kind: "firewall"`.

import { operatorAccount } from "./signer";
import { getAccount, type StoredIntent } from "./store";

export type PayerKind = "smart_account" | "firewall";

export interface ResolvedPayer {
  kind: PayerKind;
  address: `0x${string}`;
}

export type PayerResolution =
  | { ok: true; payer: ResolvedPayer }
  | { ok: false; reason: "account_not_set_up"; detail: string };

/**
 * A `source: "world_id"` mandate (an account's promise, `promises.ts`'s
 * `promiseAsMandate`) pays from its account's own smart account — refusing
 * fail-closed, before any on-chain read, if that account has no smart
 * account deployed yet. Every other mandate (a wallet-signed `StoredIntent`,
 * `source` unset) keeps paying from the firewall's own operator key,
 * unchanged.
 */
export function resolvePayer(intent: StoredIntent): PayerResolution {
  if (intent.source !== "world_id") {
    return { ok: true, payer: { kind: "firewall", address: operatorAccount.address } };
  }
  const account = intent.accountId ? getAccount(intent.accountId) : undefined;
  if (!account?.smartAccount) {
    return {
      ok: false,
      reason: "account_not_set_up",
      detail: "this account has no smart account yet — call setup_account to deploy one before it can pay",
    };
  }
  return { ok: true, payer: { kind: "smart_account", address: account.smartAccount } };
}
