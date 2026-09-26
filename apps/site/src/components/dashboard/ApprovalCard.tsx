import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { formatCountdown } from "../../lib/receiptView";

export interface ApprovalCardData {
  receiptId: string;
  verificationUri?: string;
  userCode?: string;
  expiresAt?: string;
  /** Shown above the QR — usually the other lane's "would pay X to Y" line,
   * so the human approves knowing what they're approving without hunting
   * through the timeline for the matching row. */
  summary?: string;
}

/** World ID human-approval prompt (P6 brief step 6): a QR of the
 * verification URI, the user code as a fallback, and a live countdown.
 * Resolves on its own once the receipt's SSE `decision` event lands
 * (`DashboardApp` removes it from the pending set) — this component only
 * renders the waiting state, never a resolve action, so a reviewer can never
 * approve from here by accident. */
export default function ApprovalCard({ data }: { data: ApprovalCardData }) {
  const [, forceTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const countdown = formatCountdown(data.expiresAt);

  return (
    <div className="rounded-card border border-saffron/40 bg-saffron/10 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-body font-semibold text-ink">Waiting for your approval</h3>
        <span className={`text-body-sm font-medium ${countdown.expired ? "text-vermillion" : "text-saffron"}`}>
          {countdown.expired ? "expired" : `expires in ${countdown.label}`}
        </span>
      </div>
      {data.summary && <p className="mt-1 text-body-sm text-graphite">{data.summary}</p>}

      <div className="mt-4 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        {data.verificationUri && !countdown.expired && (
          <div className="shrink-0 rounded-btn border border-black/[0.08] bg-surface p-2">
            <QRCodeSVG value={data.verificationUri} size={128} />
          </div>
        )}
        <div className="min-w-0 space-y-2">
          <div>
            <p className="text-caption font-medium text-stone">User code</p>
            <p className="font-mono text-heading-sm font-semibold tracking-wide text-ink">{data.userCode ?? "—"}</p>
          </div>
          {data.verificationUri && (
            <a
              href={data.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="inline-block text-body-sm font-medium text-primary underline decoration-1 underline-offset-2 hover:opacity-80"
            >
              Open on this device &rarr;
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
