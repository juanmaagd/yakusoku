import { useCallback, useEffect, useState } from "react";
import { listMandates, revokeMandate, type SerializedMandate } from "../../lib/api";
import { formatExpiry, formatUsdc } from "../../lib/format";
import { card, dangerOutlinedButton, outlinedButton } from "../../lib/ui";

interface MandateListProps {
  sessionToken: string;
  /** Bumped by the parent after a new mandate is created so the list refetches. */
  refreshSignal: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; mandates: SerializedMandate[] };

export default function MandateList({ sessionToken, refreshSignal }: MandateListProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [confirmingId, setConfirmingId] = useState<string | undefined>();
  const [revokingId, setRevokingId] = useState<string | undefined>();

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const mandates = await listMandates(sessionToken);
      mandates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setState({ kind: "loaded", mandates });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Could not load your mandates." });
    }
  }, [sessionToken]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  async function handleRevoke(id: string) {
    setRevokingId(id);
    try {
      await revokeMandate(sessionToken, id);
      await load();
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "Could not revoke this mandate." });
    } finally {
      setRevokingId(undefined);
      setConfirmingId(undefined);
    }
  }

  return (
    <div className={card}>
      <h3 className="text-heading-sm font-semibold text-ink">Your mandates</h3>

      {state.kind === "loading" && <p className="mt-3 text-body-sm text-stone">Loading your mandates&hellip;</p>}

      {state.kind === "error" && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-body-sm text-vermillion">{state.message}</p>
          <button type="button" onClick={() => void load()} className={outlinedButton}>
            Retry
          </button>
        </div>
      )}

      {state.kind === "loaded" && state.mandates.length === 0 && (
        <p className="mt-3 text-body-sm text-graphite">
          No mandates yet. Create one above to hand your agent a spending credential.
        </p>
      )}

      {state.kind === "loaded" && state.mandates.length > 0 && (
        <ul className="mt-4 space-y-3">
          {state.mandates.map((mandate) => {
            const expiry = formatExpiry(mandate.message.expiry);
            const isDead = mandate.revoked || expiry.isExpired;
            return (
              <li
                key={mandate.id}
                className={`rounded-btn border border-black/[0.08] p-4 ${isDead ? "bg-canvas/60 opacity-70" : "bg-canvas"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-body font-medium text-ink">{mandate.message.task}</p>
                    <p className="mt-1 text-body-sm text-graphite">
                      ${formatUsdc(mandate.remainingBudget)} of ${formatUsdc(mandate.message.budget)} USDC remaining
                      {" · "}
                      {mandate.message.categories.join(", ")}
                    </p>
                    <p className="mt-1 text-caption text-stone">
                      {mandate.revoked
                        ? `Revoked${mandate.revokedAt ? ` · ${new Date(mandate.revokedAt).toLocaleString()}` : ""}`
                        : `Expires ${expiry.absolute} (${expiry.relative})`}
                    </p>
                  </div>
                  {!isDead &&
                    (confirmingId === mandate.id ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-body-sm text-graphite">Revoke this mandate?</span>
                        <button
                          type="button"
                          disabled={revokingId === mandate.id}
                          onClick={() => void handleRevoke(mandate.id)}
                          className={dangerOutlinedButton}
                        >
                          {revokingId === mandate.id ? "Revoking…" : "Confirm"}
                        </button>
                        <button type="button" onClick={() => setConfirmingId(undefined)} className={outlinedButton}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingId(mandate.id)}
                        className={`${dangerOutlinedButton} shrink-0`}
                      >
                        Revoke
                      </button>
                    ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
