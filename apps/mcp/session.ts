// Per-conversation state the MCP tools share: the untrusted-content log
// `pay_x402` forwards to the firewall's provenance/Jev layers (WU-P2), plus
// small demo-scoped HTTP helpers. One `SessionState` per stdio process, or
// per HTTP session (index.ts) — never shared across two different agent
// conversations, since the untrusted-content log is exactly what the agent
// itself has read so far.

export interface SeenContent {
  source: string;
  text: string;
}

/** The resolved agent key for one MCP session — `undefined` before the first
 * successful `connect`/`check_connection` (tools.ts) when no env/header/file
 * credential was found either. A plain mutable cell (not a getter function)
 * so index.ts's HTTP per-request `Authorization: Bearer` override and this
 * session's own `connect`-driven updates share the exact same value. */
export interface CredentialRef {
  current?: string;
}

/** Everything `connect` (tools.ts) needs to resume polling the SAME device
 * flow from `check_connection` instead of starting a fresh one. Never sent
 * back to the client as a whole — only the non-secret fields (verification
 * link, user code, expiry) ever appear in a tool result; `pollSecret` stays
 * server-side for the lifetime of this pending request. */
export interface PendingConnect {
  connectId: string;
  pollSecret: string;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
}

/** P9.6 — everything `request_promise` (tools.ts) needs to resume polling a
 * `POST /promises/first` request from `check_promise`, mirroring
 * `PendingConnect` above: a single World ID approval that creates an
 * account AND activates its first promise together, for a session with no
 * credential at all yet. `pollSecret` stays server-side, same as
 * `PendingConnect.pollSecret`. */
export interface PendingFirstPromise {
  promiseId: string;
  pollSecret: string;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresAt: string;
  summary: string;
}

export interface SessionState {
  untrustedContent: SeenContent[];
  /** The firewall base URL this session talks to — also the credentials
   * file's lookup key (credentials.ts). */
  firewallUrl: string;
  /** Throws a friendly, LLM-actionable error when no credential is set yet. */
  getAgentKey: () => string;
  hasAgentKey: () => boolean;
  /** Called by `connect`/`check_connection` once World ID approves — updates
   * this session's live credential immediately (no restart needed). */
  setAgentKey: (key: string) => void;
  /** Set while a `connect` call is waiting on a human; cleared on any
   * terminal outcome (approved/denied/expired/error). */
  pendingConnect?: PendingConnect;
  /** Set while a `request_promise` call made through the P9.6 no-credential
   * path is waiting on a human; cleared on any terminal outcome. */
  pendingFirstPromise?: PendingFirstPromise;
}

/** T8 fix A follow-up (odd/tasks/dokploy-deploy.md) — the no-credential hint
 * differs by transport, since Fix A stopped the HTTP transport from ever
 * reading/writing the shared credentials file (index.ts): stdio's credential
 * is still file-backed (a stored key survives a process restart), so
 * pointing at the file is still accurate there. An HTTP session's credential
 * now lives ONLY in that session's own memory — never the shared file, never
 * another session — so the only way back in is calling connect/
 * request_promise again, which this message says plainly instead of naming a
 * fallback that no longer applies to it. Exported so tools.ts's own direct
 * "no credential yet" messages (pay_x402, get_mandate) stay in sync with
 * this one. */
export function noCredentialMessage(httpMode: boolean): string {
  if (httpMode) {
    return (
      "no credential yet for this MCP session — call request_promise with the human's spending rules (what you " +
      "may buy, the budget, how long) to set them and create the account together in one step; call connect " +
      "only if the human already has an existing account to link to. This session's credential lives in memory " +
      "only for this session — it is never shared with another session and never persisted, so a session that " +
      "reconnects with a new session id must call request_promise (or connect) again."
    );
  }
  return (
    "no credential yet for this MCP session — call request_promise with the human's spending rules to set them " +
    "and create the account together in one step (call connect only if the human already has an existing " +
    "account), or provide an existing wallet mandate key (yk_...) or account key (ya_...) via the Authorization: " +
    "Bearer header, OMAMORISAN_AGENT_KEY, or the credentials file"
  );
}

export function createSessionState(firewallUrl: string, credential: CredentialRef, httpMode: boolean): SessionState {
  return {
    untrustedContent: [],
    firewallUrl,
    getAgentKey: () => {
      if (!credential.current) throw new Error(noCredentialMessage(httpMode));
      return credential.current;
    },
    hasAgentKey: () => credential.current !== undefined,
    setAgentKey: (key: string) => {
      credential.current = key;
    },
  };
}

/** Polls `check` at `intervalMs` until `isDone` accepts its result, or
 * `maxWaitMs` elapses — whichever comes first. Never throws on a timeout: it
 * just returns the last (still-not-done) result, so callers decide what
 * "still pending" means for their own tool response. Shared by `connect`/
 * `check_connection` (device-flow polling) and `request_promise`/
 * `check_promise` (promise-approval polling), so every "wait briefly for a
 * human" tool in this server has the exact same ≤~30s budget. */
export async function pollWithTimeout<T>(
  check: () => Promise<T>,
  isDone: (result: T) => boolean,
  { intervalMs = 3000, maxWaitMs = 30_000 }: { intervalMs?: number; maxWaitMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const result = await check();
    if (isDone(result)) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}

// --- fetch_url / pay_x402 shared HTTP helpers (demo-scoped) -----------------
//
// `fetch_url` is a demo convenience for browsing the store from inside an MCP
// client — it is intentionally unrestricted beyond scheme/timeout/size. A
// production build would need an allowlist of fetchable hosts.

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 200 * 1024; // 200 KB

export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported URL scheme "${parsed.protocol}" — only http/https are allowed`);
  }
}

/** Reads a `Response` body up to `maxBytes`, discarding the rest. Never
 * throws on an oversized body — callers get back what fit, plus `truncated`. */
export async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (slice.byteLength < value.byteLength) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text: Buffer.concat(chunks).toString("utf-8"), truncated };
}

/** Best-effort JSON parse for a fetched body, based on its content-type —
 * falls back to the raw text for anything else or a parse failure. */
export function parseMaybeJson(text: string, contentType: string): unknown {
  if (!contentType.includes("json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function extractBearerToken(headerValue: string | null | undefined): string | undefined {
  if (!headerValue) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}
