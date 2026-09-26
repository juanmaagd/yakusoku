import { useCallback, useEffect, useState } from "react";
import { parseUnits } from "viem";
import type { Address, Hex } from "viem";
import type { ReactNode } from "react";
import { basescanAddress, basescanTx, SITE } from "../../config";
import { formatUsdc, shortAddress } from "../../lib/format";
import type { SetupInfo } from "../../lib/setupApi";
import { depositUsdc, readAccountPaused, readUsdcBalance, setAccountPaused, withdrawFromAccount } from "../../lib/setupAccount";
import { useSetupWallet } from "../../lib/useSetupWallet";
import { describeWalletError, getInjectedProvider } from "../../lib/wallet";
import { errorText, inputBase, outlinedButton, primaryButton, smallButton } from "../../lib/ui";
import CopyButton from "../ui/CopyButton";
import { IconExternal, IconPause, IconPlay } from "../ui/Icons";
import InlineError from "../ui/InlineError";
import Skeleton from "../ui/Skeleton";
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
 * merchants and limit, a deposit form open to anyone, and — only when the
 * connected wallet is the owner — withdraw and pause/resume. */
export default function DeployedCard({ info, justDeployedTxHash }: Props) {
  const wallet = useSetupWallet();
  const address = wallet.stage.kind === "ready" ? wallet.stage.address : undefined;
  const isOwner = !!address && address.toLowerCase() === info.owner.toLowerCase();

  const [balance, setBalance] = useState<Balance>({ kind: "loading" });
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

  const refreshPaused = useCallback(async () => {
    setPaused({ kind: "loading" });
    try {
      const value = await readAccountPaused(info.smartAccount);
      setPaused({ kind: "loaded", value });
    } catch {
      setPaused({ kind: "error" });
    }
  }, [info.smartAccount]);

  useEffect(() => {
    void refreshBalance();
    void refreshPaused();
  }, [refreshBalance, refreshPaused]);

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

      <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
        <h2 className="text-subheading font-medium">Registered merchants</h2>
        <ul className="mt-3 divide-y divide-hairline">
          {info.recipients.map((r) => (
            <li key={r.address} className="flex items-center justify-between gap-3 py-2.5 text-body-sm">
              <span className="text-ink">{r.label}</span>
              <span className="font-mono text-caption text-graphite">{shortAddress(r.address)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-subheading font-medium">Balance</h2>
          <button type="button" onClick={() => void refreshBalance()} className={smallButton}>
            Refresh
          </button>
        </div>
        <p className="mt-3 font-mono text-heading-sm">
          {balance.kind === "loading" ? <Skeleton className="h-8 w-32" /> : balance.kind === "loaded" ? `${formatUsdc(balance.atomic)} USDC` : "—"}
        </p>
        {balance.kind === "error" && <InlineError title="Couldn't read your balance from the chain." onRetry={() => void refreshBalance()} />}
      </section>

      {!address && (
        <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
          <h2 className="text-subheading font-medium">Connect a wallet</h2>
          <p className="mt-2 text-body-sm text-graphite">Connect the wallet you want to deposit from, or your owner wallet to manage this account.</p>
          <div className="mt-3">
            <WalletConnectPrompt wallet={wallet} />
          </div>
        </section>
      )}

      {address && <DepositSection usdc={info.usdc} smartAccount={info.smartAccount} from={address} onDeposited={refreshBalance} />}

      {address && isOwner && (
        <OwnerControls smartAccount={info.smartAccount} owner={address} paused={paused} onPausedChange={setPaused} onWithdrawn={refreshBalance} />
      )}
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

// --- Deposit (anyone) ------------------------------------------------------

function DepositSection({ usdc, smartAccount, from, onDeposited }: { usdc: Address; smartAccount: Address; from: Address; onDeposited: () => void }) {
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
      onDeposited();
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
  onPausedChange,
  onWithdrawn,
}: {
  smartAccount: Address;
  owner: Address;
  paused: Paused;
  onPausedChange: (p: Paused) => void;
  onWithdrawn: () => void;
}) {
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | undefined>();
  const [withdrawTx, setWithdrawTx] = useState<Hex | undefined>();
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | undefined>();
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
      onWithdrawn();
    } catch (err) {
      setWithdrawError(describeWalletError(err, "Could not withdraw. Check the account's balance and try again."));
    } finally {
      setWithdrawBusy(false);
    }
  }

  async function togglePause() {
    const provider = getInjectedProvider();
    if (!provider || paused.kind !== "loaded") return;
    setPauseBusy(true);
    setPauseError(undefined);
    try {
      await setAccountPaused(provider, owner, smartAccount, !paused.value);
      onPausedChange({ kind: "loaded", value: !paused.value });
    } catch (err) {
      setPauseError(describeWalletError(err, "Could not update the pause state. Try again."));
    } finally {
      setPauseBusy(false);
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
        <p className="text-body-sm font-medium text-ink">{paused.kind === "loaded" && paused.value ? "Payments are paused" : "Payments are active"}</p>
        <p className="mt-1 text-body-sm text-graphite">
          {paused.kind === "loaded" && paused.value
            ? "The firewall cannot pay from this account until you resume it."
            : "The firewall can pay registered merchants up to your per-payment limit."}
        </p>
        {paused.kind === "loaded" && paused.value ? (
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
