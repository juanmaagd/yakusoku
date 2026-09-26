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
import { createSessionState, extractBearerToken, type SessionState } from "./session";
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
  const agentKey = process.env.OMAMORISAN_AGENT_KEY;
  if (!agentKey) {
    console.error("OMAMORISAN_AGENT_KEY is required for stdio mode — see apps/mcp/README.md.");
    process.exit(1);
  }
  const session = createSessionState(() => agentKey);
  await buildServer(session).connect(new StdioServerTransport());
  console.error(`[omamorisan-mcp] stdio ready (firewall ${FIREWALL_URL})`);
}

// --- Streamable HTTP transport -----------------------------------------------
//
// One McpServer + WebStandardStreamableHTTPServerTransport per MCP session
// (keyed by the SDK's own Mcp-Session-Id, stateful mode). The agent key is
// resolved from `Authorization: Bearer` on every request that carries one —
// falling back to OMAMORISAN_AGENT_KEY — and is otherwise sticky for the rest
// of that session, so a client that authenticates once doesn't need to repeat
// the header on every call.

interface AgentKeyRef {
  current?: string;
}

const httpSessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; agentKeyRef: AgentKeyRef }>();

function jsonRpcError(message: string, status: number): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });
}

async function handleMcpRequest(req: Request): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id") ?? undefined;
  const headerKey = extractBearerToken(req.headers.get("authorization"));

  if (sessionId) {
    const entry = httpSessions.get(sessionId);
    if (!entry) return jsonRpcError("Session not found", 404);
    if (headerKey) entry.agentKeyRef.current = headerKey;
    return entry.transport.handleRequest(req);
  }

  if (req.method !== "POST") return jsonRpcError("Bad Request: Session ID required", 400);

  const parsedBody = await req
    .clone()
    .json()
    .catch(() => undefined);
  if (!isInitializeRequest(parsedBody)) return jsonRpcError("Bad Request: Session ID required", 400);

  const agentKeyRef: AgentKeyRef = { current: headerKey ?? process.env.OMAMORISAN_AGENT_KEY };
  const session = createSessionState(() => {
    if (!agentKeyRef.current) {
      throw new Error("no agent key: send Authorization: Bearer <key>, or set OMAMORISAN_AGENT_KEY");
    }
    return agentKeyRef.current;
  });

  const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      httpSessions.set(sid, { transport, agentKeyRef });
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
