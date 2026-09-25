// Intercepta (Web3 Antivirus) address + token screening (plan-tecnico.md
// §2.3, docs/research/intercepta-implementacion.md, ref-worldid-intercepta.md
// Part B). Runs after provenance, before Jev (pipeline.ts): the first network
// call in the pipeline, so it fails closed on anything but a clean verdict —
// timeout, network error, non-2xx, malformed JSON, an unexpected response
// shape, or a missing API key all become `ask_human`, never a silent pass.
//
// Track requirement (docs/tracks/intercepta.md): "At least one live call to
// the Intercepta API runs before a payment is signed... Mocked or
// hard-coded responses don't qualify." This module never mocks or bypasses
// the API in runtime code — stubbing only happens in intercepta.test.ts.
//
// Endpoint choice: Deep Scan Address (`toxic-score`) is used for `payTo`,
// not Quick Scan — same response shape, but the doc recommends Deep Scan for
// a pre-signature gate since it covers more risk categories (sanctions,
// phishing, darkweb, laundering), latency being secondary here
// (intercepta-implementacion.md §2). Scan Message is deliberately NOT used
// (§3.3/§1.4 of the same doc): its `messageType` enum has no
// `TransferWithAuthorization` (EIP-3009, what x402 actually signs), so
// scan-address + scan-token are the two decision layers, per the doc's own
// fallback plan.

import { z } from "zod";
import { USDC_MAINNET_ADDRESS, USDC_SEPOLIA_ADDRESS } from "@yakusoku/shared";
import type { PipelineStage, StageContext, StageVerdict } from "./pipeline";

// --- Configuration (read lazily, never snapshotted at import time — lets
// tests and the live-check script override INTERCEPTA_API_KEY/_BASE_URL/
// _TIMEOUT_MS per-call without needing to reimport the module) -------------

function baseUrl(): string {
  return process.env.INTERCEPTA_BASE_URL ?? "https://api.web3antivirus.io";
}

