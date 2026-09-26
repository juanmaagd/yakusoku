import { useMemo, useState } from "react";
import { getAddress } from "viem";
import type { Hex } from "viem";
import { SITE } from "../../config";
import { shortAddress } from "../../lib/format";
import { InvalidSignatureError, submitSetupOwner, type SetupInfo, type SubmitOwnerResponse } from "../../lib/setupApi";
import { errorText, primaryButton } from "../../lib/ui";
import { useSetupWallet } from "../../lib/useSetupWallet";
import { createTargetWalletClient, describeWalletError, getInjectedProvider } from "../../lib/wallet";
import { IconCheck } from "../ui/Icons";
import WalletConnectPrompt from "./WalletConnectPrompt";

interface Props {
  token: string;
  info: SetupInfo;
  onDeployed: (result: SubmitOwnerResponse) => void;
}

type Busy = "idle" | "signing" | "deploying";

/** State 2 (`needs_owner`): explains what's about to be created, lists the
 * registered merchants, then walks the connected wallet through signing the
 * firewall-issued message and posting it — the firewall deploys the account
 * and pays the gas, so this component never touches a contract itself. */
export default function NeedsOwnerCard({ token, info, onDeployed }: Props) {
  const wallet = useSetupWallet();
  const address = wallet.stage.kind === "ready" ? wallet.stage.address : undefined;
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | undefined>();

  const resolvedMessage = useMemo(() => (address ? info.message.replace("{owner}", getAddress(address)) : undefined), [address, info.message]);

  async function signAndActivate() {
    if (!address || !resolvedMessage) return;
    const provider = getInjectedProvider();
    if (!provider) return;
    setError(undefined);
    setBusy("signing");
    try {
      const signature = (await createTargetWalletClient(provider).signMessage({ account: address, message: resolvedMessage })) as Hex;
      setBusy("deploying");
      const result = await submitSetupOwner(token, getAddress(address), signature);
      onDeployed(result);
    } catch (err) {
      setBusy("idle");
      setError(err instanceof InvalidSignatureError ? err.message : describeWalletError(err, "Could not finish setting up your account. Try again."));
    }
  }

  return (
    <div className="mx-auto max-w-[640px]">
      <div className="flex flex-col items-center pt-2 text-center md:pt-8">
        <img src="/art/app/wallet.webp" alt="" width={1024} height={1024} decoding="async" className="size-32 md:size-36" />
        <h1 className="headline mt-2 text-heading-sm md:text-heading">
          Set up your <strong>{SITE.name}</strong> account
        </h1>
        <p className="mt-3 text-body text-graphite">Your agent asked you to link a wallet so {SITE.name} can pay merchants for you — never the other way around.</p>
      </div>

      <section className="mt-8 rounded-card border border-hairline bg-surface p-5 md:p-6">
        <h2 className="text-subheading font-medium">What you&rsquo;re creating</h2>
        <ul className="mt-3 space-y-2.5 text-body-sm text-graphite">
          <li>
            The wallet you connect below becomes the <strong className="text-ink">owner</strong> — only you can pause payments or withdraw funds.
          </li>
          <li>
            {SITE.name} can pay <strong className="text-ink">only the merchants listed below</strong>, up to{" "}
            <strong className="text-ink">{info.perPaymentLimitUsdc} USDC</strong> per payment.
          </li>
          <li>You can pause payments or withdraw your balance at any time. Payments already made are final.</li>
          <li>This runs on {SITE.network}, a testnet. No real funds are at risk.</li>
        </ul>
      </section>

      <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
        <h2 className="text-subheading font-medium">Registered merchants</h2>
        {info.recipients.length === 0 ? (
          <p className="mt-3 text-body-sm text-graphite">No merchants registered yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-hairline">
            {info.recipients.map((r) => (
              <li key={r.address} className="flex items-center justify-between gap-3 py-2.5">
                <span className="text-body-sm text-ink">{r.label}</span>
                <span className="font-mono text-caption text-graphite">{shortAddress(r.address)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-card border border-hairline bg-surface p-5 md:p-6">
        <h2 className="text-subheading font-medium">Connect and activate</h2>

        {!address ? (
          <div className="mt-3">
            <WalletConnectPrompt wallet={wallet} ctaLabel="Connect wallet" />
          </div>
        ) : (
          <div className="mt-3">
            <p className="flex items-center gap-2 text-body-sm text-ink">
              <IconCheck size={14} />
              Connected · <span className="font-mono">{shortAddress(address)}</span>
            </p>
            {resolvedMessage && (
              <details className="mt-3 text-body-sm">
                <summary className="cursor-pointer font-medium">What you&rsquo;re signing</summary>
                <p className="mt-2 rounded-btn bg-fog p-3 text-caption text-graphite">{resolvedMessage}</p>
              </details>
            )}
            <button type="button" disabled={busy !== "idle"} onClick={() => void signAndActivate()} className={`${primaryButton} mt-4`}>
              {busy === "signing" ? "Waiting for your wallet…" : busy === "deploying" ? "Deploying your account…" : "Sign & activate"}
            </button>
            {busy === "deploying" && (
              <p className="mt-2 text-caption text-graphite">The firewall is deploying your account and paying the gas. This takes a few seconds.</p>
            )}
            {error && (
              <p className={`${errorText} mt-2`} role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
