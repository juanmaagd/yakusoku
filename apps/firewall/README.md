# Payment firewall

The Hono service on port 4001 stores authorizations and receipts, checks each x402 payment through the policy, merchant, provenance, Intercepta, and Jev stages, and handles World ID approvals. It supports both legacy wallet mandates and World ID account promises. Account payments use a user-owned `OmamorisanAccount`; legacy payments use the firewall wallet.

From the repo root, run `bun install`, configure the environment as described in the [root README](../../README.md), then start the service with `bun run firewall`. The loopback operator console is at `http://localhost:4001/dashboard`.

`bun run scenarios` runs isolated end-to-end checks without settling on-chain. `bun run roundtrip` settles a real Base Sepolia test USDC payment and needs a funded legacy wallet. See the root README before running a payment check.