function timeoutMs(): number {
  const raw = Number(process.env.INTERCEPTA_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4_000;
}

const CACHE_TTL_MS = 10 * 60 * 1000;

let warnedMissingKey = false;

/** Fail-closed entry point for the key check — logs once, not per payment. */
function getApiKey(): string | undefined {
  const key = process.env.INTERCEPTA_API_KEY;
  if (key) return key;
  if (!warnedMissingKey) {
    console.warn(
      "[intercepta] INTERCEPTA_API_KEY is not set — every payment will escalate to ask_human " +
        "(fail-closed, WU7). Run `bun run intercepta-check` once the sandbox key arrives.",
    );
    warnedMissingKey = true;
  }
  return undefined;
}

class InterceptaUnavailableError extends Error {}

// --- Response schemas (intercepta-implementacion.md §1) — only the fields
// this module's decision actually reads; unknown extra fields (apiVersion,
// saleTax/buyTax, token...) are stripped, not validated. ---------------------

const toxicScoreTraitSchema = z.object({
  risk: z.number().optional(),
  name: z.string(),
  txsCount: z.number().optional(),
  description: z.string().optional(),
});

const toxicScoreResponseSchema = z.object({
  toxicScore: z.number(),
  traits: z.array(toxicScoreTraitSchema),
});
export type ToxicScoreResponse = z.infer<typeof toxicScoreResponseSchema>;

const tokenRiskResponseSchema = z.object({
  riskScore: z.number().optional(),
  riskLevel: z.enum(["neutral", "low", "medium", "high"]),
  category: z.enum(["malicious", "restricted", "suspicious", "availability", "sanctioned", "unverified", "info"]),
  trust: z.enum(["whitelist", "blocklist", "neutral"]),
  action: z.enum(["block", "warn", "info"]),
});
export type TokenRiskResponse = z.infer<typeof tokenRiskResponseSchema>;

// --- Testnet -> mainnet token mapping (intercepta-implementacion.md §4) ---
// Intercepta's risk data is mainnet-only; the firewall always screens Base
// mainnet USDC even though the demo payment runs on Base Sepolia. No mapping
// found -> treat as unverified, never as "safe by default".

const TESTNET_TO_MAINNET_TOKEN: Record<string, { address: string; chainId: string }> = {
  [USDC_SEPOLIA_ADDRESS.toLowerCase()]: { address: USDC_MAINNET_ADDRESS, chainId: "8453" },
};

export function mapAssetForScreening(testnetAsset: string): { address: string; chainId: string } | null {
  return TESTNET_TO_MAINNET_TOKEN[testnetAsset.toLowerCase()] ?? null;
}

// --- HTTP client (fail-closed: any failure throws InterceptaUnavailableError) --

async function interceptaGet<T>(path: string): Promise<unknown> {
  const apiKey = getApiKey();
  if (!apiKey) throw new InterceptaUnavailableError("Intercepta not configured (missing INTERCEPTA_API_KEY)");

  const controller = new AbortController();
  const ms = timeoutMs();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      headers: { "X-API-KEY": apiKey, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new InterceptaUnavailableError(`Intercepta HTTP ${res.status} on ${path}`);
    }
    try {
      return await res.json();
    } catch {
      throw new InterceptaUnavailableError(`Intercepta returned malformed JSON on ${path}`);
    }
  } catch (err) {
    if (err instanceof InterceptaUnavailableError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new InterceptaUnavailableError(`Intercepta timeout after ${ms}ms on ${path}`);
    }
    throw new InterceptaUnavailableError(
      `Intercepta request failed on ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// --- TTL cache (per address/token, lowercased — intercepta-implementacion.md
// §2 "Presupuesto de 1.000 requests") --------------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const addressCache = new Map<string, CacheEntry<ToxicScoreResponse>>();
const tokenCache = new Map<string, CacheEntry<TokenRiskResponse>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function deepScanAddressCached(address: string): Promise<{ data: ToxicScoreResponse; fromCache: boolean }> {
  const key = address.toLowerCase();
  const cached = getCached(addressCache, key);
  if (cached) return { data: cached, fromCache: true };

  const raw = await interceptaGet(`/api/public/v2/extension/account/${address}/toxic-score`);
  const parsed = toxicScoreResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InterceptaUnavailableError(`Intercepta returned an unexpected address-scan schema: ${parsed.error.message}`);
  }
  setCached(addressCache, key, parsed.data);
  return { data: parsed.data, fromCache: false };
}

async function scanTokenCached(address: string, chainId: string): Promise<{ data: TokenRiskResponse; fromCache: boolean }> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const cached = getCached(tokenCache, key);
  if (cached) return { data: cached, fromCache: true };

  const raw = await interceptaGet(`/api/public/v2/extension/token-intelligence/token/${address}/risks?chainId=${chainId}`);
  const parsed = tokenRiskResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InterceptaUnavailableError(`Intercepta returned an unexpected token-scan schema: ${parsed.error.message}`);
  }
  setCached(tokenCache, key, parsed.data);
  return { data: parsed.data, fromCache: false };
}

/** Public, cache-transparent wrappers — used by the live-check script and available for direct testing. */
export const deepScanAddress = (address: string): Promise<ToxicScoreResponse> =>
  deepScanAddressCached(address).then((r) => r.data);
export const scanToken = (address: string, chainId: string): Promise<TokenRiskResponse> =>
  scanTokenCached(address, chainId).then((r) => r.data);

/** Test-only: clears both TTL caches so unit tests with stubbed `fetch`
 * don't leak cached verdicts across cases (every test fixture screens the
 * same mapped mainnet USDC token). Not used by any runtime code path. */
export function __clearInterceptaCachesForTests(): void {
  addressCache.clear();
  tokenCache.clear();
}

// --- Verdict mapping (intercepta-implementacion.md §5) ----------------------

type AddressVerdict = "clean" | "medium" | "high";
type TokenVerdict = "clean" | "warn" | "block" | "unverified";

/** `traits[].name` values that hard-block regardless of `toxicScore`. */
const HARD_ADDRESS_TRAITS = new Set(["sanction_address", "known_scammer", "blacklist", "mixer_transfers"]);
const ADDRESS_BLOCK_SCORE = 75;
const ADDRESS_ESCALATE_SCORE = 30;

function decideAddressVerdict(scan: ToxicScoreResponse): { verdict: AddressVerdict; reason: string } {
  const hardTrait = scan.traits.find((t) => HARD_ADDRESS_TRAITS.has(t.name));
  if (hardTrait || scan.toxicScore >= ADDRESS_BLOCK_SCORE) {
    return {
      verdict: "high",
      reason: `payTo toxicScore=${scan.toxicScore}${hardTrait ? `, trait=${hardTrait.name}` : ""}`,
    };
  }
  if (scan.toxicScore >= ADDRESS_ESCALATE_SCORE) {
    return { verdict: "medium", reason: `payTo toxicScore=${scan.toxicScore} (medium threshold ${ADDRESS_ESCALATE_SCORE})` };
  }
  return { verdict: "clean", reason: `payTo toxicScore=${scan.toxicScore}` };
}

function decideTokenVerdict(scan: TokenRiskResponse): { verdict: TokenVerdict; reason: string } {
  if (scan.action === "block" || scan.trust === "blocklist" || scan.category === "sanctioned" || scan.category === "malicious") {
    return { verdict: "block", reason: `token action=${scan.action}, trust=${scan.trust}, category=${scan.category}` };
  }
  if (scan.action === "warn" || scan.riskLevel === "high") {
    return { verdict: "warn", reason: `token action=${scan.action}, riskLevel=${scan.riskLevel}` };
  }
  return { verdict: "clean", reason: `token action=${scan.action}, riskLevel=${scan.riskLevel}` };
}

// --- Pipeline wiring ---------------------------------------------------------

export const interceptaStage: PipelineStage = {
  name: "intercepta",
  async run(ctx: StageContext): Promise<StageVerdict> {
    const startedAt = Date.now();
    const payTo = ctx.requirement.payTo;
    const asset = ctx.requirement.asset;

    if (!getApiKey()) {
      return {
        outcome: "ask_human",
        state: "intercepta_escalated",
        reason: "Intercepta not configured",
        detail: { intercepta: { addressVerdict: "unavailable", cached: false, latencyMs: Date.now() - startedAt } },
      };
    }

    const mapped = mapAssetForScreening(asset);
    const addressPromise = deepScanAddressCached(payTo);
    const tokenPromise = mapped ? scanTokenCached(mapped.address, mapped.chainId) : null;

    let addressResult: Awaited<ReturnType<typeof deepScanAddressCached>>;
    let tokenResult: Awaited<ReturnType<typeof scanTokenCached>> | null;
    try {
      [addressResult, tokenResult] = await Promise.all([addressPromise, tokenPromise ?? Promise.resolve(null)]);
    } catch (err) {
      const reason =
        err instanceof InterceptaUnavailableError
          ? err.message
          : `Intercepta screening failed: ${err instanceof Error ? err.message : String(err)}`;
      return {
        outcome: "ask_human",
        state: "intercepta_escalated",
        reason,
        detail: { intercepta: { addressVerdict: "unavailable", cached: false, latencyMs: Date.now() - startedAt } },
      };
    }

    const address = decideAddressVerdict(addressResult.data);
    const token =
      mapped && tokenResult
        ? decideTokenVerdict(tokenResult.data)
        : { verdict: "unverified" as const, reason: `no Sepolia->mainnet mapping for asset ${asset}` };

    const cached = addressResult.fromCache && (!tokenResult || tokenResult.fromCache);
    const detail = {
      intercepta: {
        addressVerdict: address.verdict,
        addressScore: addressResult.data.toxicScore,
        tokenVerdict: token.verdict,
        cached,
        latencyMs: Date.now() - startedAt,
      },
    };

    if (address.verdict === "high" || token.verdict === "block") {
      const reasons = [address.verdict === "high" ? address.reason : null, token.verdict === "block" ? token.reason : null]
        .filter((r): r is string => r !== null)
        .join("; ");
      return { outcome: "refuse", state: "intercepta_blocked", reason: reasons, detail };
    }
    if (address.verdict === "medium" || token.verdict === "warn" || token.verdict === "unverified") {
      const reasons = [address.verdict !== "clean" ? address.reason : null, token.verdict !== "clean" ? token.reason : null]
        .filter((r): r is string => r !== null)
        .join("; ");
      return { outcome: "ask_human", state: "intercepta_escalated", reason: reasons, detail };
    }
    return { outcome: "pass", detail };
  },
};
