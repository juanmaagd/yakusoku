import TutorialVideo from "../ui/TutorialVideo";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DecisionReceipt } from "@yakusoku/shared";
import { SITE } from "../../config";
import {
  getApprovalStatus,
  listMandates,
  listOwnerPromises,
  listReceipts,
  ownerEventsUrl,
  UnauthorizedError,
  type ApprovalStatus,
  type OwnerPromise,
  type SerializedMandate,
} from "../../lib/api";
import { connectSseWithRetry, type SseConnectionStatus } from "../../lib/sse";
import { inputBase, primaryButton, textButton } from "../../lib/ui";
import { useOwnerControl } from "../ui/AppShell";
import EmptyState from "../ui/EmptyState";
import { IconArrowRight, IconChevronDown, IconCross, IconPlay, IconPlus } from "../ui/Icons";
import InlineError from "../ui/InlineError";
import Skeleton from "../ui/Skeleton";
import ApprovalBanner, { ApprovalResolved, type ApprovalOutcome } from "./ApprovalBanner";
import DecisionDetail from "./DecisionDetail";
import DecisionFeed from "./DecisionFeed";
import PromisesSection from "./PromisesSection";

// --- Live state: GET /receipts + GET /intents once, then SSE forever -------

interface LiveState {
  receipts: Map<string, DecisionReceipt>;
  mandates: Map<string, SerializedMandate>;
  promises: Map<string, OwnerPromise>;
  approvals: Map<string, ApprovalStatus>;
  fresh: Set<string>;
}

type LiveAction =
  | { type: "receipts"; receipts: DecisionReceipt[]; live?: boolean }
  | { type: "mandates"; mandates: SerializedMandate[] }
  // `GET /owner/promises` (index.ts) has no "since" filter — every refetch
  // hands back the FULL current list, so this replaces rather than merges
  // (unlike "receipts"/"mandates", which only ever add/overwrite one item).
  | { type: "promises"; promises: OwnerPromise[] }
  | { type: "approval"; receiptId: string; approval: ApprovalStatus };

function reducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case "receipts": {
      const receipts = new Map(state.receipts);
      let fresh = state.fresh;
      for (const r of action.receipts) {
        if (action.live && !receipts.has(r.receiptId)) fresh = new Set(fresh).add(r.receiptId);
        receipts.set(r.receiptId, r);
      }
      return { ...state, receipts, fresh };
    }
    case "mandates": {
      const mandates = new Map(state.mandates);
      for (const m of action.mandates) mandates.set(m.id, m);
      return { ...state, mandates };
    }
    case "promises":
      return { ...state, promises: new Map(action.promises.map((p) => [p.id, p])) };
    case "approval": {
      const approvals = new Map(state.approvals);
      approvals.set(action.receiptId, action.approval);
      return { ...state, approvals };
    }
  }
}

const initialState: LiveState = { receipts: new Map(), mandates: new Map(), promises: new Map(), approvals: new Map(), fresh: new Set() };

/** The neutral loading state shown in this tab while a stored session is
 * being verified (`useWalletSession`'s `"checking"` stage) — also `AppRoot`'s
 * server-rendered and first-client render for `/app/dashboard`, so there's
 * no hydration mismatch and no "Sign in" flash while the check is in flight. */
