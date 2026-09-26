import type { DecisionReceipt } from "@yakusoku/shared";
import { formatUsdcFixed, shortAddress, timeAgo } from "../../lib/format";
import { plainReason, verdictOf, type Verdict } from "../../lib/decisionCopy";
import { resourcePath } from "../../lib/receiptView";
import { StatusMark } from "../ui/Icons";

interface DecisionFeedProps {
  receipts: DecisionReceipt[];
  selectedReceiptId: string | undefined;
  /** Receipts that arrived over SSE after the first load: they slide in. */
  freshIds: ReadonlySet<string>;
  onSelect: (receiptId: string) => void;
}

/** The two lanes: what the agent tried on the left, what Omamorisan did on
 * the right, newest first. Presentational: `DashboardApp` owns the data. */
export default function DecisionFeed({ receipts, selectedReceiptId, freshIds, onSelect }: DecisionFeedProps) {
  return (
    <div className="overflow-hidden rounded-card border border-hairline bg-surface">
      <div className="hidden grid-cols-2 border-b border-hairline sm:grid">
        <div className="label px-4 py-2.5 text-graphite">Agent tried</div>
        <div className="label border-l border-hairline px-4 py-2.5 text-graphite">Omamorisan</div>
      </div>
      <ul className="divide-y divide-hairline">
        {receipts.map((r) => {
          const selected = r.receiptId === selectedReceiptId;
          return (
            <li key={r.receiptId} className={freshIds.has(r.receiptId) ? "row-in" : undefined}>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(r.receiptId)}
                className={`grid w-full grid-cols-1 gap-3 px-4 py-4 text-left transition-colors duration-200 ease-out sm:grid-cols-2 sm:gap-0 ${
                  selected ? "bg-fog" : "hover:bg-fog"
                }`}
              >
                <div className="min-w-0 sm:pr-4">
                  <p className="text-body text-ink">
                    <span className="font-mono tabular-nums">{formatUsdcFixed(r.amount ?? "0")} USDC</span>
                  </p>
                  <p className="mt-0.5 truncate font-mono text-caption text-graphite" title={r.resourceUrl}>
                    {resourcePath(r.resourceUrl)}
                  </p>
                  <p className="mt-1 text-caption text-graphite">
                    to <span className="font-mono">{r.payTo ? shortAddress(r.payTo) : "unknown"}</span> · {timeAgo(r.createdAt)}
                  </p>
                </div>
                <div className="min-w-0 sm:border-l sm:border-hairline sm:pl-4">
                  <VerdictStamp verdict={verdictOf(r)} />
                  <p className="mt-1.5 text-body-sm text-ink">{plainReason(r)}</p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const stampStyle: Record<Verdict["tone"], { mark: "verified" | "fail" | "wait" | "skip"; text: string }> = {
  paid: { mark: "verified", text: "text-verified" },
  refused: { mark: "fail", text: "text-refuse-ink" },
  "needs-you": { mark: "wait", text: "text-ask-ink" },
  expired: { mark: "skip", text: "text-graphite" },
  paused: { mark: "skip", text: "text-graphite" },
};

export function VerdictStamp({ verdict }: { verdict: Verdict }) {
  const style = stampStyle[verdict.tone];
  return (
    <span className={`inline-flex items-center gap-2 text-body-sm font-semibold ${style.text}`}>
      <StatusMark kind={style.mark} />
      {verdict.label}
    </span>
  );
}
