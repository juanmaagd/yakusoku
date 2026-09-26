// The World ID human-approval gate (WU11, plan-tecnico.md §2.3 last step).
//
// Two ways into this gate (pipeline.ts): a stage upstream (provenance,
// Intercepta, Jev) escalated `ask_human`, or every stage passed but the
// payment exceeds `HUMAN_APPROVAL_OVER_USDC` (`worldIdThresholdStage`
// below, the real implementation that replaces the WU3-WU10 pass-through in
// `PIPELINE_STAGES`). Either way, `startApprovalGate` starts a fresh
// RFC 8628 device flow, persists an `awaiting_world_id` receipt + a
// `PendingApproval` row (store.ts), and returns to the caller immediately —
// resolution happens in the background (`resolveApprovalInBackground`),
// driven by `world-id.ts`'s poll-until-resolved primitive, and is resumable
// across a `--watch` restart (`resumePendingApprovalsOnBoot`).
//
// Fail-closed throughout (plan-tecnico.md §2.4): every non-`approved`
// outcome — denied, expired, an unstartable device flow, an invalid ID
// token, or a signing failure after approval — refuses and releases the
// budget reservation `pipeline.ts` kept open while pending.

import type { PaymentRequired } from "@x402/core/types";
import {
  hashWorldIdSubject,
  paymentRequirementSchema,
  transition,
  USDC_DECIMALS,
  type DecisionReceipt,
  type ReceiptState,
  type ReceiptTimelineEntry,
  type Verdict,
} from "@yakusoku/shared";
import { publish } from "./events-bus";
import { resolvePayer } from "./payer";
import { resolveMandate } from "./promises";
import { finalize, type ApprovalInfo, type PipelineOutcome, type ReceiptContext } from "./receipts";
import { signPayment } from "./signer";
import { signStepUpAttestation } from "./step-up";
import {
  getAccount,
  getControlState,
  getOwnerControl,
  getPendingApprovalByReceiptId,
  getReceipt,
  listPendingApprovalsByStatus,
  recordSpend,
  savePendingApproval,
  type PendingApproval,
} from "./store";
import { ACR_ORB_V3, pollUntilResolved, startDeviceAuthorization, validateIdToken, type FreshApprovalClaims } from "./world-id";
import type { PipelineStage, StageContext, StageVerdict } from "./pipeline";

