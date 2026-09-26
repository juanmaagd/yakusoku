import { useEffect, useState } from "react";
import type { DecisionReceipt } from "@yakusoku/shared";
import { verifyStepUpAttestation } from "@yakusoku/shared";
import { basescanTx } from "../../config";
import { getAttestation, type ApprovalStatus } from "../../lib/api";
import { formatUsdc, shortAddress } from "../../lib/format";
import { classifyReceipt, decidingStage, formatMs, formatPercent, reasonText, resourcePath } from "../../lib/receiptView";
import { createPublicReadClient } from "../../lib/wallet";
import { laneBadgeClass, outlinedButton } from "../../lib/ui";
import ApprovalCard from "./ApprovalCard";

interface ReceiptDetailPanelProps {
  receipt: DecisionReceipt;
  approval: ApprovalStatus | undefined;
}

type AttestationState =
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "verified"; signer: string }
  | { kind: "invalid" }
  | { kind: "error"; message: string };

type ChainConfirmState = { kind: "idle" } | { kind: "checking" } | { kind: "confirmed"; blockNumber: bigint } | { kind: "not-found" } | { kind: "error"; message: string };

/** Receipt detail drawer (P6 brief step 5): full stage timeline, Jev
 * probabilities, Intercepta verdict, World ID state (the live approval card
 * while pending, an attested badge once resolved), settlement, and two
 * pieces of independent, browser-side evidence — a StepUp attestation
 * signature check and an optional on-chain settlement confirmation — neither
 * of which trusts the firewall's own say-so (same "an application is never
 * its own oracle" principle PRODUCT.md and the WU14 verifier already apply). */
