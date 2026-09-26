// Firewall API client for the /app onboarding flow (P5). Every request shape
// here matches the actual handlers in apps/firewall/index.ts — read there
// before changing this file, not the other way around.

import type { Address, Hex } from "viem";
import type { DecisionReceipt, StepUpAttestation } from "@yakusoku/shared";
import { SITE } from "../config";

const FIREWALL_URL = SITE.firewallUrl;

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: { message?: string }[];
}

async function parseJson<T>(res: Response): Promise<T | undefined> {
  return (await res.json().catch(() => undefined)) as T | undefined;
}

function describeApiError(body: unknown, fallback: string): string {
  const err = body as ApiErrorBody | undefined;
  if (err?.message) return err.message;
  const firstIssue = err?.issues?.[0]?.message;
  if (firstIssue) return firstIssue;
  if (err?.error) return err.error.replace(/_/g, " ");
  return fallback;
}

/** Every call below can also fail because the firewall isn't reachable at
 * all (dev server down) — surfaced as this one friendly message instead of a
 * raw `TypeError: Failed to fetch`. */
async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${FIREWALL_URL}${path}`, init);
  } catch {
    throw new Error(`Could not reach the firewall at ${FIREWALL_URL}. Is it running?`);
  }
}

// --- Wallet sign-in (SIWE, apps/firewall/index.ts's /auth/*) ----------------

export interface NonceResponse {
  nonce: string;
  expiresAt: string;
}

export async function fetchNonce(): Promise<NonceResponse> {
  const res = await request("/auth/nonce");
  const body = await parseJson<NonceResponse>(res);
  if (!res.ok || !body?.nonce) throw new Error(describeApiError(body, "Could not get a sign-in nonce."));
  return body;
}

export interface VerifyResponse {
  sessionToken: string;
  address: Address;
  expiresAt: string;
}

export async function verifySiwe(message: string, signature: Hex): Promise<VerifyResponse> {
  const res = await request("/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  const body = await parseJson<VerifyResponse & ApiErrorBody>(res);
  if (!res.ok || !body?.sessionToken) throw new Error(describeApiError(body, "Sign-in was rejected by the firewall."));
  return body;
}

export async function fetchMe(sessionToken: string): Promise<{ address: Address; expiresAt: string }> {
  const res = await request("/auth/me", { headers: { authorization: `Bearer ${sessionToken}` } });
  const body = await parseJson<{ address: Address; expiresAt: string }>(res);
  if (!res.ok || !body?.address) throw new Error("session_invalid");
  return body;
}

export async function logoutSession(sessionToken: string): Promise<void> {
  await request("/auth/logout", { method: "POST", headers: { authorization: `Bearer ${sessionToken}` } }).catch(
    () => undefined,
  );
}

// --- Mandates (apps/firewall/index.ts's /intents*) --------------------------

export interface SerializedMandate {
  id: string;
  message: { task: string; budget: string; categories: string[]; expiry: string; nonce: string };
  signer: Address;
  createdAt: string;
  remainingBudget: string;
  revoked: boolean;
  revokedAt?: string;
}

export async function listMandates(sessionToken: string): Promise<SerializedMandate[]> {
  const res = await request("/intents", { headers: { authorization: `Bearer ${sessionToken}` } });
  const body = await parseJson<SerializedMandate[]>(res);
  if (!res.ok || !body) throw new Error("Could not load your mandates.");
  return body;
}

export interface CreateMandateResponse {
  id: string;
  remainingBudget: string;
  /** Shown exactly once — see apps/firewall/auth.ts and index.ts's `POST /intents`. */
  agentKey: string;
}

/** `signedIntentJson` is already a bigint-safe JSON string — see
 * lib/taskIntent.ts's `serializeSignedIntent`. */
export async function createMandate(signedIntentJson: string): Promise<CreateMandateResponse> {
  const res = await request("/intents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: signedIntentJson,
  });
  const body = await parseJson<CreateMandateResponse & ApiErrorBody>(res);
  if (!res.ok || !body?.id || !body.agentKey) {
    throw new Error(describeApiError(body, "The firewall rejected this mandate."));
  }
  return body;
}

export async function revokeMandate(sessionToken: string, id: string): Promise<void> {
  const res = await request(`/intents/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) throw new Error("Could not revoke this mandate.");
}