export function LiveSkeleton() {
  return (
    <section>
      <Skeleton className="h-7 w-40" />
      <div aria-busy="true" aria-label="Checking your session" className="mt-6 divide-y divide-hairline rounded-card border border-hairline">
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-2">
            <div>
              <Skeleton className="h-4 w-28" />
              <Skeleton className="mt-2 h-3 w-40" />
            </div>
            <div>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="mt-2 h-3 w-48" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface LiveFilterRequest {
  /** The promise/mandate id to filter by, or `undefined` for "All promises". */
  id: string | undefined;
  /** Bumped on every explicit navigation to this tab (a "Watch live" link, a
   * header tab click, or back/forward) so the effect below re-applies `id`
   * even when it repeats a value already selected, and never fires from an
   * unrelated re-render. */
  token: number;
}

interface LiveViewProps {
  sessionToken: string;
  onUnauthorized: () => void;
  onLiveStatus: (status: SseConnectionStatus) => void;
  /** Set by `AppRoot` (P5) whenever the owner navigates *to* this
   * already-mounted tab from elsewhere in the app — e.g. a "Watch live" link
   * on a different promise while this tab stayed alive in the background.
   * `initialPromiseFilter` below only ever reads the URL once, at mount, so
   * without this a second "Watch live" click while Live is already mounted
   * would silently keep showing the previous filter. */
  filterRequest?: LiveFilterRequest;
}

function initialPromiseFilter(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("promise") ?? undefined;
}

function initialReceiptFilter(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("receipt") ?? undefined;
}

/** The Live tab's signed-in content (S4): the owner's decisions kept live
 * over SSE. Formerly `/app/dashboard`'s whole React island (`DashboardApp`);
 * `AppRoot` (P5) now owns the wallet/SIWE session and the sign-in gate once,
 * shared with the Promises tab, and mounts this component the first time the
 * owner visits Live. It then stays mounted (hidden, not unmounted) so the
 * SSE connection and every fetched list survive switching back to Promises
 * and returning. */
export default function LiveView({ sessionToken, onUnauthorized, onLiveStatus, filterRequest }: LiveViewProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [load, setLoad] = useState<{ kind: "loading" } | { kind: "loaded" } | { kind: "error"; message: string }>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [connStatus, setConnStatus] = useState<SseConnectionStatus>("connecting");
  const [selectedMandateId, setSelectedMandateId] = useState<string | undefined>(initialPromiseFilter);
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | undefined>(initialReceiptFilter);
  const [resolved, setResolved] = useState<ApprovalOutcome | undefined>();
  const fetchedApprovalsRef = useRef(new Set<string>());
  const pendingRef = useRef(new Set<string>());
  const ownerControl = useOwnerControl();
  const isDesktop = useMediaQuery("(min-width: 1024px)");

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

  // dashboard-promises (D2) — fetched independently of the receipts/mandates
  // `Promise.all` below: a hiccup here should never blank out the existing
  // decision feed, it just means no World ID promises show up this round.
  const fetchPromises = useCallback(async () => {
    try {
      const promises = await listOwnerPromises(sessionToken);
      dispatch({ type: "promises", promises });
    } catch (err) {
      handleUnauthorized(err);
    }
  }, [sessionToken, handleUnauthorized]);

  // --- Initial load ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: "loading" });
    void (async () => {
      try {
        const [receipts, mandates] = await Promise.all([listReceipts(sessionToken), listMandates(sessionToken)]);
        if (cancelled) return;
        dispatch({ type: "receipts", receipts });
        dispatch({ type: "mandates", mandates });
        setLoad({ kind: "loaded" });
        for (const r of receipts) if (r.state === "awaiting_world_id") void fetchApproval(r.receiptId);
      } catch (err) {
        if (cancelled) return;
        if (!handleUnauthorized(err)) setLoad({ kind: "error", message: err instanceof Error ? err.message : "Could not load your decisions." });
      }
    })();
    void fetchPromises();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchApproval/fetchPromises are stable per sessionToken
  }, [sessionToken, reloadKey]);

  // --- Live updates (fetch-stream SSE, never EventSource: see lib/sse.ts) ----
  useEffect(() => {
    const disconnect = connectSseWithRetry(
      ownerEventsUrl(sessionToken),
      (status) => {
        setConnStatus(status);
        onLiveStatus(status);
      },
      (frame) => {
        switch (frame.event) {
          case "intent.created":
          case "intent.revoked":
            dispatch({ type: "mandates", mandates: [JSON.parse(frame.data) as SerializedMandate] });
            break;
          case "decision": {
            const receipt = JSON.parse(frame.data) as DecisionReceipt;
            dispatch({ type: "receipts", receipts: [receipt], live: true });
            if (receipt.state === "awaiting_world_id") void fetchApproval(receipt.receiptId);
            // A decision may have spent against (or activated) a promise's
            // budget — refetch rather than try to patch one in from the
            // receipt alone.
            void fetchPromises();
            break;
          }
          case "settlement.reported":
            dispatch({ type: "receipts", receipts: [JSON.parse(frame.data) as DecisionReceipt] });
            void fetchPromises();
            break;
          case "promise.requested":
          case "promise.approved":
          case "promise.denied":
            void fetchPromises();
            break;
          case "approval.requested": {
            const data = JSON.parse(frame.data) as { receiptId: string };
            fetchedApprovalsRef.current.delete(data.receiptId); // force a fresh fetch — it just started
            void fetchApproval(data.receiptId);
            break;
          }
          default:
            break; // heartbeat; approval.resolved (a "decision" frame always follows it); control.changed (never on an owner stream)
        }
      },
    );
    return disconnect;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchApproval/fetchPromises are stable per sessionToken
  }, [sessionToken]);

  const mandates = useMemo(() => [...state.mandates.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.mandates]);
  const promises = useMemo(() => [...state.promises.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.promises]);

  // dashboard-promises (D2) fix: `GET /receipts`/`GET /events?session=...`
  // are already owner-scoped server-side (index.ts's
  // `listOwnedMandateIds`/`eventOwnerAddress`), so every receipt already in
  // `state.receipts` belongs to this wallet — whether it's a legacy
  // wallet-signed intent or a World ID promise. This used to re-filter by
  // `mandates` (the wallet-only `GET /intents` list), which silently
  // dropped every promise-backed receipt since a promise id never appears
  // there.
  const ownedReceipts = useMemo(() => [...state.receipts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.receipts]);

  const visibleReceipts = useMemo(
    () => (selectedMandateId ? ownedReceipts.filter((r) => r.intentId === selectedMandateId) : ownedReceipts),
    [ownedReceipts, selectedMandateId],
  );

  // Approvals interrupt regardless of the promise filter.
  const pendingApprovals = useMemo(() => ownedReceipts.filter((r) => r.state === "awaiting_world_id"), [ownedReceipts]);

  // When a banner resolves, say how for a few seconds.
  useEffect(() => {
    const now = new Set(pendingApprovals.map((r) => r.receiptId));
    for (const id of pendingRef.current) {
      if (now.has(id)) continue;
      const r = state.receipts.get(id);
      if (!r) continue;
      const outcome: ApprovalOutcome =
        r.verdict === "pay" ? "approved" : r.state === "world_id_expired" ? "expired" : r.state === "world_id_denied" && !r.worldId?.status?.match(/paused|revoked|error/) ? "denied" : "stopped";
      setResolved(outcome);
    }
    pendingRef.current = now;
  }, [pendingApprovals, state.receipts]);

  useEffect(() => {
    if (!resolved) return;
    const timer = window.setTimeout(() => setResolved(undefined), 4000);
    return () => window.clearTimeout(timer);
  }, [resolved]);

  // A "Watch live" link (or the header tab, or back/forward) navigating to
  // this already-mounted tab: apply its filter the same way `selectPromise`
  // would, but without touching history — `AppRoot` already pushed/replaced
  // the URL this filter came from.
  useEffect(() => {
    if (!filterRequest) return;
    setSelectedMandateId(filterRequest.id);
    setSelectedReceiptId(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react only to a new navigation (token), not to filterRequest.id's identity
  }, [filterRequest?.token]);

  function selectPromise(id: string | undefined) {
    setSelectedMandateId(id);
    setSelectedReceiptId(undefined);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("promise", id);
    else url.searchParams.delete("promise");
    window.history.replaceState(null, "", url);
  }

  const selectedReceipt = selectedReceiptId ? state.receipts.get(selectedReceiptId) : undefined;

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div>
          <h1 className="headline text-heading-sm md:text-heading">
            <strong>Live</strong> decisions
          </h1>
          <div className="mt-2">
            <ConnectionChip status={connStatus} />
          </div>
        </div>
        {mandates.length > 0 && <PromiseFilter mandates={mandates} selectedId={selectedMandateId} onSelect={selectPromise} />}
      </div>

      <PromisesSection promises={promises} />

      <div className="mt-6 space-y-4">
        {ownerControl?.control.paused && <PausedBanner onResume={ownerControl.resume} />}
        {resolved && <ApprovalResolved outcome={resolved} />}
        {pendingApprovals.map((r) => (
          <ApprovalBanner key={r.receiptId} receipt={r} approval={state.approvals.get(r.receiptId)} />
        ))}
      </div>

      <div className="mt-6">
        {load.kind === "error" && <InlineError title="Couldn't load your decisions." detail={load.message} onRetry={() => setReloadKey((k) => k + 1)} />}

        {load.kind === "loading" && (
          <div aria-busy="true" aria-label="Loading your decisions" className="divide-y divide-hairline rounded-card border border-hairline">
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid grid-cols-1 gap-3 px-4 py-4 sm:grid-cols-2">
                <div>
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="mt-2 h-3 w-40" />
                </div>
                <div>
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="mt-2 h-3 w-48" />
                </div>
              </div>
            ))}
          </div>
        )}

        {load.kind === "loaded" && mandates.length === 0 && promises.length === 0 && (
          <div className="rounded-card border border-hairline">
            <EmptyState art="/art/app/agent.webp" title="No intents yet" body="Your agent can only pay against an intent you signed. Sign one first.">
              <a href={SITE.appRoute} className={primaryButton}>
                <IconPlus size={14} />
                New intent
              </a>
            </EmptyState>
          </div>
        )}

        {load.kind === "loaded" && (mandates.length > 0 || promises.length > 0) && visibleReceipts.length === 0 && (
          <div className="rounded-card border border-hairline">
            <EmptyState
              art="/art/app/agent.webp"
              title="No payments yet."
              body="When your agent asks the firewall to pay, every decision shows up here in real time."
            >
              <p className="max-w-[46ch] text-body-sm text-graphite">Connect your agent with the key or account it received when the intent was set up.</p>
              <a href={SITE.appRoute} className={textButton}>
                Go to intents
                <IconArrowRight size={14} />
              </a>
            </EmptyState>
          </div>
        )}

        {load.kind === "loaded" && visibleReceipts.length > 0 && (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
            <DecisionFeed receipts={visibleReceipts} selectedReceiptId={selectedReceiptId} freshIds={state.fresh} onSelect={setSelectedReceiptId} />
            {isDesktop && (
              <aside className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-card border border-hairline bg-surface p-5">
                {selectedReceipt ? (
                  <DecisionDetail key={selectedReceipt.receiptId} receipt={selectedReceipt} sessionToken={sessionToken} />
                ) : (
                  <p className="text-body-sm text-graphite">Select a decision to see what happened, step by step.</p>
                )}
              </aside>
            )}
          </div>
        )}
      </div>

      {!isDesktop && selectedReceipt && <DetailSheet receipt={selectedReceipt} sessionToken={sessionToken} onClose={() => setSelectedReceiptId(undefined)} />}
      <TutorialVideo topic="live" />
    </section>
  );
}

