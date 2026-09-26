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
// account). This suite mostly exercises `evaluateStages` — pure
// stage-iteration logic, no signing or persistence involved — plus (the
// "purchaseRef" describe blocks below) the network-free TOP of
// `runSignPipeline` (kill switch / idempotency / pending-approval / policy),
// which never reaches a real pipeline stage — so point both at an isolated
// temp dir / throwaway key before importing, rather than opening the shared
// dev sqlite file (apps/firewall/data/, live while the dev server runs) or
// requiring a real key when `bun test` runs without `--env-file` (the root
// `test` script). Neither value is ever used to sign or persist anything for
// real in this file.
process.env.FIREWALL_DATA_DIR = mkdtempSync(join(tmpdir(), "yakusoku-pipeline-test-"));
process.env.FIREWALL_PRIVATE_KEY ??= `0x${"11".repeat(32)}`;
const { computePaymentIdentifier, computePurchaseIdentifier, evaluateStages, runSignPipeline } = await import("./pipeline");
const { createIntent, getCachedSignOutcome, getIntent, savePendingApproval } = await import("./store");

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
    revoked: false,
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

// --- WU: purchase ref — repeat-purchase fix (odd/tasks/standing-rules.md T7) -
//
// These tests only ever exercise the TOP of `runSignPipeline` — the kill
// switch, the idempotency/base-refusal lookup, the pending-approval lookup,
// and `checkPolicy` — deliberately never reaching a real `PIPELINE_STAGES`
// stage. `merchant` (the very first real stage) does a genuine `fetch()` of
// `resourceUrl`, which this worktree must never do against a bare
// `localhost:4000`/`4001` — those ports belong to the main checkout's live
// dev servers (see this task's own instructions) — so every fixture below is
// shaped to refuse at `checkPolicy` (an over-budget amount) or short-circuit
// at the pending-approval check, both strictly BEFORE any stage would run.
// "Pay"-outcome coverage (two purchaseRefs settling as two independently
// signed payments, two independent budget reservations) lives in
// approvals.test.ts, which already has the established no-network pattern
// for driving the sign path directly (`settleApproved`, no
// `PIPELINE_STAGES` either).

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

function makeWalletIntent(budgetAtomic: bigint) {
  return createIntent(
    {
      task: "Buy a $1 Amazon gift card",
      budget: budgetAtomic,
      categories: ["gift_card:amazon"],
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: randomNonce(),
    },
    `0x${"aa".repeat(65)}`,
    "0x3333333333333333333333333333333333333333",
  );
}

function makePaymentRequired(amount: string): PaymentRequired {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: X402_NETWORK,
        amount,
        asset: USDC_SEPOLIA_ADDRESS,
        payTo: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  } as unknown as PaymentRequired;
}

describe("computePurchaseIdentifier", () => {
  test("no purchaseRef -> identical to the base identifier (current behavior, byte-for-byte)", () => {
    const base = computePaymentIdentifier(
      "intent_x",
      { scheme: "exact", network: X402_NETWORK, amount: "1", asset: USDC_SEPOLIA_ADDRESS, payTo: "0xabc" },
      "http://x/y",
    );
    expect(computePurchaseIdentifier(base, undefined)).toBe(base);
  });

  test("a purchaseRef produces a distinct, deterministic identifier per ref", () => {
    const base = "pay_deadbeef";
    const first = computePurchaseIdentifier(base, "first");
    const firstAgain = computePurchaseIdentifier(base, "first");
    const second = computePurchaseIdentifier(base, "second");

    expect(first).toBe(firstAgain); // deterministic — same (base, ref) -> same identifier
    expect(first).not.toBe(base); // distinct from the base identifier
    expect(first).not.toBe(second); // distinct per purchaseRef
  });
});

