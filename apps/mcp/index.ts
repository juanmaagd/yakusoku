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

function buildServer(session: SessionState): McpServer {
  const server = new McpServer({ name: "omamorisan", version: "0.1.0" });
  registerTools(server, { firewallUrl: FIREWALL_URL }, session);
  return server;
}

// --- stdio transport ---------------------------------------------------------

async function runStdio(): Promise<void> {
  // P9.3: no key required to start anymore — an agent with nothing set yet
  // just gets the `connect` tool as its only useful first move (every other
  // tool fails fast with a "call connect first" message, session.ts's
  // NO_CREDENTIAL_MESSAGE). Resolution order: env var (unchanged) > this
  // firewall's row in the credentials file (credentials.ts), written by a
  // previous `connect`/`check_connection` run.
  // `|| undefined` (not `??`) so an accidentally-empty-string env var is
  // treated as "unset" rather than as a literal empty credential.
  const envKey = process.env.OMAMORISAN_AGENT_KEY || undefined;
  const stored = envKey ? undefined : await loadStoredCredential(FIREWALL_URL);
  const credential: CredentialRef = { current: envKey ?? stored?.agentKey };
  const session = createSessionState(FIREWALL_URL, credential);
  await buildServer(session).connect(new StdioServerTransport());
  console.error(
    `[omamorisan-mcp] stdio ready (firewall ${FIREWALL_URL}) — ` +
      (credential.current ? "using a stored credential" : "not connected yet: the agent should call the connect tool"),
  );
}

// --- Streamable HTTP transport -----------------------------------------------
//
// One McpServer + WebStandardStreamableHTTPServerTransport per MCP session
// (keyed by the SDK's own Mcp-Session-Id, stateful mode). The agent key is
// resolved from `Authorization: Bearer` on every request that carries one —
// falling back to OMAMORISAN_AGENT_KEY, then the credentials file
// (credentials.ts) — and is otherwise sticky for the rest of that session, so
// a client that authenticates once doesn't need to repeat the header on
// every call. `connect`/`check_connection` (tools.ts) update the same
// `CredentialRef` cell the moment World ID approves.

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

  // P9.3: no header/env key just means "not connected yet" now — same
  // resolution order as stdio (env > credentials file), plus the header.
  // `|| undefined` so an accidentally-empty-string env var is "unset".
  let resolvedKey = headerKey ?? (process.env.OMAMORISAN_AGENT_KEY || undefined);
  if (!resolvedKey) resolvedKey = (await loadStoredCredential(FIREWALL_URL))?.agentKey;
  const credential: CredentialRef = { current: resolvedKey };
  const session = createSessionState(FIREWALL_URL, credential);

  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      httpSessions.set(sid, { transport, credential });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) httpSessions.delete(transport.sessionId);
  };

  await buildServer(session).connect(transport);
  return transport.handleRequest(req, { parsedBody });
}

function runHttp(): void {
  Bun.serve({
    port: HTTP_PORT,
    // Bun's default idleTimeout (10 s) is shorter than the ~30 s that
    // connect / request_promise wait for a World ID approval; clients then
    // see ECONNRESET mid-call.
    idleTimeout: 120,
    routes: { "/mcp": { POST: handleMcpRequest, GET: handleMcpRequest, DELETE: handleMcpRequest } },
    fetch: () => new Response("not found", { status: 404 }),
  });
  console.error(`[omamorisan-mcp] Streamable HTTP ready on http://localhost:${HTTP_PORT}/mcp (firewall ${FIREWALL_URL})`);
}

// --- Entry point ---------------------------------------------------------

if (process.argv.includes("--http")) {
  runHttp();
} else {
  await runStdio();
}
