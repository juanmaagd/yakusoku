import TutorialVideo from "../ui/TutorialVideo";
import { useCallback, useEffect, useState } from "react";
import { MANDATE_CATEGORY_OPTIONS, SITE } from "../../config";
import { listMandates, listOwnerPromises, revokeMandate, revokeOwnerPromise, type OwnerPromise, type SerializedMandate } from "../../lib/api";
import { formatRemaining, formatUsdcFixed, shortHex } from "../../lib/format";
import { dangerOutlinedButton, primaryButton, textButton } from "../../lib/ui";
import ConfirmInline from "../ui/ConfirmInline";
import EmptyState from "../ui/EmptyState";
import { IconArrowRight, IconCheck, IconCopy, IconPlus } from "../ui/Icons";
import InlineError from "../ui/InlineError";
import Skeleton from "../ui/Skeleton";
import StatusPill from "../ui/StatusPill";

interface PromiseListProps {
  sessionToken: string;
  /** Bumped by the parent after a new promise is created so the list refetches. */
  refreshSignal: number;
  onNew: () => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; mandates: SerializedMandate[]; worldIdPromises: OwnerPromise[] };

/** S1: the owner's promises, with budget left, time left and what you do with
 * one. Two sources: World ID promises on the accounts this wallet owns
 * (`GET /owner/promises`, linked at /setup) and legacy wallet-signed mandates
 * (`GET /intents`), which are the only ones that can be revoked from here. */
export default function PromiseList({ sessionToken, refreshSignal, onNew }: PromiseListProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [mandates, worldIdPromises] = await Promise.all([listMandates(sessionToken), listOwnerPromises(sessionToken)]);
      setState({ kind: "loaded", mandates: sortPromises(mandates), worldIdPromises: sortWorldIdPromises(worldIdPromises) });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Could not load your promises." });
    }
  }, [sessionToken]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  // Expiry countdowns move once a minute.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  async function handleRevoke(id: string) {
    await revokeMandate(sessionToken, id);
    const mandates = await listMandates(sessionToken);
    setState((prev) => ({
      kind: "loaded",
      mandates: sortPromises(mandates),
      worldIdPromises: prev.kind === "loaded" ? prev.worldIdPromises : [],
    }));
  }

  async function handleRevokeWorldId(id: string) {
    await revokeOwnerPromise(sessionToken, id);
    const worldIdPromises = await listOwnerPromises(sessionToken);
    setState((prev) => ({
      kind: "loaded",
      mandates: prev.kind === "loaded" ? prev.mandates : [],
      worldIdPromises: sortWorldIdPromises(worldIdPromises),
    }));
  }

  const hasPromises = state.kind === "loaded" && (state.mandates.length > 0 || state.worldIdPromises.length > 0);

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="max-w-[640px]">
          <h1 className="headline text-heading-sm md:text-heading">
            Your <strong>promises</strong>
          </h1>
          <p className="mt-2 text-body text-graphite">
            What your agent may buy, with how much, until when. Enforced before every payment.
          </p>
        </div>
        {hasPromises && (
          <button type="button" onClick={onNew} className={primaryButton}>
            <IconPlus size={14} />
            New promise
          </button>
        )}
      </div>

      <div className="mt-8">
        {state.kind === "loading" && (
          <ul aria-busy="true" aria-label="Loading your promises" className="grid gap-4 lg:grid-cols-2">
            {[0, 1].map((i) => (
              <li key={i} className="rounded-card border border-hairline p-5">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="mt-4 h-5 w-4/5" />
                <Skeleton className="mt-5 h-1 w-full" />
                <Skeleton className="mt-4 h-3 w-1/2" />
              </li>
            ))}
          </ul>
        )}

        {state.kind === "error" && <InlineError title="Couldn't load your promises." detail={state.message} onRetry={() => void load()} />}

        {state.kind === "loaded" && !hasPromises && (
          <div className="rounded-card border border-hairline">
            <EmptyState
              art="/art/app/intent.webp"
              title="No promises yet"
              body="Sign your first promise. Your agent gets a key that can only ask the firewall to pay for it."
            >
              <button type="button" onClick={onNew} className={primaryButton}>
                <IconPlus size={14} />
                New promise
              </button>
            </EmptyState>
          </div>
        )}

        {hasPromises && (
          <ul className="grid gap-4 lg:grid-cols-2">
            {state.worldIdPromises.map((p) => (
              <WorldIdPromiseCard key={p.id} promise={p} onRevoke={handleRevokeWorldId} />
            ))}
            {state.mandates.map((mandate) => (
              <PromiseCard key={mandate.id} mandate={mandate} onRevoke={handleRevoke} />
            ))}
          </ul>
        )}
      </div>
      <TutorialVideo topic="promises" />
    </section>
  );
}

