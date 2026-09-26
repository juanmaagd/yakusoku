// H1 fix (GitHub issue #1) — firewall self-fetch. Before this stage existed,
// `/sign` trusted whatever `payTo`/`amount`/`asset`/`network`/`scheme` the
// agent forwarded from its own decode of the store's `PAYMENT-REQUIRED`
// header (apps/mcp/tools.ts's `pay_x402`, apps/agent/index.ts). A compromised
// agent could swap `payTo` for a fresh attacker address — clean, in budget,
// right item — and provenance/Intercepta/Jev/World ID all pass it, because
// none of them independently confirm the requirement against the merchant
// itself. A look-alike store reached by an honest agent is caught the same
// way.
//
// This stage runs FIRST in `PIPELINE_STAGES` (pipeline.ts), before
// `provenance`, so every later stage — and the eventual `signPayment` call —
// only ever sees the firewall's own fetch, never the agent's copy:
//
//   1. (world_id promises only) refuse before any network call if
//      `resourceUrl`'s origin isn't the promise's own bound merchant
//      (`StoredPromise.merchant`, promises.ts) — `merchant_mismatch`. This
//      also means the self-fetch below, for a promise payment, is only ever
//      made to that human-approved origin.
//   2. GET `resourceUrl` itself — http(s) only, no redirects followed, a
//      ~4s timeout, headers read only, body discarded unread.
//   3. Decode its `PAYMENT-REQUIRED` header and compare the STABLE fields of
//      `accepts[0]` (scheme, network, asset, amount, payTo) against what the
//      agent forwarded. A `payTo` difference is `payee_mismatch`; any other
//      difference is `requirement_mismatch`.
//   4. A non-402, a missing/undecodable header, or a fetch/timeout failure
//      is `merchant_unreachable` (network-level) or `requirement_mismatch`
//      (the merchant answered, just not with this requirement) — always
//      fail-closed refuse, never pass.
//
// A wallet-signed TaskIntent has no merchant field in its EIP-712 schema (see
// step 1's caveat) and only gets the generic self-fetch protection (steps
// 2-4) — a documented tradeoff, see README's limitations section.

import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { paymentRequirementSchema, type PaymentRequirement } from "@yakusoku/shared";
import type { PipelineStage, StageContext, StageVerdict } from "./pipeline";

const SELF_FETCH_TIMEOUT_MS = 4000;

export type MerchantCheckReason = "payee_mismatch" | "requirement_mismatch" | "merchant_unreachable" | "merchant_mismatch";

export interface MerchantCheckFailure {
  ok: false;
  reason: MerchantCheckReason;
  detail: string;
}

/**
 * Normalizes a URL down to its origin (`scheme://host[:port]`, default ports
 * omitted, host lowercased) via the platform's own `URL` parser — the ONE
 * normalization both `promises.ts` (binding a promise's merchant at
 * creation) and this stage (comparing at payment time) use, so the two can
 * never drift apart. Only `http`/`https` are accepted, matching the
 * self-fetch below.
 */
export function normalizeMerchantOrigin(rawUrl: string): { ok: true; origin: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `not a valid URL: ${rawUrl}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported URL scheme: ${url.protocol}` };
  }
  return { ok: true, origin: url.origin };
}

interface MerchantFetchSuccess {
  ok: true;
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirement;
}

/**
 * Independently fetches `resourceUrl` and decodes its own `PAYMENT-REQUIRED`
 * header — never trusts anything the agent forwarded. `redirect: "manual"`
 * plus the explicit 3xx check below means a redirect is treated as a failure
 * rather than followed (SSRF hardening — see README's limitations section);
 * the response body is cancelled unread since only headers matter here.
 */
