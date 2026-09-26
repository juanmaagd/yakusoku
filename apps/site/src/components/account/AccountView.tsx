// Owner account panel — the "Account" tab of the unified /app island. Unlike
// `/setup` (P11.4, components/setup/DeployedCard.tsx), which a fresh,
// agent-issued 30-minute link walks a human through, this tab is reachable at
// any time with the owner's ordinary SIWE session (`AppRoot`'s
// `useWalletSession`) — the emergency controls (Pause, Withdraw) must not
// depend on asking the agent for a new link. `GET /owner/accounts`
// (apps/firewall/index.ts) only ever returns accounts THIS session's wallet
// owns, so every account rendered here is already confirmed owned by the
// connected wallet — no "connect a wallet" or "wrong owner" branch like
// `/setup` needs, and every write below goes straight from that same
// connected wallet to the contract, exactly as `/setup`'s controls do; the
// firewall never gains custody. Deposit/Withdraw/Pause/Register reuse
// `lib/setupAccount.ts`'s on-chain calls verbatim — only the surrounding
// copy and state handling differ, since this tab always knows it's talking
// to the owner.

import { useCallback, useEffect, useState } from "react";
import { parseUnits } from "viem";
import type { Address, Hex } from "viem";
import type { ReactNode } from "react";
import { basescanAddress, basescanTx, SITE } from "../../config";
import {
  listOwnerAccounts,
  UnauthorizedError,
  type OwnerAccount,
  type OwnerAccountMerchant,
} from "../../lib/api";
import { formatUsdc, shortAddress } from "../../lib/format";
import {
  depositUsdc,
  readAccountPaused,
  readMerchantRegistered,
  readUsdcBalance,
  registerMerchant,
  setAccountPaused,
  withdrawFromAccount,
} from "../../lib/setupAccount";
import { describeWalletError, getInjectedProvider } from "../../lib/wallet";
import { errorText, helpText, inputBase, outlinedButton, primaryButton, smallButton } from "../../lib/ui";
import CopyButton from "../ui/CopyButton";
import EmptyState from "../ui/EmptyState";
import { IconExternal, IconPause, IconPlay, IconRefresh } from "../ui/Icons";
import InlineError from "../ui/InlineError";
import Skeleton from "../ui/Skeleton";
import StatusPill from "../ui/StatusPill";

interface AccountViewProps {
  sessionToken: string;
  /** Routes a 401 from any owner-scoped call straight back to sign-in,
   * same "401 anywhere -> back to sign-in" contract every other /app tab
   * follows (P6 brief, `AppShell`'s own `rethrowUnlessUnauthorized`). */
  onUnauthorized: () => void;
}

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "loaded"; accounts: OwnerAccount[] };

/** The Account tab's signed-in content: every smart account this wallet
 * linked as owner at `/setup`, each with its own balances, deposit,
 * withdraw, pause/resume and registered merchants. */
export default function AccountView({ sessionToken, onUnauthorized }: AccountViewProps) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const accounts = await listOwnerAccounts(sessionToken);
      setLoad({ kind: "loaded", accounts });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setLoad({ kind: "error", message: err instanceof Error ? err.message : "Could not load your account." });
    }
  }, [sessionToken, onUnauthorized]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (load.kind === "loading") return <AccountSkeleton />;

  if (load.kind === "error") {
    return (
      <div className="mx-auto max-w-[640px] pt-8">
        <InlineError title="Couldn't load your account." detail={load.message} onRetry={() => void refresh()} />
      </div>
    );
  }

  if (load.accounts.length === 0) {
    return (
      <EmptyState
        art="/art/app/agent.webp"
        title="No account yet"
        body={`Your agent sets this account up the first time it asks you to link a wallet. Once you've followed that link, its balances and controls show up here.`}
      />
    );
  }

  return (
    <div className="mx-auto max-w-[640px]">
      <div className="flex flex-col items-center pt-2 text-center md:pt-8">
        <h1 className="headline text-heading-sm md:text-heading">Account</h1>
        <p className="mt-3 text-body text-graphite">
          {SITE.name} pays merchants straight from this account. Pause stops every payment at once.
        </p>
      </div>
      {load.accounts.map((account, i) => (
        <AccountCard key={account.accountId} account={account} heading={load.accounts.length > 1 ? `Account ${i + 1}` : "Account"} />
      ))}
    </div>
  );
}

function AccountSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your account" className="mx-auto max-w-[640px]">
      <div className="flex flex-col items-center gap-3 pt-2 md:pt-8">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-4 h-4 w-full" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-3 h-4 w-2/3" />
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline pb-3 last:border-0 last:pb-0">
      <dt className="text-graphite">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2 text-ink">{children}</dd>
    </div>
  );
}

