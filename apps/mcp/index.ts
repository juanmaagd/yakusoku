#!/usr/bin/env bun
// Omamorisan MCP server (WU-P2, root CLAUDE.md) — exposes the payment
// firewall to ANY MCP-speaking agent (Claude Code, Claude Desktop, Cursor,
// a custom agent, ...) as four tools: get_mandate, fetch_url, pay_x402,
// check_approval. This process never holds a signing key — every payment
// still goes through the firewall's `/sign`, exactly like apps/agent's `buy`
// tool.
//
// Two transports:
//   `bun index.ts`         — stdio (default), one session per process.
//   `bun index.ts --http`  — Streamable HTTP on :4010, one session per MCP
//                            connection (see apps/mcp/README.md for client config).

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadStoredCredential } from "./credentials";
import { createSessionState, extractBearerToken, type CredentialRef, type SessionState } from "./session";
import { registerTools } from "./tools";

const FIREWALL_URL = process.env.OMAMORISAN_FIREWALL_URL ?? "http://localhost:4001";
const HTTP_PORT = 4010;

// Standing-rules fix (odd/tasks/standing-rules.md) — day-to-day purchases
// need zero human approvals. The human approves their spending rules ONCE,
// via request_promise, and that single approval also creates the account for
// a brand-new user — connect is only for linking to an account that already
// exists. Every later purchase reuses the active promise (list_promises +
// pay_x402) with no new approval, until it's widened (replaces) or a doubtful
// payment needs a fresh one. The essential flow is self-contained within the
// first ~460 chars (verified against the installed
// @modelcontextprotocol/sdk@1.30.1's `ServerOptions.instructions?: string`,
// server/index.d.ts) so a client that only surfaces a truncated instructions
// string still shows the whole "don't call connect first" rule.
const SERVER_INSTRUCTIONS =
  "Omamorisan lets you pay for things on the human's behalf within spending rules they approve once. If there " +
  "is no active promise yet, ask the human for their rules — what you may buy, the store URL, a total USDC " +
  "budget, and how long (up to 7 days) — then call request_promise ONCE with them; that single World ID " +
  "approval also connects a new account, so never call connect first. Show the World ID link and code, and any " +
  "setup link, so they can fund the account. Before every purchase, call list_promises and pay with pay_x402 " +
  "under a promise with usableNow true that covers it (trust its expiresInMinutes and remainingUsdc; never " +
  "compare dates yourself) — never request a new promise per item or per task. Judge each purchase on its own: " +
  "buy what fits, and for what does not, tell the human why and only call request_promise with replaces if " +
  "they agree to widen the rules. " +
  "If pay_x402 returns needs_human_approval, show the link and code and wait, then call check_approval. A " +
  "refusal is final: never retry with different wording.";

function buildServer(session: SessionState, httpMode: boolean): McpServer {
  const server = new McpServer({ name: "omamorisan", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, { firewallUrl: FIREWALL_URL, httpMode }, session);
  return server;
}

// --- stdio transport ---------------------------------------------------------

async function runStdio(): Promise<void> {
  // P9.3: no key required to start anymore — an agent with nothing set yet
  // should call `request_promise` (sets the human's spending rules and
  // creates the account together in one approval); `connect` is only for
  // linking to an account that already exists (every other tool fails fast
  // with a "no credential yet" message pointing at both, session.ts's
  // `noCredentialMessage`). Resolution order: env var (unchanged) > this
  // firewall's row in the credentials file (credentials.ts), written by a
  // previous `connect`/`check_connection` or first-time `request_promise` run.
  // `|| undefined` (not `??`) so an accidentally-empty-string env var is
  // treated as "unset" rather than as a literal empty credential.
  const envKey = process.env.OMAMORISAN_AGENT_KEY || undefined;
  const stored = envKey ? undefined : await loadStoredCredential(FIREWALL_URL);
  const credential: CredentialRef = { current: envKey ?? stored?.agentKey };
  const session = createSessionState(FIREWALL_URL, credential, false);
  await buildServer(session, false).connect(new StdioServerTransport());
  console.error(
    `[omamorisan-mcp] stdio ready (firewall ${FIREWALL_URL}) — ` +
      (credential.current
        ? "using a stored credential"
        : "no credential yet: the agent should call request_promise to set spending rules (or connect for an existing account)"),
  );
}

// --- Streamable HTTP transport -----------------------------------------------
//
// One McpServer + WebStandardStreamableHTTPServerTransport per MCP session
// (keyed by the SDK's own Mcp-Session-Id, stateful mode). The agent key is
// resolved from `Authorization: Bearer` on every request that carries one
// (never from OMAMORISAN_AGENT_KEY, which is stdio-only) and is otherwise sticky for the
// rest of that session, so a client that authenticates once doesn't need to
// repeat the header on every call. `connect`/`check_connection` (tools.ts)
// update the same `CredentialRef` cell the moment World ID approves.
//
// T8 fix A (odd/tasks/dokploy-deploy.md) — this shared server is used by
// every tester who talks to the hosted MCP URL, so it deliberately NEVER
// reads or writes the credentials file (credentials.ts): that file is keyed
// only by firewall URL, not by session, so a brand-new session with no
// header/env key used to silently inherit whichever account last connected
// on this same server — a real cross-tester account leak. A brand-new HTTP
// session with no header/env key now starts credential-less (session.ts's
// `noCredentialMessage(true)` tells the agent to call connect/
// request_promise); its credential then lives ONLY in this session's own
// `CredentialRef` cell for the life of the session — never persisted, never
// shared. Stdio (`runStdio` above) is unchanged: one process, one operator,
// file persistence across restarts is still the whole point there.

const httpSessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; credential: CredentialRef }>();