async function fetchMerchantRequirement(resourceUrl: string): Promise<MerchantFetchSuccess | MerchantCheckFailure> {
  const originResult = normalizeMerchantOrigin(resourceUrl);
  if (!originResult.ok) {
    return { ok: false, reason: "merchant_unreachable", detail: originResult.reason };
  }

  let response: Response;
  try {
    response = await fetch(resourceUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(SELF_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // T1 fix (odd/tasks/dokploy-deploy.md) — this used to fail silently: the
    // `merchant_unreachable` reason reaches the receipt, but nothing told an
    // operator watching stdout that the firewall's OWN self-fetch (not the
    // agent's) just failed — the exact signal you'd want first when, say, a
    // deploy's internal networking is misconfigured (T3's networking note).
    console.error(`[firewall] merchant self-fetch failed for ${originResult.origin}:`, err instanceof Error ? err.message : String(err));
    return { ok: false, reason: "merchant_unreachable", detail: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Headers only — never read or trust the body, and never hold the
  // connection open waiting for one.
  void response.body?.cancel().catch(() => {});

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    return {
      ok: false,
      reason: "merchant_unreachable",
      detail: `merchant responded with a redirect (HTTP ${response.status || "opaque"}) — self-fetch never follows redirects`,
    };
  }
  if (response.status !== 402) {
    return { ok: false, reason: "requirement_mismatch", detail: `merchant responded HTTP ${response.status}, expected 402 Payment Required` };
  }

  const headerValue = response.headers.get("PAYMENT-REQUIRED");
  if (!headerValue) {
    return { ok: false, reason: "requirement_mismatch", detail: "merchant's 402 response has no PAYMENT-REQUIRED header" };
  }

  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = decodePaymentRequiredHeader(headerValue);
  } catch (err) {
    return {
      ok: false,
      reason: "requirement_mismatch",
      detail: `could not decode merchant's PAYMENT-REQUIRED header: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = paymentRequirementSchema.safeParse(paymentRequired.accepts?.[0]);
  if (!parsed.success) {
    return { ok: false, reason: "requirement_mismatch", detail: `merchant's payment requirement is malformed: ${parsed.error.message}` };
  }

  return { ok: true, paymentRequired, requirement: parsed.data };
}

/**
 * Compares the merchant's own (self-fetched) requirement against what the
 * agent forwarded. A `payTo` difference is named `payee_mismatch`
 * specifically — the exact attack this stage exists for (H1); any other
 * stable-field difference is `requirement_mismatch`. Addresses compare
 * case-insensitively (EVM checksums aside, they're the same address).
 */
export function compareRequirements(fetched: PaymentRequirement, forwarded: PaymentRequirement): { ok: true } | MerchantCheckFailure {
  if (fetched.payTo.toLowerCase() !== forwarded.payTo.toLowerCase()) {
    return {
      ok: false,
      reason: "payee_mismatch",
      detail: `agent forwarded payTo ${forwarded.payTo}, the merchant's own 402 names ${fetched.payTo}`,
    };
  }
  if (fetched.asset.toLowerCase() !== forwarded.asset.toLowerCase()) {
    return { ok: false, reason: "requirement_mismatch", detail: `asset differs: forwarded ${forwarded.asset}, merchant ${fetched.asset}` };
  }
  if (fetched.amount !== forwarded.amount) {
    return { ok: false, reason: "requirement_mismatch", detail: `amount differs: forwarded ${forwarded.amount}, merchant ${fetched.amount}` };
  }
  if (fetched.network !== forwarded.network) {
    return { ok: false, reason: "requirement_mismatch", detail: `network differs: forwarded ${forwarded.network}, merchant ${fetched.network}` };
  }
  if (fetched.scheme !== forwarded.scheme) {
    return { ok: false, reason: "requirement_mismatch", detail: `scheme differs: forwarded ${forwarded.scheme}, merchant ${fetched.scheme}` };
  }
  return { ok: true };
}

/** Fail-closed per plan-tecnico.md §2.4: any mismatch, unreachable merchant,
 * or unbound/wrong-origin promise refuses — never silently passes through
 * to provenance/Intercepta/Jev with an unverified requirement. */
export const merchantStage: PipelineStage = {
  name: "merchant",
  async run(ctx: StageContext): Promise<StageVerdict> {
    if (ctx.intent.source === "world_id") {
      if (!ctx.intent.merchant) {
        return {
          outcome: "refuse",
          state: "merchant_blocked",
          reason: "merchant_mismatch: this intent has no bound merchant (created before merchant binding existed)",
        };
      }
      const resourceOrigin = normalizeMerchantOrigin(ctx.resourceUrl);
      if (!resourceOrigin.ok) {
        return { outcome: "refuse", state: "merchant_blocked", reason: `merchant_mismatch: ${resourceOrigin.reason}` };
      }
      if (resourceOrigin.origin !== ctx.intent.merchant) {
        return {
          outcome: "refuse",
          state: "merchant_blocked",
          reason: `merchant_mismatch: intent is bound to ${ctx.intent.merchant}, this payment targets ${resourceOrigin.origin}`,
        };
      }
    }

    const fetched = await fetchMerchantRequirement(ctx.resourceUrl);
    if (!fetched.ok) {
      return { outcome: "refuse", state: "merchant_blocked", reason: `${fetched.reason}: ${fetched.detail}` };
    }
    const comparison = compareRequirements(fetched.requirement, ctx.requirement);
    if (!comparison.ok) {
      return { outcome: "refuse", state: "merchant_blocked", reason: `${comparison.reason}: ${comparison.detail}` };
    }

    // Sign from the firewall's own fetch, never the agent's copy. `ctx` is
    // the same mutable object every later stage (and pipeline.ts's eventual
    // `signPayment` call) reads from, so replacing these two fields here is
    // enough for the swap to take effect for the rest of this request.
    ctx.paymentRequired = fetched.paymentRequired;
    ctx.requirement = fetched.requirement;
    return { outcome: "pass" };
  },
};
