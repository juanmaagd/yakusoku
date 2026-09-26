# Per-client connection steps

Omamori exposes MCP over Streamable HTTP (hosted, recommended) or stdio (local). Internal identifiers keep the `omamorisan` name (env vars, MCP server key, tool names); user-facing text says Omamori.

Hosted team instance (also in `../assets/instance.example.json`):

- MCP (Streamable HTTP): `https://omamorisan-mcp-8e4dca-91-98-199-240.sslip.io/mcp`
- Site (Settings/keys, account, intents, dashboard): `https://omamorisan-site-074960-91-98-199-240.sslip.io`
- Firewall: `https://omamorisan-firewall-e25869-91-98-199-240.sslip.io`
- Stores: gift cards `https://omamorisan-store-1135aa-91-98-199-240.sslip.io`, data `https://omamorisan-data-da00c3-91-98-199-240.sslip.io`, cloud `https://omamorisan-cloud-ead900-91-98-199-240.sslip.io`

Every service serves `GET /health`. A local stack uses `http://localhost:<port>` instead — see `apps/mcp/README.md`.

## Minting the agent key (do this first, for the hosted instance)

The hosted MCP server keeps each session's World-ID credential in memory only, so a brand-new session re-asks for World ID. To skip that:

1. The human signs in at `<site>/app/settings` (SIWE wallet sign-in).
2. They click **Create agent key** — the key is shown once, and is revocable from the same page.
3. **The human pastes it into their own client config or terminal.** An agent following this skill never sees, requests, or handles the raw key — only the human can complete this step.

Without the header, every new session asks for World ID again; that's a valid (slower) way to work if the human prefers not to mint a key.

## Claude Code

Hosted, with a key:

```bash
claude mcp add --transport http omamorisan <MCP_URL> --header "Authorization: Bearer <key>"
```

([docs](https://code.claude.com/docs/en/mcp#option-1-add-a-remote-http-server))

Hosted, no key (re-asks World ID each new session):

```bash
claude mcp add --transport http omamorisan <MCP_URL>
```

Local stdio:

```bash
claude mcp add omamorisan -- bun /absolute/path/to/yakusoku/apps/mcp/index.ts
```

## Claude Desktop

`claude_desktop_config.json` only speaks stdio, so bridge the hosted server with [`mcp-remote`](https://github.com/punkpeye/mcp-remote#custom-headers). Template: `../assets/claude-desktop.json`.

```json
{
  "mcpServers": {
    "omamorisan": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "<MCP_URL>", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <key>" }
    }
  }
}
```

The human edits this file and fills `<key>` themselves; an agent should confirm before writing it and never fill the placeholder in.

## Cursor

`~/.cursor/mcp.json` (global) or the project's `.cursor/mcp.json`. Template: `../assets/cursor-mcp.json`. ([docs](https://cursor.com/docs/mcp#config-interpolation))

```json
{
  "mcpServers": {
    "omamorisan": {
      "url": "<MCP_URL>",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

## Codex (OpenAI)

Codex reads MCP servers from `~/.codex/config.toml` (`mcp_servers` table) or `codex mcp add <name> --url <url>` for a no-auth server. For bearer auth, current Codex CLI supports a `bearer_token_env_var` field that names an environment variable holding the token — never the token itself — so the config file stays safe to check in. Template: `../assets/codex-config.toml`.

```toml
[mcp_servers.omamorisan]
url = "<MCP_URL>"
bearer_token_env_var = "OMAMORI_AGENT_KEY"
```

The human exports `OMAMORI_AGENT_KEY` in their own shell profile (never in the checked-in config); Codex reads the header from the environment at connect time.

Verified against: [OpenAI Docs MCP quickstart](https://developers.openai.com/learn/docs-mcp) (the `codex mcp add` / `config.toml` shape) and a live Codex bug report confirming `bearer_token_env_var` as the current field name ([openai/codex#30125](https://github.com/openai/codex/issues/30125)).

## Any other MCP client

- If it supports Streamable HTTP with custom headers natively: point it at `<MCP_URL>` with `Authorization: Bearer <key>`.
- If it only supports stdio (like Claude Desktop): bridge with `npx -y mcp-remote <MCP_URL> --header "Authorization:Bearer <key>"`.
- If it's a script or CLI with no MCP client at all: use the legacy CLI path in the main README (`bun run agent -- --intent <id> --key <key> "..."`), or drive `apps/mcp` over stdio directly.

## Local stdio alternative (any client)

Skip the hosted instance and run the MCP server yourself, pointed at a local or remote firewall:

```json
{
  "mcpServers": {
    "omamorisan": {
      "command": "bun",
      "args": ["/absolute/path/to/yakusoku/apps/mcp/index.ts"],
      "env": { "OMAMORISAN_FIREWALL_URL": "http://localhost:4001" }
    }
  }
}
```

Credentials then persist in `~/.omamorisan/credentials.json` instead of the hosted server's in-memory session.