function firewallTimeoutSeconds(): number {
  const raw = Number(process.env.WORLD_ID_APPROVAL_TIMEOUT_S);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

function maxAuthAgeSeconds(): number {
  const raw = Number(process.env.WORLD_ID_MAX_AUTH_AGE_S);
  return Number.isFinite(raw) && raw > 0 ? raw : 300;
}

// --- world_id pipeline stage: the amount-threshold check --------------------

/**
 * Real implementation of the `world_id` slot in `PIPELINE_STAGES`
 * (pipeline.ts): with `HUMAN_APPROVAL_OVER_USDC` unset (default), every
 * payment that cleared every earlier stage passes straight through, so the
 * $25 legit demo purchase can still auto-pay once Intercepta is configured.
 * Set, a payment above the threshold still escalates to a fresh human
 * approval even though nothing upstream found it suspicious.
 */
export const worldIdThresholdStage: PipelineStage = {
  name: "world_id",
  run(ctx: StageContext): StageVerdict {
    const raw = process.env.HUMAN_APPROVAL_OVER_USDC;
    if (!raw) return { outcome: "pass" };
    const thresholdUsdc = Number(raw);
    if (!Number.isFinite(thresholdUsdc) || thresholdUsdc < 0) {
      // Malformed config is an operator mistake, not a payment risk signal —
      // log once-per-process and treat the threshold as unset rather than
      // escalating every single payment.
      console.warn(`[world-id] ignoring malformed HUMAN_APPROVAL_OVER_USDC=${raw}`);
      return { outcome: "pass" };
    }
    const amountUsdc = Number(ctx.requirement.amount) / 10 ** USDC_DECIMALS;
    if (amountUsdc > thresholdUsdc) {
      return {
        outcome: "ask_human",
        state: "awaiting_world_id",
        reason: `amount ${amountUsdc} USDC exceeds the ${thresholdUsdc} USDC human-approval threshold`,
      };
    }
    return { outcome: "pass" };
  },
};

// --- Response shaping --------------------------------------------------------

function toApprovalInfo(approval: PendingApproval): ApprovalInfo {
  return {
    status: approval.status,
    verificationUri: approval.verificationUriComplete ?? approval.verificationUri,
    userCode: approval.userCode,
    expiresAt: approval.expiresAt,
  };
}

/** Repeat `/sign` while an approval is still pending (pipeline.ts's
 * idempotency short-circuit) — same shape `startApprovalGate` returned the
 * first time, no second device flow, no second budget reservation. */
export function pendingApprovalOutcome(approval: PendingApproval): PipelineOutcome {
  return {
    verdict: "ask_human",
    reason: approval.reason ?? "awaiting World ID approval",
    receiptId: approval.receiptId,
    approval: toApprovalInfo(approval),
  };
}

export interface ApprovalStatusResponse {
  status: PendingApproval["status"];
  verificationUri?: string;
  userCode?: string;
  expiresAt?: string;
  verdict: Verdict;
  reason: string;
  paymentSignature?: string;
}

/** `GET /approvals/:receiptId` response shape. */
export function approvalStatusResponse(approval: PendingApproval): ApprovalStatusResponse {
  const verdict: Verdict = approval.status === "approved" ? "pay" : approval.status === "pending" ? "ask_human" : "refuse";
  return {
    ...toApprovalInfo(approval),
    verdict,
    reason: approval.reason ?? "awaiting World ID approval",
    paymentSignature: approval.status === "approved" ? approval.paymentSignature : undefined,
  };
}

// --- Entering the gate --------------------------------------------------------

export interface StartApprovalGateInput {
  receiptContext: ReceiptContext;
  timeline: ReceiptTimelineEntry[];
  stageCtx: StageContext;
  jevDetail?: DecisionReceipt["jev"];
  interceptaDetail?: DecisionReceipt["intercepta"];
  triggerReason: string;
  /** Tells the caller (pipeline.ts) to keep the budget reservation open —
   * this is neither "signed" nor "released", a third outcome for the
   * reservation's lifecycle. */
  markPending: () => void;
}

export async function startApprovalGate(input: StartApprovalGateInput): Promise<PipelineOutcome> {
  const { receiptContext, timeline, stageCtx, jevDetail, interceptaDetail, triggerReason, markPending } = input;
  const receiptId = `receipt_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const gateStartedAtMs = Date.now();

  let device: Awaited<ReturnType<typeof startDeviceAuthorization>>;
  try {
    device = await startDeviceAuthorization();
  } catch (err) {
    // Never entered "pending" — nothing to resume, budget was never touched
    // beyond the reservation pipeline.ts already released in `finally`.
    const reason = `could not start World ID approval: ${err instanceof Error ? err.message : String(err)}`;
    const finalTimeline = [...timeline, { stage: "world_id", outcome: "refuse" as const, reason, ms: Date.now() - gateStartedAtMs }];
    return finalize({
      ...receiptContext,
      receiptId,
      createdAt,
      timeline: finalTimeline,
      jev: jevDetail,
      intercepta: interceptaDetail,
      state: transition("initial", "error"),
      verdict: "refuse",
      reason,
      cache: true,
    });
  }

  const requestedAt = new Date();
  const deadlineMs = requestedAt.getTime() + Math.min(device.expiresIn, firewallTimeoutSeconds()) * 1000;
  const expiresAt = new Date(deadlineMs).toISOString();

  // Interim receipt: the pipeline's decision so far, now waiting on a human.
  // Never cached (`cache: false`) — a genuine idempotent replay of this
  // exact payment is handled by the pending-approval short-circuit above,
  // not by freezing "ask_human" into the idempotency cache forever.
  const interimTimeline = [
    ...timeline,
    { stage: "world_id", outcome: "ask_human" as const, reason: `awaiting fresh World ID approval (${triggerReason})`, ms: Date.now() - gateStartedAtMs },
  ];
  finalize({
    ...receiptContext,
    receiptId,
    createdAt,
    timeline: interimTimeline,
    jev: jevDetail,
    intercepta: interceptaDetail,
    state: transition("initial", "awaiting_world_id"),
    verdict: "ask_human",
    reason: triggerReason,
    cache: false,
  });

  const pending: PendingApproval = {
    receiptId,
    paymentIdentifier: receiptContext.paymentIdentifier,
    intentId: stageCtx.intent.id,
    amountAtomic: stageCtx.requirement.amount,
    deviceCode: device.deviceCode,
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
    intervalSeconds: device.interval,
    expiresAt,
    requestedAt: requestedAt.toISOString(),
    gateStartedAtMs,
    status: "pending",
    // The trigger, kept visible in `/sign` and `/approvals/:id` responses
    // while pending too — `settleRefused`/`settleApproved` overwrite this
    // with the terminal reason once the gate resolves.
    reason: triggerReason,
    paymentRequiredJson: JSON.stringify(stageCtx.paymentRequired),
    createdAt,
    updatedAt: createdAt,
  };
  savePendingApproval(pending);
  markPending();
  publish("approval.requested", {
    receiptId,
    userCode: device.userCode,
    verificationUri: device.verificationUriComplete ?? device.verificationUri,
    expiresAt,
  });

  void resolveApprovalInBackground(receiptId).catch((err) => {
    console.error(`[world-id] background resolution crashed for ${receiptId}`, err);
  });

  return pendingApprovalOutcome(pending);
}

// --- Resolving the gate --------------------------------------------------------

/** Shared tail of every terminal outcome: append the `world_id` (and, on
 * approval, `sign`) timeline entries, finalize the receipt in place, persist
 * the approval record, and publish the SSE events the dashboard listens for. */
function finalizeResolution(
  approval: PendingApproval,
  receipt: DecisionReceipt,
  extraTimeline: ReceiptTimelineEntry[],
  toState: ReceiptState,
  verdict: Verdict,
  reason: string,
  opts: { paymentSignature?: string; worldId?: DecisionReceipt["worldId"]; payer?: string; payerKind?: DecisionReceipt["payerKind"] } = {},
): void {
  finalize({
    receiptId: approval.receiptId,
    createdAt: receipt.createdAt,
    paymentIdentifier: receipt.paymentIdentifier,
    intentId: receipt.intentId,
    task: receipt.task,
    justification: receipt.justification,
    resourceUrl: receipt.resourceUrl ?? "",
    amount: receipt.amount,
    payTo: receipt.payTo,
    timeline: [...receipt.timeline, ...extraTimeline],
    jev: receipt.jev,
    intercepta: receipt.intercepta,
    worldId: opts.worldId,
    state: transition("awaiting_world_id", toState),
    verdict,
    reason,
    paymentSignature: opts.paymentSignature,
    payer: opts.payer,
    payerKind: opts.payerKind,
    cache: true,
  });
  publish("approval.resolved", { receiptId: approval.receiptId, status: approval.status, reason });
  const updated = getReceipt(approval.receiptId);
  if (updated) publish("decision", updated);
}

/** Denied / expired / pre-signature error: refuse and release the reservation.
 * WU12: every non-approved terminal status gets `worldId: { approved: false,
 * status }` and never an attestation — there's nothing to attest, no valid
 * human approval was used for this decision (plan-tecnico.md §2.4).
 * Exported (alongside `settleApproved` below) so approvals.test.ts can drive
 * "the approval resolution path" directly with fabricated claims/outcomes,
 * instead of mocking `world-id.ts`'s network-calling poll/validate
 * primitives — those already have their own no-network unit tests
 * (world-id.test.ts), and `mock.module` replaces a module process-wide for
 * the rest of the `bun test` run, which would otherwise break them. */
export async function settleRefused(
  approval: PendingApproval,
  status: Exclude<PendingApproval["status"], "pending" | "approved">,
  reason: string,
  receiptState: ReceiptState,
): Promise<void> {
  const receipt = getReceipt(approval.receiptId);
  if (!receipt) {
    console.error(`[world-id] settleRefused: receipt ${approval.receiptId} missing`);
    return;
  }
  const ms = Date.now() - approval.gateStartedAtMs;
  finalizeResolution(
    approval,
    receipt,
    [{ stage: "world_id", outcome: "refuse", reason, ms }],
    receiptState,
    "refuse",
    reason,
    { worldId: { approved: false, status } },
  );
  recordSpend(approval.intentId, -BigInt(approval.amountAtomic));

  approval.status = status;
  approval.reason = reason;
  approval.updatedAt = new Date().toISOString();
  savePendingApproval(approval);
}

/**
 * Approved + a valid, fresh ID token: first sign a StepUp attestation
 * binding this exact human approval to this exact payment (WU12 — before
 * the payment itself, per world-id-implementacion.md §C), then sign exactly
 * as the automatic path does (signer.ts, same spendControls). A failure at
 * either step is still fail-closed — refuse and release, never retry
 * silently, never sign a payment without also attesting the approval that
 * authorized it.
 */
export async function settleApproved(approval: PendingApproval, claims: FreshApprovalClaims): Promise<void> {
  const receipt = getReceipt(approval.receiptId);
  if (!receipt) {
    console.error(`[world-id] settleApproved: receipt ${approval.receiptId} missing`);
    return;
  }
  // P9.2: resolves either a wallet-signed intent or a world_id promise —
  // see promises.ts's `resolveMandate`/`promiseAsMandate`.
  const intent = resolveMandate(approval.intentId);
  if (!intent) {
    await settleRefused(approval, "error", "intent no longer available when the approval resolved", "error");
    return;
  }

  // P9.2: a doubtful-payment approval on a world_id-sourced promise must be
  // approved by the SAME human the promise belongs to — a valid, fresh
  // World ID token for a different person still refuses, fail-closed,
  // exactly like promises.ts's own approval gate requires to activate the
  // promise in the first place. Never reached for a wallet-sourced intent
  // (`intent.source` is only ever set on the promise adapter).
  if (intent.source === "world_id") {
    const account = intent.accountId ? getAccount(intent.accountId) : undefined;
    if (!account) {
      await settleRefused(approval, "error", "account no longer available when the approval resolved", "error");
      return;
    }
    const subjectHash = hashWorldIdSubject(claims.sub);
    if (subjectHash.toLowerCase() !== account.subjectHash.toLowerCase()) {
      await settleRefused(approval, "world_id_wrong_human", "world_id_wrong_human", "world_id_denied");
      return;
    }
  }

  // WU13: re-check the kill switch and intent-revocation status right here,
  // right before signing — a human can approve minutes after a pause was
  // hit or the intent got revoked, and neither must slip a payment through
  // this late. `settleRefused` releases the budget reservation exactly like
  // every other non-approved outcome; reused `world_id_denied` receipt
  // state since it's already a valid transition from `awaiting_world_id`.
  const control = getControlState();
  if (control.paused) {
    const reason = control.reason ? `paused: ${control.reason}` : "paused";
    await settleRefused(approval, "paused", reason, "world_id_denied");
    return;
  }
  if (intent.revoked) {
    await settleRefused(approval, "revoked", "intent revoked", "world_id_denied");
    return;
  }
  // WU-P3: same re-check for a per-owner pause landed while this approval was
  // in flight — independent of the global kill switch above.
  const ownerControl = getOwnerControl(intent.signer);
  if (ownerControl.paused) {
    const reason = ownerControl.reason ? `paused by owner: ${ownerControl.reason}` : "paused by owner";
    await settleRefused(approval, "paused", reason, "world_id_denied");
    return;
  }

  // P11.2 — resolved fresh here (cheap, pure, deterministic from `intent`
  // alone) rather than carried from the original `/sign` request's
  // `StageContext` (long gone by the time a World ID approval resolves in
  // the background) — see pipeline.ts's identical recomputation for the
  // immediate-sign path. `checkPolicy`'s promise/account checks above already
  // guarantee this succeeds for anything that reached `awaiting_world_id`.
  const payerResolution = resolvePayer(intent);
  if (!payerResolution.ok) {
    await settleRefused(approval, "error", `account_not_set_up: ${payerResolution.detail}`, "error");
    return;
  }
  const { payer } = payerResolution;

  const worldMs = Date.now() - approval.gateStartedAtMs;
  const signStart = Date.now();
  // Set once the StepUp attestation itself is signed — kept in this outer
  // scope so a later payment-signing failure can still attach it to the
  // `sign_failed` receipt (the human genuinely approved; only the payment
  // signature failed).
  let worldIdDetail: DecisionReceipt["worldId"] | undefined;
  try {
    const paymentRequired = JSON.parse(approval.paymentRequiredJson) as PaymentRequired;
    const requirement = paymentRequirementSchema.parse(paymentRequired.accepts?.[0] ?? {});

    const attestation = await signStepUpAttestation({
      receiptId: approval.receiptId,
      intentId: approval.intentId,
      paymentIdentifier: approval.paymentIdentifier,
      payTo: requirement.payTo,
      amount: requirement.amount,
      asset: requirement.asset,
      network: requirement.network,
      worldIdSub: claims.sub,
      // The sandbox's discovery document currently only advertises this acr
      // (world-id.ts) and `validateIdToken` already rejects any other
      // non-undefined value — an absent claim (lenient case) still attests
      // under the only acr this deployment recognizes.
      acr: claims.acr ?? ACR_ORB_V3,
      authTimeSeconds: claims.authTime,
    });
    worldIdDetail = {
      approved: true,
      subject: attestation.message.worldIdSubject,
      acr: attestation.message.acr,
      authTime: claims.authTime,
      attestation,
    };

    const { paymentSignatureHeader } = await signPayment({
      paymentRequired,
      maxBudgetAtomic: intent.message.budget,
      paymentIdentifier: approval.paymentIdentifier,
      payer,
    });
    const timeline: ReceiptTimelineEntry[] = [
      { stage: "world_id", outcome: "pass", reason: "human approved via World ID", ms: worldMs },
      { stage: "sign", outcome: "pass", ms: Date.now() - signStart },
    ];
    finalizeResolution(
      approval,
      receipt,
      timeline,
      "signed",
      "pay",
      "human approved via World ID; all pipeline checks passed",
      { paymentSignature: paymentSignatureHeader, worldId: worldIdDetail, payer: payer.address, payerKind: payer.kind },
    );
    approval.status = "approved";
    approval.paymentSignature = paymentSignatureHeader;
    approval.updatedAt = new Date().toISOString();
    savePendingApproval(approval);
  } catch (err) {
    const reason = `signing failed after World ID approval: ${err instanceof Error ? err.message : String(err)}`;
    const timeline: ReceiptTimelineEntry[] = [
      { stage: "world_id", outcome: "pass", reason: "human approved via World ID", ms: worldMs },
      { stage: "sign", outcome: "refuse", reason, ms: Date.now() - signStart },
    ];
    finalizeResolution(approval, receipt, timeline, "sign_failed", "refuse", reason, { worldId: worldIdDetail });
    recordSpend(approval.intentId, -BigInt(approval.amountAtomic));
    approval.status = "error";
    approval.reason = reason;
    approval.updatedAt = new Date().toISOString();
    savePendingApproval(approval);
  }
}

/** Drives one pending approval to a terminal outcome — polls World ID until
 * approved/denied/expired/error or the deadline passes, then settles.
 * Resumable: called both right after `startApprovalGate` and again on boot
 * (`resumePendingApprovalsOnBoot`) for rows still `status: "pending"`. */
export async function resolveApprovalInBackground(receiptId: string): Promise<void> {
  const approval = getPendingApprovalByReceiptId(receiptId);
  if (!approval || approval.status !== "pending") return; // already resolved, or unknown

  const deadlineMs = new Date(approval.expiresAt).getTime();
  const outcome = await pollUntilResolved({
    deviceCode: approval.deviceCode,
    initialIntervalSeconds: approval.intervalSeconds,
    deadlineMs,
    onTick: (result, intervalSeconds) => {
      if (result.status === "slow_down" && intervalSeconds !== approval.intervalSeconds) {
        approval.intervalSeconds = intervalSeconds;
        approval.updatedAt = new Date().toISOString();
        savePendingApproval(approval);
      }
    },
  });

  switch (outcome.status) {
    case "approved": {
      const validation = await validateIdToken(outcome.idToken, {
        requestedAtSeconds: Math.floor(new Date(approval.requestedAt).getTime() / 1000),
        maxAuthAgeSeconds: maxAuthAgeSeconds(),
      });
      if (!validation.valid) {
        await settleRefused(approval, "error", `invalid World ID token: ${validation.reason}`, "error");
        return;
      }
      await settleApproved(approval, validation.claims);
      return;
    }
    case "denied":
      await settleRefused(approval, "denied", "human denied the World ID approval request", "world_id_denied");
      return;
    case "expired":
      await settleRefused(approval, "expired", "World ID approval window elapsed without a response", "world_id_expired");
      return;
    case "error":
      await settleRefused(approval, "error", outcome.message, "error");
      return;
  }
}

/** Resume every still-pending approval on process start (`--watch` restart
 * or a crash recovery) — `resolveApprovalInBackground` itself resolves as
 * `expired` immediately for a row whose deadline already passed, so this is
 * safe to call unconditionally at boot. */
export function resumePendingApprovalsOnBoot(): void {
  const pending = listPendingApprovalsByStatus("pending");
  for (const approval of pending) {
    console.log(`[world-id] resuming pending approval ${approval.receiptId} (expires ${approval.expiresAt})`);
    void resolveApprovalInBackground(approval.receiptId).catch((err) => {
      console.error(`[world-id] resume failed for ${approval.receiptId}`, err);
    });
  }
}
