import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DecisionReceipt } from "@yakusoku/shared";
import { agentCliCommand, SITE } from "../../config";
import {
  fetchOwnerControl,
  getApprovalStatus,
  listMandates,
  listReceipts,
  ownerEventsUrl,
  pauseOwnerSigning,
  resumeOwnerSigning,
  revokeMandate,
  UnauthorizedError,
  type ApprovalStatus,
  type OwnerControlState,
  type SerializedMandate,
} from "../../lib/api";
import { connectSseWithRetry } from "../../lib/sse";
import { primaryButton } from "../../lib/ui";
import { useWalletSession, type WalletSessionStage } from "../../lib/useWalletSession";
import ApprovalCard from "./ApprovalCard";
import DashboardHeader from "./DashboardHeader";
import MandateFilterList from "./MandateFilterList";
import ReceiptDetailPanel from "./ReceiptDetailPanel";
import Timeline from "./Timeline";

// --- Live state, kept current by GET /receipts + GET /intents (once) then
// SSE (forever) -------------------------------------------------------------

interface DashboardState {
  receipts: Map<string, DecisionReceipt>;
  mandates: Map<string, SerializedMandate>;
  approvals: Map<string, ApprovalStatus>;
  control: OwnerControlState;
}

type DashboardAction =
  | { type: "receipts"; receipts: DecisionReceipt[] }
  | { type: "mandates"; mandates: SerializedMandate[] }
  | { type: "control"; control: OwnerControlState }
  | { type: "approval"; receiptId: string; approval: ApprovalStatus };

function reducer(state: DashboardState, action: DashboardAction): DashboardState {
  switch (action.type) {
    case "receipts": {
      const receipts = new Map(state.receipts);
      for (const r of action.receipts) receipts.set(r.receiptId, r);
      return { ...state, receipts };
    }
    case "mandates": {
      const mandates = new Map(state.mandates);
      for (const m of action.mandates) mandates.set(m.id, m);
      return { ...state, mandates };
    }
    case "control":
      return { ...state, control: action.control };
    case "approval": {
      const approvals = new Map(state.approvals);
      approvals.set(action.receiptId, action.approval);
      return { ...state, approvals };
    }
  }
}

const initialState: DashboardState = { receipts: new Map(), mandates: new Map(), approvals: new Map(), control: { paused: false } };

/** `/app/dashboard`'s React island (P6). Gates on the same wallet+SIWE
 * session `/app` uses (`useWalletSession`); once signed in, loads the
 * owner's mandates/receipts/control once and keeps them live over SSE. */
export default function DashboardApp() {
  const session = useWalletSession();

  if (session.stage.kind !== "signed-in") {
    return <AuthRequired stage={session.stage} />;
  }

  return (
    <DashboardContent
      key={session.stage.sessionToken}
      address={session.stage.address}
      sessionToken={session.stage.sessionToken}
      onSignOut={session.signOut}
      onUnauthorized={session.handleUnauthorized}
    />
  );
}

function AuthRequired({ stage }: { stage: WalletSessionStage }) {
  const detail: Record<WalletSessionStage["kind"], string> = {
    checking: "Checking your wallet…",
    "no-wallet": `${SITE.name} needs a browser wallet to identify you as a mandate owner.`,
    connect: "Connect your wallet to see your live dashboard.",
    "wrong-network": `Switch to ${SITE.network} to see your live dashboard.`,
    "sign-in": "Sign in with your wallet to see your live dashboard.",
    "signed-in": "",
  };
  return (
    <div className="mx-auto mt-12 w-full max-w-[560px] rounded-card border border-black/[0.08] bg-surface p-8 text-center md:mt-20 md:p-10">
      <h1 className="text-heading-sm font-semibold text-ink">Sign in to see your dashboard</h1>
      <p className="mt-3 text-body text-graphite">{detail[stage.kind]}</p>
      <a href={SITE.appRoute} className={`${primaryButton} mt-5 inline-flex`}>
        Go to {SITE.appRoute}
      </a>
      <p className="mt-3 text-caption text-stone">Come back to this page after you sign in — your session carries over.</p>
    </div>
  );
}

interface DashboardContentProps {
  address: string;
  sessionToken: string;
  onSignOut: () => Promise<void>;
  onUnauthorized: () => void;
}

