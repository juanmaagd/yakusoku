import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import { SITE } from "../../config";
import { fetchMe, fetchNonce, logoutSession, verifySiwe } from "../../lib/api";
import { shortAddress } from "../../lib/format";
import { clearSessionToken, readSessionToken, writeSessionToken } from "../../lib/storage";
import { outlinedButton, primaryButton } from "../../lib/ui";
import { createTargetWalletClient, describeWalletError, ensureTargetChain, getInjectedProvider, TARGET_CHAIN } from "../../lib/wallet";
import MandateList from "./MandateList";
import MandateResult, { type MandateResultData } from "./MandateResult";
import MandateWizard from "./MandateWizard";

type Stage =
  | { kind: "checking" }
  | { kind: "no-wallet" }
  | { kind: "connect"; error?: string }
  | { kind: "wrong-network"; error?: string }
  | { kind: "sign-in"; address: Address; error?: string; busy?: boolean }
  | { kind: "signed-in"; address: Address; sessionToken: string };

/** Single React island driving the whole /app onboarding flow (P5): connect
 * wallet -> ensure Base Sepolia -> SIWE sign-in -> create-mandate wizard ->
 * sign -> one-time result -> mandate list. See the P5 brief for the full
 * spec; each screen below maps to one `Stage`. */
export default function AppFlow() {
  const [stage, setStage] = useState<Stage>({ kind: "checking" });
  const [result, setResult] = useState<MandateResultData | undefined>();
  const [refreshSignal, setRefreshSignal] = useState(0);

  const evaluate = useCallback(async () => {
    const provider = getInjectedProvider();
    if (!provider) {
      setStage({ kind: "no-wallet" });
      return;
    }
    const client = createTargetWalletClient(provider);
    const accounts = await client.getAddresses().catch(() => [] as Address[]);
    if (accounts.length === 0) {
      setStage({ kind: "connect" });
      return;
    }
    const address = accounts[0]!;
    const chainId = await client.getChainId().catch(() => undefined);
    if (chainId !== TARGET_CHAIN.id) {
      setStage({ kind: "wrong-network" });
      return;
    }
    const storedToken = readSessionToken();
    if (storedToken) {
      const me = await fetchMe(storedToken).catch(() => undefined);
      if (me && me.address.toLowerCase() === address.toLowerCase()) {
        setStage({ kind: "signed-in", address, sessionToken: storedToken });
        return;
      }
      clearSessionToken();
    }
    setStage({ kind: "sign-in", address });
  }, []);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  const handleConnect = useCallback(async () => {
    const provider = getInjectedProvider();
    if (!provider) return;
    try {
      await createTargetWalletClient(provider).requestAddresses();
      await evaluate();
    } catch (err) {
      setStage({ kind: "connect", error: describeWalletError(err, "Could not connect to your wallet.") });
    }
  }, [evaluate]);

  const handleSwitchNetwork = useCallback(async () => {
    const provider = getInjectedProvider();
    if (!provider) return;
    try {
      await ensureTargetChain(provider);
      await evaluate();
    } catch (err) {
      setStage({ kind: "wrong-network", error: describeWalletError(err, "Could not switch network.") });
    }
  }, [evaluate]);

  const handleSignIn = useCallback(async () => {
    if (stage.kind !== "sign-in") return;
    const provider = getInjectedProvider();
    if (!provider) return;
    const address = stage.address;
    setStage({ kind: "sign-in", address, busy: true });
    try {
      const { nonce } = await fetchNonce();
      const message = createSiweMessage({
        address,
        chainId: TARGET_CHAIN.id,
        domain: window.location.host,
        uri: window.location.origin,
        version: "1",
        statement: `Sign in to ${SITE.name} to manage your agent mandates.`,
        nonce,
      });
      const signature = await createTargetWalletClient(provider).signMessage({ account: address, message });
      const verified = await verifySiwe(message, signature);
      writeSessionToken(verified.sessionToken);
      setStage({ kind: "signed-in", address, sessionToken: verified.sessionToken });
    } catch (err) {
      setStage({ kind: "sign-in", address, error: describeWalletError(err, "Sign-in was rejected.") });
    }
  }, [stage]);

  const handleSignOut = useCallback(async () => {
    if (stage.kind !== "signed-in") return;
    await logoutSession(stage.sessionToken);
    clearSessionToken();
    setResult(undefined);
    await evaluate();
  }, [stage, evaluate]);

  const handleCreated = useCallback((data: MandateResultData) => {
    setResult(data);
  }, []);

  const handleBackFromResult = useCallback(() => {
    setResult(undefined);
    setRefreshSignal((v) => v + 1);
  }, []);

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
          <button type="button" onClick={() => void handleConnect()} className={`${primaryButton} mt-5`}>
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
          <button type="button" onClick={() => void handleSwitchNetwork()} className={`${primaryButton} mt-5`}>
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
          <button type="button" onClick={() => void handleSignIn()} disabled={stage.busy} className={`${primaryButton} mt-5`}>
            {stage.busy ? "Waiting for signature…" : "Sign in"}
          </button>
        </StatusCard>
      );

    case "signed-in": {
      const provider = getInjectedProvider();
      if (!provider) {
        // The wallet extension disappeared after sign-in (rare) — bounce
        // back through the normal state machine instead of crashing.
        void evaluate();
        return <StatusCard title="Reconnecting…" />;
      }
      return (
        <div className="mx-auto w-full max-w-[720px] space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-body-sm text-stone">Signed in as</p>
              <p className="text-body font-medium text-ink">{shortAddress(stage.address)}</p>
            </div>
            <button type="button" onClick={() => void handleSignOut()} className={outlinedButton}>
              Sign out
            </button>
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
