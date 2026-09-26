# @yakusoku/mcp — Omamorisan MCP server

Exposes the Omamorisan payment firewall to **any** MCP-speaking agent (Claude
Code, Claude Desktop, Codex, Cursor, a custom agent, ...). This process never
holds a signing key — every payment still goes through the firewall's
`/sign`, exactly like `apps/agent`'s `buy` tool.

Two credential paths, both usable from the same server:

- **World ID account (`ya_...`, recommended)** — no wallet, no key ever
  typed anywhere. Add the MCP server once with no key at all; on first use
  the agent calls `connect`, which shows a link + short code for the human to
  approve in World App. Per task, the agent calls `request_promise` (what,
  budget, categories, expiry) for a fresh World ID approval; once active,
  `pay_x402` spends against it with zero further human taps until it runs out
  or expires, or until a doubtful payment needs a fresh approval.
- **Wallet mandate (`yk_...`, legacy)** — a human signs a `TaskIntent` via the
  site's `/app` wizard and hands the agent a mandate key up front
  (`OMAMORISAN_AGENT_KEY`). Unchanged since WU-P2.

## Tools

| Tool | Input | Credential | What it does |
|---|---|---|---|
| `connect` | _(none)_ | none yet | Links this agent to a human's account via World ID. No-op ("already_connected") if this session already has a credential. Starts a World ID device flow, waits briefly (≤~30s) for approval, and returns `{status: "connected", accountId}` or `{status: "pending", connectId, verificationUri, userCode, expiresAt}` — call `check_connection` again if still pending. |
| `check_connection` | _(none)_ | none yet | Resumes waiting on the pending `connect()` request. Same response shapes as `connect`. |
| `request_promise` | `{ task, budgetUsdc, categories[1-5], expiresInMinutes }` | account | Asks the human to pre-authorize a task with a budget — the World-ID-native replacement for a signed mandate. Waits briefly for approval; returns `{status: "active", promiseId, summary, remainingBudget}` or `{status: "pending", promiseId, verificationUri, userCode, expiresAt, summary}` (call `check_promise`) or a terminal `{status: "denied"\|"expired", reason}`. |
| `check_promise` | `{ promiseId }` | account | Resumes waiting on a pending promise, or reports the current status of any promise on the account. |
| `list_promises` | _(none)_ | account | Lists every promise on the account (pending, active, or resolved) with remaining budget, categories, and expiry. |
| `get_mandate` | _(none)_ | either | With an account: `{accountId, createdAt, promises}`. With a wallet mandate: `{id, task, budget, remainingBudget, categories, expiry, revoked}`. |
| `fetch_url` | `{ url }` | either | GETs an http(s) URL (10s timeout, 200 KB cap) and returns its body (JSON-parsed when possible). Every fetched body is recorded in this session's untrusted-content log, so `pay_x402` can hand it to the firewall's provenance/Jev checks. Demo tool — no host allowlist. |
| `pay_x402` | `{ url, justification, promiseId? }` | either | Runs the full x402 flow through the firewall. With an account, `promiseId` says which promise to spend from — omit it only when the account has exactly one active promise (the response then carries `autoSelectedPromise: true`). GETs `url`; if not a 402, returns the body as-is; if 402, asks `/sign` (with this session's untrusted-content log as context) and either pays immediately (`{status: "paid", resource, txHash, explorerUrl, receiptId}`), refuses (`{status: "refused", reason, receiptId}`, never retried), or starts a World ID approval (`{status: "needs_human_approval", verificationUri, userCode, expiresAt, receiptId, instructions}`). |
| `check_approval` | `{ receiptId }` | either | Polls a pending World ID payment approval once. Still pending → `{status: "pending", ...}`. Approved → completes the purchase, same `paid` shape as `pay_x402`. Denied/expired → `{status: "refused", reason}`. |

## Configuration

- `OMAMORISAN_FIREWALL_URL` — firewall base URL. Default `http://localhost:4001`.
- `OMAMORISAN_AGENT_KEY` — an existing credential: `ya_...` (account) or
  `yk_...` (legacy wallet mandate). Optional — omit it entirely to start
  with no credential and let the agent call `connect` itself.
- `OMAMORISAN_CREDENTIALS_FILE` — where a `connect`/`check_connection`
  approval stores the resulting account key, keyed by firewall URL, so the
  next stdio process picks it up automatically. Default
  `~/.omamorisan/credentials.json` (created mode 0600, directory mode 0700).

### Credential resolution order

1. An `Authorization: Bearer <key>` header on the connecting HTTP request
   (Streamable HTTP transport only).
2. `OMAMORISAN_AGENT_KEY`.
3. The credentials file, for this exact `OMAMORISAN_FIREWALL_URL`.
4. None of the above — the session starts with no credential. Every tool
   except `connect`/`check_connection` fails with a clear "call connect
   first" message until one is established.

A key is **never** returned in any tool's output — the LLM never sees it,
only `connect`/`check_connection` see it (to store it) and every other tool
sees it only as an `Authorization` header value it sends to the firewall.

## Guided setup in the app

For the wallet mandate path, after signing a promise at `/app`, use the embedded **Connect your agent** video and client selector. The app generates a configuration containing the promise's agent key and shows its exact save location. Downloading a file does not install it: save or merge it into the chosen client's settings, restart that client, then ask it to call `get_mandate` without buying anything.

For stdio, the **client launches this server** and provides `OMAMORISAN_AGENT_KEY` through its configuration. You do not need to start this server manually or put that key in the shared `.env.local`. A manually started stdio process is waiting for protocol messages, not for conversational input.

Keep generated credential files private and out of Git. The agent key authorizes requests under a signed promise; do not paste it into a model prompt. Configure only the agent key and firewall URL for MCP, not the firewall or merchant private keys.

## Running

```bash
# stdio (default) — one session per process
bun run --filter @yakusoku/mcp start

# Streamable HTTP on :4010 — one session per MCP connection
bun run --filter @yakusoku/mcp http
```

## Client configuration

### Claude Code — agent-first (no key needed)

```bash
claude mcp add omamorisan -- bun /absolute/path/to/yakusoku/apps/mcp/index.ts
```

First use: ask the agent to "connect my account" — it calls `connect`, shows
a link and a short code, and waits for you to approve in World App.

### Claude Code — with an existing key (either kind)

```bash
claude mcp add omamorisan \
  --env OMAMORISAN_AGENT_KEY=ya_your_account_key_here \
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
        "OMAMORISAN_FIREWALL_URL": "http://localhost:4001"
      }
    }
  }
}
```

Codex uses `~/.codex/config.toml`, not this JSON format. The `/app` wallet-promise handoff generates a Codex TOML section and gives its save location. For agent-first setup, use the landing page instructions without a key.

Omit `OMAMORISAN_AGENT_KEY` entirely for the agent-first flow above, or set
it to an existing `ya_...`/`yk_...` key.

### Streamable HTTP

```
http://localhost:4010/mcp
```

Send `Authorization: Bearer <agentKey>` on the connecting request, or omit it
and let the session's first `connect` call establish one (stored in the
credentials file, so the header is optional on reconnect too).

