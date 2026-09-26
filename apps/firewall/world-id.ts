// World ID for Agents — RFC 8628 device-authorization flow against the
// sandbox Human Continuity IdP, plus ID-token freshness validation
// (docs/research/world-id-implementacion.md §A — device flow verified
// end-to-end with a real World App, root CLAUDE.md). This is the last,
// most expensive gate before a payment is signed (plan-tecnico.md §2.3):
// every payment that reaches the gate already cleared idempotency/policy/
// provenance/Intercepta/Jev (or one of those stages explicitly escalated
// `ask_human`, or the payment exceeds `HUMAN_APPROVAL_OVER_USDC`) — a fresh
// human approval is the only thing left standing between "doubt" and "pay".
//
// Fail-closed contract (plan-tecnico.md §2.4): `access_denied`,
// `expired_token`, a local timeout, an invalid/stale ID token, or any
// network/parsing error all resolve to "the human did not freshly approve
// this payment" — never assumed approval. This module never retries
// silently past a terminal outcome and never fabricates an approval.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

function issuer(): string {
  return process.env.WORLD_ID_ISSUER || "https://sandbox.auth.world.org"; // `||`: compose passes unset vars as ""
}

/** World ID for Agents currently only issues this credential (discovery
 * document's `acr_values_supported`, verified in world-id-implementacion.md §A). */
export const ACR_ORB_V3 = "https://world.org/oidc/acr/orb-v3";

function clientId(): string {
  const v = process.env.WORLD_CLIENT_ID;
  if (!v) throw new WorldIdConfigError("missing WORLD_CLIENT_ID");
  return v;
}

function clientSecret(): string {
  const v = process.env.WORLD_CLIENT_SECRET;
  if (!v) throw new WorldIdConfigError("missing WORLD_CLIENT_SECRET");
  return v;
}

function basicAuthHeader(): string {
  return `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString("base64")}`;
}

export class WorldIdConfigError extends Error {}
export class WorldIdRequestError extends Error {}

// --- Device Authorization (RFC 8628 §3.1-3.2) -------------------------------

const deviceAuthorizationResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional(),
});

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** Seconds until World's own `device_code` expires. */
  expiresIn: number;
  /** Minimum seconds between polls — defaults to 5 (RFC 8628 §3.2) when the IdP omits it. */
  interval: number;
}

/** Step 1: the firewall requests a device_code. Nobody has touched the
 * human's phone yet. */
export async function startDeviceAuthorization(): Promise<DeviceAuthorization> {
  let res: Response;
  try {
    res = await fetch(`${issuer()}/api/v1/device_authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuthHeader() },
      // `prompt=login` forces a fresh authentication rather than reusing a
      // continuity session — verified end-to-end (root CLAUDE.md).
      body: new URLSearchParams({ scope: "openid", prompt: "login" }),
    });
  } catch (err) {
    throw new WorldIdRequestError(
      `device_authorization request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new WorldIdRequestError(`device_authorization returned HTTP ${res.status}: ${body}`);
  }
  const raw = await res.json().catch(() => undefined);
  const parsed = deviceAuthorizationResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new WorldIdRequestError(`device_authorization returned an unexpected shape: ${parsed.error.message}`);
  }
  return {
    deviceCode: parsed.data.device_code,
    userCode: parsed.data.user_code,
    verificationUri: parsed.data.verification_uri,
    verificationUriComplete: parsed.data.verification_uri_complete,
    expiresIn: parsed.data.expires_in,
    interval: parsed.data.interval ?? 5,
  };
}

// --- Token polling (RFC 8628 §3.4-3.5) --------------------------------------

const tokenSuccessSchema = z.object({ id_token: z.string().min(1) });
const tokenErrorSchema = z.object({ error: z.string(), error_description: z.string().optional() });

export type PollOutcome =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "approved"; idToken: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; message: string };

/** One non-blocking poll of the token endpoint — the caller owns timing
 * (see `pollUntilResolved` below, or a persisted resumable loop in
 * approvals.ts). Never throws: every failure mode maps to `{status:"error"}`. */
export async function pollDeviceToken(deviceCode: string): Promise<PollOutcome> {
  let res: Response;
  let raw: unknown;
  try {
    res = await fetch(`${issuer()}/api/v1/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuthHeader() },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: clientId(),
      }),
    });
  } catch (err) {
    return { status: "error", message: `token request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    raw = await res.json();
  } catch {
    return { status: "error", message: `token endpoint returned malformed JSON (HTTP ${res.status})` };
  }

  if (res.ok) {
    const parsed = tokenSuccessSchema.safeParse(raw);
    if (!parsed.success) {
      return { status: "error", message: `token response missing id_token: ${parsed.error.message}` };
    }
    return { status: "approved", idToken: parsed.data.id_token };
  }

  const errParsed = tokenErrorSchema.safeParse(raw);
  const code = errParsed.success ? errParsed.data.error : undefined;
  switch (code) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      return { status: "error", message: `token endpoint error (HTTP ${res.status}): ${JSON.stringify(raw)}` };
  }
}

/** RFC 8628 §3.5 backoff: on `slow_down`, add 5s to the polling interval and
 * keep polling; `authorization_pending` keeps the interval unchanged. */
