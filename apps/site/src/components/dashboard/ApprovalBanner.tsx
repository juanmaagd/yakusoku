import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { DecisionReceipt } from "@yakusoku/shared";
import type { ApprovalStatus } from "../../lib/api";
import { formatUsdcFixed, shortAddress } from "../../lib/format";
import { formatCountdown, resourcePath } from "../../lib/receiptView";
import { IconExternal } from "../ui/Icons";
import Skeleton from "../ui/Skeleton";

interface ApprovalBannerProps {
  receipt: DecisionReceipt;
  approval: ApprovalStatus | undefined;
}

/** The only time the app interrupts: a payment waits for a fresh World ID
 * approval. Shows the QR for the World App, the user code and a countdown.
 * It has no approve action: it resolves only when the receipt's `decision`
 * event arrives over SSE. */
export default function ApprovalBanner({ receipt, approval }: ApprovalBannerProps) {
  const [, tick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const countdown = formatCountdown(approval?.expiresAt);
  const uri = approval?.verificationUri;

  return (
    <section aria-live="polite" className="rounded-card border border-ask/40 bg-ask-wash p-5 md:p-6">
      <div className="flex flex-col gap-6 md:flex-row md:items-center">
        <img src="/art/app/approval.webp" alt="" width={1024} height={1024} decoding="async" className="hidden size-24 shrink-0 md:block" />
        <div className="min-w-0 flex-1">
          <h2 className="headline text-heading-sm text-ink">
            Your agent <strong>needs you.</strong>
          </h2>
          <p className="mt-2 text-body-sm text-ask-ink">
            This payment couldn&rsquo;t be cleared automatically. Approve or deny it with World ID on your phone.
          </p>
          <p className="mt-3 text-body-sm text-ink">
            <span className="font-mono tabular-nums">{formatUsdcFixed(receipt.amount ?? "0")} USDC</span> to{" "}
            <span className="font-mono">{receipt.payTo ? shortAddress(receipt.payTo) : "unknown"}</span>
            <span className="text-ask-ink"> · </span>
            <span className="font-mono text-caption">{resourcePath(receipt.resourceUrl)}</span>
          </p>
          {receipt.task && <p className="mt-1 text-caption text-ask-ink">For &ldquo;{receipt.task}&rdquo;</p>}
        </div>

        <div className="flex items-center gap-5">
          <div className="shrink-0 rounded-card border border-hairline bg-surface p-2">
            {uri && !countdown.expired ? (
              <QRCodeSVG value={uri} size={112} fgColor="#0b0d12" aria-label="World ID approval QR code" />
            ) : (
              <Skeleton className="size-28" />
            )}
          </div>
          <div className="min-w-0 space-y-2">
            <div>
              <p className="label text-ask-ink">Code</p>
              <p className="font-mono text-heading-sm tracking-wide text-ink">{approval?.userCode ?? "······"}</p>
            </div>
            <p className={`text-body-sm font-medium tabular-nums ${countdown.expired ? "text-refuse-ink" : "text-ask-ink"}`}>
              {!approval ? "Loading the approval…" : countdown.expired ? "Expired" : `Expires in ${countdown.label.padStart(5, "0")}`}
            </p>
            {uri && !countdown.expired && (
              <a
                href={uri}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-body-sm font-medium text-ink underline decoration-ask/50 underline-offset-4 hover:decoration-ink"
              >
                Open on this device
                <IconExternal size={14} />
              </a>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export type ApprovalOutcome = "approved" | "denied" | "expired" | "stopped";

/** ~4s confirmation after a banner resolves, so the owner sees what happened. */
export function ApprovalResolved({ outcome }: { outcome: ApprovalOutcome }) {
  const copy: Record<ApprovalOutcome, { text: string; tone: string }> = {
    approved: { text: "Approved. Payment signed.", tone: "border-verified/30 bg-verified-wash text-verified" },
    denied: { text: "Denied. Nothing was paid, the budget is restored.", tone: "border-refuse/30 bg-refuse-wash text-refuse-ink" },
    expired: { text: "The approval expired. Nothing was paid.", tone: "border-hairline bg-fog text-graphite" },
    stopped: { text: "The approval was stopped. Nothing was paid.", tone: "border-hairline bg-fog text-graphite" },
  };
  const { text, tone } = copy[outcome];
  return (
    <p role="status" className={`rounded-card border px-4 py-3 text-body-sm font-medium ${tone}`}>
      {text}
    </p>
  );
}