## How an autonomous agent uses it

**World ID account path:** the agent calls `connect` once; the human approves
in World App on their phone and the resulting account key is stored — never
shown to the LLM. Per task, the agent calls `request_promise` with what it
wants to do, a USDC budget, categories, and how long the promise should
stay valid; the human approves that specific task/budget in World App too.
Once active, the agent calls `pay_x402` (with that promise's id, or letting
it auto-select the account's one active promise) as many times as it needs,
with zero further human taps, until the promise's budget or expiry is
reached — at which point a fresh `request_promise` is needed. A doubtful
payment (one the firewall's pipeline can't clear on its own) still triggers
a fresh World ID approval via `pay_x402`'s `needs_human_approval` response,
exactly like the legacy path.

**Legacy wallet mandate path:** the agent calls `get_mandate` first to learn
what the human authorized (task, budget, categories, expiry) via the site's
`/app` wizard, browses with `fetch_url`, then calls `pay_x402` with a
justification tying the purchase back to the mandate's task.

## Elicitation (URL mode)

When the connected client declares `elicitation.url` support during MCP
`initialize`, `connect`, `request_promise`, and a `pay_x402` that returns
`needs_human_approval` also send an out-of-band `elicitation/create` (mode
`url`) request — a server-written message (the firewall's own summary text,
or a fixed message for a bare payment approval, plus the user code) that the
model cannot alter, and the exact World ID verification link. This is
**never awaited**: the World ID poll (`check_connection`/`check_promise`/
`check_approval`) is always the source of truth for whether a human actually
approved, so an unsupported client, an ignored elicitation, or the human
just closing the prompt never changes what a tool returns — only the plain
tool-result text (always present) does.

**Verified against the installed `@modelcontextprotocol/sdk@1.30.1`:**
`Server.elicitInput({ mode: "url", message, url, elicitationId })` exists and
is gated on `getClientCapabilities()?.elicitation?.url`; a raw stdio capture
of Claude Code CLI 2.1.283's `initialize` request shows it declares
`"capabilities":{"roots":{"listChanged":true},"elicitation":{}}` — an empty
elicitation object, which the SDK's own backward-compatibility preprocessing
normalizes to `{form: {}}` (**no** `url` key). So **Claude Code CLI today
never receives a url-mode elicitation from this server** — every `connect`/
`request_promise`/`pay_x402` call falls back to plain tool-result text there,
which is exactly the documented fallback behavior. A client that DOES
declare `elicitation.url` (verified with a minimal SDK `Client` built for
this check, capabilities `{ elicitation: { url: {} } }`) receives a
well-formed request, e.g. for `connect`:

```json
{
  "mode": "url",
  "message": "Approve connecting this AI agent to your Omamorisan account in World App. Code: JBRDP-5UXKJ.",
  "elicitationId": "0a5ca7a3-...",
  "url": "https://sandbox.auth.world.org/authorize?transaction_id=..."
}
```

## Notes

- `fetch_url` is a demo convenience with no host allowlist, a 10s timeout, and
  a 200 KB body cap — a production build would need to restrict which hosts
  it can reach.
- `check_approval`/`pay_x402`'s pending-payment tracking is keyed by
  `receiptId` (globally unique) and lives in process memory — it must be
  called against the same running server process that started the
  `pay_x402` call (or, for HTTP mode, any session on that same process).
- The credentials file and its directory are created with restrictive
  permissions (0600 / 0700) and re-`chmod`ed on every save; delete
  `~/.omamorisan/credentials.json` (or the file named by
  `OMAMORISAN_CREDENTIALS_FILE`) to force a fresh `connect`.