export type TerminalPollOutcome = Exclude<PollOutcome, { status: "pending" } | { status: "slow_down" }>;

export interface PollUntilResolvedOptions {
  deviceCode: string;
  initialIntervalSeconds: number;
  /** Absolute deadline (epoch ms) — the smaller of World's `expires_in` and
   * the firewall's own `WORLD_ID_APPROVAL_TIMEOUT_S`. */
  deadlineMs: number;
  /** Observes every poll result, including non-terminal ones — used to
   * persist an interval bumped by `slow_down` so a restart resumes at the
   * right pace, and to log intermediate ticks for the live-check script. */
  onTick?: (outcome: PollOutcome, intervalSeconds: number) => void | Promise<void>;
  /** Injectable for tests — real code always uses the default (real) sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until a terminal outcome or `deadlineMs` passes. Past the deadline
 * without a terminal result resolves as `expired` — fail-closed, never
 * "assume approved" or "keep looping forever". */
export async function pollUntilResolved(opts: PollUntilResolvedOptions): Promise<TerminalPollOutcome> {
  let intervalSeconds = opts.initialIntervalSeconds;
  const sleep = opts.sleep ?? defaultSleep;

  while (Date.now() < opts.deadlineMs) {
    await sleep(intervalSeconds * 1000);
    if (Date.now() >= opts.deadlineMs) break;

    const outcome = await pollDeviceToken(opts.deviceCode);
    if (outcome.status === "slow_down") {
      intervalSeconds += 5;
      await opts.onTick?.(outcome, intervalSeconds);
      continue;
    }
    if (outcome.status === "pending") {
      await opts.onTick?.(outcome, intervalSeconds);
      continue;
    }
    await opts.onTick?.(outcome, intervalSeconds);
    return outcome;
  }
  return { status: "expired" };
}

// --- ID token validation (jose, remote JWKS) --------------------------------

let cachedJwks: JWTVerifyGetKey | undefined;
let cachedJwksIssuer: string | undefined;

function defaultJwks(): JWTVerifyGetKey {
  const currentIssuer = issuer();
  if (!cachedJwks || cachedJwksIssuer !== currentIssuer) {
    cachedJwks = createRemoteJWKSet(new URL(`${currentIssuer}/.well-known/jwks.json`));
    cachedJwksIssuer = currentIssuer;
  }
  return cachedJwks;
}

export interface FreshApprovalClaims {
  sub: string;
  acr?: string;
  authTime: number;
  amr?: unknown;
}

export interface ValidateIdTokenOptions {
  /** Epoch seconds the device flow was requested at — `auth_time` must be at
   * or after this (minus a small clock-skew allowance), never "approval" of
   * an older, reused authentication. */
  requestedAtSeconds: number;
  /** Freshness window in seconds — `now - auth_time` beyond this is stale. */
  maxAuthAgeSeconds: number;
  /** Injectable for tests — real code always uses the remote sandbox JWKS. */
  jwks?: JWTVerifyGetKey;
  issuer?: string;
  audience?: string;
}

/** Small allowance for clock drift between this process and the IdP when
 * comparing `auth_time` against the approval request timestamp. */
const CLOCK_SKEW_SECONDS = 30;

export type ValidateIdTokenResult =
  | { valid: true; claims: FreshApprovalClaims }
  | { valid: false; reason: string };

/** Validates signature (RS256, remote JWKS), `iss`, `aud`, `exp` (all via
 * `jwtVerify`), then this module's own freshness checks on `auth_time` and
 * `acr` — every failure mode returns `{valid:false}`, never throws, so a
 * caller can fail closed uniformly. */
export async function validateIdToken(
  idToken: string,
  opts: ValidateIdTokenOptions,
): Promise<ValidateIdTokenResult> {
  try {
    const { payload } = await jwtVerify(idToken, opts.jwks ?? defaultJwks(), {
      issuer: opts.issuer ?? issuer(),
      audience: opts.audience ?? clientId(),
    });

    const authTime = payload.auth_time;
    if (typeof authTime !== "number") {
      return { valid: false, reason: "id token missing auth_time — cannot validate freshness" };
    }
    if (authTime < opts.requestedAtSeconds - CLOCK_SKEW_SECONDS) {
      return {
        valid: false,
        reason: `auth_time ${authTime} predates the approval request (${opts.requestedAtSeconds}) — stale/reused authentication`,
      };
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const ageSeconds = nowSeconds - authTime;
    if (ageSeconds > opts.maxAuthAgeSeconds) {
      return {
        valid: false,
        reason: `approval is ${ageSeconds}s old, exceeds the ${opts.maxAuthAgeSeconds}s freshness window`,
      };
    }
    const acr = typeof payload.acr === "string" ? payload.acr : undefined;
    if (acr !== undefined && acr !== ACR_ORB_V3) {
      return { valid: false, reason: `unexpected acr: ${acr}` };
    }

    return {
      valid: true,
      claims: { sub: String(payload.sub ?? ""), acr, authTime, amr: payload.amr },
    };
  } catch (err) {
    return { valid: false, reason: `id token verification failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
