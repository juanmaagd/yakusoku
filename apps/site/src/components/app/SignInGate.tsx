import TutorialVideo from "../ui/TutorialVideo";
import type { ReactNode } from "react";
import { SITE } from "../../config";
import { shortAddress } from "../../lib/format";
import type { WalletSession, WalletSessionStage } from "../../lib/useWalletSession";
import { errorText, primaryButton } from "../../lib/ui";
import { IconExternal, StatusMark } from "../ui/Icons";
import Skeleton from "../ui/Skeleton";

type StepState = "done" | "active" | "todo";

function stepStates(kind: WalletSessionStage["kind"]): [StepState, StepState, StepState] {
  switch (kind) {
    case "checking":
      return ["todo", "todo", "todo"];
    case "no-wallet":
    case "connect":
      return ["active", "todo", "todo"];
    case "wrong-network":
      return ["done", "active", "todo"];
    case "sign-in":
      return ["done", "done", "active"];
    case "signed-in":
      return ["done", "done", "done"];
  }
}

/** S0: wallet, network and SIWE sign-in as one checklist that ticks in place,
 * instead of one full screen per step. Shared by /app and /app/dashboard. */
export default function SignInGate({ session }: { session: WalletSession }) {
  const { stage } = session;
  const [s1, s2, s3] = stepStates(stage.kind);
  const error = "error" in stage ? stage.error : undefined;

  return (
    <>
      <div className="mx-auto flex max-w-[480px] flex-col items-center pt-2 md:pt-8">
        <img src="/art/app/wallet.webp" alt="" width={1024} height={1024} decoding="async" className="size-32 md:size-36" />
        <h1 className="headline mt-2 text-center text-heading-sm md:text-heading">
          Sign in to <strong>{SITE.name}</strong>
        </h1>
        <p className="mt-3 text-center text-body text-graphite">Your wallet is your account. Nothing here moves funds.</p>

        {stage.kind === "checking" ? (
          <ol aria-busy="true" aria-label="Checking your wallet" className="mt-8 w-full divide-y divide-hairline rounded-card border border-hairline">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-4 px-5 py-4">
                <Skeleton className="size-5 rounded-full" />
                <Skeleton className="h-3.5 w-40" />
              </li>
            ))}
          </ol>
        ) : (
          <ol className="mt-8 w-full divide-y divide-hairline rounded-card border border-hairline bg-surface">
            <Step n={1} state={s1} error={error} title="Connect a wallet" doneText={stage.kind === "sign-in" ? `Connected · ${shortAddress(stage.address)}` : "Connected"}>
              {stage.kind === "no-wallet" ? (
                <>
                  <p className="text-body-sm text-graphite">No browser wallet found.</p>
                  <a href="https://metamask.io/download/" target="_blank" rel="noreferrer" className={`${primaryButton} mt-3`}>
                    Get MetaMask
                    <IconExternal size={14} />
                  </a>
                </>
              ) : (
                <button type="button" onClick={() => void session.connect()} className={primaryButton}>
                  Connect wallet
                </button>
              )}
            </Step>
            <Step n={2} state={s2} error={error} title={`Switch to ${SITE.network}`} doneText={`On ${SITE.network}`}>
              <p className="text-body-sm text-graphite">Intents are signed on {SITE.network}, a testnet.</p>
              <button type="button" onClick={() => void session.switchNetwork()} className={`${primaryButton} mt-3`}>
                Switch network
              </button>
            </Step>
            <Step n={3} state={s3} error={error} title="Sign in" doneText="Signed in">
              <p className="text-body-sm text-graphite">A signature, not a transaction. It&rsquo;s free.</p>
              {stage.kind === "sign-in" && (
                <button type="button" onClick={() => void session.signIn()} disabled={stage.busy} className={`${primaryButton} mt-3`}>
                  {stage.busy ? "Waiting for your wallet…" : "Sign in with wallet"}
                </button>
              )}
            </Step>
          </ol>
        )}

      </div>
      <TutorialVideo topic="signin" />
    </>
  );
}

interface StepProps {
  n: number;
  state: StepState;
  title: string;
  doneText: string;
  error?: string;
  children: ReactNode;
}

function Step({ n, state, title, doneText, error, children }: StepProps) {
  return (
    <li className="flex gap-4 px-5 py-4" aria-current={state === "active" ? "step" : undefined}>
      {state === "done" ? (
        <StatusMark kind="pass" />
      ) : (
        <span
          className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${
            state === "active" ? "border-ink text-ink" : "border-hairline-strong text-graphite"
          }`}
        >
          {n}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className={`text-body leading-5 ${state === "todo" ? "text-graphite" : "font-medium text-ink"}`}>{title}</p>
        {state === "done" && <p className="mt-0.5 text-body-sm text-graphite">{doneText}</p>}
        {state === "active" && (
          <div className="mt-2">
            {children}
            {error && (
              <p className={`${errorText} mt-2`} role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
