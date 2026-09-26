import { useEffect, useRef, useState } from "react";
import { dangerButton, errorText, ghostButton } from "../../lib/ui";

interface ConfirmInlineProps {
  message: string;
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

/** The one confirmation pattern of the app (revoke a promise, pause every
 * agent): a sentence that names the consequence, a destructive action and a
 * way out. Rendered inline where the action was triggered, never a modal. */
export default function ConfirmInline({ message, confirmLabel, busyLabel, onConfirm, onCancel }: ConfirmInlineProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  async function handleConfirm() {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="group"
      aria-label={confirmLabel}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <p className="text-body-sm text-ink">{message}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button ref={confirmRef} type="button" onClick={() => void handleConfirm()} disabled={busy} className={dangerButton}>
          {busy ? busyLabel : confirmLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={ghostButton}>
          Cancel
        </button>
      </div>
      {error && (
        <p className={`${errorText} mt-2`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
