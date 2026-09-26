# Demo x402 store

The Express store on port 4000 serves gift-card resources through x402. Its catalog includes a legitimate Amazon item and a Steam item used in the prompt-injection demo; promo pages contain the test content read by agents. Payments settle through the configured x402 facilitator on Base Sepolia.

From the repo root, run `bun install`, configure the environment as described in the [root README](../../README.md), then start the store with `bun run store`. The firewall checks the store's own 402 response before signing a payment.
