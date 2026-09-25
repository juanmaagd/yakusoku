import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { PaymentRequired } from "@x402/core/types";
import { USDC_SEPOLIA_ADDRESS, X402_NETWORK, type PaymentRequirement } from "@yakusoku/shared";
import type { PipelineStage, StageContext, StageVerdict } from "./pipeline";
import type { StoredIntent } from "./store";

// pipeline.ts transitively imports store.ts (opens a bun:sqlite file under
// FIREWALL_DATA_DIR at module-load time) and signer.ts (reads
// FIREWALL_PRIVATE_KEY at module-load time to build the firewall's signing
// account). This suite only exercises `evaluateStages` — pure stage-iteration
// logic, no signing or persistence involved — so point both at an isolated
// temp dir / throwaway key before importing, rather than opening the shared
// dev sqlite file (apps/firewall/data/, live while the dev server runs) or
// requiring a real key when `bun test` runs without `--env-file` (the root
// `test` script). Neither value is ever used to sign or persist anything in
// this file.
process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-pipeline-test-"));
process.env.FIREWALL_PRIVATE_KEY ??= `0x${"11".repeat(32)}`;
const { evaluateStages } = await import("./pipeline");

// Pure ordering tests for the HARDEN "refuse dominance" fix — stubbed stages
// only, no network. The rule under test: `refuse` from any stage stops
// immediately and wins; `ask_human` is recorded but evaluation continues
// through the remaining stages, so a later `refuse` still overrides an
// earlier `ask_human`.

function makeIntent(): StoredIntent {
  return {
    id: "intent_pipeline_test",
    message: {
      task: "Buy a $25 Amazon gift card",
      budget: 25_000_000n,
      categories: ["gift_card:amazon"],
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: `0x${"11".repeat(32)}`,
    },
    signature: `0x${"aa".repeat(65)}`,
    signer: "0x1111111111111111111111111111111111111111",
    spent: 0n,
    createdAt: new Date().toISOString(),
  };
}

function makeRequirement(): PaymentRequirement {
  return {
    scheme: "exact",
    network: X402_NETWORK,
    amount: "25000000",
    asset: USDC_SEPOLIA_ADDRESS,
    payTo: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
  };
}

function makeCtx(): StageContext {
  return {
    intent: makeIntent(),
    requirement: makeRequirement(),
    paymentRequired: {} as unknown as PaymentRequired,
    resourceUrl: "http://localhost:4000/giftcard/amazon-25",
    context: {},
  };
}

/** A stub stage that records whether it ran and returns a fixed verdict. */
function stubStage(name: string, verdict: StageVerdict): PipelineStage & { calls: number } {
  const stage = {
    name,
    calls: 0,
    run(): StageVerdict {
      stage.calls++;
      return verdict;
    },
  };
  return stage;
}

const PASS: StageVerdict = { outcome: "pass" };
function refuse(reason: string, detail?: Record<string, unknown>): StageVerdict {
  return { outcome: "refuse", state: "jev_refused", reason, detail };
}
function askHuman(reason: string, detail?: Record<string, unknown>): StageVerdict {
  return { outcome: "ask_human", state: "jev_ask_human", reason, detail };
}

describe("evaluateStages", () => {
  test("every stage passes -> clear, full timeline of passes", async () => {
    const a = stubStage("a", PASS);
    const b = stubStage("b", PASS);
    const result = await evaluateStages([a, b], makeCtx());

    expect(result.outcome).toEqual({ kind: "clear" });
    expect(result.timeline.map((t) => [t.stage, t.outcome])).toEqual([
      ["a", "pass"],
      ["b", "pass"],
    ]);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });

  test("a refuse stops immediately — later stages never run", async () => {
    const a = stubStage("a", refuse("nope"));
    const b = stubStage("b", PASS);
    const result = await evaluateStages([a, b], makeCtx());

    expect(result.outcome).toEqual({ kind: "refuse", stageName: "a", state: "jev_refused", reason: "nope" });
    expect(b.calls).toBe(0);
  });

  test("ask_human does NOT stop evaluation — later stages still run", async () => {
    const a = stubStage("a", askHuman("needs a human"));
    const b = stubStage("b", PASS);
    const result = await evaluateStages([a, b], makeCtx());

    expect(b.calls).toBe(1);
    expect(result.outcome).toEqual({ kind: "ask_human", reason: "a: needs a human" });
  });

  // The HARDEN key scenario: an earlier stage escalates for an operational
  // reason (Intercepta with no API key), a later stage refuses outright
  // (Jev catching KEY CASE #9) — the refuse must win, not the earlier
  // ask_human, and the later stage must actually have run to produce it.
  test("HARDEN key case: ask_human from an earlier stage, refuse from a later stage -> refuse wins", async () => {
    const intercepta = stubStage("intercepta", askHuman("Intercepta not configured"));
    const jev = stubStage("jev", refuse("does not match the signed intent"));
    const result = await evaluateStages([intercepta, jev], makeCtx());

    expect(jev.calls).toBe(1); // Jev actually ran despite intercepta's ask_human
    expect(result.outcome).toEqual({
      kind: "refuse",
      stageName: "jev",
      state: "jev_refused",
      reason: "does not match the signed intent",
    });
    // Both stages' timeline entries are preserved even though refuse wins.
    expect(result.timeline.map((t) => [t.stage, t.outcome])).toEqual([
      ["intercepta", "ask_human"],
      ["jev", "refuse"],
    ]);
  });

  test("multiple ask_human stages -> reasons combine in stage order", async () => {
    const a = stubStage("a", askHuman("reason a"));
    const b = stubStage("b", PASS);
    const c = stubStage("c", askHuman("reason c"));
    const result = await evaluateStages([a, b, c], makeCtx());

    expect(result.outcome).toEqual({ kind: "ask_human", reason: "a: reason a; c: reason c" });
  });

  test("a later refuse after ask_human still stops any stage after it", async () => {
    const a = stubStage("a", askHuman("reason a"));
    const b = stubStage("b", refuse("reason b"));
    const c = stubStage("c", PASS);
    const result = await evaluateStages([a, b, c], makeCtx());

    expect(c.calls).toBe(0);
    expect(result.outcome).toMatchObject({ kind: "refuse", stageName: "b" });
  });

  test("jev/intercepta detail is collected across stages regardless of outcome kind", async () => {
    const intercepta = stubStage(
      "intercepta",
      askHuman("escalated", { intercepta: { addressVerdict: "medium", cached: false, latencyMs: 1 } }),
    );
    const jev = stubStage("jev", { outcome: "pass", detail: { jev: { verdict: "pay", model: "jev-1.13.0" } } });
    const result = await evaluateStages([intercepta, jev], makeCtx());

    expect(result.interceptaDetail).toEqual({ addressVerdict: "medium", cached: false, latencyMs: 1 } as never);
    expect(result.jevDetail).toEqual({ verdict: "pay", model: "jev-1.13.0" } as never);
    // pass from jev after ask_human from intercepta -> still ask_human overall.
    expect(result.outcome).toEqual({ kind: "ask_human", reason: "intercepta: escalated" });
  });

  test("empty stage list -> clear", async () => {
    const result = await evaluateStages([], makeCtx());
    expect(result.outcome).toEqual({ kind: "clear" });
    expect(result.timeline).toEqual([]);
  });
});
