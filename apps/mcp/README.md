# @yakusoku/mcp — Omamorisan MCP server

Exposes the Omamorisan payment firewall to **any** MCP-speaking agent (Claude
Code, Claude Desktop, Codex, Cursor, a custom agent, ...). This process never
holds a signing key — every payment still goes through the firewall's
`/sign`, exactly like `apps/agent`'s `buy` tool.

Two credential paths, both usable from the same server:

- **World ID account (`ya_...`, recommended)** — no wallet, no key ever
  typed anywhere. Add the MCP server once with no key at all; on first use
  the agent calls `request_promise` directly with the human's spending rules
  (what, budget, categories, expiry, and the one merchant/store origin it may
  pay): with no credential at all yet, this creates the account AND that
  first promise together under a SINGLE World ID approval (P9.6) — never a
  separate `connect` step for a new user. Once active, `pay_x402` reuses that
  same promise across every later purchase that fits — only on that exact
  origin — with zero further human taps until it runs out, expires, or is
  widened (`replaces`), or until a doubtful payment needs a fresh approval.
  `connect` exists separately, only to link this agent to an account the
  human already has. Once connected, the account still
  needs its own smart account (`OmamorisanAccount`) deployed before it can
  actually hold and pay USDC — `connect`/`check_connection`/a first-time
  `request_promise` mention this with a `setupUrl`, and `setup_account`
  fetches a fresh one any time (P11.3a).
- **Wallet mandate (`yk_...`, legacy)** — a human signs a `TaskIntent` via the
  site's `/app` wizard and hands the agent a mandate key up front
  (`OMAMORISAN_AGENT_KEY`). Unchanged since WU-P2.

## Tools

