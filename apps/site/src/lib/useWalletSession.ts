// Shared wallet-connect -> Base Sepolia -> SIWE sign-in state machine (P5's
// AppFlow.tsx originally inlined this; extracted in P6 so `/app/dashboard`
// reuses the exact same flow instead of a second hand-rolled copy — see the
// P6 brief: "Auth gate: reuse P5's connect + sign-in"). Since a later P5
// pass, `AppRoot.tsx` is the only caller (once per document load), shared by
// both tabs; the promises/live views built on top of this hook are
// unchanged.

import { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { createSiweMessage } from "viem/siwe";
import { SITE } from "../config";
import { fetchMe, fetchNonce, logoutSession, verifySiwe } from "./api";
import { clearSessionToken, readSessionToken, writeSessionToken } from "./storage";
import { createTargetWalletClient, describeWalletError, ensureTargetChain, getInjectedProvider, TARGET_CHAIN } from "./wallet";

export type WalletSessionStage =
  | { kind: "checking" }
  | { kind: "no-wallet" }
  | { kind: "connect"; error?: string }
  | { kind: "wrong-network"; error?: string }
  | { kind: "sign-in"; address: Address; error?: string; busy?: boolean }
  | { kind: "signed-in"; address: Address; sessionToken: string };

export interface WalletSession {
  stage: WalletSessionStage;
  connect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Drops the stored session and re-evaluates from scratch. Every dashboard
   * API caller that gets back a 401 should call this (P6 brief: "401
   * anywhere -> back to sign-in") instead of showing a dead screen. */
  handleUnauthorized: () => void;
}

export function useWalletSession(): WalletSession {
  const [stage, setStage] = useState<WalletSessionStage>({ kind: "checking" });

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

  const signIn = useCallback(async () => {
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

  const signOut = useCallback(async () => {
    if (stage.kind !== "signed-in") return;
    await logoutSession(stage.sessionToken);
    clearSessionToken();
    await evaluate();
  }, [stage, evaluate]);

  const handleUnauthorized = useCallback(() => {
    clearSessionToken();
    void evaluate();
  }, [evaluate]);

  return { stage, connect, switchNetwork, signIn, signOut, handleUnauthorized };
}
