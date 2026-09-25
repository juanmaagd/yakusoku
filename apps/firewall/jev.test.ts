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

  test("social engineering never forces a hard refuse by itself (round-1 architecture change) -> ceiling is ask_human", () => {
    const result = decideJevVerdict(answers({ socialEngineering: 0.99, actionChoice: "refuse", actionConfidence: 0.99 }));
    expect(result.verdict).toBe("ask_human");
  });

  test("payment_source_is_untrusted_content just under 0.75 does not escalate", () => {
    const result = decideJevVerdict(answers({ untrustedSource: 0.7 }));
    expect(result.verdict).toBe("pay");
  });

  test("payment_source_is_untrusted_content >= 0.75 -> ask_human", () => {
    const result = decideJevVerdict(answers({ untrustedSource: 0.76 }));
    expect(result.verdict).toBe("ask_human");
  });

  test("matches_intent in the 0.3-0.8 band -> ask_human", () => {
    const result = decideJevVerdict(answers({ matchesIntent: 0.5 }));
    expect(result.verdict).toBe("ask_human");
  });

  test("high normalized risk score -> ask_human even with a clean matches_intent", () => {
    // risk score 3 of a 4-level (0-3) rubric normalizes to 1.0, well over the 0.66 threshold.
    const result = decideJevVerdict(answers({ riskScore: 3 }));
    expect(result.verdict).toBe("ask_human");
  });

  test("action=pay below the confidence threshold does not auto-pay", () => {
    const result = decideJevVerdict(answers({ actionChoice: "pay", actionConfidence: JEV_THRESHOLDS.payConfidence - 0.01 }));
    expect(result.verdict).toBe("ask_human");
  });

  test("action=refuse with no earlier signal -> refuse", () => {
    const result = decideJevVerdict(answers({ actionChoice: "refuse", actionConfidence: 0.5 }));
    expect(result.verdict).toBe("refuse");
  });
});
