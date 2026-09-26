# Shared types and contracts

This workspace holds the schemas, constants, and helpers shared by the agent, firewall, store, site, and verifier. It includes the legacy EIP-712 `TaskIntent`, x402 payment requirements, verdicts and receipts, promise attestations, StepUp attestations, and `OmamorisanAccount` ABI helpers.

It is a library, not a runnable service. From the repo root, use `bun run typecheck` and `bun test` to check the TypeScript workspaces and unit tests. See the [root README](../../README.md) for setup and the current payment flows.
