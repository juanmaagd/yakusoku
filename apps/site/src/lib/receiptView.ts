// Pure view-model helpers for the P6 live dashboard — ported from the plain
// `apps/firewall/public/dashboard.js` (WU10/WU13), which stays in place
// (P7 decides its fate) but is no longer the thing anyone edits. Kept
// framework-free so both the timeline row and the detail panel can share
// exactly one classification of "what happened".

import type { DecisionReceipt, ReceiptTimelineEntry } from "@yakusoku/shared";

export type LaneStatus = "paid" | "blocked" | "waiting" | "expired" | "paused";

export interface ReceiptClassification {
  code: LaneStatus;
  label: string;
}

/** Maps a receipt to the badge shown on the "what Omamorisan did" lane. */
export function classifyReceipt(r: Pick<DecisionReceipt, "state" | "verdict">): ReceiptClassification {
  if (r.state === "paused") return { code: "paused", label: "Paused" };
  if (r.state === "awaiting_world_id") return { code: "waiting", label: "Waiting for you" };
  if (r.state === "world_id_denied" || r.state === "world_id_expired") {
    return { code: "expired", label: "Denied / expired" };
  }
  if (r.verdict === "pay") return { code: "paid", label: "Paid" };
  return { code: "blocked", label: "Blocked" };
}

export function decidingStage(timeline: readonly ReceiptTimelineEntry[] | undefined): string {
  if (!timeline || timeline.length === 0) return "—";
  return timeline[timeline.length - 1]!.stage;
}

export function reasonText(r: Pick<DecisionReceipt, "reasons">): string {
  return r.reasons?.[0] ?? "";
}

export function resourcePath(url?: string): string {
  if (!url) return "—";
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function formatPercent(n: number | undefined): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

export function formatMs(ms: number | undefined): string {
  return typeof ms === "number" ? `${ms} ms` : "—";
}

/** A short "in 4m" / "expired" countdown, refreshed by the caller on an
 * interval — same relative-time style as `format.ts`'s `formatExpiry`, kept
 * separate since the World ID approval card needs sub-minute resolution
 * (`format.ts` rounds to whole minutes). */
export function formatCountdown(expiresAtIso: string | undefined): { label: string; expired: boolean } {
  if (!expiresAtIso) return { label: "—", expired: false };
  const diffMs = new Date(expiresAtIso).getTime() - Date.now();
  if (diffMs <= 0) return { label: "expired", expired: true };
  const totalSeconds = Math.ceil(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return { label: `${minutes}:${String(seconds).padStart(2, "0")}`, expired: false };
}