function DashboardContent({ address, sessionToken, onSignOut, onUnauthorized }: DashboardContentProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [connStatus, setConnStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [selectedMandateId, setSelectedMandateId] = useState<string | undefined>();
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | undefined>();
  const fetchedApprovalsRef = useRef(new Set<string>());

  const handleUnauthorized = useCallback(
    (err: unknown) => {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return true;
      }
      return false;
    },
    [onUnauthorized],
  );

  const fetchApproval = useCallback(
    async (receiptId: string) => {
      if (fetchedApprovalsRef.current.has(receiptId)) return;
      fetchedApprovalsRef.current.add(receiptId);
      try {
        const approval = await getApprovalStatus(sessionToken, receiptId);
        dispatch({ type: "approval", receiptId, approval });
      } catch (err) {
        fetchedApprovalsRef.current.delete(receiptId);
        handleUnauthorized(err);
      }
    },
    [sessionToken, handleUnauthorized],
  );

  // --- Initial load -----------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [receipts, mandates, control] = await Promise.all([
          listReceipts(sessionToken),
          listMandates(sessionToken),
          fetchOwnerControl(sessionToken),
        ]);
        if (cancelled) return;
        dispatch({ type: "receipts", receipts });
        dispatch({ type: "mandates", mandates });
        dispatch({ type: "control", control });
        for (const r of receipts) if (r.state === "awaiting_world_id") void fetchApproval(r.receiptId);
      } catch (err) {
        if (cancelled) return;
        if (!handleUnauthorized(err)) setLoadError(err instanceof Error ? err.message : "Could not load the dashboard.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchApproval is stable per sessionToken
  }, [sessionToken]);

  // --- Live updates (SSE) -------------------------------------------------
  // A fetch-based stream, not the browser's native `EventSource` — see
  // lib/sse.ts's file header for why.
  useEffect(() => {
    const disconnect = connectSseWithRetry(ownerEventsUrl(sessionToken), setConnStatus, (frame) => {
      switch (frame.event) {
        case "intent.created":
        case "intent.revoked":
          dispatch({ type: "mandates", mandates: [JSON.parse(frame.data) as SerializedMandate] });
          break;
        case "decision": {
          const receipt = JSON.parse(frame.data) as DecisionReceipt;
          dispatch({ type: "receipts", receipts: [receipt] });
          if (receipt.state === "awaiting_world_id") void fetchApproval(receipt.receiptId);
          break;
        }
        case "settlement.reported":
          dispatch({ type: "receipts", receipts: [JSON.parse(frame.data) as DecisionReceipt] });
          break;
        case "approval.requested": {
          const data = JSON.parse(frame.data) as { receiptId: string };
          fetchedApprovalsRef.current.delete(data.receiptId); // force a fresh fetch — it just started
          void fetchApproval(data.receiptId);
          break;
        }
        default:
          break; // heartbeat; approval.resolved (a "decision" frame always follows it); control.changed (never delivered on an owner-scoped stream)
      }
    });
    return disconnect;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchApproval is stable per sessionToken
  }, [sessionToken]);

  const mandates = useMemo(() => [...state.mandates.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.mandates]);

  const receiptsForOwner = useMemo(() => {
    const ownedIntentIds = new Set(mandates.map((m) => m.id));
    return [...state.receipts.values()]
      .filter((r) => ownedIntentIds.has(r.intentId))
      .filter((r) => !selectedMandateId || r.intentId === selectedMandateId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [state.receipts, mandates, selectedMandateId]);

  const pendingApprovals = useMemo(() => receiptsForOwner.filter((r) => r.state === "awaiting_world_id"), [receiptsForOwner]);

  const selectedReceipt = selectedReceiptId ? state.receipts.get(selectedReceiptId) : undefined;
  const selectedMandate = selectedMandateId ? state.mandates.get(selectedMandateId) : undefined;

  async function handleRevoke(id: string) {
    try {
      await revokeMandate(sessionToken, id);
    } catch (err) {
      handleUnauthorized(err);
      throw err;
    }
  }

  async function handlePause(reason?: string) {
    try {
      const control = await pauseOwnerSigning(sessionToken, reason);
      dispatch({ type: "control", control });
    } catch (err) {
      handleUnauthorized(err);
    }
  }

  async function handleResume() {
    try {
      const control = await resumeOwnerSigning(sessionToken);
      dispatch({ type: "control", control });
    } catch (err) {
      handleUnauthorized(err);
    }
  }

  const emptyState =
    mandates.length === 0 ? (
      <>
        <p className="text-body text-graphite">No mandates yet — create one to give your agent something to spend against.</p>
        <a href={SITE.appRoute} className={`${primaryButton} mt-3 inline-flex`}>
          Create a mandate
        </a>
      </>
    ) : selectedMandate ? (
      <>
        <p className="text-body text-graphite">No activity yet for &ldquo;{selectedMandate.message.task}&rdquo;.</p>
        <p className="mx-auto mt-2 max-w-[440px] text-body-sm text-graphite">
          Hand your agent the key you saved when you created this mandate:
        </p>
        <pre className="mx-auto mt-2 max-w-[440px] overflow-x-auto rounded-btn border border-black/[0.1] bg-canvas p-3 text-left text-caption text-charcoal">
          <code>{agentCliCommand(selectedMandate.id, "<your-agent-key>")}</code>
        </pre>
      </>
    ) : (
      <p className="text-body text-graphite">
        No activity yet — once your agent asks the firewall to sign something, it shows up here live.
      </p>
    );

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-5">
      <DashboardHeader address={address} control={state.control} onPause={handlePause} onResume={handleResume} onSignOut={onSignOut} />

      {connStatus !== "connected" && (
        <p className="rounded-btn border border-saffron/40 bg-saffron/10 px-3 py-2 text-body-sm text-saffron">
          {connStatus === "connecting" ? "Connecting to live updates…" : "Lost the live connection — reconnecting…"}
        </p>
      )}
      {loadError && <p className="rounded-btn border border-vermillion/40 bg-vermillion/10 px-3 py-2 text-body-sm text-vermillion">{loadError}</p>}

      <MandateFilterList mandates={mandates} selectedId={selectedMandateId} onSelect={setSelectedMandateId} onRevoke={handleRevoke} />

      {pendingApprovals.map((r) => (
        <ApprovalCard
          key={r.receiptId}
          data={{
            receiptId: r.receiptId,
            verificationUri: state.approvals.get(r.receiptId)?.verificationUri,
            userCode: state.approvals.get(r.receiptId)?.userCode,
            expiresAt: state.approvals.get(r.receiptId)?.expiresAt,
            summary: r.task,
          }}
        />
      ))}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Timeline receipts={receiptsForOwner} selectedReceiptId={selectedReceiptId} onSelect={setSelectedReceiptId} emptyState={emptyState} />
        <aside className="rounded-card border border-black/[0.08] bg-surface p-5 lg:sticky lg:top-5">
          {selectedReceipt ? (
            <ReceiptDetailPanel receipt={selectedReceipt} approval={state.approvals.get(selectedReceipt.receiptId)} />
          ) : (
            <p className="text-body-sm text-stone">Select a row to see the decision detail.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
