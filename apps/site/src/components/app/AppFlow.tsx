import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { getInjectedProvider } from "../../lib/wallet";
import { useWalletSession } from "../../lib/useWalletSession";
import AppShell from "../ui/AppShell";
import InlineError from "../ui/InlineError";
import Skeleton from "../ui/Skeleton";
import KeyHandoff from "./KeyHandoff";
import PromiseComposer, { type CreatedPromise } from "./PromiseComposer";
import PromiseList from "./PromiseList";
import SignInGate from "./SignInGate";

/** `/app`'s React island: the sign-in gate (S0) until a SIWE session exists,
 * then the promises home (S1), the composer (S2) and the one-time key
 * handoff (S3) as view states. The wallet/SIWE state machine itself lives in
 * `useWalletSession`, shared with `/app/dashboard`. A stored session token is
 * verified on every mount (including a plain navigation between /app and
 * /app/dashboard, since each is a separate page load) — `"checking"` renders
 * this neutral skeleton instead of `SignInGate`, so a signed-in owner never
 * sees the "Sign in" screen flash while that check is in flight. This is
 * also the server-rendered (and first client) render, since `useWalletSession`
 * starts in `"checking"` — no hydration mismatch. */
export default function AppFlow({ entryPath }: { entryPath?: string }) {
  const session = useWalletSession();
  return (
    <AppShell active="promises" session={session}>
      {session.stage.kind === "signed-in" ? (
        <SignedIn entryPath={entryPath} key={session.stage.sessionToken} address={session.stage.address} sessionToken={session.stage.sessionToken} />
      ) : session.stage.kind === "checking" ? (
        <PromisesSkeleton />
      ) : (
        <SignInGate session={session} />
      )}
    </AppShell>
  );
}

function PromisesSkeleton() {
  return (
    <section>
      <div className="max-w-[640px]">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="mt-3 h-4 w-full max-w-[420px]" />
      </div>
      <ul aria-busy="true" aria-label="Checking your session" className="mt-8 grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <li key={i} className="rounded-card border border-hairline p-5">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="mt-4 h-5 w-4/5" />
            <Skeleton className="mt-5 h-1 w-full" />
            <Skeleton className="mt-4 h-3 w-1/2" />
          </li>
        ))}
      </ul>
    </section>
  );
}

type View = { kind: "list" } | { kind: "new" } | { kind: "handoff"; created: CreatedPromise };

function SignedIn({ address, sessionToken, entryPath }: { address: Address; sessionToken: string; entryPath?: string }) {
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
    return <KeyHandoff entryPath={entryPath} created={view.created} onDone={backToList} />;
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
