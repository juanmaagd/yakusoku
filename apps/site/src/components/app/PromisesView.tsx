import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { getInjectedProvider } from "../../lib/wallet";
import InlineError from "../ui/InlineError";
import Skeleton from "../ui/Skeleton";
import KeyHandoff from "./KeyHandoff";
import PromiseComposer, { type CreatedPromise } from "./PromiseComposer";
import PromiseList from "./PromiseList";

/** The Promises tab's signed-in content: the promises home (S1), the
 * composer (S2) and the one-time key handoff (S3) as view states. Formerly
 * `/app`'s whole React island (`AppFlow`); `AppRoot` (P5) now owns the
 * wallet/SIWE session and the sign-in gate once, shared with the Live tab,
 * and mounts this component the first time the owner visits Promises. It
 * then stays mounted (hidden, not unmounted) so switching to Live and back
 * never re-fetches the promise list. */
export default function PromisesView({ address, sessionToken, entryPath, onOpenLive }: PromisesViewProps) {
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
    return <KeyHandoff entryPath={entryPath} created={view.created} onDone={backToList} onOpenLive={onOpenLive} />;
  }

  if (view.kind === "new") {
    const provider = getInjectedProvider();
    if (!provider) {
      return <InlineError title="Your wallet disconnected." detail="Reload the page and sign in again to create an intent." />;
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

interface PromisesViewProps {
  address: Address;
  sessionToken: string;
  entryPath?: string;
  /** Switches `AppRoot` to the Live tab client-side. Used by the key
   * handoff's "Open Live" button, which used to be a `window.location.assign`
   * full document reload. */
  onOpenLive: () => void;
}

type View = { kind: "list" } | { kind: "new" } | { kind: "handoff"; created: CreatedPromise };

/** The neutral loading state shown in this tab while a stored session is
 * being verified (`useWalletSession`'s `"checking"` stage) — also `AppRoot`'s
 * server-rendered and first-client render for `/app`, so there's no
 * hydration mismatch and no "Sign in" flash while the check is in flight. */
export function PromisesSkeleton() {
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
