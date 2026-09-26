import { useEffect, useState, type ReactNode } from "react";
import type { DecisionReceipt } from "@yakusoku/shared";
import { verifyStepUpAttestation } from "@yakusoku/shared";
import { basescanTx } from "../../config";
import { getAttestation, revealGiftCard } from "../../lib/api";
import { plainReason, stageChecklist, verdictOf } from "../../lib/decisionCopy";
import { formatUsdcFixed, shortAddress, shortHex } from "../../lib/format";
import { formatMs, formatPercent, resourcePath } from "../../lib/receiptView";
import { smallButton } from "../../lib/ui";
import { createPublicReadClient } from "../../lib/wallet";
import { IconChevronDown, IconExternal, StatusMark } from "../ui/Icons";
import { VerdictStamp } from "./DecisionFeed";

type AttestationState =
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "verified"; signer: string }
  | { kind: "invalid" }
  | { kind: "error"; message: string };

type ChainConfirmState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "confirmed"; blockNumber: bigint }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

/** One decision, explained: plain answer first, the stage checklist, the
 * independent evidence (StepUp attestation checked in this browser, the
 * settlement tx read straight from Base Sepolia), and the raw technical
 * record one disclosure away. */
export default function DecisionDetail({ receipt, sessionToken }: { receipt: DecisionReceipt; sessionToken: string }) {
  const [attestation, setAttestation] = useState<AttestationState>({ kind: "checking" });
  const [chainConfirm, setChainConfirm] = useState<ChainConfirmState>({ kind: "idle" });
  const [giftCard, setGiftCard] = useState<{ kind: "hidden" | "loading" } | { kind: "revealed"; code: string } | { kind: "error"; message: string }>({ kind: "hidden" });

  useEffect(() => {
    let cancelled = false;
    setAttestation({ kind: "checking" });
    setChainConfirm({ kind: "idle" });
    setGiftCard({ kind: "hidden" });
    void (async () => {
      try {
        const record = await getAttestation(receipt.receiptId);
        if (cancelled) return;
        if (!record) {
          setAttestation({ kind: "none" });
          return;
        }
        const valid = await verifyStepUpAttestation(record);
        if (!cancelled) setAttestation(valid ? { kind: "verified", signer: record.signer } : { kind: "invalid" });
      } catch (err) {
        if (!cancelled) setAttestation({ kind: "error", message: err instanceof Error ? err.message : "Could not check the attestation." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receipt.receiptId]);

  async function handleConfirmOnChain() {
    const txHash = receipt.settlement?.txHash;
    if (!txHash) return;
    setChainConfirm({ kind: "checking" });
    try {
      const txReceipt = await createPublicReadClient().getTransactionReceipt({ hash: txHash as `0x${string}` });
      setChainConfirm({ kind: "confirmed", blockNumber: txReceipt.blockNumber });
    } catch (err) {
      const notFound = err instanceof Error && /could not be found/i.test(err.message);
      setChainConfirm(notFound ? { kind: "not-found" } : { kind: "error", message: err instanceof Error ? err.message : "Lookup failed." });
    }
  }

  const stages = stageChecklist(receipt);
  const showEvidence = Boolean(receipt.settlement) || Boolean(receipt.worldId) || attestation.kind === "verified" || attestation.kind === "invalid";
  const hasGiftCard = receipt.state === "settled" && receipt.giftCardAvailable === true;

  async function handleRevealGiftCard() {
    setGiftCard({ kind: "loading" });
    try {
      const result = await revealGiftCard(sessionToken, receipt.receiptId);
      setGiftCard({ kind: "revealed", code: result.code });
    } catch (err) {
      setGiftCard({ kind: "error", message: err instanceof Error ? err.message : "Could not reveal the code." });
    }
  }

  return (
    <div className="space-y-7">
      <div>
        <VerdictStamp verdict={verdictOf(receipt)} />
        <p className="mt-2 text-subheading font-medium text-pretty text-ink">{plainReason(receipt)}</p>
        <dl className="mt-4 divide-y divide-hairline border-y border-hairline text-body-sm">
          <Row term="Amount">
            <span className="font-mono tabular-nums">{formatUsdcFixed(receipt.amount ?? "0")} USDC</span>
          </Row>
          <Row term="For">
            <span className="font-mono break-all">{resourcePath(receipt.resourceUrl)}</span>
          </Row>
          <Row term="Paid to">
            <span className="font-mono" title={receipt.payTo}>
              {receipt.payTo ? shortAddress(receipt.payTo) : "unknown"}
            </span>
          </Row>
          <Row term="When">{new Date(receipt.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" })}</Row>
          {receipt.task && <Row term="Intent">{receipt.task}</Row>}
        </dl>
        {receipt.justification && (
          <details className="group mt-3">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-body-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
              <IconChevronDown size={14} className="-rotate-90 text-graphite transition-transform duration-200 group-open:rotate-0" />
              Why the agent tried
            </summary>
            <blockquote className="mt-2 border-l border-hairline-strong pl-3 text-body-sm text-graphite">&ldquo;{receipt.justification}&rdquo;</blockquote>
          </details>
        )}
        {receipt.state === "awaiting_world_id" && (
          <p className="mt-3 rounded-card bg-ask-wash px-3 py-2 text-body-sm text-ask-ink">Waiting for your approval. Scan the code in the banner above.</p>
        )}
      </div>

      {hasGiftCard && (
        <section className="rounded-card border border-hairline bg-fog p-4">
          <h3 className="text-body-sm font-semibold text-ink">Gift card</h3>
          {giftCard.kind === "revealed" ? (
            <div className="mt-3 space-y-3">
              <p className="break-all font-mono text-body text-ink">{giftCard.code}</p>
              <button type="button" className={smallButton} onClick={() => setGiftCard({ kind: "hidden" })}>Hide code</button>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <button type="button" className={smallButton} disabled={giftCard.kind === "loading"} onClick={() => void handleRevealGiftCard()}>
                {giftCard.kind === "loading" ? "Loading…" : "Reveal code"}
              </button>
              {giftCard.kind === "error" && <p className="text-body-sm text-refuse-ink">{giftCard.message}</p>}
            </div>
          )}
        </section>
      )}

      <section>
        <h3 className="text-body-sm font-semibold text-ink">What happened</h3>
        <ol className="mt-3 space-y-2.5">
          {stages.map((stage) => (
            <li key={stage.name} className="flex items-center gap-3">
              <StatusMark kind={stage.mark} />
              <span className={`text-body-sm ${stage.mark === "skip" ? "text-graphite" : "text-ink"}`}>{stage.name}</span>
              {stage.note && <span className="ml-auto text-caption text-graphite">{stage.note}</span>}
            </li>
          ))}
        </ol>
      </section>

      {showEvidence && (
        <section>
          <h3 className="text-body-sm font-semibold text-ink">Evidence</h3>
          <div className="mt-3 space-y-3 text-body-sm">
            {receipt.settlement && (
              <div>
                <a
                  href={basescanTx(receipt.settlement.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 font-mono text-ink underline decoration-hairline-strong underline-offset-4 hover:decoration-ink"
                >
                  {shortHex(receipt.settlement.txHash, 10, 8)}
                  <IconExternal size={14} />
                </a>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => void handleConfirmOnChain()} disabled={chainConfirm.kind === "checking"} className={smallButton}>
                    {chainConfirm.kind === "checking" ? "Checking…" : "Confirm on-chain"}
                  </button>
                  {chainConfirm.kind === "confirmed" && (
                    <span className="text-verified">Confirmed in block {chainConfirm.blockNumber.toString()}</span>
                  )}
                  {chainConfirm.kind === "not-found" && <span className="text-graphite">Not on-chain yet.</span>}
                  {chainConfirm.kind === "error" && <span className="text-refuse-ink">{chainConfirm.message}</span>}
                </div>
              </div>
            )}
            {attestation.kind === "verified" && (
              <p className="flex items-center gap-2 text-verified">
                <StatusMark kind="verified" />
                Approval attestation verified in your browser
              </p>
            )}
            {attestation.kind === "invalid" && (
              <p className="flex items-center gap-2 text-refuse-ink">
                <StatusMark kind="fail" />
                The approval attestation does not verify.
              </p>
            )}
            {attestation.kind === "checking" && receipt.worldId && <p className="text-graphite">Checking the approval attestation…</p>}
            {attestation.kind === "error" && receipt.worldId && <p className="text-refuse-ink">{attestation.message}</p>}
          </div>
        </section>
      )}

      <details className="group border-t border-hairline pt-4">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-body-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
          <IconChevronDown size={14} className="-rotate-90 text-graphite transition-transform duration-200 group-open:rotate-0" />
          Technical details
        </summary>
        <div className="mt-4 space-y-5 text-caption">
          <table className="w-full">
            <thead>
              <tr className="label text-left text-graphite">
                <th className="pb-1.5 pr-2 font-normal">Stage</th>
                <th className="pb-1.5 pr-2 font-normal">Outcome</th>
                <th className="pb-1.5 font-normal">Latency</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {receipt.timeline.map((t, i) => (
                <tr key={`${t.stage}-${i}`} className="border-t border-hairline align-top">
                  <td className="py-1.5 pr-2 text-ink">
                    {t.stage}
                    {t.reason && <span className="block break-words font-sans text-graphite">{t.reason}</span>}
                  </td>
                  <td className={`py-1.5 pr-2 ${t.outcome === "refuse" ? "text-refuse-ink" : t.outcome === "ask_human" ? "text-ask-ink" : "text-ink"}`}>
                    {t.outcome}
                  </td>
                  <td className="py-1.5 tabular-nums text-graphite">{formatMs(t.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {receipt.jev && (
            <TechBlock title="Jev (semantic intent match)">
              <TechRow term="matches_intent" value={formatPercent(receipt.jev.matchesIntent)} />
              <TechRow term="social_engineering" value={formatPercent(receipt.jev.looksLikeSocialEngineering)} />
              <TechRow term="untrusted_content_source" value={formatPercent(receipt.jev.paymentSourceIsUntrustedContent)} />
              <TechRow term="risk" value={`${formatPercent(receipt.jev.riskNormalized)} normalized`} />
              <TechRow term="model" value={`${receipt.jev.model} · ${formatMs(receipt.jev.latencyMs)}`} />
            </TechBlock>
          )}

          {receipt.intercepta && (
            <TechBlock title="Intercepta (address and token screening)">
              <TechRow
                term="address"
                value={`${receipt.intercepta.addressVerdict}${typeof receipt.intercepta.addressScore === "number" ? ` (score ${receipt.intercepta.addressScore})` : ""}`}
              />
              <TechRow term="token" value={receipt.intercepta.tokenVerdict ?? "—"} />
              <TechRow term="cached" value={receipt.intercepta.cached ? "yes" : "no"} />
              <TechRow term="latency" value={formatMs(receipt.intercepta.latencyMs)} />
            </TechBlock>
          )}

          <TechBlock title="Receipt">
            <TechRow term="state" value={receipt.state} />
            <TechRow term="verdict" value={receipt.verdict} />
            <TechRow term="reasons" value={receipt.reasons.join("; ") || "—"} />
            <TechRow term="receipt_id" value={receipt.receiptId} />
            <TechRow term="mandate_id" value={receipt.intentId} />
            {attestation.kind === "verified" && <TechRow term="attestation_signer" value={attestation.signer} />}
          </TechBlock>
        </div>
      </details>
    </div>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-3 py-2">
      <dt className="text-graphite">{term}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

function TechBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="font-medium text-ink">{title}</p>
      <dl className="mt-1.5 space-y-1 font-mono">{children}</dl>
    </div>
  );
}

function TechRow({ term, value }: { term: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-3">
      <dt className="break-words text-graphite">{term}</dt>
      <dd className="break-all text-ink">{value}</dd>
    </div>
  );
}
