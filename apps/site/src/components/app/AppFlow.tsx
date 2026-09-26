import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { getInjectedProvider } from "../../lib/wallet";
import { useWalletSession } from "../../lib/useWalletSession";
import AppShell from "../ui/AppShell";
import InlineError from "../ui/InlineError";
import KeyHandoff from "./KeyHandoff";
import PromiseComposer, { type CreatedPromise } from "./PromiseComposer";
import PromiseList from "./PromiseList";
import SignInGate from "./SignInGate";

/** `/app`'s React island: the sign-in gate (S0) until a SIWE session exists,
 * then the promises home (S1), the composer (S2) and the one-time key
 * handoff (S3) as view states. The wallet/SIWE state machine itself lives in
 * `useWalletSession`, shared with `/app/dashboard`. */
export default function AppFlow() {
  const session = useWalletSession();
  return (
    <AppShell active="promises" session={session}>
      {session.stage.kind === "signed-in" ? (
        <SignedIn key={session.stage.sessionToken} address={session.stage.address} sessionToken={session.stage.sessionToken} />
      ) : (
        <SignInGate session={session} />
      )}
    </AppShell>
  );
}

type View = { kind: "list" } | { kind: "new" } | { kind: "handoff"; created: CreatedPromise };

function SignedIn({ address, sessionToken }: { address: Address; sessionToken: string }) {
  const [view, setView] = useState<View>({ kind: "list" });
  const [refreshSignal, setRefreshSignal] = useState(0);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view.kind]);

  const backToList = useCallback(() => {
    setView({ kind: "list" });
    setRefreshSignal((v) => v + 1);
  }, []);

  if (view.kind === "handoff") {
    return <KeyHandoff created={view.created} onDone={backToList} />;
  }

  if (view.kind === "new") {
    const provider = getInjectedProvider();
    if (!provider) {
      return <InlineError title="Your wallet disconnected." detail="Reload the page and sign in again to create a promise." />;
    }
    return (
      <PromiseComposer
        provider={provider}
        address={address}
        onCreated={(created) => setView({ kind: "handoff", created })}
        onCancel={() => setView({ kind: "list" })}
      />
    );
  }

  return <PromiseList sessionToken={sessionToken} refreshSignal={refreshSignal} onNew={() => setView({ kind: "new" })} />;
}