function ConnectionChip({ status }: { status: SseConnectionStatus }) {
  const view = {
    connected: { dot: "bg-verified", text: "Live", tone: "text-ink" },
    connecting: { dot: "bg-ask", text: "Connecting…", tone: "text-ask-ink" },
    disconnected: { dot: "bg-ask", text: "Reconnecting…", tone: "text-ask-ink" },
  }[status];
  return (
    <span role="status" className={`label inline-flex items-center gap-2 ${view.tone}`}>
      <span className={`size-1.5 rounded-full ${view.dot} ${status === "connected" ? "" : "animate-pulse"}`} aria-hidden="true" />
      {view.text}
    </span>
  );
}

function PromiseFilter({
  mandates,
  selectedId,
  onSelect,
}: {
  mandates: SerializedMandate[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  return (
    <label className="flex w-full flex-col gap-1.5 sm:w-auto">
      <span className="text-caption text-graphite">Showing</span>
      <span className="relative">
        <select
          value={selectedId ?? ""}
          onChange={(e) => onSelect(e.target.value || undefined)}
          className={`${inputBase} appearance-none py-2 pr-9 text-body-sm sm:w-[320px]`}
        >
          <option value="">All intents</option>
          {mandates.map((m) => (
            <option key={m.id} value={m.id}>
              {truncate(m.message.task, 56)}
              {m.revoked ? " (revoked)" : ""}
            </option>
          ))}
        </select>
        <IconChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-graphite" />
      </span>
    </label>
  );
}

function PausedBanner({ onResume }: { onResume: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="flex flex-col gap-4 rounded-card border border-ink p-5 md:flex-row md:items-center">
      <img src="/art/app/pause.webp" alt="" width={1024} height={1024} decoding="async" className="hidden size-20 shrink-0 md:block" />
      <div className="min-w-0 flex-1">
        <h2 className="text-subheading font-medium text-ink">All your agents are paused.</h2>
        <p className="mt-1 text-body-sm text-graphite">The firewall refuses to sign for any of your intents until you resume.</p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onResume();
          } finally {
            setBusy(false);
          }
        }}
        className={`${primaryButton} self-start md:self-auto`}
      >
        <IconPlay size={14} />
        {busy ? "Resuming…" : "Resume"}
      </button>
    </section>
  );
}

function DetailSheet({ receipt, sessionToken, onClose }: { receipt: DecisionReceipt; sessionToken: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Decision detail">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-ink/40" />
      <div className="sheet-in relative max-h-[85vh] overflow-y-auto rounded-t-[12px] border-t border-hairline bg-surface px-5 pb-8 pt-4">
        <div className="mb-3 flex justify-end">
          <button type="button" onClick={onClose} className="inline-flex size-8 items-center justify-center rounded-btn text-graphite hover:bg-fog hover:text-ink" aria-label="Close">
            <IconCross size={16} />
          </button>
        </div>
        <DecisionDetail receipt={receipt} sessionToken={sessionToken} />
      </div>
    </div>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" ? true : window.matchMedia(query).matches));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