| Tool | Input | Credential | What it does |
|---|---|---|---|
| `connect` | _(none)_ | none yet | Links this agent to a human's EXISTING account via World ID — it does not set any spending rules. For a brand-new user, call `request_promise` instead: it sets the human's spending rules and creates the account together in a single approval. No-op ("already_connected") if this session already has a credential. Starts a World ID device flow, waits briefly (≤~30s) for approval, and returns `{status: "connected", accountId, setupUrl?}` or `{status: "pending", connectId, verificationUri, userCode, expiresAt}` — call `check_connection` again if still pending. `setupUrl` (and a "Next: open ... " note in `message`) appears only while this account still has no deployed smart account (P11.3a). |
| `check_connection` | _(none)_ | none yet | Resumes waiting on the pending `connect()` request. Same response shapes as `connect`. |
| `request_promise` | `{ task, budgetUsdc, categories[1-5], expiresInMinutes, merchant, replaces? }` | none yet, or account | Asks the human to set (or widen) their standing spending rules, bound to one merchant (store) origin — the World-ID-native replacement for a signed mandate. Call it ONCE to cover many purchases, not once per item or task: `task` should state the full scope approved (e.g. `"Any Amazon or Steam gift card for personal gifts"`), and every later purchase that fits reuses this same rule via `list_promises`/`pay_x402`. **With no credential at all yet**, this creates the account AND these rules together under a SINGLE World ID approval (P9.6) — never call `connect` first for a new user. `merchant` is the store's base URL (e.g. `http://localhost:4000`); the resulting rules can only ever pay a resource on that exact origin, never a different store. **Widening the rules:** when a purchase doesn't fit (something outside what was approved, or a different budget/store), tell the human why and, only if they agree, pass `replaces` as the CURRENT promiseId — the human approves the widened rules in World App, and once approved the old promise is revoked. `replaces` requires an already-connected account (refused on the first-time no-credential path). Waits briefly for approval; returns `{status: "active", promiseId, summary, remainingBudget, replaces?, setupUrl?}` or `{status: "pending", promiseId, verificationUri, userCode, expiresAt, summary}` (call `check_promise`) or a terminal `{status: "denied"\|"expired", reason}`. `setupUrl` appears on the first-time (no-credential) path only, same P11.3a condition as `connect`. |
| `check_promise` | `{ promiseId }` | none yet (if resuming a first-time `request_promise`), or account | Resumes waiting on a pending promise, or reports the current status of any promise on the account. Once active, the response names the promise it replaced (`replaces`) if any. |
| `list_promises` | _(none)_ | account | Lists every promise (spending rule) on the account (pending, active, or resolved) with remaining budget, categories, expiry, and replacement lineage (`replaces`/`replacedBy`). Call this before every purchase to check whether an active promise already covers it, so `pay_x402` can reuse it instead of asking for a new one. |
| `get_mandate` | _(none)_ | either | With an account: `{accountId, createdAt, promises, smartAccount?, owner?, balanceUsdc?, perPaymentLimitUsdc?, recipients?}` — the last five only once the smart account is deployed (`balanceUsdc`/`perPaymentLimitUsdc` are decimal USDC strings, e.g. `"25"`, never atomic units). With a wallet mandate: `{id, task, budget, remainingBudget, categories, expiry, revoked}`. |
| `setup_account` | _(none)_ | account | P11.3a — mints a fresh `${setupUrl}` (a browser link, valid 30 minutes) for the human to link their own wallet as this account's owner and fund it with USDC, deploying the `OmamorisanAccount` smart account that actually holds and pays the money. Call it any time another tool mentions setup is still needed, or whenever asked how to fund the account. |
| `fetch_url` | `{ url }` | either | GETs an http(s) URL (10s timeout, 200 KB cap) and returns its body (JSON-parsed when possible). Every fetched body is recorded in this session's untrusted-content log, so `pay_x402` can hand it to the firewall's provenance/Jev checks. Demo tool — no host allowlist. |
| `pay_x402` | `{ url, justification, promiseId? }` | either | Runs the full x402 flow through the firewall, reusing the human's existing spending rules — call `list_promises` first and pay under whichever active promise already covers the purchase, without asking the human again. With an account, `promiseId` says which promise to spend from — omit it only when the account has exactly one active promise (the response then carries `autoSelectedPromise: true`). GETs `url`; if not a 402, returns the body as-is; if 402, asks `/sign` (with this session's untrusted-content log as context) and either pays immediately (`{status: "paid", resource, txHash, explorerUrl, receiptId}`), refuses (`{status: "refused", reason, receiptId, actionableHint?}`, never retried — `actionableHint` appears for a funding refusal, or for a Jev refusal specifically because the purchase no longer matches the approved promise, in which case it points at `request_promise`'s `replaces`), or starts a World ID approval (`{status: "needs_human_approval", verificationUri, userCode, expiresAt, receiptId, instructions}`). |
| `check_approval` | `{ receiptId }` | either | Polls a pending World ID payment approval once. Still pending → `{status: "pending", ...}`. Approved → completes the purchase, same `paid` shape as `pay_x402`. Denied/expired → `{status: "refused", reason}`. |

## Configuration

- `OMAMORISAN_FIREWALL_URL` — firewall base URL. Default `http://localhost:4001`.
- `OMAMORISAN_AGENT_KEY` — an existing credential: `ya_...` (account) or
  `yk_...` (legacy wallet mandate). Optional — omit it entirely to start
  with no credential and let the agent call `request_promise` itself.
- `OMAMORISAN_CREDENTIALS_FILE` — where a `connect`/`check_connection` or
  first-time `request_promise` approval stores the resulting account key,
  keyed by firewall URL, so the next stdio process picks it up automatically.
  Default `~/.omamorisan/credentials.json` (created mode 0600, directory
  mode 0700).

### Credential resolution order

1. An `Authorization: Bearer <key>` header on the connecting HTTP request
   (Streamable HTTP transport only).
2. `OMAMORISAN_AGENT_KEY`.
3. The credentials file, for this exact `OMAMORISAN_FIREWALL_URL`.
4. None of the above — the session starts with no credential. It should call
   `request_promise` to set the human's spending rules, creating the account
   and its first promise together in one approval (`check_promise` resumes
   it); `connect`/`check_connection` remain available for linking to an
   account the human already has. Other account and payment tools require a
   credential.

A key is **never** returned in any tool's output — the LLM never sees it.
`connect`/`check_connection` and the first-time `request_promise`/`check_promise`
path store a newly issued key; later tools use it as an `Authorization` header
value sent to the firewall.

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

First use: tell the agent your spending rules — what it may buy, the store,
a total USDC budget, and how long (up to 7 days) — it calls `request_promise`,
shows a link and a short code, and waits for you to approve in World App.
That single approval also creates your account; no separate `connect` step.

### Claude Code — with an existing key (either kind)

```bash
claude mcp add omamorisan \
  --env OMAMORISAN_AGENT_KEY=ya_your_account_key_here \
  -- bun /absolute/path/to/yakusoku/apps/mcp/index.ts
```

### Claude Desktop / Cursor / Codex (`mcpServers` JSON)

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

Omit `OMAMORISAN_AGENT_KEY` entirely for the agent-first flow above, or set
it to an existing `ya_...`/`yk_...` key.

### Streamable HTTP

```
http://localhost:4010/mcp
```

Send `Authorization: Bearer <agentKey>` on the connecting request, or omit it
and let the session's first `request_promise` (or `connect`) call establish
one (stored in the credentials file, so the header is optional on reconnect
too).

## How an autonomous agent uses it

**Approve spending rules once, then buy freely (the standing-rules flow):**
day-to-day purchases need zero human approvals. An agent doesn't even need to
call `connect` first — calling `request_promise` directly with no credential
at all creates the human's account AND activates their first spending rules
together under ONE World ID approval (P9.6), instead of a separate `connect`
tap first. The human approves what the agent may buy, a USDC budget,
categories, how long the rules stay valid (up to 7 days), and the one
merchant (store) origin it may pay — `task` should state the full approved
scope (e.g. "any Amazon or Steam gift card for personal gifts"), not a single
item. `check_promise` resumes a pending request exactly like an ordinary
pending promise.

Once active, the agent calls `list_promises` before every purchase and pays
with `pay_x402` (with that promise's id, or letting it auto-select the
account's one active promise) under whichever active promise already covers
it — as many times as needed, against that same origin, with zero further
human taps, never asking for a new promise per item or per task, until the
rules' budget or expiry is reached. A doubtful payment (one the firewall's
pipeline can't clear on its own) still triggers a fresh World ID approval via
`pay_x402`'s `needs_human_approval` response, exactly like the legacy path.

**Widening the rules, but only the human can change them:** if a purchase
doesn't fit the active rules — something outside what was approved, or the
human wants a different budget/store — the agent must never keep trying to
pay under them. Instead it explains why to the human and, only if they agree,
calls `request_promise` again with `replaces` set to the current promiseId,
describing exactly what they now want; the human approves that specific
change (old rules → new rules) in World App, and only on approval does the
old promise stop working — a denied or expired replacement leaves it
untouched. Jev still checks every payment against whichever promise is
currently approved, never the conversation, so a payment that no longer
matches the (old) rules is refused with an `actionableHint` pointing the
agent at `request_promise`'s `replaces` — but only for that specific refusal
reason; every other refusal (funding, provenance, Intercepta, policy) is
unaffected and never suggests a replacement.

**`connect` is for an existing account only:** it links this agent to a
human's account that already exists and sets no spending rules of its own —
use it only when the human already has an account, never as the first step
for a new user.

**Funding the account (P11.3a):** a connected account still needs its own
`OmamorisanAccount` smart account deployed before `pay_x402` can actually
move money — `connect`/`check_connection`/a first-time `request_promise`
mention this with a `setupUrl` the moment the account has none yet, and
`setup_account` fetches a fresh link any time. The human opens it in a
browser, links their own wallet as the account's owner, and funds it with
USDC — the site (out of scope for this server) handles that page.

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