export default function ReceiptDetailPanel({ receipt, approval }: ReceiptDetailPanelProps) {
  const [attestation, setAttestation] = useState<AttestationState>({ kind: "checking" });
  const [chainConfirm, setChainConfirm] = useState<ChainConfirmState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    setAttestation({ kind: "checking" });
    setChainConfirm({ kind: "idle" });
    void (async () => {
      try {
        const record = await getAttestation(receipt.receiptId);
        if (cancelled) return;
        if (!record) {
          setAttestation({ kind: "none" });
          return;
        }
        const valid = await verifyStepUpAttestation(record);
        if (cancelled) return;
        setAttestation(valid ? { kind: "verified", signer: record.signer } : { kind: "invalid" });
      } catch (err) {
        if (!cancelled) setAttestation({ kind: "error", message: err instanceof Error ? err.message : "Could not verify." });
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
      const client = createPublicReadClient();
      const txReceipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
      setChainConfirm({ kind: "confirmed", blockNumber: txReceipt.blockNumber });
    } catch (err) {
      const notFound = err instanceof Error && /could not be found/i.test(err.message);
      setChainConfirm(notFound ? { kind: "not-found" } : { kind: "error", message: err instanceof Error ? err.message : "Lookup failed." });
    }
  }

  const cls = classifyReceipt(receipt);
  const jev = receipt.jev;
  const intercepta = receipt.intercepta;

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={laneBadgeClass(cls.code)}>{cls.label}</span>
          <span className="text-caption text-stone">{decidingStage(receipt.timeline)}</span>
        </div>
        <p className="mt-2 text-body font-medium text-ink">{receipt.task ?? "—"}</p>
        {receipt.justification && <p className="mt-1 text-body-sm italic text-graphite">&ldquo;{receipt.justification}&rdquo;</p>}
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
          <dt className="text-stone">Resource</dt>
          <dd className="truncate text-ink">{resourcePath(receipt.resourceUrl)}</dd>
          <dt className="text-stone">Amount</dt>
          <dd className="text-ink">{formatUsdc(receipt.amount ?? "0")} USDC</dd>
          <dt className="text-stone">Paid to</dt>
          <dd className="text-ink">{receipt.payTo ? shortAddress(receipt.payTo) : "—"}</dd>
          <dt className="text-stone">Reason</dt>
          <dd className="text-ink">{reasonText(receipt) || "—"}</dd>
        </dl>
      </div>

      {receipt.state === "awaiting_world_id" && (
        <ApprovalCard
          data={{
            receiptId: receipt.receiptId,
            verificationUri: approval?.verificationUri,
            userCode: approval?.userCode,
            expiresAt: approval?.expiresAt,
            summary: `Would pay ${formatUsdc(receipt.amount ?? "0")} USDC to ${receipt.payTo ? shortAddress(receipt.payTo) : "—"}`,
          }}
        />
      )}

      <section>
        <h3 className="text-body-sm font-semibold text-stone">Pipeline timeline</h3>
        {receipt.timeline.length === 0 ? (
          <p className="mt-1 text-body-sm text-graphite">No stages recorded.</p>
        ) : (
          <table className="mt-2 w-full text-body-sm">
            <thead>
              <tr className="text-left text-caption uppercase tracking-wide text-stone">
                <th className="pb-1 pr-2 font-medium">Stage</th>
                <th className="pb-1 pr-2 font-medium">Outcome</th>
                <th className="pb-1 pr-2 font-medium">Latency</th>
                <th className="pb-1 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {receipt.timeline.map((t, i) => (
                <tr key={`${t.stage}-${i}`} className="border-t border-black/[0.06]">
                  <td className="py-1 pr-2 font-medium text-ink">{t.stage}</td>
                  <td className={`py-1 pr-2 ${t.outcome === "refuse" ? "text-vermillion" : t.outcome === "ask_human" ? "text-saffron" : "text-ink"}`}>
                    {t.outcome}
                  </td>
                  <td className="py-1 pr-2 text-graphite">{formatMs(t.ms)}</td>
                  <td className="py-1 text-graphite">{t.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {jev && (
        <section>
          <h3 className="text-body-sm font-semibold text-stone">Jev — semantic intent match</h3>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
            <dt className="text-stone">Matches intent</dt>
            <dd className="text-ink">{formatPercent(jev.matchesIntent)}</dd>
            <dt className="text-stone">Social engineering</dt>
            <dd className="text-ink">{formatPercent(jev.looksLikeSocialEngineering)}</dd>
            <dt className="text-stone">Untrusted-content source</dt>
            <dd className="text-ink">{formatPercent(jev.paymentSourceIsUntrustedContent)}</dd>
            <dt className="text-stone">Risk</dt>
            <dd className="text-ink">{formatPercent(jev.riskNormalized)} normalized</dd>
            <dt className="text-stone">Model</dt>
            <dd className="text-ink">
              {jev.model} · {formatMs(jev.latencyMs)}
            </dd>
          </dl>
        </section>
      )}

      {intercepta && (
        <section>
          <h3 className="text-body-sm font-semibold text-stone">Intercepta — address/token screening</h3>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
            <dt className="text-stone">Address verdict</dt>
            <dd className="text-ink">
              {intercepta.addressVerdict}
              {typeof intercepta.addressScore === "number" ? ` (score ${intercepta.addressScore})` : ""}
            </dd>
            <dt className="text-stone">Token verdict</dt>
            <dd className="text-ink">{intercepta.tokenVerdict ?? "—"}</dd>
            <dt className="text-stone">Cached</dt>
            <dd className="text-ink">{intercepta.cached ? "yes" : "no"}</dd>
            <dt className="text-stone">Latency</dt>
            <dd className="text-ink">{formatMs(intercepta.latencyMs)}</dd>
          </dl>
        </section>
      )}

      {(receipt.worldId || attestation.kind !== "none") && (
        <section>
          <h3 className="text-body-sm font-semibold text-stone">Human approval attestation</h3>
          <p className="mt-2 text-body-sm">
            {attestation.kind === "checking" && <span className="text-graphite">Verifying signature…</span>}
            {attestation.kind === "none" && <span className="text-graphite">No World ID approval was used for this payment.</span>}
            {attestation.kind === "verified" && (
              <span className="font-medium text-primary">Verified — signed by {shortAddress(attestation.signer)}</span>
            )}
            {attestation.kind === "invalid" && <span className="font-medium text-vermillion">Signature does not verify.</span>}
            {attestation.kind === "error" && <span className="text-vermillion">{attestation.message}</span>}
          </p>
        </section>
      )}

      {receipt.settlement && (
        <section>
          <h3 className="text-body-sm font-semibold text-stone">Settlement</h3>
          <p className="mt-2">
            <a
              href={basescanTx(receipt.settlement.txHash)}
              target="_blank"
              rel="noreferrer"
              className="break-all text-body-sm font-medium text-primary underline decoration-1 underline-offset-2 hover:opacity-80"
            >
              {receipt.settlement.txHash}
            </a>
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button type="button" onClick={() => void handleConfirmOnChain()} disabled={chainConfirm.kind === "checking"} className={outlinedButton}>
              {chainConfirm.kind === "checking" ? "Checking…" : "Confirm on-chain"}
            </button>
            {chainConfirm.kind === "confirmed" && (
              <span className="text-body-sm font-medium text-primary">Confirmed on-chain, block {chainConfirm.blockNumber.toString()}</span>
            )}
            {chainConfirm.kind === "not-found" && <span className="text-body-sm text-graphite">Not found yet on-chain.</span>}
            {chainConfirm.kind === "error" && <span className="text-body-sm text-vermillion">{chainConfirm.message}</span>}
          </div>
        </section>
      )}
    </div>
  );
}
