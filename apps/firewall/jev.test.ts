import { describe, expect, test } from "bun:test";
import { decideJevVerdict, JEV_THRESHOLDS } from "./jev";

// Pure decision-rule tests only — stubbed answers, no network call, per the
// WU8 TDD-off constraint ("don't let it call the network").
function answers(overrides: {
  matchesIntent?: number;
  socialEngineering?: number;
  untrustedSource?: number;
  actionChoice?: "pay" | "refuse" | "ask_human";
  actionConfidence?: number;
  riskScore?: number;
}) {
  return {
    matches_intent: { noul: overrides.matchesIntent ?? 0.95 },
    looks_like_social_engineering: { noul: overrides.socialEngineering ?? 0.1 },
    payment_source_is_untrusted_content: { noul: overrides.untrustedSource ?? 0.1 },
    action: { choice: overrides.actionChoice ?? "pay", confidence: overrides.actionConfidence ?? 0.95 },
    risk: { score: overrides.riskScore ?? 0, confidence: 0.9 },
  };
}

describe("decideJevVerdict", () => {
  test("clean, high-confidence pay -> pay", () => {
    const result = decideJevVerdict(answers({}));
    expect(result.verdict).toBe("pay");
  });

  test("KEY CASE #9 shape: low matches_intent refuses even when social engineering is also high", () => {
    const result = decideJevVerdict(
      answers({ matchesIntent: 0.03, socialEngineering: 0.67, actionChoice: "refuse", actionConfidence: 0.97 }),
    );
    expect(result.verdict).toBe("refuse");
  });

  test("low matches_intent with no social-engineering/untrusted-source signal -> refuse", () => {
    const result = decideJevVerdict(answers({ matchesIntent: 0.03, actionChoice: "refuse", actionConfidence: 0.97 }));
    expect(result.verdict).toBe("refuse");
  });

  test("social engineering alone never hard-refuses: ceiling is ask_human", () => {
    const result = decideJevVerdict(answers({ socialEngineering: 0.99, actionChoice: "ask_human", actionConfidence: 0.5 }));
    expect(result.verdict).toBe("ask_human");
  });

  test("model refuse with high confidence -> refuse", () => {
    const result = decideJevVerdict(answers({ actionChoice: "refuse", actionConfidence: 0.9 }));
    expect(result.verdict).toBe("refuse");
  });

  test("model refuse with medium confidence never auto-pays -> ask_human", () => {
    const result = decideJevVerdict(answers({ actionChoice: "refuse", actionConfidence: 0.5 }));
    expect(result.verdict).toBe("ask_human");
  });

  test("noise-level model refuse on a clean purchase is ignored (live legit-1 flip) -> pay", () => {
    const result = decideJevVerdict(
      answers({ matchesIntent: 0.85, socialEngineering: 0.09, untrustedSource: 0.24, actionChoice: "refuse", actionConfidence: 0.05, riskScore: 2.06 }),
    );
    expect(result.verdict).toBe("pay");
  });

  test("untrusted source below the auto-pay margin -> pay", () => {
    const result = decideJevVerdict(answers({ untrustedSource: 0.4 }));
    expect(result.verdict).toBe("pay");
  });

  test("untrusted source under the 0.75 ceiling -> pay (item picked from the store's own catalog)", () => {
    // Live standing-rules purchase: matches_intent 0.87, social engineering
    // 0.04, untrusted source 0.64 — used to land on ask_human at the old 0.5 margin.
    const result = decideJevVerdict(answers({ matchesIntent: 0.87, socialEngineering: 0.04, untrustedSource: 0.64 }));
    expect(result.verdict).toBe("pay");
  });

  test("payment_source_is_untrusted_content >= 0.75 -> ask_human", () => {
    const result = decideJevVerdict(answers({ untrustedSource: 0.76 }));
    expect(result.verdict).toBe("ask_human");
  });

  test("social engineering at or above the auto-pay margin -> ask_human", () => {
    const result = decideJevVerdict(answers({ socialEngineering: JEV_THRESHOLDS.payMaxSocialEngineering }));
    expect(result.verdict).toBe("ask_human");
  });

  test("matches_intent in the 0.3-0.8 band -> ask_human", () => {
    const result = decideJevVerdict(answers({ matchesIntent: 0.5 }));
    expect(result.verdict).toBe("ask_human");
  });

  test("high normalized risk score -> ask_human even with a clean matches_intent", () => {
    // risk score 3 of a 4-level (0-3) rubric normalizes to 1.0, over the 0.8 threshold.
    const result = decideJevVerdict(answers({ riskScore: 3 }));
    expect(result.verdict).toBe("ask_human");
  });

  test("clean gift-card purchase with low action confidence and risk ~0.70 pays (live legit-1 shape)", () => {
    const result = decideJevVerdict(
      answers({ matchesIntent: 0.84, socialEngineering: 0.09, untrustedSource: 0.27, actionChoice: "ask_human", actionConfidence: 0.01, riskScore: 2.1 }),
    );
    expect(result.verdict).toBe("pay");
  });
});
