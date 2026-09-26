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

export interface SessionState {
  untrustedContent: SeenContent[];
  /** Throws when no agent key is available yet (HTTP mode, before the first
   * `Authorization: Bearer` header arrives, and no env fallback is set). */
  getAgentKey: () => string;
}

export function createSessionState(getAgentKey: () => string): SessionState {
  return { untrustedContent: [], getAgentKey };
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
