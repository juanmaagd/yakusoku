import { useCallback, useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { fetchSetup, SetupNotFoundError, type SetupInfo, type SubmitOwnerResponse } from "../../lib/setupApi";
import InlineError from "../ui/InlineError";
import Skeleton from "../ui/Skeleton";
import DeployedCard from "./DeployedCard";
import NeedsOwnerCard from "./NeedsOwnerCard";

type Load = { kind: "loading" } | { kind: "invalid" } | { kind: "error"; message: string } | { kind: "loaded"; info: SetupInfo };

/** Reads `?token=` once at mount. Guarded for SSR (Astro's `client:load`
 * pre-renders this component on the server, where `window` doesn't exist) —
 * same pattern as `LiveView.tsx`'s `initialPromiseFilter`. */
function initialToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("token") ?? undefined;
}

/**
 * `/setup`'s React island (P11.4): a one-time, agent-issued link that walks a
 * human through linking their wallet as the owner of their Omamorisan smart
 * account, then lets them manage it (deposit / withdraw / pause). Unlike
 * `/app`, this flow needs no SIWE session with the firewall — only a
 * connected wallet (`useSetupWallet`, per card) and the token in the URL.
 */
export default function SetupFlow() {
  const [token] = useState(initialToken);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [justDeployedTxHash, setJustDeployedTxHash] = useState<Hex | undefined>();

  const loadSetup = useCallback(async () => {
    if (!token) {
      setLoad({ kind: "invalid" });
      return;
    }
    setLoad({ kind: "loading" });
    try {
      const info = await fetchSetup(token);
      setLoad({ kind: "loaded", info });
    } catch (err) {
      if (err instanceof SetupNotFoundError) setLoad({ kind: "invalid" });
      else setLoad({ kind: "error", message: err instanceof Error ? err.message : "Could not load this setup link." });
    }
  }, [token]);

  useEffect(() => {
    void loadSetup();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadKey is a manual retry trigger, not a data dependency
  }, [loadSetup, reloadKey]);

  const handleDeployed = useCallback(
    (result: SubmitOwnerResponse) => {
      setJustDeployedTxHash(result.txHash);
      setLoad((prev) =>
        prev.kind === "loaded"
          ? { kind: "loaded", info: { ...prev.info, status: "deployed", smartAccount: result.smartAccount, owner: result.owner } }
          : prev,
      );
      // Reconcile with the canonical shape (e.g. `balanceUsdc`) in the background.
      if (token) void fetchSetup(token).then((info) => setLoad({ kind: "loaded", info })).catch(() => undefined);
    },
    [token],
  );

  if (load.kind === "loading") {
    return (
      <div className="mx-auto max-w-[640px] pt-8">
        <div aria-busy="true" aria-label="Loading your setup link" className="flex flex-col items-center gap-3">
          <Skeleton className="size-32 rounded-full" />
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>
    );
  }

  if (load.kind === "invalid") {
    return (
      <div className="mx-auto max-w-[480px] pt-8 text-center">
        <img src="/art/app/agent.webp" alt="" width={1024} height={1024} decoding="async" className="mx-auto size-28 md:size-32" />
        <h1 className="headline mt-2 text-heading-sm md:text-heading">This link isn&rsquo;t valid anymore</h1>
        <p className="mt-3 text-body text-graphite">Setup links are one-time and can expire. Ask your agent for a new setup link.</p>
      </div>
    );
  }

  if (load.kind === "error") {
    return (
      <div className="mx-auto max-w-[480px] pt-8">
        <InlineError title="Couldn't load this setup link." detail={load.message} onRetry={() => setReloadKey((k) => k + 1)} />
      </div>
    );
  }

  const { info } = load;

  if (info.status === "deployed" && info.smartAccount && info.owner) {
    // `token` is guaranteed set here — a missing token short-circuits to "invalid" before any fetch runs.
    return <DeployedCard info={info as SetupInfo & { smartAccount: Address; owner: Address }} justDeployedTxHash={justDeployedTxHash} />;
  }

  return <NeedsOwnerCard token={token!} info={info} onDeployed={handleDeployed} />;
}
