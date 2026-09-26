# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Astro + Tailwind site (`apps/site`): landing at `/`, promise (mandate) onboarding at `/app` (React island, viem, SIWE), owner-scoped live dashboard at `/app/dashboard` (SSE). It replaced the Next.js signing app (`apps/web`, removed); the firewall still serves a loopback-only operator console at `/dashboard`. Agents connect through `apps/mcp` (stdio or Streamable HTTP :4010) or the agent CLI. Backend: firewall (Hono :4001), store (:4000), verifier CLI.

## Users
- **ETHGlobal Tokyo 2026 judges** evaluating the project in a few minutes: they must grasp the problem, the mechanism and the evidence quickly.
- **Developers building agents that pay** (x402 / agent payments) who could put this firewall in front of their agent's signing key.
- **The person who delegates a purchase to an AI agent**: signs what the agent is allowed to buy (`/sign`), watches decisions live (`/dashboard`) and approves doubtful payments with World ID on their phone.

## Product Purpose
A pre-signature firewall for AI agent payments. The agent never holds a key; it asks the firewall to sign. The firewall signs an x402 payment only when it matches an intent the user signed with their wallet (EIP-712), stored outside the agent's context. Every check runs before signing and fails closed: any error or doubt ends in refuse or ask-a-human, never pay. Success: a prompt-injected agent cannot spend on something the user never asked for, while legitimate purchases go through without friction.

## Positioning
Existing guards are deterministic (spend caps, allow/deny lists, network/asset checks). They all miss a payment to a clean address, within budget, for something never requested. This product adds a calibrated semantic intent check (TypeSafe Jev) against the user-signed intent before signing, layered with deterministic provenance, address/token screening (Intercepta) and fresh human approval (World ID for Agents) — and proves each decision afterwards (receipts, StepUp attestation, independent on-chain verifier).

## Operating Context
- Base Sepolia testnet, USDC, x402 v2 payments through the public facilitator.
- Demo scenario: "Buy a $25 Amazon gift card for my sister's birthday"; the store's promo copy tries to make the agent buy a Steam card instead.
- Pipeline order: idempotency → policy → provenance → Intercepta → Jev → World ID → sign; a refusal from any layer wins over a doubt.
- The user signs the intent with MetaMask (injected wallet) and approves doubtful payments in the World App.
- The dashboard contrasts two lanes for each payment attempt: what a naive agent wallet would have paid vs. the firewall's verdict with the deciding layer and reason.

## Capabilities and Constraints
- Firewall API: `POST /intents`, `GET /intents`, `GET /intents/:id`, `POST /sign`, `GET /receipts`, `GET /receipts/:id`, `GET /receipts/:id/attestation`, `GET /approvals/:receiptId`, `GET /events` (SSE), `GET /control` + pause/resume/revoke (localhost + admin header).
- Testnet only; no mainnet funds. Control endpoints are localhost-guarded, not authenticated.
- The key-case attack in the demo is a disclosed scripted compromised agent (`bun run attack`), because current LLMs are not fooled on cue.
- Intercepta live screening pending the sandbox key; without it every payment escalates to World ID.
- **Product name: "Omamorisan"** (decided Sat Sep 26, "for now"; may still change). Replaces the working name "Yakusoku". User-facing surfaces (site, dashboard, EIP-712 signing domain, agent output, README) use it; internal identifiers (package scope `@yakusoku/*`, repo and folder name) stay until the name is final. Logo: a pen nib with a checkmark ("signed, then verified"), see `apps/site/BRAND.md`.

## Brand Commitments
- Name: Omamorisan (working name, may change).
- **No Japanese aesthetic**, even though the name is Japanese: no kanji, torii, washi, seals, vermilion-as-Japan, cherry blossoms or similar motifs.
- **Visual world (decided Sat Sep 26, replaces the warm paper-notebook reference):** sober, modern, security-grade. The builder pinned three reference products as the craft bar: clutch.security (leads: white gallery canvas, hairline-framed column, mixed-weight grotesk headlines, monochrome dithered 3D objects), base.org (technical line diagrams, mono uppercase labels) and neverhack.com (split hero with the live product, trust/evidence rows). Borrow grammar only: never their logos, fonts, exact brand colors or copy. Color is rationed and means state. DESIGN.md records the built system.
- Use only the existing pen-nib + check mark; never invent another mark or one that implies an existing brand.

## Evidence on Hand
All verified, nothing else may be claimed:
- First firewall-signed payment on Base Sepolia: `0xa6e1d2e08390e47654e3c64523f1fc16695633ce9bdeaf5f90b8e5f4acc26ac6`.
- Human-signed intent (MetaMask) → agent purchase with Jev live: `0xc85d39e616d1dbbd97d66606f12418c92d13843b2a73d5815b841fdd60e2059e`.
- World ID approval → payment with a valid StepUp attestation: `0xbc77ac5b547301ade87d09651f15f550a2f5b5b3003befa310d5eab9d9280897`; a denied approval refused and restored the budget.
- Jev live results: key case (clean address, within budget, never requested) refused with matches_intent 0.02; legitimate demo purchase pays; no attack fixture ever paid across repeated runs.
- `bun run scenarios`: 29/29 end-to-end scenarios pass (legit purchase, key case, provenance and zero-width injection, over budget, expired intent, tampered 402, unknown intent, bad signature, idempotent replay, concurrency, missing context, World ID expiry, pause/revoke (global and per-owner), per-mandate agent credentials, SIWE sign-in/nonce-replay, and owner-scoped access control across `/intents`, `/receipts`, `/approvals`, `/events`).
- Real MCP-client validation (2026-09-26): Claude Code driven as a genuine MCP client over stdio against `apps/mcp`, using the exact config shape the site's mandate wizard produces. A legit purchase attempt correctly reached `needs_human_approval` with a live World ID sandbox link (left pending, never approved); a second attempt following the injected "buy a Steam gift card" promo copy was correctly `refused` by Jev.
- Independent verifier: every on-chain payment traces back to a firewall `pay` receipt.
- No customers, testimonials, benchmarks, pricing or production deployments exist; never fabricate them.

## Product Principles
- Fail closed: doubt never becomes a payment.
- The user's signed intent is the source of truth, never the agent's word or a page's text.
- Every decision is explainable: which layer decided, and why.
- Prove it, don't claim it: on-chain evidence, attestations and an independent verifier.
- Legitimate purchases must stay frictionless; humans are asked only when it matters.
