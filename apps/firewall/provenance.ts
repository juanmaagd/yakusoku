// Deterministic provenance check (plan-tecnico.md §2.3, jev-diseno.md §5) —
// re-implemented from the Aegis402 `L4 — provenance` detector's published
// logic (docs/research/jev-diseno.md §5, itself ported from
// `Solitud1nem/aegis402`'s `src/aegis402/detectors/provenance.py` and
// `text_extract.py`; no code copied). Pure, synchronous, no network: decides
// whether the payment's recipient is traceable to something the user
// actually signed, or only to content an untrusted page/API asserted.
//
// Adaptation vs. the ported pseudocode: Aegis402's `recipient` came from
// free-form agent-reported text, so "not found anywhere" fell into a review
// band. Here `requirement.payTo` is instead independently decoded by the
// firewall from the store's real x402 `PaymentRequirements` for the resource
// (never from agent-reported text — see casos-de-ataque.md #10), so a clean
// merchant address that's simply never mentioned in any text is the ordinary
// case, not a suspicious one: it PASSES. Only a recipient asserted solely by
// untrusted content — and never by the user's own signed request — blocks.
// Item/category mismatches (a clean, in-budget address for the wrong
// product — casos-de-ataque.md KEY CASE #9) are deliberately NOT this
// layer's job: that's Jev's `matches_intent` (WU8).

import type { PipelineStage, StageContext, StageVerdict } from "./pipeline";

const ZERO_WIDTH_PATTERN = /[​-‍⁠﻿]/g;

// Confusables folded onto the hex alphabet before matching. Cyrillic/Greek
// entries are lowercase because folding runs after `.toLowerCase()`; Latin
// entries disguise hex digits with visually similar letters (jev-diseno.md
// §5's illustrative table).
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: "a", // U+0430 CYRILLIC SMALL LETTER A
  е: "e", // U+0435 CYRILLIC SMALL LETTER IE
  о: "0", // U+043E CYRILLIC SMALL LETTER O
  с: "c", // U+0441 CYRILLIC SMALL LETTER ES
  α: "a", // U+03B1 GREEK SMALL LETTER ALPHA
  ε: "e", // U+03B5 GREEK SMALL LETTER EPSILON
  ο: "0", // U+03BF GREEK SMALL LETTER OMICRON
  o: "0",
  l: "1",
  i: "1",
  z: "2",
  s: "5",
  g: "9",
  q: "9",
};

const HEX_DIGITS = new Set("0123456789abcdef");

/**
 * Folds text to a continuous hex-alphabet stream: NFKC-normalizes, strips
 * zero-width/control separators, lowercases, then maps confusables — any
 * non-hex character (real separators, punctuation, prose) is simply dropped.
 * <1ms, deterministic.
 */
function hexStream(text: string): string {
  const folded = text.normalize("NFKC").replace(ZERO_WIDTH_PATTERN, "").toLowerCase();
  let out = "";
  for (const ch of folded) {
    const mapped = CONFUSABLES[ch] ?? ch;
    if (HEX_DIGITS.has(mapped)) out += mapped;
  }
  return out;
}

/** True when `address` appears inside `text`, tolerant to case, zero-width
 * splitting, and homoglyph obfuscation (see `hexStream`). */
export function addressAppears(address: string, text: string): boolean {
  const body = (address.startsWith("0x") ? address.slice(2) : address).toLowerCase();
  if (body.length !== 40 || [...body].some((c) => !HEX_DIGITS.has(c))) return false;
  return hexStream(text).includes(body);
}

export interface UntrustedContentItem {
  source: string;
  text: string;
}

export interface ProvenanceInput {
  payTo: string;
  /** The user's own signed request text (`intent.message.task`) — the only
   * trusted grounding source; there is no allowlist field on `TaskIntent`. */
  trustedText: string;
  untrustedContent: readonly UntrustedContentItem[];
}

export type ProvenanceResult =
  | { outcome: "pass"; reason: string }
  | { outcome: "refuse" | "ask_human"; reason: string };

export function checkProvenance(input: ProvenanceInput): ProvenanceResult {
  if (addressAppears(input.payTo, input.trustedText)) {
    return { outcome: "pass", reason: "recipient address appears in the user's signed request" };
  }

  const untrustedHit = input.untrustedContent.find((item) => addressAppears(input.payTo, item.text));
  if (untrustedHit) {
    return {
      outcome: "refuse",
      reason: `recipient address only appears in untrusted content (${untrustedHit.source}), never in the signed request`,
    };
  }

  return {
    outcome: "pass",
    reason: "recipient not asserted by any untrusted content; trusted via the x402 protocol-level requirement",
  };
}

// --- Pipeline wiring ---------------------------------------------------------

function parseUntrustedContent(
  context: Record<string, unknown> | undefined,
): { ok: true; items: UntrustedContentItem[] } | { ok: false; reason: string } {
  if (context === undefined) {
    return { ok: false, reason: "missing pipeline context: no untrusted-content signal for provenance" };
  }
  const raw = context.untrustedContent;
  if (raw === undefined) {
    return { ok: false, reason: "context.untrustedContent is missing" };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "context.untrustedContent is not an array" };
  }
  const items: UntrustedContentItem[] = [];
  for (const entry of raw) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as Record<string, unknown>).source !== "string" ||
      typeof (entry as Record<string, unknown>).text !== "string"
    ) {
      return { ok: false, reason: "context.untrustedContent has a malformed entry" };
    }
    items.push(entry as UntrustedContentItem);
  }
  return { ok: true, items };
}

/** Fail-closed per plan-tecnico.md §2.4: a missing/malformed `context` never
 * silently passes — there is no untrusted-content signal to reason about, so
 * an autonomous agent shouldn't have its payment waved through in silence. */
export const provenanceStage: PipelineStage = {
  name: "provenance",
  run(ctx: StageContext): StageVerdict {
    const parsed = parseUntrustedContent(ctx.context);
    if (!parsed.ok) {
      return { outcome: "ask_human", state: "provenance_blocked", reason: parsed.reason };
    }
    const result = checkProvenance({
      payTo: ctx.requirement.payTo,
      trustedText: ctx.intent.message.task,
      untrustedContent: parsed.items,
    });
    if (result.outcome === "pass") return { outcome: "pass" };
    return { outcome: result.outcome, state: "provenance_blocked", reason: result.reason };
  },
};
