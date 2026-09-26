import type { ReactNode } from "react";

export type PillTone = "neutral" | "verified" | "refuse" | "ask" | "muted";

const tones: Record<PillTone, string> = {
  neutral: "border border-hairline-strong text-ink",
  verified: "bg-verified-wash text-verified",
  refuse: "bg-refuse-wash text-refuse-ink",
  ask: "bg-ask-wash text-ask-ink",
  muted: "bg-fog text-graphite",
};

/** Small mono state pill. Tone is a firewall/promise state, never decoration. */
export default function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span className={`label inline-flex items-center gap-1.5 rounded-sm px-2 py-[3px] ${tones[tone]}`}>{children}</span>;
}
