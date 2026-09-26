# Installing the `omamori-setup` skill

This skill is a standard [Agent Skills](https://agentskills.io/specification) package (`SKILL.md` + `references/` + `assets/` + `scripts/`) — the same open format Anthropic, OpenAI, Cursor, and GitHub Copilot all load. Drop the whole `omamori-setup/` folder into the location your provider scans; no build step, no manifest to edit.

Verified against each provider's own docs (fetched 2026-09-27):

| Provider | Project-scoped location | Personal/global location | Source |
|---|---|---|---|
| Claude Code | `.claude/skills/omamori-setup/` | `~/.claude/skills/omamori-setup/` | [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory), [Extend Claude with skills](https://code.claude.com/docs/en/skills) |
| Claude Desktop | — (no project scope) | `~/.claude/skills/omamori-setup/` | [Introducing Agent Skills](https://claude.com/blog/skills) ("manually install skills by adding them to `~/.claude/skills`") |
| Cursor | `.cursor/skills/omamori-setup/` or `.agents/skills/omamori-setup/` | `~/.cursor/skills/omamori-setup/` or `~/.agents/skills/omamori-setup/` | [Agent Skills · Cursor Docs](https://cursor.com/docs/skills), [Skills · Cursor Docs](https://cursor.com/help/customization/skills) |
| Codex / ChatGPT | `.agents/skills/omamori-setup/` (Codex scans this from your CWD up to the repo root) | `$HOME/.agents/skills/omamori-setup/` | [Build skills — ChatGPT Learn](https://learn.chatgpt.com/docs/build-skills) |
| GitHub Copilot / VS Code | `.github/skills/omamori-setup/`, `.claude/skills/omamori-setup/`, or `.agents/skills/omamori-setup/` | `~/.copilot/skills/omamori-setup/`, `~/.claude/skills/omamori-setup/`, or `~/.agents/skills/omamori-setup/` | [Use Agent Skills in VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills), [About agent skills — GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) |

In this repo, the skill already lives at `skills/omamori-setup/` (repo-relative), which is **not** one of the scanned paths above — it's the canonical source. To use it with a given provider, copy or symlink it into that provider's scanned location, e.g.:

```bash
# Claude Code / Claude Desktop, project-scoped
mkdir -p .claude/skills && cp -r skills/omamori-setup .claude/skills/

# Cursor / Codex, project-scoped (either works for both per their docs above)
mkdir -p .agents/skills && cp -r skills/omamori-setup .agents/skills/

# GitHub Copilot / VS Code, project-scoped
mkdir -p .github/skills && cp -r skills/omamori-setup .github/skills/

# Any provider, personal/global (adjust the target per the table above)
mkdir -p ~/.claude/skills && cp -r skills/omamori-setup ~/.claude/skills/
```

A symlink works too, and keeps the copy in sync with the repo:

```bash
ln -s "$(pwd)/skills/omamori-setup" .agents/skills/omamori-setup
```

No provider needs anything beyond the folder itself — skill discovery is name/description-only at startup (progressive disclosure), so adding it costs nothing until a task actually matches its `description`.

## What's in here

- `SKILL.md` — the runtime contract (read this first if you're an agent).
- `references/` — per-client connection steps, first-run walkthrough, troubleshooting map.
- `assets/` — config templates (placeholders only, never a real key) and `instance.example.json`.
- `scripts/omamori-doctor.mjs` — zero-dependency, read-only health/config check. Run it directly: `node scripts/omamori-doctor.mjs --instance assets/instance.example.json`.