type PromiseStatus = "active" | "revoked" | "expired";

function promiseStatus(mandate: SerializedMandate): PromiseStatus {
  if (mandate.revoked) return "revoked";
  return Number(mandate.message.expiry) * 1000 <= Date.now() ? "expired" : "active";
}

function sortPromises(mandates: SerializedMandate[]): SerializedMandate[] {
  return [...mandates].sort((a, b) => {
    const aLive = promiseStatus(a) === "active" ? 0 : 1;
    const bLive = promiseStatus(b) === "active" ? 0 : 1;
    return aLive - bLive || b.createdAt.localeCompare(a.createdAt);
  });
}

type WorldIdStatus = "active" | "pending" | "expired" | "revoked" | "denied" | "error";

/** The firewall only flips `status` to `expired` lazily, so an `active`
 * promise past its expiry is shown as expired here. */
function worldIdStatus(p: OwnerPromise): WorldIdStatus {
  if (p.status === "pending_approval") return "pending";
  if (p.status !== "active") return p.status;
  return Number(p.expiry) * 1000 <= Date.now() ? "expired" : "active";
}

function sortWorldIdPromises(promises: OwnerPromise[]): OwnerPromise[] {
  return [...promises].sort((a, b) => {
    const aLive = worldIdStatus(a) === "active" ? 0 : 1;
    const bLive = worldIdStatus(b) === "active" ? 0 : 1;
    return aLive - bLive || b.createdAt.localeCompare(a.createdAt);
  });
}

function merchantHost(merchant: string | undefined): string | undefined {
  if (!merchant) return undefined;
  try {
    return new URL(merchant).host;
  } catch {
    return merchant;
  }
}

/** A World ID promise: approved on the phone, spent from the account's smart
 * account, bound to one merchant. An active one can be revoked by its
 * linked owner straight from here (P6, `POST /owner/promises/:id/revoke`). */
