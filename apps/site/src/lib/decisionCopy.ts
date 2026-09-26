// Plain-language view of a firewall decision for the Live view: the verdict
// stamp, one human sentence for why, and the stage checklist. Technical names
// (Jev, Intercepta, state machine values) stay in the detail's "Technical
// details" disclosure; nothing here claims more than the receipt says.

import type { DecisionReceipt } from "@yakusoku/shared";
import { classifyReceipt } from "./receiptView";

export type VerdictTone = "paid" | "refused" | "needs-you" | "expired" | "paused";

export interface Verdict {
  tone: VerdictTone;
  label: string;
}

export function verdictOf(r: Pick<DecisionReceipt, "state" | "verdict">): Verdict {
  const cls = classifyReceipt(r);
  switch (cls.code) {
    case "paid":
      return { tone: "paid", label: "Paid" };
    case "waiting":
      return { tone: "needs-you", label: "Needs you" };
    case "paused":
      return { tone: "paused", label: "Paused" };
    case "expired":
      return r.state === "world_id_expired" ? { tone: "expired", label: "Expired" } : { tone: "refused", label: "Refused" };
    case "blocked":
      return { tone: "refused", label: "Refused" };
  }
}

function policyReason(raw: string): string {
  if (/budget/i.test(raw)) return "Outside your intent: budget.";
  if (/expired/i.test(raw)) return "Outside your intent: expiry.";
  if (/network/i.test(raw)) return "Outside your intent: network.";
  if (/asset/i.test(raw)) return "Outside your intent: asset.";
  if (/revoked/i.test(raw)) return "The intent was revoked.";
  if (/paused by owner/i.test(raw)) return "You paused all agents.";
  if (/unknown intent/i.test(raw)) return "No intent matches this request.";
  if (/malformed/i.test(raw)) return "The payment request was malformed.";
  return "Outside your intent.";
}

/** One sentence for the "Omamorisan" lane. */
export function plainReason(r: Pick<DecisionReceipt, "state" | "reasons" | "worldId">): string {
  const raw = r.reasons?.[0] ?? "";
  switch (r.state) {
    case "idempotent_hit":
      return "Already handled. This was a replay.";
    case "policy_rejected":
      return policyReason(raw);
    case "merchant_blocked":
      return "The store's own answer didn't match what the agent asked to pay.";
    case "provenance_blocked":
      return "The destination came from untrusted page text.";
    case "intercepta_blocked":
      return "Recipient flagged by address screening.";
    case "intercepta_escalated":
      return "Address screening couldn't clear the recipient.";
    case "jev_refused":
      return "Not what you signed.";
    case "jev_ask_human":
      return "Unclear if this is what you signed.";
    case "awaiting_world_id":
      return "Waiting for you.";
    case "world_id_denied":
      if (r.worldId?.status === "paused") return "Stopped: you paused all agents.";
      if (r.worldId?.status === "revoked") return "Stopped: the intent was revoked.";
      if (r.worldId?.status === "error") return "The approval failed, so it was refused.";
      return "You denied it.";
    case "world_id_expired":
      return "The approval window expired. Nothing was paid.";
    case "paused":
      return "All agents were paused.";
    case "sign_failed":
      return "Signing failed. Nothing was paid.";
    case "signed":
    case "settled":
      return "Matches your intent. Signed.";
    case "settlement_failed":
      return "Signed, but the settlement failed.";
    case "error":
      return "Something failed, so it was refused.";
  }
}

export type StageMark = "pass" | "fail" | "wait" | "skip";

export interface StageRow {
  name: string;
  mark: StageMark;
  note?: string;
}

const STAGES: { id: string; name: string }[] = [
  { id: "idempotency", name: "Not a replay" },
  { id: "policy", name: "Within your intent" },
  { id: "merchant", name: "Verified with the store directly" },
  { id: "provenance", name: "Destination traceable" },
  { id: "intercepta", name: "Address screening" },
  { id: "jev", name: "Matches your intent" },
  { id: "world_id", name: "Human approval" },
  { id: "sign", name: "Signed" },
];

/** The pipeline as a plain checklist, in order. A stage missing from the
 * receipt's timeline was either not needed (the payment went through) or
 * never reached (something earlier stopped it). */
export function stageChecklist(r: Pick<DecisionReceipt, "timeline" | "verdict" | "state">): StageRow[] {
  const last = new Map<string, DecisionReceipt["timeline"][number]>();
  for (const entry of r.timeline) last.set(entry.stage, entry);
  const wentThrough = r.verdict === "pay";

  const rows: StageRow[] = [];
  const control = last.get("control");
  if (control) rows.push({ name: "Agents not paused", mark: control.outcome === "refuse" ? "fail" : "pass" });

  for (const stage of STAGES) {
    const entry = last.get(stage.id);
    if (!entry) {
      rows.push({ name: stage.name, mark: "skip", note: wentThrough ? "Not needed" : "Not reached" });
      continue;
    }
    if (entry.outcome === "pass") rows.push({ name: stage.name, mark: "pass" });
    else if (entry.outcome === "refuse") rows.push({ name: stage.name, mark: "fail" });
    else if (entry.outcome === "hit") rows.push({ name: stage.name, mark: "fail", note: "Replay of an earlier payment" });
    else rows.push({ name: stage.name, mark: "wait", note: r.state === "awaiting_world_id" ? "Waiting for you" : "Asked for a human" });
  }
  return rows;
}
