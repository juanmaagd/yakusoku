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
}

const NO_CREDENTIAL_MESSAGE =
  "no credential yet for this MCP session — call the connect tool to link this agent to a human's account via " +
  "World ID (or provide an existing wallet mandate key (yk_...) or account key (ya_...) via the Authorization: " +
  "Bearer header, OMAMORISAN_AGENT_KEY, or the credentials file)";

export function createSessionState(firewallUrl: string, credential: CredentialRef): SessionState {
  return {
    untrustedContent: [],
    firewallUrl,
    getAgentKey: () => {
      if (!credential.current) throw new Error(NO_CREDENTIAL_MESSAGE);
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