function WorldIdPromiseCard({ promise, onRevoke }: { promise: OwnerPromise; onRevoke: (id: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const status = worldIdStatus(promise);
  const expiryMs = Number(promise.expiry) * 1000;
  const absolute = new Date(expiryMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const live = status === "active";
  const host = merchantHost(promise.merchant);

  return (
    <li className="flex flex-col rounded-card border border-hairline bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        {status === "active" && <StatusPill tone="neutral">Active</StatusPill>}
        {status === "pending" && <StatusPill tone="ask">Pending approval</StatusPill>}
        {status === "expired" && <StatusPill tone="muted">Expired</StatusPill>}
        {(status === "revoked" || status === "denied" || status === "error") && (
          <StatusPill tone="refuse">{status === "revoked" ? "Revoked" : status === "denied" ? "Denied" : "Error"}</StatusPill>
        )}
        <PromiseIdRef id={promise.id} />
      </div>

      <h2 className={`mt-3 text-body-lg font-medium text-pretty ${live ? "text-ink" : "text-graphite"}`}>{promise.task}</h2>

      <BudgetMeter remaining={promise.remainingBudget} total={promise.budget} />

      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-graphite">
        {promise.categories.map((c) => (
          <span key={c} className="rounded-sm bg-fog px-1.5 py-0.5 text-ink">
            {categoryLabel(c)}
          </span>
        ))}
        {host && (
          <>
            <span aria-hidden="true">·</span>
            <span>{host}</span>
          </>
        )}
        <span aria-hidden="true">·</span>
        {status === "active" && <span title={absolute}>Expires in {formatRemaining(expiryMs - Date.now())}</span>}
        {status !== "active" && <span>Expires {absolute}</span>}
      </p>

      <div className="mt-auto pt-5">
        <div className="border-t border-hairline pt-4">
          {confirming ? (
            <ConfirmInline
              message="Revoke this promise? Your agent can't spend from it anymore."
              confirmLabel="Revoke"
              busyLabel="Revoking…"
              onConfirm={async () => {
                await onRevoke(promise.id);
                setConfirming(false);
              }}
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <div className="flex items-center justify-between gap-3">
              <a href={`${SITE.dashboardRoute}?promise=${encodeURIComponent(promise.id)}`} className={textButton}>
                Watch live
                <IconArrowRight size={14} />
              </a>
              {live ? (
                <button type="button" onClick={() => setConfirming(true)} className={dangerOutlinedButton}>
                  Revoke
                </button>
              ) : (
                <span className="text-caption text-graphite">Approved with World ID</span>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function categoryLabel(value: string): string {
  return MANDATE_CATEGORY_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function PromiseCard({ mandate, onRevoke }: { mandate: SerializedMandate; onRevoke: (id: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const status = promiseStatus(mandate);
  const expiryMs = Number(mandate.message.expiry) * 1000;
  const absolute = new Date(expiryMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const live = status === "active";

  return (
    <li className="flex flex-col rounded-card border border-hairline bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        {status === "active" && <StatusPill tone="neutral">Active</StatusPill>}
        {status === "revoked" && <StatusPill tone="refuse">Revoked</StatusPill>}
        {status === "expired" && <StatusPill tone="muted">Expired</StatusPill>}
        <PromiseIdRef id={mandate.id} />
      </div>

      <h2 className={`mt-3 text-body-lg font-medium text-pretty ${live ? "text-ink" : "text-graphite"}`}>{mandate.message.task}</h2>

      <BudgetMeter remaining={mandate.remainingBudget} total={mandate.message.budget} />

      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-graphite">
        {mandate.message.categories.map((c) => (
          <span key={c} className="rounded-sm bg-fog px-1.5 py-0.5 text-ink">
            {categoryLabel(c)}
          </span>
        ))}
        <span aria-hidden="true">·</span>
        {status === "active" && <span title={absolute}>Expires in {formatRemaining(expiryMs - Date.now())}</span>}
        {status === "expired" && <span>Expired {absolute}</span>}
        {status === "revoked" && (
          <span>
            Revoked
            {mandate.revokedAt
              ? ` ${new Date(mandate.revokedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
              : ""}
          </span>
        )}
      </p>

      <div className="mt-auto pt-5">
        <div className="border-t border-hairline pt-4">
          {confirming ? (
            <ConfirmInline
              message="Revoke this promise? Its agent key stops working immediately."
              confirmLabel="Revoke"
              busyLabel="Revoking…"
              onConfirm={async () => {
                await onRevoke(mandate.id);
                setConfirming(false);
              }}
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <div className="flex items-center justify-between gap-3">
              <a href={`${SITE.dashboardRoute}?promise=${encodeURIComponent(mandate.id)}`} className={textButton}>
                Watch live
                <IconArrowRight size={14} />
              </a>
              {live && (
                <button type="button" onClick={() => setConfirming(true)} className={dangerOutlinedButton}>
                  Revoke
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** The promise's reference, labeled and short (`5fcb…2252`); copies the full id. */
function PromiseIdRef({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const short = shortHex(id.replace(/^(intent|promise)_/, ""), 4, 4);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={id}
      aria-label={copied ? "Promise ID copied" : `Copy promise ID ${short}`}
      className="inline-flex items-center gap-2 rounded-sm px-1.5 py-1 text-graphite transition-colors duration-200 ease-out hover:bg-fog hover:text-ink"
    >
      <span className="label">Promise ID</span>
      <span className="font-mono text-caption text-ink">{short}</span>
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

function BudgetMeter({ remaining, total }: { remaining: string; total: string }) {
  const totalN = Number(total);
  const remainingN = Number(remaining);
  const pct = totalN > 0 ? Math.min(Math.max(remainingN / totalN, 0), 1) * 100 : 0;
  const exhausted = remainingN <= 0;
  return (
    <div className="mt-4">
      <p className="text-body-sm text-graphite">
        <span className="font-mono tabular-nums text-ink">{formatUsdcFixed(remaining)}</span> of{" "}
        <span className="font-mono tabular-nums">{formatUsdcFixed(total)}</span> USDC left
      </p>
      <div
        role="meter"
        aria-label="Budget left"
        aria-valuemin={0}
        aria-valuemax={totalN}
        aria-valuenow={remainingN}
        className="mt-2 h-1 w-full overflow-hidden rounded-full bg-hairline"
      >
        <div className={`h-full rounded-full ${exhausted ? "bg-graphite" : "bg-ink"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
