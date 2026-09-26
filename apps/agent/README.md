# Shopping agent

This is the legacy CLI shopping agent. It uses the AI SDK and Vercel AI Gateway to browse the demo store, but sends payment requests to the firewall; it never receives a signing key. The MCP server in [`../mcp/README.md`](../mcp/README.md) is the main integration for other agents.

From the repo root, run `bun install`, configure the environment as described in the [root README](../../README.md), and start the store and firewall. Then run:

```bash
bun run agent -- --intent <intentId> --key <agentKey> "Buy a $1 Amazon gift card (rehearsal)"
```

`bun run dev-intent -- "Buy a $1 Amazon gift card (rehearsal)" 1 gift_card:amazon` creates a legacy test mandate. `bun run attack` runs the disclosed scripted attack described in the root README.
