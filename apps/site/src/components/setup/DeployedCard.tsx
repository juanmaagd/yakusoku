import { useCallback, useEffect, useState } from "react";
import { parseUnits } from "viem";
import type { Address, Hex } from "viem";
import type { ReactNode } from "react";
import { basescanAddress, basescanTx, SITE } from "../../config";
import { formatUsdc, shortAddress } from "../../lib/format";
import type { KnownMerchant, SetupInfo } from "../../lib/setupApi";
import {
  depositUsdc,
  readAccountPaused,
  readMerchantRegistered,
  readUsdcBalance,
  registerMerchant,
  setAccountPaused,
  withdrawFromAccount,
} from "../../lib/setupAccount";
import { useSetupWallet } from "../../lib/useSetupWallet";
import { describeWalletError, getInjectedProvider } from "../../lib/wallet";
import { errorText, helpText, inputBase, outlinedButton, primaryButton, smallButton } from "../../lib/ui";
import CopyButton from "../ui/CopyButton";
import { IconExternal, IconPause, IconPlay } from "../ui/Icons";
import InlineError from "../ui/InlineError";
import Skeleton from "../ui/Skeleton";
import StatusPill from "../ui/StatusPill";
import WalletConnectPrompt from "./WalletConnectPrompt";

interface Props {
  info: SetupInfo & { smartAccount: Address; owner: Address };
  /** Set only right after this session's own deploy, for the one-time "view
   * transaction" banner — never re-derived from the API. */
  justDeployedTxHash?: Hex;
}

type Balance = { kind: "loading" } | { kind: "loaded"; atomic: bigint } | { kind: "error" };
type Paused = { kind: "loading" } | { kind: "loaded"; value: boolean } | { kind: "error" };

/** State 3 (`deployed`): the account's live on-chain balance, its registered
 * merchants and limit, and — only when the connected wallet is the owner —
 * deposit, withdraw and pause/resume (a warning otherwise). */
