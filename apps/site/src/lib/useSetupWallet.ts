// Wallet-connect -> Base Sepolia state machine for `/setup` (P11.4). A
// deliberately smaller sibling of `useWalletSession`: `/setup` needs a
// connected wallet on the right network, never a SIWE session with the
// firewall, so this stops one step earlier instead of reusing (and
// complicating) the `/app` sign-in hook.

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { createTargetWalletClient, describeWalletError, ensureTargetChain, getInjectedProvider, TARGET_CHAIN } from "./wallet";

export type SetupWalletStage =
  | { kind: "checking" }
  | { kind: "no-wallet" }
  | { kind: "connect"; error?: string }
  | { kind: "wrong-network"; error?: string }
  | { kind: "ready"; address: Address };

export interface SetupWallet {
  stage: SetupWalletStage;
  connect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSetupWallet(): SetupWallet {
  const [stage, setStage] = useState<SetupWalletStage>({ kind: "checking" });

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
    setStage({ kind: "ready", address });
  }, []);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  const connect = useCallback(async () => {
    const provider = getInjectedProvider();
    if (!provider) return;
    try {
      await createTargetWalletClient(provider).requestAddresses();
      await evaluate();
    } catch (err) {
      setStage({ kind: "connect", error: describeWalletError(err, "Could not connect to your wallet.") });
    }
  }, [evaluate]);

  const switchNetwork = useCallback(async () => {
    const provider = getInjectedProvider();
    if (!provider) return;
    try {
      await ensureTargetChain(provider);
      await evaluate();
    } catch (err) {
      setStage({ kind: "wrong-network", error: describeWalletError(err, "Could not switch network.") });
    }
  }, [evaluate]);

  return { stage, connect, switchNetwork, refresh: evaluate };
}
