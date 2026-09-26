# @yakusoku/mcp — Omamorisan MCP server

Exposes the Omamorisan payment firewall to **any** MCP-speaking agent (Claude
Code, Claude Desktop, Cursor, a custom agent, ...) as four tools. This process
never holds a signing key — every payment still goes through the firewall's
`/sign`, exactly like `apps/agent`'s `buy` tool.

## Tools

| Tool | Input | What it does |
|---|---|---|
| `get_mandate` | _(none)_ | Returns the human-authorized mandate behind this agent's key: `{ id, task, budget, remainingBudget, categories, expiry, revoked }`. |
| `fetch_url` | `{ url }` | GETs an http(s) URL (10s timeout, 200 KB cap) and returns its body (JSON-parsed when possible). Every fetched body is recorded in this session's untrusted-content log, so `pay_x402` can hand it to the firewall's provenance/Jev checks. Demo tool — no host allowlist. |
| `pay_x402` | `{ url, justification }` | Runs the full x402 flow through the firewall: GETs `url`; if not a 402, returns the body as-is; if 402, asks `/sign` (with this session's untrusted-content log as context) and either pays immediately (`{ status: "paid", resource, txHash, explorerUrl, receiptId }`), refuses (`{ status: "refused", reason, receiptId }`, never retried), or starts a World ID approval (`{ status: "needs_human_approval", verificationUri, userCode, expiresAt, receiptId, instructions }`, returned immediately). |
| `check_approval` | `{ receiptId }` | Polls a pending World ID approval once. Still pending → `{ status: "pending", ... }`. Approved → completes the original purchase and returns the same `paid` shape as `pay_x402`. Denied/expired → `{ status: "refused", reason }`. |

## Configuration

- `OMAMORISAN_FIREWALL_URL` — firewall base URL. Default `http://localhost:4001`.
- `OMAMORISAN_AGENT_KEY` — the mandate credential (`yk_...`) printed once by
  `POST /intents` (e.g. via `bun run dev-intent`). **Required** for stdio mode.
  For HTTP mode, each request's `Authorization: Bearer <key>` header is used
  instead, falling back to this env var if the header is absent.

## Running

```bash
# stdio (default) — one session per process
bun run --filter @yakusoku/mcp start

# Streamable HTTP on :4010 — one session per MCP connection
bun run --filter @yakusoku/mcp http
```

## Client configuration

### Claude Code

```bash
claude mcp add omamorisan \
  --env OMAMORISAN_AGENT_KEY=yk_your_key_here \
  -- bun /absolute/path/to/yakusoku/apps/mcp/index.ts
```

### Claude Desktop / Cursor (`mcpServers` JSON)

```json
{
  "mcpServers": {
    "omamorisan": {
      "command": "bun",
      "args": ["/absolute/path/to/yakusoku/apps/mcp/index.ts"],
      "env": {
        "OMAMORISAN_AGENT_KEY": "yk_your_key_here",
        "OMAMORISAN_FIREWALL_URL": "http://localhost:4001"
      }
    }
  }
}
```

### Streamable HTTP

```
http://localhost:4010/mcp
```

Send `Authorization: Bearer <agentKey>` on the connecting request (or set
`OMAMORISAN_AGENT_KEY` on the server process as a fallback).

## How an autonomous agent uses it

An agent calls `get_mandate` first to learn what the human actually
authorized (task, budget, categories, expiry). It then browses freely with
`fetch_url` — every page it reads is logged as untrusted content for this
session. When ready to buy, it calls `pay_x402` with the resource URL and a
justification tying the purchase back to the mandate's task; the firewall
decides pay/refuse/ask_human using everything the agent has read so far. If
the firewall asks for human approval, the agent reports the `verificationUri`
to the human and calls `check_approval` later (e.g. after a short delay, or
when the human confirms) to finish the purchase or learn it was denied.

## Notes

- `fetch_url` is a demo convenience with no host allowlist, a 10s timeout, and
  a 200 KB body cap — a production build would need to restrict which hosts
  it can reach.
- `check_approval` keeps the pending purchase's URL in this process's memory,
  keyed by `receiptId` — it must be called against the same running server
  that started the `pay_x402` call (or, for HTTP mode, any session on that
  same server process).
