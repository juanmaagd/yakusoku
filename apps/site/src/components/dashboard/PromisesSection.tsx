import { MANDATE_CATEGORY_OPTIONS } from "../../config";
import type { OwnerPromise } from "../../lib/api";
import { formatExpiry, formatUsdcFixed, shortAddress } from "../../lib/format";
import { card } from "../../lib/ui";
import StatusPill from "../ui/StatusPill";

function categoryLabel(value: string): string {
  return MANDATE_CATEGORY_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function merchantHost(merchant: string | undefined): string | undefined {
  if (!merchant) return undefined;
  try {
    return new URL(merchant).host;
  } catch {
    return merchant;
  }
}

interface PromisesSectionProps {
  promises: OwnerPromise[];
}

/** Live shows only intent requests that still need human approval. */
export default function PromisesSection({ promises }: PromisesSectionProps) {
  const pending = promises.filter((promise) => promise.status === "pending_approval");
  if (pending.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-subheading font-medium text-ink">Intents awaiting approval</h2>
      <ul className="mt-3 grid gap-4 lg:grid-cols-2">
        {pending.map((p) => (
          <PromiseRow key={p.id} promise={p} />
        ))}
      </ul>
    </section>
  );
}

function PromiseRow({ promise }: { promise: OwnerPromise }) {
  const expiry = formatExpiry(promise.expiry);
  const host = merchantHost(promise.merchant);

  return (
    <li className={`flex flex-col p-5 ${card}`}>
      <div className="flex items-center justify-between gap-3">
        <StatusPill tone="ask">Needs approval</StatusPill>
        {promise.smartAccount && <span className="font-mono text-caption text-graphite">{shortAddress(promise.smartAccount)}</span>}
      </div>

      <h3 className="mt-3 text-body-lg font-medium text-pretty text-ink">{promise.task}</h3>

      <p className="mt-2 text-body-sm text-graphite">
        Requested budget: <span className="font-mono tabular-nums text-ink">{formatUsdcFixed(promise.budget)}</span> USDC
      </p>

      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-graphite">
        {promise.categories.map((c) => (
          <span key={c} className="rounded-sm bg-fog px-1.5 py-0.5 text-ink">
            {categoryLabel(c)}
          </span>
        ))}
        <span aria-hidden="true">·</span>
        <span title={expiry.absolute}>{expiry.isExpired ? "Expired" : `Expires ${expiry.relative}`}</span>
        {host && (
          <>
            <span aria-hidden="true">·</span>
            <span>{host}</span>
          </>
        )}
      </p>
    </li>
  );
}
