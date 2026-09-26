import { SITE } from "../../config";
import type { SetupWallet } from "../../lib/useSetupWallet";
import { errorText, primaryButton } from "../../lib/ui";
import { IconExternal } from "../ui/Icons";

/** The connect/switch-network half of `/setup`'s wallet flow, shared by
 * `NeedsOwnerCard` (connect before signing) and `DeployedCard` (connect
 * before depositing). Renders nothing once `wallet.stage.kind === "ready"` —
 * the caller renders its own next step for that case. */
export default function WalletConnectPrompt({ wallet, ctaLabel = "Connect wallet" }: { wallet: SetupWallet; ctaLabel?: string }) {
  const { stage } = wallet;

  if (stage.kind === "checking") {
    return <p className="text-body-sm text-graphite">Checking your wallet…</p>;
  }

  if (stage.kind === "no-wallet") {
    return (
      <div>
        <p className="text-body-sm text-graphite">No browser wallet found.</p>
        <a href="https://metamask.io/download/" target="_blank" rel="noreferrer" className={`${primaryButton} mt-3`}>
          Get MetaMask
          <IconExternal size={14} />
        </a>
      </div>
    );
  }

  if (stage.kind === "connect") {
    return (
      <div>
        <button type="button" onClick={() => void wallet.connect()} className={primaryButton}>
          {ctaLabel}
        </button>
        {stage.error && (
          <p className={`${errorText} mt-2`} role="alert">
            {stage.error}
          </p>
        )}
      </div>
    );
  }

  if (stage.kind === "wrong-network") {
    return (
      <div>
        <p className="text-body-sm text-graphite">Switch to {SITE.network} to continue.</p>
        <button type="button" onClick={() => void wallet.switchNetwork()} className={`${primaryButton} mt-3`}>
          Switch network
        </button>
        {stage.error && (
          <p className={`${errorText} mt-2`} role="alert">
            {stage.error}
          </p>
        )}
      </div>
    );
  }

  return null;
}
