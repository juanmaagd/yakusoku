# Installing the `omamori-purchase` skill

This skill is a standard [Agent Skills](https://agentskills.io/specification) package (`SKILL.md` + `references/` + `scripts/`), same format as its sibling [`omamori-setup`](../omamori-setup/). Drop the whole `omamori-purchase/` folder into the location your provider scans; no build step, no manifest to edit.

**Installation paths are identical to `omamori-setup`** — see [its README's provider table](../omamori-setup/README.md#installing-the-omamori-setup-skill) for the verified per-provider project/personal locations (Claude Code, Claude Desktop, Cursor, Codex, GitHub Copilot). Substitute `omamori-purchase` for `omamori-setup` in every path, e.g.:

```bash
# Claude Code / Claude Desktop, project-scoped
mkdir -p .claude/skills && cp -r skills/omamori-purchase .claude/skills/

# Any provider, personal/global (adjust the target per omamori-setup's table)
mkdir -p ~/.claude/skills && cp -r skills/omamori-purchase ~/.claude/skills/
```

A symlink works too, and keeps the copy in sync with the repo:

```bash
ln -s "$(pwd)/skills/omamori-purchase" .agents/skills/omamori-purchase
```

Install `omamori-setup` alongside it if the agent isn't connected to Omamori yet — `omamori-purchase` assumes a working session and only covers making a purchase.

## What's in here

- `SKILL.md` — the runtime contract (read this first if you're an agent).
- `references/flow.md` — the purchase flow, step by step, with example tool calls.
- `references/verdicts.md` — every status/refusal reason the MCP tools can return, what it means, and what to do next.
- `references/tools.md` — a **generated** reference of every Omamori MCP tool (name, description, parameters). Do not hand-edit it.
- `scripts/sync-tool-reference.mjs` — zero-dependency, Node ≥18 script that regenerates `references/tools.md` from the live MCP server's own `tools/list` (falling back to a static parse of `apps/mcp/tools.ts` if the server can't be reached).

## Regenerating the tool reference

```bash
node scripts/sync-tool-reference.mjs
```

Defaults to the hosted team instance (`https://omamorisan-mcp-8e4dca-91-98-199-240.sslip.io/mcp`). Point it at another server (e.g. a local one) with `--mcp <url>`:

```bash
node scripts/sync-tool-reference.mjs --mcp http://localhost:4010/mcp
```

Run it again any time `apps/mcp/tools.ts` changes, and commit the refreshed `references/tools.md` — this reference is generated from the server's own tool metadata specifically so it can never drift from what the MCP server actually exposes.
