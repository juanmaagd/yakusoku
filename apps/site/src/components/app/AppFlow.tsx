import { useCallback, useState, type ReactNode } from "react";
import { SITE } from "../../config";
import { shortAddress } from "../../lib/format";
import { outlinedButton, primaryButton, textButton } from "../../lib/ui";
import { getInjectedProvider } from "../../lib/wallet";
import { useWalletSession } from "../../lib/useWalletSession";
import MandateList from "./MandateList";
import MandateResult, { type MandateResultData } from "./MandateResult";
import MandateWizard from "./MandateWizard";

/** Single React island driving the whole /app onboarding flow (P5): connect
 * wallet -> ensure Base Sepolia -> SIWE sign-in -> create-mandate wizard ->
 * sign -> one-time result -> mandate list. See the P5 brief for the full
 * spec; each screen below maps to one `WalletSessionStage` (P6: the
 * connect/sign-in state machine itself now lives in `useWalletSession`, so
 * `/app/dashboard` can reuse it verbatim). */
export default function AppFlow() {
  const session = useWalletSession();
  const [result, setResult] = useState<MandateResultData | undefined>();
  const [refreshSignal, setRefreshSignal] = useState(0);

  const handleSignOut = useCallback(async () => {
    await session.signOut();
    setResult(undefined);
  }, [session]);

  const handleCreated = useCallback((data: MandateResultData) => {
    setResult(data);
  }, []);

  const handleBackFromResult = useCallback(() => {
    setResult(undefined);
    setRefreshSignal((v) => v + 1);
  }, []);

  const { stage } = session;

  switch (stage.kind) {
    case "checking":
      return <StatusCard title="Checking your wallet…" />;

    case "no-wallet":
      return (
        <StatusCard title="Connect a wallet to continue">
          <p className="text-body text-graphite">
            {SITE.name} needs a browser wallet (like MetaMask) to sign your mandate. No wallet was found on this
            page.
          </p>
          <a
            href="https://metamask.io/download/"
            target="_blank"
            rel="noreferrer"
            className={`${primaryButton} mt-5`}
          >
            Install MetaMask
          </a>
        </StatusCard>
      );

    case "connect":
      return (
        <StatusCard title="Connect your wallet">
          <p className="text-body text-graphite">
            Connect the wallet you&rsquo;ll use to sign the agent mandate. This doesn&rsquo;t cost gas.
          </p>
          {stage.error && (
            <p className="mt-3 text-body-sm text-vermillion" role="alert">
              {stage.error}
            </p>
          )}
          <button type="button" onClick={() => void session.connect()} className={`${primaryButton} mt-5`}>
            Connect wallet
          </button>
        </StatusCard>
      );

    case "wrong-network":
      return (
        <StatusCard title="Switch to Base Sepolia">
          <p className="text-body text-graphite">
            {SITE.name} mandates are signed on {SITE.network} (testnet). Switch your wallet&rsquo;s network to
            continue.
          </p>
          {stage.error && (
            <p className="mt-3 text-body-sm text-vermillion" role="alert">
              {stage.error}
            </p>
          )}
          <button type="button" onClick={() => void session.switchNetwork()} className={`${primaryButton} mt-5`}>
            Switch network
          </button>
        </StatusCard>
      );

    case "sign-in":
      return (
        <StatusCard title="Sign in with your wallet">
          <p className="text-body text-graphite">
            Prove you own {shortAddress(stage.address)} by signing a message. This never costs gas and never
            authorizes a payment on its own.
          </p>
          {stage.error && (
            <p className="mt-3 text-body-sm text-vermillion" role="alert">
              {stage.error}
            </p>
          )}
          <button type="button" onClick={() => void session.signIn()} disabled={stage.busy} className={`${primaryButton} mt-5`}>
            {stage.busy ? "Waiting for signature…" : "Sign in"}
          </button>
        </StatusCard>
      );

    case "signed-in": {
      const provider = getInjectedProvider();
      if (!provider) {
        // The wallet extension disappeared after sign-in (rare) — bounce
        // back through the normal state machine instead of crashing.
        return <StatusCard title="Reconnecting…" />;
      }
      return (
        <div className="mx-auto w-full max-w-[720px] space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-body-sm text-stone">Signed in as</p>
              <p className="text-body font-medium text-ink">{shortAddress(stage.address)}</p>
            </div>
            <div className="flex items-center gap-4">
              <a href={SITE.dashboardRoute} className={textButton}>
                Open dashboard
              </a>
              <button type="button" onClick={() => void handleSignOut()} className={outlinedButton}>
                Sign out
              </button>
            </div>
          </div>

          {result ? (
            <MandateResult result={result} onDone={handleBackFromResult} />
          ) : (
            <>
              <MandateWizard provider={provider} address={stage.address} onCreated={handleCreated} />
              <MandateList sessionToken={stage.sessionToken} refreshSignal={refreshSignal} />
            </>
          )}
        </div>
      );
    }
  }
}

function StatusCard({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto mt-12 w-full max-w-[560px] rounded-card border border-black/[0.08] bg-surface p-8 text-center md:mt-20 md:p-10">
      <h1 className="text-heading-sm font-semibold text-ink">{title}</h1>
      <div className="mt-4">{children}</div>
    </div>
  );
}
