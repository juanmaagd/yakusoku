import { useState } from "react";
import { SITE } from "../../config";
import type { OwnerControlState } from "../../lib/api";
import { shortAddress } from "../../lib/format";
import { dangerOutlinedButton, outlinedButton, textButton } from "../../lib/ui";

interface DashboardHeaderProps {
  address: string;
  control: OwnerControlState;
  onPause: (reason?: string) => Promise<void>;
  onResume: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

/** Dashboard header strip (P6 brief step 2): identity, the per-owner kill
 * switch, and a way back to `/app` to create another mandate. Pausing needs
 * an explicit confirmation click (it stops every one of this owner's agents
 * mid-flight) — resuming doesn't, since it only restores normal evaluation. */
export default function DashboardHeader({ address, control, onPause, onResume, onSignOut }: DashboardHeaderProps) {
  const [confirmingPause, setConfirmingPause] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handlePause() {
    setBusy(true);
    try {
      await onPause("paused from the dashboard");
    } finally {
      setBusy(false);
      setConfirmingPause(false);
    }
  }

  async function handleResume() {
    setBusy(true);
    try {
      await onResume();
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-black/[0.08] bg-surface p-4">
      <div className="flex items-center gap-3">
        <div>
          <p className="text-caption text-stone">Signed in as</p>
          <p className="text-body-sm font-medium text-ink">{shortAddress(address)}</p>
        </div>
        {control.paused && (
          <span className="rounded-full bg-vermillion px-2.5 py-0.5 text-caption font-semibold text-white">
            PAUSED{control.reason ? ` — ${control.reason}` : ""}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <a href={SITE.appRoute} className={textButton}>
          + New mandate
        </a>
        {control.paused ? (
          <button type="button" onClick={() => void handleResume()} disabled={busy} className={outlinedButton}>
            {busy ? "Resuming…" : "Resume signing"}
          </button>
        ) : confirmingPause ? (
          <div className="flex items-center gap-2">
            <span className="text-body-sm text-graphite">Stop every agent from signing?</span>
            <button type="button" onClick={() => void handlePause()} disabled={busy} className={dangerOutlinedButton}>
              {busy ? "Pausing…" : "Confirm pause"}
            </button>
            <button type="button" onClick={() => setConfirmingPause(false)} className={textButton}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmingPause(true)} className={dangerOutlinedButton}>
            Pause all signing
          </button>
        )}
        <button type="button" onClick={() => void onSignOut()} className={outlinedButton}>
          Sign out
        </button>
      </div>
    </header>
  );
}