function parsePositiveUsdc(input: string): bigint | undefined {
  try {
    if (!input.trim()) return undefined;
    const value = parseUnits(input.trim(), 6);
    return value > 0n ? value : undefined;
  } catch {
    return undefined;
  }
}

type Balance = { kind: "loading" } | { kind: "loaded"; atomic: bigint } | { kind: "error" };
type Paused = { kind: "loading" } | { kind: "loaded"; value: boolean } | { kind: "error" };

function AccountCard({ account, heading }: { account: OwnerAccount; heading: string }) {
  const [balance, setBalance] = useState<Balance>({ kind: "loading" });
  const [ownerBalance, setOwnerBalance] = useState<Balance>({ kind: "loading" });
  const [paused, setPaused] = useState<Paused>({ kind: "loading" });

  const refreshBalance = useCallback(async () => {
    setBalance({ kind: "loading" });
    try {
      setBalance({ kind: "loaded", atomic: await readUsdcBalance(account.usdc, account.smartAccount) });
    } catch {
      setBalance({ kind: "error" });
    }
  }, [account.usdc, account.smartAccount]);

  const refreshOwnerBalance = useCallback(async () => {
    setOwnerBalance({ kind: "loading" });
    try {
      setOwnerBalance({ kind: "loaded", atomic: await readUsdcBalance(account.usdc, account.owner) });
    } catch {
      setOwnerBalance({ kind: "error" });
    }
  }, [account.usdc, account.owner]);

  const refreshPaused = useCallback(async () => {
    setPaused({ kind: "loading" });
    try {
      setPaused({ kind: "loaded", value: await readAccountPaused(account.smartAccount) });
    } catch {
      setPaused({ kind: "error" });
    }
  }, [account.smartAccount]);

  // Same "one entry point refreshes everything" discipline as `/setup`'s
  // `DeployedCard`: every owner transaction below (deposit, withdraw, pause,
  // register) re-reads all three from the chain together, so the page never
  // needs a manual reload.
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshBalance(), refreshOwnerBalance(), refreshPaused()]);
  }, [refreshBalance, refreshOwnerBalance, refreshPaused]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  return (
    <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
      <h2 className="text-subheading font-medium">{heading}</h2>
      <dl className="mt-3 space-y-3 text-body-sm">
        <Row label="Address">
          <span className="font-mono">{shortAddress(account.smartAccount)}</span>
          <CopyButton value={account.smartAccount} ariaLabel="Copy account address" />
          <a className="underline" href={basescanAddress(account.smartAccount)} target="_blank" rel="noreferrer">
            Basescan <IconExternal size={12} className="inline" />
          </a>
        </Row>
        <Row label="Owner">
          <span className="font-mono">{shortAddress(account.owner)}</span>
          <span className="text-caption text-graphite">(you)</span>
        </Row>
        <Row label="Per-payment limit">{account.perPaymentLimitUsdc} USDC</Row>
        <Row label="Network">{SITE.network}</Row>
      </dl>

      <KnownMerchantsSection knownMerchants={account.knownMerchants} smartAccount={account.smartAccount} owner={account.owner} />

      <div className="mt-6 border-t border-hairline pt-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-body font-medium text-ink">Balance</h3>
          <button type="button" onClick={() => void refreshAll()} className={smallButton}>
            <IconRefresh size={14} />
            Refresh
          </button>
        </div>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-caption text-graphite">Your wallet</dt>
            <dd className="mt-1 font-mono text-heading-sm">
              {ownerBalance.kind === "loading" ? (
                <Skeleton className="h-8 w-32" />
              ) : ownerBalance.kind === "loaded" ? (
                `${formatUsdc(ownerBalance.atomic)} USDC`
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-graphite">Available to your agent</dt>
            <dd className="mt-1 font-mono text-heading-sm">
              {balance.kind === "loading" ? <Skeleton className="h-8 w-32" /> : balance.kind === "loaded" ? `${formatUsdc(balance.atomic)} USDC` : "—"}
            </dd>
          </div>
        </dl>
        {(balance.kind === "error" || ownerBalance.kind === "error") && (
          <InlineError title="Couldn't read a balance from the chain." onRetry={() => void refreshAll()} />
        )}
      </div>

      <DepositSection usdc={account.usdc} smartAccount={account.smartAccount} from={account.owner} ownerBalance={ownerBalance} onDeposited={refreshAll} />
      <OwnerControls smartAccount={account.smartAccount} owner={account.owner} paused={paused} onChanged={refreshAll} />
    </section>
  );
}

// --- Registered merchants ----------------------------------------------------
// Every demo store the firewall knows about, with its live on-chain
// registration status against this account — same data/behavior as
// `/setup`'s "Registered merchants" card (multi-store M2), minus the
// `isOwner` gating that card needs: every account reaching this tab is
// already confirmed owned by the connected wallet, so "Register" always
// shows for an unregistered store.

function KnownMerchantsSection({
  knownMerchants,
  smartAccount,
  owner,
}: {
  knownMerchants: OwnerAccountMerchant[];
  smartAccount: Address;
  owner: Address;
}) {
  const [merchants, setMerchants] = useState<OwnerAccountMerchant[]>(knownMerchants);
  const [registeringAddress, setRegisteringAddress] = useState<Address | undefined>();
  const [registerError, setRegisterError] = useState<string | undefined>();

  async function register(merchant: Address) {
    const provider = getInjectedProvider();
    if (!provider) return;
    setRegisteringAddress(merchant);
    setRegisterError(undefined);
    try {
      await registerMerchant(provider, owner, smartAccount, merchant);
      // Re-read the flag from the chain rather than optimistically flipping
      // it locally, matching OwnerControls's own pause/resume discipline.
      const registered = await readMerchantRegistered(smartAccount, merchant);
      setMerchants((prev) => prev.map((m) => (m.address === merchant ? { ...m, registered } : m)));
    } catch (err) {
      setRegisterError(describeWalletError(err, "Could not register this merchant. Try again."));
    } finally {
      setRegisteringAddress(undefined);
    }
  }

  return (
    <section className="mt-6 border-t border-hairline pt-4">
      <h3 className="text-body font-medium text-ink">Registered merchants</h3>
      <p className="mt-1 text-body-sm text-graphite">
        Stores this account can pay. An unregistered store needs to be added before the firewall can send it a payment.
      </p>
      <ul className="mt-3 divide-y divide-hairline">
        {merchants.map((m) => (
          <li key={m.address} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-body-sm">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-ink">{m.label}</span>
              <span className="font-mono text-caption text-graphite">{shortAddress(m.address)}</span>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill tone={m.registered === true ? "verified" : m.registered === false ? "neutral" : "muted"}>
                {m.registered === true ? "Registered" : m.registered === false ? "Not registered" : "Unknown"}
              </StatusPill>
              {m.registered === false && (
                <button type="button" disabled={registeringAddress === m.address} onClick={() => void register(m.address)} className={smallButton}>
                  {registeringAddress === m.address ? "Registering…" : "Register"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {registerError && (
        <p className={`${errorText} mt-2`} role="alert">
          {registerError}
        </p>
      )}
    </section>
  );
}

// --- Deposit (owner) ----------------------------------------------------------

function DepositSection({
  usdc,
  smartAccount,
  from,
  ownerBalance,
  onDeposited,
}: {
  usdc: Address;
  smartAccount: Address;
  from: Address;
  ownerBalance: Balance;
  onDeposited: () => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [txHash, setTxHash] = useState<Hex | undefined>();
  const parsedAmount = parsePositiveUsdc(amount);

  async function deposit() {
    const provider = getInjectedProvider();
    if (!provider || !parsedAmount) return;
    setBusy(true);
    setError(undefined);
    setTxHash(undefined);
    try {
      const hash = await depositUsdc(provider, from, usdc, smartAccount, parsedAmount);
      setTxHash(hash);
      setAmount("");
      await onDeposited();
    } catch (err) {
      setError(describeWalletError(err, "Could not send this deposit. Check your USDC balance and try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 border-t border-hairline pt-4">
      <h3 className="text-body font-medium text-ink">Deposit USDC</h3>
      <p className="mt-2 text-body-sm text-graphite">
        Sends USDC straight from your connected wallet to this account.{" "}
        <a className="underline" href={SITE.circleFaucetUrl} target="_blank" rel="noreferrer">
          Need testnet USDC? <IconExternal size={12} className="inline" />
        </a>
      </p>
      <p className={helpText}>Available: {ownerBalance.kind === "loaded" ? `${formatUsdc(ownerBalance.atomic)} USDC` : "—"}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={`${inputBase} w-40 font-mono`}
          aria-label="Amount to deposit (USDC)"
        />
        <button type="button" disabled={!parsedAmount || busy} onClick={() => void deposit()} className={primaryButton}>
          {busy ? "Depositing…" : "Deposit"}
        </button>
      </div>
      {txHash && (
        <p className="mt-2 text-body-sm text-graphite">
          Sent.{" "}
          <a className="underline" href={basescanTx(txHash)} target="_blank" rel="noreferrer">
            View transaction <IconExternal size={12} className="inline" />
          </a>
        </p>
      )}
      {error && (
        <p className={`${errorText} mt-2`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// --- Withdraw + Pause/Resume (owner) ------------------------------------------

function OwnerControls({
  smartAccount,
  owner,
  paused,
  onChanged,
}: {
  smartAccount: Address;
  owner: Address;
  paused: Paused;
  onChanged: () => Promise<void>;
}) {
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | undefined>();
  const [withdrawTx, setWithdrawTx] = useState<Hex | undefined>();
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | undefined>();
  // Which way `togglePause` is heading, held only while it's in flight — see
  // `/setup`'s identical `DeployedCard.OwnerControls` for why this avoids a
  // one-frame flash to the wrong icon/label while `onChanged` reloads.
  const [pendingAction, setPendingAction] = useState<"pause" | "resume" | undefined>();
  const isPaused = pendingAction ? pendingAction === "resume" : paused.kind === "loaded" && paused.value;
  const parsedWithdraw = parsePositiveUsdc(withdrawAmount);

  async function withdraw() {
    const provider = getInjectedProvider();
    if (!provider || !parsedWithdraw) return;
    setWithdrawBusy(true);
    setWithdrawError(undefined);
    setWithdrawTx(undefined);
    try {
      const hash = await withdrawFromAccount(provider, owner, smartAccount, owner, parsedWithdraw);
      setWithdrawTx(hash);
      setWithdrawAmount("");
      await onChanged();
    } catch (err) {
      setWithdrawError(describeWalletError(err, "Could not withdraw. Check the account's balance and try again."));
    } finally {
      setWithdrawBusy(false);
    }
  }

  async function togglePause() {
    const provider = getInjectedProvider();
    if (!provider || paused.kind !== "loaded") return;
    setPendingAction(paused.value ? "resume" : "pause");
    setPauseBusy(true);
    setPauseError(undefined);
    try {
      await setAccountPaused(provider, owner, smartAccount, !paused.value);
      await onChanged();
    } catch (err) {
      setPauseError(describeWalletError(err, "Could not update the pause state. Try again."));
    } finally {
      setPauseBusy(false);
      setPendingAction(undefined);
    }
  }

  return (
    <div className="mt-6 border-t border-hairline pt-4">
      <h3 className="text-body font-medium text-ink">Withdraw to your wallet</h3>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={withdrawAmount}
          onChange={(e) => setWithdrawAmount(e.target.value)}
          className={`${inputBase} w-40 font-mono`}
          aria-label="Amount to withdraw (USDC)"
        />
        <button type="button" disabled={!parsedWithdraw || withdrawBusy} onClick={() => void withdraw()} className={outlinedButton}>
          {withdrawBusy ? "Withdrawing…" : "Withdraw"}
        </button>
      </div>
      {withdrawTx && (
        <p className="mt-2 text-body-sm text-graphite">
          Sent.{" "}
          <a className="underline" href={basescanTx(withdrawTx)} target="_blank" rel="noreferrer">
            View transaction <IconExternal size={12} className="inline" />
          </a>
        </p>
      )}
      {withdrawError && (
        <p className={`${errorText} mt-2`} role="alert">
          {withdrawError}
        </p>
      )}

      <div className="mt-6 border-t border-hairline pt-4">
        <p className="text-body-sm font-medium text-ink">{isPaused ? "Payments are paused" : "Payments are active"}</p>
        <p className="mt-1 text-body-sm text-graphite">
          {isPaused
            ? "The firewall cannot pay from this account until you resume it."
            : "The firewall can pay registered merchants up to your per-payment limit."}
        </p>
        {isPaused ? (
          <button
            type="button"
            disabled={pauseBusy}
            onClick={() => void togglePause()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-btn border border-refuse/60 bg-refuse-wash px-3 py-1.5 text-body-sm leading-[1.2] font-medium text-refuse-ink transition-colors duration-200 ease-out hover:border-refuse disabled:opacity-60"
          >
            <IconPlay size={14} />
            {pauseBusy ? "Resuming…" : "Paused · Resume"}
          </button>
        ) : (
          <button type="button" disabled={paused.kind !== "loaded" || pauseBusy} onClick={() => void togglePause()} className={`${smallButton} mt-3`}>
            <IconPause size={14} />
            {pauseBusy ? "Pausing…" : "Pause"}
          </button>
        )}
        {pauseError && (
          <p className={`${errorText} mt-2`} role="alert">
            {pauseError}
          </p>
        )}
      </div>
    </div>
  );
}