function jsonRpcError(message: string, status: number): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });
}

async function handleMcpRequest(req: Request): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id") ?? undefined;
  const headerKey = extractBearerToken(req.headers.get("authorization"));

  if (sessionId) {
    const entry = httpSessions.get(sessionId);
    if (!entry) return jsonRpcError("Session not found", 404);
    if (headerKey) entry.credential.current = headerKey;
    return entry.transport.handleRequest(req);
  }

  if (req.method !== "POST") return jsonRpcError("Bad Request: Session ID required", 400);

  const parsedBody = await req
    .clone()
    .json()
    .catch(() => undefined);
  if (!isInitializeRequest(parsedBody)) return jsonRpcError("Bad Request: Session ID required", 400);

  // T8 fix A: header > credential-less. Deliberately no credentials-file and
  // no OMAMORISAN_AGENT_KEY fallback here (see the file-header comment above):
  // either one would hand every headerless session the same account.
  const resolvedKey = headerKey;
  const credential: CredentialRef = { current: resolvedKey };
  const session = createSessionState(FIREWALL_URL, credential, true);

  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      httpSessions.set(sid, { transport, credential });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) httpSessions.delete(transport.sessionId);
  };

  await buildServer(session, true).connect(transport);
  return transport.handleRequest(req, { parsedBody });
}

// --- T1 request logging (odd/tasks/dokploy-deploy.md) ------------------------
// No framework here (raw Bun.serve routes), so a tiny wrapper stands in for
// what hono/logger gives the firewall — method, path, status, ms, to stdout.

function withRequestLog(handler: (req: Request) => Promise<Response> | Response): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const start = Date.now();
    const res = await handler(req);
    console.log(`${req.method} ${new URL(req.url).pathname} ${res.status} ${Date.now() - start}ms`);
    return res;
  };
}

function health(): Response {
  return Response.json({ ok: true });
}

function runHttp(): void {
  if (process.env.OMAMORISAN_AGENT_KEY) {
    console.error("[omamorisan-mcp] [SECURITY] OMAMORISAN_AGENT_KEY is set but ignored in HTTP mode (it would be shared by every session)");
  }
  const loggedMcp = withRequestLog(handleMcpRequest);
  Bun.serve({
    port: HTTP_PORT,
    // Bun's default idleTimeout (10 s) is shorter than the ~30 s that
    // connect / request_promise wait for a World ID approval; clients then
    // see ECONNRESET mid-call.
    idleTimeout: 120,
    routes: {
      "/mcp": { POST: loggedMcp, GET: loggedMcp, DELETE: loggedMcp },
      "/health": { GET: withRequestLog(health) },
    },
    fetch: withRequestLog(() => new Response("not found", { status: 404 })),
  });
  console.error(`[omamorisan-mcp] Streamable HTTP ready on http://localhost:${HTTP_PORT}/mcp (firewall ${FIREWALL_URL})`);
}

// --- Entry point ---------------------------------------------------------

if (process.argv.includes("--http")) {
  runHttp();
} else {
  await runStdio();
}
