import { useState } from "react";
import { SITE } from "../../config";
import type { SerializedMandate } from "../../lib/api";
import { formatExpiry, formatUsdc } from "../../lib/format";
import { chipClass, dangerOutlinedButton, textButton } from "../../lib/ui";

interface MandateFilterListProps {
  mandates: SerializedMandate[];
  /** `undefined` means "all mandates" — the timeline shows every receipt the
   * owner can see. */
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onRevoke: (id: string) => Promise<void>;
}

/** Compact mandate filter for the dashboard (P6 brief step 3) — presentational
 * only: `DashboardApp` owns the actual mandate list (kept live via SSE) and
 * the revoke call; this component just renders it and reuses P5's revoke
 * confirmation pattern (`MandateList.tsx`). */
export default function MandateFilterList({ mandates, selectedId, onSelect, onRevoke }: MandateFilterListProps) {
  const [confirmingId, setConfirmingId] = useState<string | undefined>();
  const [revokingId, setRevokingId] = useState<string | undefined>();

  async function handleRevoke(id: string) {
    setRevokingId(id);
    try {
      await onRevoke(id);
    } finally {
      setRevokingId(undefined);
      setConfirmingId(undefined);
    }
  }

  if (mandates.length === 0) {
    return (
      <div className="rounded-card border border-black/[0.08] bg-surface p-6 text-center">
        <p className="text-body text-graphite">No mandates yet — nothing for your agent to spend against.</p>
        <a href={SITE.appRoute} className={`${textButton} mt-2 inline-block`}>
          Create your first mandate &rarr;
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-card border border-black/[0.08] bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-body-sm font-semibold text-stone">Mandates</h2>
        <a href={SITE.appRoute} className={textButton}>
          + New mandate
        </a>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => onSelect(undefined)} className={chipClass(selectedId === undefined)}>
          All mandates
        </button>
      </div>

      <ul className="mt-3 space-y-2">
        {mandates.map((mandate) => {
          const expiry = formatExpiry(mandate.message.expiry);
          const isDead = mandate.revoked || expiry.isExpired;
          const selected = selectedId === mandate.id;
          return (
            <li key={mandate.id}>
              <div
                className={`flex flex-wrap items-center justify-between gap-3 rounded-btn border p-3 transition-colors duration-200 ease-out ${
                  selected ? "border-primary bg-sky-tint/40" : "border-black/[0.08] bg-canvas"
                } ${isDead ? "opacity-60" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(selected ? undefined : mandate.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-body-sm font-medium text-ink">{mandate.message.task}</p>
                  <p className="mt-0.5 text-caption text-graphite">
                    ${formatUsdc(mandate.remainingBudget)} of ${formatUsdc(mandate.message.budget)} USDC remaining
                    {" · "}
                    {mandate.revoked ? "revoked" : `expires ${expiry.relative}`}
                  </p>
                </button>
                {!isDead &&
                  (confirmingId === mandate.id ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={revokingId === mandate.id}
                        onClick={() => void handleRevoke(mandate.id)}
                        className={dangerOutlinedButton}
                      >
                        {revokingId === mandate.id ? "Revoking…" : "Confirm revoke"}
                      </button>
                      <button type="button" onClick={() => setConfirmingId(undefined)} className={textButton}>
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
    </div>
  );
}
