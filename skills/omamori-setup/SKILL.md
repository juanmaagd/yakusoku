---
name: omamori-setup
description: "Trigger: connecting an agent (Claude Code, Desktop, Cursor, Codex, or any MCP client) to Omamori, first-run setup/funding, or Omamori MCP troubleshooting. Detects the client, wires the hosted or local MCP server, and verifies the connection."
license: Apache-2.0
metadata:
  author: "juanmaagd"
  version: "1.0"
---

## Activation Contract

Load this skill when a human asks to connect their agent to Omamori (the `omamorisan` MCP server), set up or fund their Omamori account, or diagnose an MCP tool call that fails with a repeated World ID prompt, `401`, `recipient_not_registered`, `insufficient_funds`, `paused`, `merchant_mismatch`, or `account_not_set_up`.

## Hard Rules

- NEVER ask the human to paste their agent key into chat, and NEVER print, echo, or run a command that could reveal one (`cat`/`grep`/`echo` on a config file, printing an env var, quoting it back). The human adds it to their own config or shell themselves.
- Treat `scripts/omamori-doctor.mjs` output as the only safe introspection path — its redaction is load-bearing; never re-derive the same check with a raw `curl`/`cat` that would print a header value.
- Confirm with the human before creating or editing any of their config files (Claude Desktop config, `~/.cursor/mcp.json`, `~/.codex/config.toml`, a `claude mcp add` invocation).
- Default to the hosted team instance (`assets/instance.example.json`) unless the human says local, or the hosted instance fails health checks.
- Fail closed: if the client is ambiguous, ask once instead of guessing.

## Decision Gates

| Client | Hosted (Streamable HTTP) | Local (stdio) |
|---|---|---|
| Claude Code | `claude mcp add --transport http ... --header "Authorization: Bearer <key>"` | `claude mcp add omamorisan -- bun apps/mcp/index.ts` |
| Claude Desktop | `mcp-remote` bridge (stdio-only client) | direct `bun` command in `claude_desktop_config.json` |
| Cursor | `url` + `headers` in `mcp.json` | `command`/`args` in `mcp.json` |
| Codex | `[mcp_servers.omamorisan]` + `bearer_token_env_var` in `~/.codex/config.toml` | same block, no bearer field |
| Other MCP client | any Streamable-HTTP-capable client, or the `mcp-remote` bridge | stdio per `apps/mcp/README.md` |

Already connected (a fresh session's `get_mandate` returns the account, no World ID prompt) → skip straight to step 5 (Verify).

## Execution Steps

1. **Detect** the client and hosted-vs-local from `references/clients.md`; ask once if unclear.
2. **Connect**: tell the human to mint an agent key at `/app/settings` themselves and add it per `references/clients.md` and the matching `assets/*` template. Never see, request, or relay the raw key.
3. Run `node scripts/omamori-doctor.mjs --instance <instance.json>` to check endpoint health and existing client config, redacted.
4. **First run**: walk `references/first-run.md` (account + first intent creation, World ID approval, `/setup` wallet link, funding, unpause, store registration).
5. **Verify**: a fresh session's `get_mandate` call returns the account with no World ID prompt.
6. On any failure, map it through `references/troubleshooting.md` and report the fix — don't guess at a cause the map already answers.

## Output Contract

Report: detected client, hosted vs. local, the doctor script's redacted findings, the current step in the setup flow, and the next concrete action for the human. Never output key material or a full config file's contents — only presence/absence and the specific line to add.

## References

- `references/clients.md` — per-client connection steps and config paths.
- `references/first-run.md` — account creation, World ID approval, funding, store registration.
- `references/troubleshooting.md` — error → cause → fix map.
- `assets/` — per-client config templates and `instance.example.json`.
