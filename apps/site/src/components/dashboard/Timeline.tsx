import type { ReactNode } from "react";
import type { DecisionReceipt } from "@yakusoku/shared";
import { formatUsdc, shortAddress } from "../../lib/format";
import { classifyReceipt, decidingStage, reasonText, resourcePath } from "../../lib/receiptView";
import { laneBadgeClass } from "../../lib/ui";

interface TimelineProps {
  receipts: DecisionReceipt[];
  selectedReceiptId: string | undefined;
  onSelect: (receiptId: string) => void;
  emptyState: ReactNode;
}

/** The live two-lane timeline (P6 brief step 4) — newest first, fed by
 * `DashboardApp`'s combined `GET /receipts` + SSE state. Left lane is what
 * the agent tried (independent of any verdict); right lane is what Omamorisan
 * decided. Presentational only: `DashboardApp` owns the data and ordering. */
export default function Timeline({ receipts, selectedReceiptId, onSelect, emptyState }: TimelineProps) {
  if (receipts.length === 0) {
    return <div className="rounded-card border border-black/[0.08] bg-surface p-8 text-center">{emptyState}</div>;
  }

  return (
    <div className="overflow-hidden rounded-card border border-black/[0.08] bg-surface">
      <div className="grid grid-cols-1 border-b border-black/[0.08] bg-canvas sm:grid-cols-2">
        <div className="px-4 py-2 text-caption font-semibold uppercase tracking-wide text-stone">
          What the agent tried
        </div>
        <div className="hidden border-l border-black/[0.08] px-4 py-2 text-caption font-semibold uppercase tracking-wide text-stone sm:block">
          What Omamorisan did
        </div>
      </div>

      <ul className="max-h-[65vh] divide-y divide-black/[0.08] overflow-y-auto">
        {receipts.map((r) => {
          const cls = classifyReceipt(r);
          const stage = decidingStage(r.timeline);
          const reason = reasonText(r);
          const selected = r.receiptId === selectedReceiptId;
          return (
            <li key={r.receiptId}>
              <button
                type="button"
                onClick={() => onSelect(r.receiptId)}
                className={`grid w-full grid-cols-1 gap-2 px-4 py-3 text-left transition-colors duration-200 ease-out sm:grid-cols-2 ${
                  selected ? "bg-sky-tint/30" : "hover:bg-canvas"
                }`}
              >
                <div className="min-w-0">
                  <p className="text-body-sm font-medium text-ink">
                    Would pay {formatUsdc(r.amount ?? "0")} USDC to {shortAddress(r.payTo ?? "0x0000000000000000000000000000000000000000")}
                  </p>
                  <p className="mt-0.5 truncate text-caption text-graphite">for {resourcePath(r.resourceUrl)}</p>
                  {r.justification && <p className="mt-1 truncate text-caption italic text-slate">&ldquo;{r.justification}&rdquo;</p>}
                </div>
                <div className="min-w-0 border-black/[0.08] sm:border-l sm:pl-4">
                  <span className={laneBadgeClass(cls.code)}>{cls.label}</span>
                  <p className="mt-1 text-caption text-graphite">
                    <span className="font-medium uppercase tracking-wide text-ink/80">{stage}</span>
                    {reason && <span> — {reason}</span>}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