describe("runSignPipeline — purchaseRef base/purchase identifier routing (network-free)", () => {
  test("a refusal under purchaseRef A is replayed for purchaseRef B — cached on the BASE identifier, not either purchase identifier", async () => {
    const { intent } = makeWalletIntent(1_000_000n); // $1 budget
    const paymentRequired = makePaymentRequired("5000000"); // $5 > budget -> policy_rejected, before any stage runs
    const resourceUrl = "http://localhost:4000/giftcard/amazon-5-purchase-ref-test";

    const first = await runSignPipeline({ intentId: intent.id, paymentRequired, resourceUrl, purchaseRef: "ref-a" });
    expect(first.verdict).toBe("refuse");
    expect(first.reason).toContain("exceeds remaining budget");

    const baseIdentifier = computePaymentIdentifier(intent.id, paymentRequired.accepts?.[0], resourceUrl);
    const purchaseIdentifierA = computePurchaseIdentifier(baseIdentifier, "ref-a");
    const purchaseIdentifierB = computePurchaseIdentifier(baseIdentifier, "ref-b");
    expect(purchaseIdentifierA).not.toBe(purchaseIdentifierB);
    // Cached under the BASE identifier — a DIFFERENT purchaseRef's lookup
    // finds it too (that's exactly what the assertion below proves).
    expect(getCachedSignOutcome(baseIdentifier)?.verdict).toBe("refuse");

    const second = await runSignPipeline({ intentId: intent.id, paymentRequired, resourceUrl, purchaseRef: "ref-b" });
    expect(second.verdict).toBe("refuse");
    expect(second.reason).toContain("idempotent replay of a previously processed payment");
  });

  test("no purchaseRef -> identical to current (pre-feature) behavior: a policy refusal caches and replays under one single identifier", async () => {
    const { intent } = makeWalletIntent(1_000_000n);
    const paymentRequired = makePaymentRequired("5000000");
    const resourceUrl = "http://localhost:4000/giftcard/amazon-5-no-ref-test";

    const first = await runSignPipeline({ intentId: intent.id, paymentRequired, resourceUrl });
    expect(first.verdict).toBe("refuse");
    const baseIdentifier = computePaymentIdentifier(intent.id, paymentRequired.accepts?.[0], resourceUrl);
    expect(getCachedSignOutcome(baseIdentifier)?.verdict).toBe("refuse");

    const second = await runSignPipeline({ intentId: intent.id, paymentRequired, resourceUrl });
    expect(second.verdict).toBe("refuse");
    expect(second.reason).toContain("idempotent replay of a previously processed payment");
  });

  test("the same purchaseRef replays a pending World ID approval instead of starting a second one — no new budget reservation", async () => {
    const { intent } = makeWalletIntent(5_000_000n);
    const paymentRequired = makePaymentRequired("1000000");
    const resourceUrl = "http://localhost:4000/giftcard/amazon-1-pending-ref-test";
    const baseIdentifier = computePaymentIdentifier(intent.id, paymentRequired.accepts?.[0], resourceUrl);
    const purchaseIdentifier = computePurchaseIdentifier(baseIdentifier, "ref-pending");

    savePendingApproval({
      receiptId: "receipt_pipeline_test_pending",
      paymentIdentifier: purchaseIdentifier,
      baseIdentifier,
      intentId: intent.id,
      amountAtomic: "1000000",
      deviceCode: "device-pipeline-test-pending",
      userCode: "USER-1",
      verificationUri: "https://sandbox.auth.world.org/device",
      intervalSeconds: 5,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestedAt: new Date().toISOString(),
      gateStartedAtMs: Date.now(),
      status: "pending",
      reason: "test setup",
      paymentRequiredJson: JSON.stringify(paymentRequired),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const spentBefore = getIntent(intent.id)?.spent;
    const result = await runSignPipeline({ intentId: intent.id, paymentRequired, resourceUrl, purchaseRef: "ref-pending" });
    expect(result.verdict).toBe("ask_human");
    expect(result.receiptId).toBe("receipt_pipeline_test_pending");
    // The pending-approval short-circuit returns before `checkPolicy`/
    // `recordSpend` ever runs — a replay never reserves budget a second time.
    expect(getIntent(intent.id)?.spent).toBe(spentBefore);
  });
});