// --- Live dashboard (P6, apps/firewall/index.ts's owner-scoped routes) -----

/** Thrown by any owner-scoped call below on a 401 — the dashboard's caller
 * should route this straight into `useWalletSession`'s `handleUnauthorized`
 * (P6 brief: "401 anywhere -> back to sign-in") instead of a generic error. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Your session has expired. Please sign in again.");
    this.name = "UnauthorizedError";
  }
}

async function ownerScopedJson<T>(path: string, sessionToken: string, init?: RequestInit): Promise<T> {
  const res = await request(path, {
    ...init,
    headers: { ...init?.headers, authorization: `Bearer ${sessionToken}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  const body = await parseJson<T & ApiErrorBody>(res);
  if (!res.ok || body === undefined) throw new Error(describeApiError(body, "The firewall rejected this request."));
  return body;
}

/** Newest-first, same shape `GET /receipts` returns for the owner's own
 * mandates only (index.ts). */
export async function listReceipts(sessionToken: string, limit = 50): Promise<DecisionReceipt[]> {
  return ownerScopedJson<DecisionReceipt[]>(`/receipts?limit=${limit}`, sessionToken);
}

export async function getReceipt(sessionToken: string, id: string): Promise<DecisionReceipt> {
  return ownerScopedJson<DecisionReceipt>(`/receipts/${encodeURIComponent(id)}`, sessionToken);
}

/** No session required server-side (`GET /receipts/:id/attestation` is
 * unauthenticated, apps/firewall/index.ts) — returns `undefined` for a
 * receipt with no attestation (denied/expired/pre-World-ID) instead of
 * throwing, since that's an expected, common shape. */
export async function getAttestation(receiptId: string): Promise<StepUpAttestation | undefined> {
  const res = await request(`/receipts/${encodeURIComponent(receiptId)}/attestation`);
  if (res.status === 404) return undefined;
  const body = await parseJson<StepUpAttestation & ApiErrorBody>(res);
  if (!res.ok || !body) throw new Error(describeApiError(body, "Could not load the attestation."));
  return body;
}

export interface ApprovalStatus {
  status: "pending" | "approved" | "denied" | "expired" | "error" | "paused" | "revoked";
  verificationUri?: string;
  userCode?: string;
  expiresAt?: string;
  verdict: "pay" | "refuse" | "ask_human";
  reason: string;
}

/** `GET /approvals/:receiptId` — P6 added session-owner access alongside the
 * existing agent-key path (apps/firewall/index.ts), so the dashboard reads
 * this the same way it reads `/receipts`. */
export async function getApprovalStatus(sessionToken: string, receiptId: string): Promise<ApprovalStatus> {
  return ownerScopedJson<ApprovalStatus>(`/approvals/${encodeURIComponent(receiptId)}`, sessionToken);
}

export interface OwnerControlState {
  paused: boolean;
  pausedAt?: string;
  reason?: string;
}

export async function fetchOwnerControl(sessionToken: string): Promise<OwnerControlState> {
  return ownerScopedJson<OwnerControlState>("/me/control", sessionToken);
}

export async function pauseOwnerSigning(sessionToken: string, reason?: string): Promise<OwnerControlState> {
  return ownerScopedJson<OwnerControlState>("/me/pause", sessionToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export async function resumeOwnerSigning(sessionToken: string): Promise<OwnerControlState> {
  return ownerScopedJson<OwnerControlState>("/me/resume", sessionToken, { method: "POST" });
}

/** `GET /events?session=...` (apps/firewall/index.ts) — `EventSource` can't
 * send an `Authorization` header, so the session rides the query string,
 * same as the firewall's own admin `?admin=1` stream. */
export function ownerEventsUrl(sessionToken: string): string {
  return `${FIREWALL_URL}/events?session=${encodeURIComponent(sessionToken)}`;
}
