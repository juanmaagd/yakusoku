// Firewall API client for `/setup` (P11.4). Shape matches the P11.4 API
// contract exactly (apps/firewall's `/setup/:token` routes, built in
// parallel — read there before changing this file, not the other way
// around). Modeled on lib/api.ts's request/error conventions.

import type { Address, Hex } from "viem";
import { SITE } from "../config";

const FIREWALL_URL = SITE.firewallUrl;

export interface SetupRecipient {
  address: Address;
  label: string;
}

/** One demo store the firewall knows about, with its live on-chain
 * registration status against this specific account — `null` means there's
 * nothing to read yet (not deployed) or the read itself failed, never a
 * guessed `false`. */
export interface KnownMerchant {
  address: Address;
  label: string;
  registered: boolean | null;
}

/**
 * `GET /setup/:token`. `perPaymentLimitUsdc`/`balanceUsdc` are assumed to
 * already be decimal-formatted USDC strings (e.g. `"5.00"`), not atomic
 * 6-decimal units — inferred from the `Usdc`-suffixed field names, which
 * differs from this codebase's usual atomic-string convention
 * (`SerializedMandate.remainingBudget`, formatted with `lib/format.ts`'s
 * `formatUsdc`). If the firewall actually sends atomic units, only this
 * display and the per-payment-limit label are affected — the live balance
 * shown on `/setup` always comes from an on-chain read (`lib/setupAccount.ts`),
 * never from this field.
 */
export interface SetupInfo {
  status: "needs_owner" | "deployed";
  accountId: string;
  chainId: number;
  usdc: Address;
  factory: Address;
  operator: Address;
  perPaymentLimitUsdc: string;
  recipients: SetupRecipient[];
  /** Every demo store the firewall knows about, each with its live on-chain
   * registration status against this account (P11.4's "Registered merchants"
   * card, DeployedCard.tsx). */
  knownMerchants: KnownMerchant[];
  /** Contains the literal placeholder `{owner}` — replace with the connected
   * checksummed address before signing. */
  message: string;
  smartAccount?: Address;
  owner?: Address;
  balanceUsdc?: string;
  /** Assumed ISO 8601, matching `NonceResponse`/`VerifyResponse.expiresAt` elsewhere in this file's sibling `lib/api.ts`. */
  expiresAt: string;
}

export interface SubmitOwnerResponse {
  status: "deployed";
  smartAccount: Address;
  owner: Address;
  txHash: Hex;
}

/** Thrown on a 404 from either `/setup` route — the token is unknown or expired.
 * The contract doesn't distinguish the two, so the UI shows one message for both. */
export class SetupNotFoundError extends Error {
  constructor() {
    super("This setup link isn't valid anymore.");
    this.name = "SetupNotFoundError";
  }
}

/** Thrown on a 401 from `POST /setup/:token/owner` — the submitted signature
 * didn't match the submitted owner address. */
export class InvalidSignatureError extends Error {
  constructor() {
    super("Your wallet's signature could not be verified. Try signing again.");
    this.name = "InvalidSignatureError";
  }
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

async function parseJson<T>(res: Response): Promise<T | undefined> {
  return (await res.json().catch(() => undefined)) as T | undefined;
}

function describeApiError(body: unknown, fallback: string): string {
  const err = body as ApiErrorBody | undefined;
  if (err?.message) return err.message;
  if (err?.error) return err.error.replace(/_/g, " ");
  return fallback;
}

/** Every call below can also fail because the firewall isn't reachable at all
 * (dev server down) — surfaced as this one friendly message instead of a raw
 * `TypeError: Failed to fetch`. */
async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${FIREWALL_URL}${path}`, init);
  } catch {
    throw new Error(`Could not reach the firewall at ${FIREWALL_URL}. Is it running?`);
  }
}

export async function fetchSetup(token: string): Promise<SetupInfo> {
  const res = await request(`/setup/${encodeURIComponent(token)}`);
  if (res.status === 404) throw new SetupNotFoundError();
  const body = await parseJson<SetupInfo & ApiErrorBody>(res);
  if (!res.ok || !body?.status) throw new Error(describeApiError(body, "Could not load this setup link."));
  // Defensive fallback for a firewall build from before knownMerchants existed.
  return { ...body, knownMerchants: body.knownMerchants ?? [] };
}

export async function submitSetupOwner(token: string, owner: Address, signature: Hex): Promise<SubmitOwnerResponse> {
  const res = await request(`/setup/${encodeURIComponent(token)}/owner`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner, signature }),
  });
  if (res.status === 404) throw new SetupNotFoundError();
  if (res.status === 401) throw new InvalidSignatureError();
  const body = await parseJson<SubmitOwnerResponse & ApiErrorBody>(res);
  if (!res.ok || !body?.smartAccount) throw new Error(describeApiError(body, "The firewall could not deploy your account."));
  return body;
}
