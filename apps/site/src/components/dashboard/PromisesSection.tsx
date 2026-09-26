import { MANDATE_CATEGORY_OPTIONS } from "../../config";
import type { OwnerPromise, OwnerPromiseStatus } from "../../lib/api";
import { formatExpiry, formatUsdcFixed, shortAddress } from "../../lib/format";
import { card } from "../../lib/ui";
import StatusPill, { type PillTone } from "../ui/StatusPill";

// dashboard-promises (D2) — the owner-session view of World ID promises
// (StoredPromise, apps/firewall/store.ts), distinct from the wallet-signed
// mandates the rest of this dashboard already calls "promises" (see
// PromiseFilter above / apps/site/src/components/app/PromiseList.tsx): same
// underlying concept ("what the agent may buy"), different signing path — a
// fresh World ID approval instead of a wallet signature. Color follows the
// dashboard's state-only rule (DESIGN.md): blue = signed/active, red =
// refused/revoked, amber = ask/pending.

const STATUS_TONE: Record<OwnerPromiseStatus, PillTone> = {
  active: "verified",
  pending_approval: "ask",
  denied: "refuse",
  revoked: "refuse",
  error: "refuse",
  expired: "muted",
};

const STATUS_LABEL: Record<OwnerPromiseStatus, string> = {
  active: "Active",
  pending_approval: "Pending",
  denied: "Denied",
  revoked: "Revoked",
  error: "Error",
  expired: "Expired",
};

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

/** Nothing rendered when this wallet owns no World ID promise — the legacy
 * mandate empty states above already cover "nothing here yet". */
export default function PromisesSection({ promises }: PromisesSectionProps) {
  if (promises.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-subheading font-medium text-ink">World ID promises</h2>
      <ul className="mt-3 grid gap-4 lg:grid-cols-2">
        {promises.map((p) => (
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
        <StatusPill tone={STATUS_TONE[promise.status]}>{STATUS_LABEL[promise.status]}</StatusPill>
        {promise.smartAccount && <span className="font-mono text-caption text-graphite">{shortAddress(promise.smartAccount)}</span>}
      </div>

      <h3 className="mt-3 text-body-lg font-medium text-pretty text-ink">{promise.task}</h3>

      <p className="mt-2 text-body-sm text-graphite">
        <span className="font-mono tabular-nums text-ink">{formatUsdcFixed(promise.remainingBudget)}</span> of{" "}
        <span className="font-mono tabular-nums">{formatUsdcFixed(promise.budget)}</span> USDC left
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