export default function DeployedCard({ info, justDeployedTxHash }: Props) {
  const wallet = useSetupWallet();
  const address = wallet.stage.kind === "ready" ? wallet.stage.address : undefined;
  const isOwner = !!address && address.toLowerCase() === info.owner.toLowerCase();

  const [balance, setBalance] = useState<Balance>({ kind: "loading" });
  // The owner's own wallet, not the connected one: `info.owner` is known from
  // the setup status regardless of whether a wallet is connected yet, and a
  // public Base Sepolia client reads it (never the connected wallet's own
  // provider), so it works no matter which network that wallet is on.
  const [ownerBalance, setOwnerBalance] = useState<Balance>({ kind: "loading" });
  const [paused, setPaused] = useState<Paused>({ kind: "loading" });

  const refreshBalance = useCallback(async () => {
    setBalance({ kind: "loading" });
    try {
      const atomic = await readUsdcBalance(info.usdc, info.smartAccount);
      setBalance({ kind: "loaded", atomic });
    } catch {
      setBalance({ kind: "error" });
    }
  }, [info.usdc, info.smartAccount]);

  const refreshOwnerBalance = useCallback(async () => {
    setOwnerBalance({ kind: "loading" });
    try {
      const atomic = await readUsdcBalance(info.usdc, info.owner);
      setOwnerBalance({ kind: "loaded", atomic });
    } catch {
      setOwnerBalance({ kind: "error" });
    }
  }, [info.usdc, info.owner]);

  const refreshPaused = useCallback(async () => {
    setPaused({ kind: "loading" });
    try {
      const value = await readAccountPaused(info.smartAccount);
      setPaused({ kind: "loaded", value });
    } catch {
      setPaused({ kind: "error" });
    }
  }, [info.smartAccount]);

  // One entry point for "everything this page shows might have changed":
  // the initial load and every owner transaction (deposit, withdraw, pause,
  // unpause) refresh both balances and the paused flag together, so the page
  // never needs a manual reload.
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshBalance(), refreshOwnerBalance(), refreshPaused()]);
  }, [refreshBalance, refreshOwnerBalance, refreshPaused]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  return (
    <div className="mx-auto max-w-[640px]">
      <div className="flex flex-col items-center pt-2 text-center md:pt-8">
        <img src="/art/app/pass.webp" alt="" width={1024} height={1024} decoding="async" className="size-28 md:size-32" />
        <h1 className="headline mt-2 text-heading-sm md:text-heading">
          Your <strong>{SITE.name}</strong> account is live
        </h1>
        <p className="mt-3 text-body text-graphite">Go back to your agent — it can now buy within your promises.</p>
      </div>

      {justDeployedTxHash && (
        <p className="mt-4 rounded-card border border-hairline bg-fog px-4 py-3 text-body-sm text-ink">
          Deployed just now.{" "}
          <a className="underline" href={basescanTx(justDeployedTxHash)} target="_blank" rel="noreferrer">
            View transaction <IconExternal size={12} className="inline" />
          </a>
        </p>
      )}

      <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
        <h2 className="text-subheading font-medium">Account</h2>
        <dl className="mt-3 space-y-3 text-body-sm">
          <Row label="Account">
            <span className="font-mono">{shortAddress(info.smartAccount)}</span>
            <CopyButton value={info.smartAccount} ariaLabel="Copy account address" />
            <a className="underline" href={basescanAddress(info.smartAccount)} target="_blank" rel="noreferrer">
              Basescan <IconExternal size={12} className="inline" />
            </a>
          </Row>
          <Row label="Owner">
            <span className="font-mono">{shortAddress(info.owner)}</span>
            {isOwner && <span className="text-caption text-graphite">(you)</span>}
          </Row>
          <Row label="Per-payment limit">{info.perPaymentLimitUsdc} USDC</Row>
          <Row label="Network">{SITE.network}</Row>
        </dl>
      </section>

      <KnownMerchantsSection
        knownMerchants={info.knownMerchants}
        smartAccount={info.smartAccount}
        address={address}
        isOwner={isOwner}
      />

      <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-subheading font-medium">Balance</h2>
          <button type="button" onClick={() => void refreshAll()} className={smallButton}>
            Refresh
          </button>
        </div>
        <dl className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-caption text-graphite">{isOwner ? "Your wallet" : "Owner's wallet"}</dt>
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
            <dt className="text-caption text-graphite">{SITE.name} account</dt>
            <dd className="mt-1 font-mono text-heading-sm">
              {balance.kind === "loading" ? <Skeleton className="h-8 w-32" /> : balance.kind === "loaded" ? `${formatUsdc(balance.atomic)} USDC` : "—"}
            </dd>
          </div>
        </dl>
        {(balance.kind === "error" || ownerBalance.kind === "error") && (
          <InlineError title="Couldn't read a balance from the chain." onRetry={() => void refreshAll()} />
        )}
      </section>

      {!address && (
        <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
          <h2 className="text-subheading font-medium">Connect a wallet</h2>
          <p className="mt-2 text-body-sm text-graphite">Connect the owner wallet to deposit into and manage this account.</p>
          <div className="mt-3">
            <WalletConnectPrompt wallet={wallet} />
          </div>
        </section>
      )}

      {/* Deposits are owner-only in the UI: the setup link reaches the human through the agent, so a
          compromised agent could link its own wallet first. Never invite a deposit into an account the
          connected wallet doesn't control. */}
      {address && !isOwner && (
        <section className="mt-6 rounded-card bg-refuse-wash p-5 text-refuse-ink md:p-6">
          <h2 className="text-subheading font-medium">This account isn't owned by your wallet</h2>
          <p className="mt-2 text-body-sm">
            It's owned by <span className="font-mono">{shortAddress(info.owner)}</span>. Don't deposit into an account you don't
            control. If you didn't link that wallet, ask your agent for a new setup link.
          </p>
        </section>
      )}

      {address && isOwner && (
        <DepositSection usdc={info.usdc} smartAccount={info.smartAccount} from={address} ownerBalance={ownerBalance} onDeposited={refreshAll} />
      )}

      {address && isOwner && <OwnerControls smartAccount={info.smartAccount} owner={address} paused={paused} onChanged={refreshAll} />}
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

// --- Registered merchants (multi-store M2) ----------------------------------
// Every demo store the firewall knows about, each with its live on-chain
// registration status against this account. An unregistered store gets a
// "Register" button (owner-only, sends setRecipient(address, true)); the
// status pill is the only colored element (verified blue = registered,
// per DESIGN.md's "color only reports state" rule — "not registered" and
// "unknown" stay neutral/muted, since neither one is an error).

function KnownMerchantsSection({
  knownMerchants,
  smartAccount,
  address,
  isOwner,
}: {
  knownMerchants: KnownMerchant[];
  smartAccount: Address;
  address: Address | undefined;
  isOwner: boolean;
}) {
  const [merchants, setMerchants] = useState<KnownMerchant[]>(knownMerchants);
  const [registeringAddress, setRegisteringAddress] = useState<Address | undefined>();
  const [registerError, setRegisterError] = useState<string | undefined>();

  async function register(merchant: Address) {
    const provider = getInjectedProvider();
    if (!provider || !address) return;
    setRegisteringAddress(merchant);
    setRegisterError(undefined);
    try {
      await registerMerchant(provider, address, smartAccount, merchant);
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
    <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
      <h2 className="text-subheading font-medium">Registered merchants</h2>
      <p className="mt-1 text-body-sm text-graphite">
        Stores this account can pay. An unregistered store needs the owner to add it before the firewall can send it a payment.
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
              {address && isOwner && m.registered === false && (
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

function parsePositiveUsdc(input: string): bigint | undefined {
  try {
    if (!input.trim()) return undefined;
    const value = parseUnits(input.trim(), 6);
    return value > 0n ? value : undefined;
  } catch {
    return undefined;
  }
}

// --- Deposit (owner) -------------------------------------------------------

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
      // Wait for both balances (and the paused flag) to refresh before
      // clearing "Depositing…", so the new figures are already on screen —
      // never a stale balance the owner has to manually reload for.
      await onDeposited();
    } catch (err) {
      setError(describeWalletError(err, "Could not send this deposit. Check your USDC balance and try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
      <h2 className="text-subheading font-medium">Deposit USDC</h2>
      <p className="mt-2 text-body-sm text-graphite">
        Sends USDC straight from your connected wallet to the account above.{" "}
        <a className="underline" href={SITE.circleFaucetUrl} target="_blank" rel="noreferrer">
          Need testnet USDC? <IconExternal size={12} className="inline" />
        </a>
      </p>
      <p className={helpText}>
        Available: {ownerBalance.kind === "loaded" ? `${formatUsdc(ownerBalance.atomic)} USDC` : "—"}
      </p>
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
    </section>
  );
}

// --- Owner controls ----------------------------------------------------

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
  // Which way `togglePause` is heading, held only while it's in flight. Its
  // on-chain refresh (`onChanged`) briefly reports `paused.kind === "loading"`
  // partway through — without this, the pause/resume button would flash to
  // its *other* state (wrong icon and label) for that instant.
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
      // Withdrawals pay out to the owner's own wallet, so its balance moves
      // too — wait for both balances to refresh before clearing "Withdrawing…".
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
      // Re-read the paused flag from the chain rather than optimistically
      // flipping it locally, so this stays true even if the transaction did
      // something unexpected.
      await onChanged();
    } catch (err) {
      setPauseError(describeWalletError(err, "Could not update the pause state. Try again."));
    } finally {
      setPauseBusy(false);
      setPendingAction(undefined);
    }
  }

  return (
    <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
      <h2 className="text-subheading font-medium">Owner controls</h2>

      <div className="mt-4">
        <p className="text-body-sm font-medium text-ink">Withdraw to your wallet</p>
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
      </div>

      <div className="mt-6 border-t border-hairline pt-4">
        <p className="text-body-sm font-medium text-ink">{isPaused ? "Payments are paused" : "Payments are active"}</p>
        <p className="mt-1 text-body-sm text-graphite">
          {isPaused
            ? "The firewall cannot pay from this account until you resume it."
            : "The firewall can pay registered merchants up to your per-payment limit."}
        </p>
        {isPaused ? (
          // Mirrors AppShell.tsx's PauseControl "Paused · Resume" treatment for consistency.
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
    </section>
  );
}
