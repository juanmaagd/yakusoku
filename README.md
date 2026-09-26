<img src="apps/site/public/brand/logo.svg" alt="Omamori" width="220">

# Omamori

**A pre-signature firewall for AI agent payments: it only signs a payment when it matches an intent a human authorized.**

Built by a team of four at ETHGlobal Tokyo 2026 ("From Scratch" track). Base Sepolia testnet, [x402](https://docs.x402.org/) payments, USDC.

AI shopping/payment agents are starting to hold budgets and pay for things on their own (x402 is the first native channel for this: an API or a store returns `402 Payment Required` and the agent pays in USDC).

A prompt injection — hidden text in a page, a product description, or an API response — can trick an agent into paying for something you never asked for.

Every existing guard is deterministic: spend caps, address allowlists/denylists, network/asset checks. They all miss the same case: **a payment to a clean address, within budget, for something you never requested.**

Omamori's agent never holds a private key — it asks the firewall to sign. The firewall checks payments against a human-authorized task and budget stored outside the agent's context, using TypeSafe Jev for semantic matching, deterministic provenance checks, Intercepta screening, and World ID for payments that need a fresh human decision. Authorization can come from a World ID account intent or a legacy EIP-712 wallet mandate.

Naming: the product is Omamori and the spending rules a human approves for an agent are called intents. The repository codename is `yakusoku`, and some identifiers keep earlier names (`omamorisan` packages/env vars/MCP server key, `promise` routes, tables, and MCP tool names such as `request_promise`).

## Give your agent a firewall

The main way to use Omamori is **through your agent**, over MCP. The current account flow uses World ID to approve each task and budget; the older wallet mandate flow is still supported.

**Canonical setup guide:** [`skills/omamori-setup/`](skills/omamori-setup/) is an [Agent Skills](https://agentskills.io/specification) package that walks any MCP-capable agent (Claude Code, Claude Desktop, Cursor, Codex, or another client) through detecting the client, connecting, first run, verification and troubleshooting — the steps below are the short version.

**1. Run the services and add the MCP server to your client.**

```
bun run store      # :4000
bun run firewall   # :4001
bun run site       # :4321
```

For a stdio MCP client, add this config without a key:

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

See [`apps/mcp/README.md`](apps/mcp/README.md) for client-specific commands and Streamable HTTP.

**Using the hosted MCP server instead of running it yourself?** It keeps each session's credential in memory only, so a brand-new session (new conversation, reconnect, redeploy) normally re-asks for World ID. Sign in at `/app/settings`, click **Create agent key**, and add the header it shows instead of repeating that approval:

- Claude Code: `claude mcp add --transport http omamorisan <MCP_URL> --header "Authorization: Bearer <key>"` ([docs](https://code.claude.com/docs/en/mcp#option-1-add-a-remote-http-server)).
- Claude Desktop: its `claude_desktop_config.json` only speaks stdio, so bridge with [`mcp-remote`](https://github.com/punkpeye/mcp-remote#custom-headers): `"command": "npx", "args": ["-y", "mcp-remote", "<MCP_URL>", "--header", "Authorization:${AUTH_HEADER}"], "env": { "AUTH_HEADER": "Bearer <key>" }`.
- Cursor: in `~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`): `{ "url": "<MCP_URL>", "headers": { "Authorization": "Bearer <key>" } }` ([docs](https://cursor.com/docs/mcp#config-interpolation)).

Without the header, every new session asks for World ID again. Revoke a key anytime from `/app/settings`; creating a new one doesn't revoke older ones yet.

**2. Authorize a task.** Ask the agent to call `request_promise` with a task, USDC budget, categories, expiry, and one merchant origin. With no existing account, one World ID approval creates the account and its first intent. `check_promise` resumes a pending request. The credential is stored by the MCP server and is never returned to the model.

**3. Set up the payer account.** Follow the `setupUrl` returned on first use, or ask the agent to call `setup_account`. The human links a wallet as owner and funds the deployed `OmamorisanAccount` with Base Sepolia USDC. Account payments require this setup; the account's owner controls recipients and payment limits.

**4. Pay through the agent.** The agent calls `pay_x402` against the intent's merchant origin. It can use `get_mandate` and `fetch_url` for context, and `check_approval` when a payment needs a separate World ID approval. Every payment goes through the firewall before signing.

**Legacy wallet path:** Open `http://localhost:4321/app` and sign an EIP-712 `TaskIntent`. The page gives you a `yk_...` key for `OMAMORISAN_AGENT_KEY`; [`apps/mcp/README.md`](apps/mcp/README.md) has the configuration. This path uses the firewall-funded wallet instead of a user-owned smart account.

**Legacy CLI alternative**, no MCP client needed:

```
bun run agent -- --intent <intentId> --key <agentKey> "Buy me a $25 Amazon gift card"
```

## Human approvals and supervision

1. **Authorize a task** — approve each account intent in World App, or sign a legacy wallet mandate at `/app`.
2. **Approve a doubtful payment** — when the pipeline cannot decide or the amount crosses `HUMAN_APPROVAL_OVER_USDC`, approve or deny it in World App.
3. **Supervise** — `/app/dashboard` shows decisions for a connected wallet; the loopback operator dashboard at `:4001/dashboard` serves the demo operator.

## How it works

```
Human ──World ID intent or wallet-signed TaskIntent──▶ Firewall (holds the operator signing key)
Agent (no private key, talks over MCP or the CLI)
  │ requests a resource ──▶ Store (x402) ──▶ 402 Payment Required
  │ decodes the header, sends it to the Firewall
  ▼
FIREWALL PIPELINE (every stage runs, before signing, fail-closed):
  1. idempotency   — already processed this exact payment? replay the cached result
  2. policy        — within budget, intent not expired/revoked, correct network/asset
  3. merchant      — the firewall fetches the 402 itself: does it match what the agent forwarded?
  4. provenance    — is the recipient traceable to the signed intent, or only to untrusted page text?
  5. Intercepta    — is the destination address / token flagged (sanctions, scams, drainers)?
  6. Jev           — does the payment semantically match what you asked for?
  7. World ID      — if anything above is undecided, or the amount is large: ask a live human
  ──▶ sign for the funded smart account or legacy firewall wallet, or refuse, with a reason
Agent retries with the signature ──▶ Store ──▶ facilitator (x402.org) ──▶ Base Sepolia
Dashboard: every decision, live, with its reason (/app/dashboard, or the loopback operator view at :4001/dashboard)
```

**Fail-closed rule:** any error, timeout, missing config, or unexpected shape from *any* stage becomes `refuse` or `ask_human` — never `pay` (`apps/firewall/pipeline.ts`, file-header comment; enforced per-stage in `intercepta.ts`, `jev.ts`, `world-id.ts`).

**Refuse dominance:** an early stage escalating to "ask a human" (for example, Intercepta not configured) does **not** short-circuit the later, more expensive stages.

Every stage always runs; a `refuse` from *any* stage wins outright and stops the pipeline immediately, even if an earlier stage only asked for a human.

This was a real bug found in review (see `docs/ai/README.md`): without it, the key attack case could be routed to a human instead of refused outright by Jev. See `apps/firewall/pipeline.ts` (`evaluateStages`, `PIPELINE_STAGES`).

**Merchant self-fetch (H1 fix):** the firewall never trusts the agent's own decode of a store's `PAYMENT-REQUIRED` header. Before signing, the `merchant` stage GETs `resourceUrl` itself (http/https only, no redirects, ~4s timeout, headers only), decodes the 402 it gets back, and compares `scheme`/`network`/`asset`/`amount`/`payTo` against what the agent forwarded — any difference (`payee_mismatch`/`requirement_mismatch`), a non-402, an undecodable header, or an unreachable merchant (`merchant_unreachable`) refuses outright. Signing always uses the firewall's own fetched copy, never the agent's. A World-ID intent additionally binds one merchant origin at creation (`POST /promises`'s `merchant`); paying a different origin refuses `merchant_mismatch` before any network call. See `apps/firewall/merchant.ts`.

**StepUp attestation:** when a human approves via World ID, the firewall signs a second EIP-712 struct (`StepUpAttestation`) binding that exact approval — subject, ACR, `auth_time` — to that exact payment (`receiptId`, `paymentIdentifier`, `payTo`, `amount`, `asset`), *before* signing the payment itself.

It is independently re-verifiable (`packages/shared/step-up.ts#verifyStepUpAttestation`) without trusting the firewall's own database, and is served on its own at `GET /receipts/:id/attestation`.

**Independent verifier:** `apps/verifier` checks outgoing USDC transfers from a specified wallet against firewall receipt history over HTTP and re-verifies StepUp attestations when present. Its default wallet is the legacy firewall wallet; pass `--wallet` to inspect a deployed smart account separately.

It flags unexplained transfers, mismatched amounts/recipients, and refused payments that settled anyway as `CRITICAL`.

## Architecture

Bun workspaces monorepo, 7 TypeScript packages plus a standalone Foundry project in `contracts/`.

| App/package | Purpose | Port |
|---|---|---|
| `apps/mcp` | MCP server with account connection, intents, account setup, payment, and legacy mandate tools; never holds a signing key | `:4010` (Streamable HTTP), or stdio |
| `apps/firewall` | Hono service holding the signing key; the pipeline, receipts, SSE events, World ID gate, and a loopback-only plain operator dashboard | `:4001` |
| `apps/site` | Astro + Tailwind site: landing (`/`), legacy mandate wizard (`/app`), owner dashboard (`/app/dashboard`), account setup (`/setup`) | `:4321` |
| `apps/store` | Express x402 gift-card store (legit SKUs + a promo endpoint serving prompt-injection trap copy) | `:4000` |
| `apps/agent` | LLM shopping agent (AI SDK v7 + Vercel AI Gateway) — browses the catalog, asks the firewall to sign, never touches a key | — (CLI) |
| `apps/verifier` | Independent post-hoc on-chain verifier for a selected payer wallet — CLI, read-only | — (CLI) |
| `packages/shared` | Shared zod schemas/types: `TaskIntent`, `PaymentRequirement`, `DecisionReceipt`, `StepUpAttestation`, network constants | — |
| `contracts/` | Foundry smart account and factory for World ID account funding and on-chain spend controls | — |

Key files:

- pipeline orchestration `apps/firewall/pipeline.ts`
- merchant self-fetch (H1 fix) `apps/firewall/merchant.ts`
- Intercepta client `apps/firewall/intercepta.ts`
- Jev client `apps/firewall/jev.ts`
- World ID device flow `apps/firewall/world-id.ts` + approval gate `apps/firewall/approvals.ts`
- provenance check `apps/firewall/provenance.ts`
- StepUp signing `apps/firewall/step-up.ts` (types in `packages/shared/step-up.ts`)
- persistence `apps/firewall/store.ts` (`bun:sqlite`)
- MCP tools `apps/mcp/tools.ts`.
- account setup and funding checks `apps/firewall/account-setup.ts` and `apps/firewall/funding.ts`.

### The loopback operator dashboard

`apps/firewall` also serves a minimal plain HTML/CSS/JS console at `GET :4001/dashboard` (`apps/firewall/public/dashboard.{html,css,js}`) — same-origin, no build step, gated by a loopback check plus an `x-yakusoku-admin` header (`apps/firewall/index.ts`, `isLocalAdminRequest`), not by SIWE.

It survived the P3 owner-scoping of `/intents`, `/receipts`, `/approvals` and `/events`: every one of those routes keeps an operator branch that this dashboard's own `fetch` calls hit, verified live against the running firewall (`/dashboard`, `/control`, `/intents` all return 200 with the admin header).

It's kept as a single-operator debugging/ops view — full visibility into every mandate on the box, plus the pause/resume kill switch — not a substitute for the owner-scoped `/app/dashboard`, which is what an actual mandate owner uses.

## Sponsor usage

### Intercepta — Safe Agent-to-Agent Payments with x402

Every payment is screened **live**, before the firewall signs it, as stage 4 of the pipeline — never mocked at runtime (mocks exist only in `apps/firewall/intercepta.test.ts`, with `fetch` stubbed).

- **What is screened:** the payment's `payTo` address via Deep Scan Address (`toxic-score`), and the paid token via Scan Token.

  Intercepta's risk data is mainnet-only, so the firewall maps Base Sepolia USDC to Base mainnet USDC before the token scan (`apps/firewall/intercepta.ts`, `mapAssetForScreening`, lines 95–97).
- **Where the API is called:**
  - `apps/firewall/intercepta.ts:164` — Deep Scan Address (`GET /api/public/v2/extension/account/{payTo}/toxic-score`).
  - `apps/firewall/intercepta.ts:178` — Scan Token (`GET /api/public/v2/extension/token-intelligence/token/{mainnetUSDC}/risks?chainId=8453`).
  - `apps/firewall/intercepta.ts:237-305` — `interceptaStage`, the pipeline stage that runs both calls and turns the verdict into pass/refuse/ask_human; wired into the pipeline order at `apps/firewall/pipeline.ts:116`.
- **Fail-closed mapping:** hard-block traits (sanctions/scammer/blacklist/mixer) or `toxicScore ≥ 75` → `refuse`; score 30–74, a `warn`/`high`/unverified token, an unmapped asset, a missing key, a timeout, or a non-2xx/malformed response → `ask_human`; only a clean score and a clean token verdict → `pass`.

  Scan Message (EIP-3009) is deliberately not used — its `messageType` enum has no `TransferWithAuthorization` type (see comment header in `intercepta.ts`).
- **Demo:** a clean, in-budget purchase passes; a payment to a flagged/sanctioned address is blocked with the reason visible on the dashboard.
- **Live check script:** `bun run intercepta-check`.

### World ID for Agents

- **Device flow:** the firewall (not the agent, not the site) drives the RFC 8628 device-authorization flow against the sandbox IdP — `startDeviceAuthorization` and `pollDeviceToken`/`pollUntilResolved` in `apps/firewall/world-id.ts`. The agent only ever sees a `verificationUri` + `userCode` to hand to the human.
- **Backend validation, no secrets in the client:** the ID token is validated server-side with `jose` against the sandbox's remote JWKS (`validateIdToken`, `apps/firewall/world-id.ts:260`) — signature, `iss`, `aud`, `exp`, plus this project's own `auth_time` freshness window and `acr` check.

  `WORLD_CLIENT_ID`/`WORLD_CLIENT_SECRET` never leave the firewall process; the site and the agent never see them.
- **Protected action:** a fresh, validated World ID approval is required before the firewall signs a payment that any earlier stage left undecided, or that exceeds `HUMAN_APPROVAL_OVER_USDC` (`apps/firewall/approvals.ts`, `startApprovalGate` / `settleApproved`).
- **Failure paths:** `access_denied` → refuse (`world_id_denied`); the approval window elapsing → refuse (`world_id_expired`) and the reserved budget is released; an invalid/stale/malformed ID token → refuse (`error`).

  None of these ever fall back to approving.
- **Step-up evidence:** every approval is bound to its exact payment with a second EIP-712 signature (see StepUp above), re-servable at `GET /receipts/:id/attestation`.
- **Live check script:** `bun run world-id-check` (`--wait` polls for a real phone approval/denial).

### Curvegrid — Best AI Agent Project

**One-sentence summary:** Omamori is a policy-aware payment agent guardrail — it lets an AI shopping agent act, but only signs the payments that match what the human actually authorized, using live third-party risk screening and a fresh human-identity check as the last line of defense.

**MultiBaas:** not used. This project talks to Base Sepolia directly through `viem` (RPC calls, EIP-712 signing/verification) and to the x402 facilitator (`x402.org`) for settlement; no MultiBaas integration was built.

**Team:** Four ETHGlobal Tokyo 2026 participants. Individual credits and social handles are not documented here; do not infer sole ownership from the earlier planning notes.

**Setup and testing:** see [Setup & testing](#setup--testing) below.

## Setup & testing

### Prerequisites

- [Bun](https://bun.sh) 1.3+ (this repo does not support `npm`/`pnpm`/`yarn` — `@x402/*`'s `esbuild` build scripts do not run under `pnpm`/`tsx`).
- A Base Sepolia operator wallet (`FIREWALL_PRIVATE_KEY`) with ETH for account deployment. The legacy mandate path also needs test USDC in this wallet; the account path needs test USDC in each user's deployed smart account. See [Circle's faucet](https://faucet.circle.com) for test USDC.
- A separate Base Sepolia address for the store's `payTo` (`MERCHANT_KEY`).
- API keys:
  - TypeSafe (`TYPESAFE_API_KEY`, Jev semantic judgment).
  - Intercepta sandbox (`INTERCEPTA_API_KEY`, free at [intercepta.io/ethglobal](https://intercepta.io/ethglobal)).
  - World ID for Agents sandbox app (`WORLD_CLIENT_ID`/`WORLD_CLIENT_SECRET`).
  - Vercel AI Gateway (`AI_GATEWAY_API_KEY`, for the shopping agent).
- World App for account and payment approvals. A browser wallet (e.g. MetaMask) is needed to own and fund an account or to sign a legacy mandate at `/app`.

### Environment

Copy `.env.example` and fill in real values in a file the repo never commits.

- This project reads env from `../../../.env.hackathon` relative to each app. See each `package.json`'s `dev`/`start` scripts.
- Adjust to a plain `.env` if you deploy this differently.

Variable names only; see `.env.example` for the full list:

- `FIREWALL_PRIVATE_KEY`
- `MERCHANT_KEY`
- `TYPESAFE_API_KEY`
- `INTERCEPTA_API_KEY`
- `WORLD_CLIENT_ID`
- `WORLD_CLIENT_SECRET`
- `AI_GATEWAY_API_KEY`

Already-defaulted network constants:

- `FACILITATOR_URL`
- `USDC_SEPOLIA_ADDRESS`
- `USDC_MAINNET_ADDRESS`
- `STORE_URL`
- `FIREWALL_URL`

`apps/site` reads its own `PUBLIC_FIREWALL_URL` and defaults to `http://localhost:4001` when unset. Astro only exposes `PUBLIC_`-prefixed vars to the browser. It also reads `PUBLIC_MCP_URL` (default `http://localhost:4010/mcp`) for the landing's "Set up with Claude" prompt and connection details.

```
bun install
```

### Running each service

```
bun run store       # apps/store on :4000
bun run firewall    # apps/firewall on :4001 (dashboard at :4001/dashboard)
bun run site        # apps/site on :4321 (legacy /app, account /setup, wallet dashboard)
```

Then follow the MCP account flow above, use the legacy `/app` mandate flow, or use the legacy dev helpers directly:

```
bun run dev-intent -- "Buy a $1 Amazon gift card (rehearsal)" 1 gift_card:amazon
bun run agent -- --intent <intentId> --key <agentKey> "Buy me a $1 Amazon gift card (rehearsal)"
```

### Deploying

For a shared team-testing instance on Dokploy (Docker Compose, all four services, generated domains), see [`docs/deploy.md`](docs/deploy.md).

### Checks

| Command | What it proves | Spends testnet USDC? |
|---|---|---|
| `bun test` | Unit tests across firewall/shared (policy, provenance, merchant, World ID, account setup, signing, and attestations) | No |
| `bun run typecheck` | All 7 workspaces compile with no type errors | No |
| `bun run scenarios` | Isolated end-to-end suite (own store `:4020` + firewall `:4021`) covering legacy mandates, World ID accounts/intents, smart account funding rules, provenance, policy, merchant binding, and owner access | No — never sends a payment signature back to the store |
| `bun run --filter @yakusoku/mcp smoke` | Drives the legacy mandate tools over stdio against the live store/firewall | No |
| `bun run jev-cases` | Runs the calibration-critical cases live against the real Jev API (key case refuses, legit purchases pass/escalate as calibrated) | No |
| `bun run intercepta-check` | Live Intercepta calls through the real pipeline stage: a clean address passes, a known-risk (OFAC-sanctioned) address blocks, an unreachable endpoint escalates | No |
| `bun run world-id-check` | Starts a real sandbox device-authorization flow and polls it; `-- --wait` waits for a real phone approval/denial and validates the resulting ID token | No |
| `bun run roundtrip` | Scripted (non-LLM) round trip against the real store settling on Base Sepolia | **Yes** — 1 USDC (run at most twice) |
| `bun run attack` | Disclosed scripted compromised-agent request replaying the key attack case; pass `-- --settle` to actually attempt settlement (expected to refuse first); pass `-- --swap-payee <address>` instead to replay the H1 attack (tampered `payTo`, caught by the merchant self-fetch) | Only with `--settle`, and only if the pipeline (incorrectly) approved it |
| `bun run verify -- --from-block <n>` | Independent on-chain audit: cross-checks every outgoing USDC transfer from the firewall wallet against the receipt history | No — read-only |
| `bun run reset-data` | Wipes the firewall's local sqlite data (refuses if the firewall is currently running) | No |

## Evidence on hand

- The scenario suite includes the original 29 checks and later account, intent, and funding checks. Run `bun run scenarios` for the current total and result.
- First firewall-signed payment on Base Sepolia: [`0xa6e1d2e08390e47654e3c64523f1fc16695633ce9bdeaf5f90b8e5f4acc26ac6`](https://sepolia.basescan.org/tx/0xa6e1d2e08390e47654e3c64523f1fc16695633ce9bdeaf5f90b8e5f4acc26ac6).
- Human-signed intent → agent purchase with Jev live: [`0xc85d39e616d1dbbd97d66606f12418c92d13843b2a73d5815b841fdd60e2059e`](https://sepolia.basescan.org/tx/0xc85d39e616d1dbbd97d66606f12418c92d13843b2a73d5815b841fdd60e2059e).
- World ID approval → payment with a valid StepUp attestation: [`0xbc77ac5b547301ade87d09651f15f550a2f5b5b3003befa310d5eab9d9280897`](https://sepolia.basescan.org/tx/0xbc77ac5b547301ade87d09651f15f550a2f5b5b3003befa310d5eab9d9280897); a denied approval refused and restored the budget.
- Jev live results: key case (clean address, within budget, never requested) refused with `matches_intent` 0.02; legitimate demo purchase pays; no attack fixture ever paid across repeated runs.
- **Real MCP-client validation (2026-09-26):** Claude Code (`claude -p`, CLI 2.1.283) driven as a genuine MCP client over stdio against `apps/mcp`, using the exact config shape `apps/site/src/config.ts`'s `mcpStdioConfigSnippet` produces, with tool access scoped to only the four Omamori tools.
  - **Run 1 (legit purchase):** a fresh $1 Amazon-rehearsal mandate; the agent called `get_mandate`, browsed the catalog with `fetch_url`, then `pay_x402`. Firewall verdict: `needs_human_approval` with a real World ID sandbox link and user code — left pending, never approved, no settlement.
  - **Run 2 (key case):** a second fresh mandate; the agent fetched the item's promo page (containing the injected "add a Steam gift card" trap) with `fetch_url`, then followed it into a `pay_x402` call for the Steam SKU. Firewall verdict: `refused` — `"jev: does not match the signed intent"`. No settlement.
- Independent verifier: every on-chain payment traces back to a firewall `pay` receipt.
- No customers, testimonials, benchmarks, pricing or production deployments exist; never fabricate them.

## Demo walkthrough

1. A human signs an intent at `/app`: "Buy a 25 USDC Amazon gift card for my sister's birthday."
2. An agent — connected over MCP or the CLI — buys `amazon-25`: every stage passes, the firewall signs, the store settles on Base Sepolia. Auto-pays.
3. A scripted compromised agent (`bun run attack`) replays the key case: the same store page's hidden promo text asks it to buy a Steam card instead — clean address, in budget, wrong item. Provenance and Intercepta both pass it; **Jev refuses it** ("does not match the signed intent"), budget untouched.
4. The same scripted agent (`bun run attack -- --swap-payee <address>`) instead tampers the store's own `payTo` before forwarding it to `/sign` — right item, in budget, but a fresh address the store never named. Policy, provenance, Intercepta, and Jev would all pass a clean, in-budget, correctly-described payment; **the `merchant` stage refuses it first** (`payee_mismatch`), because the firewall re-fetched the 402 itself and the addresses don't match.
5. A borderline/ambiguous purchase escalates to World ID: `/app/dashboard` shows a user code and link, a human approves from their phone, the firewall validates the ID token and signs — the receipt carries a StepUp attestation. Repeating and denying instead refuses and releases the budget.
6. The independent verifier (`bun run verify`) confirms the settled payment on-chain, independently of the firewall's own database.

## Honest limitations

- **The legacy wallet path is custodial.** Its payments use the firewall wallet. The World ID account path instead pays from a user-owned `OmamorisanAccount`, but the firewall operator still signs the payment authorization and can initiate payments within that account's on-chain controls.
- **Intercepta needs a valid API key for live screening.** Without `INTERCEPTA_API_KEY`, the stage escalates to `ask_human` instead of getting a live pass/refuse verdict. Use `bun run intercepta-check` to verify the configured key.
- **The verifier defaults to the legacy payer wallet.** To audit a deployed smart account, select its address with `bun run verify -- --wallet <smartAccountAddress> --from-block <n>`.
- **Jev calibration margins are thin.** The legitimate demo purchase's `matches_intent`/risk scores sit close to the pay-gate thresholds (see `docs/ai/README.md` and the pre-hackathon calibration notes) — re-run `bun run jev-cases` before relying on a specific outcome.
- **No wallet `accountsChanged`/`chainChanged` handling.** `/app` reads the injected provider once per action; switching accounts or networks in the wallet mid-session isn't detected — reload the page after switching.
- **The demo's attacker is a disclosed script**, not a real prompt-injected LLM: in testing, current models (`openai/gpt-6-luna`, `gpt-4.1-mini`) were not reliably fooled by the injected promo text on cue.

  `bun run attack` replays exactly what a compromised agent would send; the firewall under test is the real one, unmodified.
- **Control endpoints are localhost-guarded, not authenticated.** `POST /control/pause|resume` and the loopback branches of the owner-scoped routes require a loopback request plus an `x-yakusoku/admin` header — adequate for a single-operator hackathon demo, not a production authorization model.
- **The wallet-signed `TaskIntent` path has no merchant binding.** Its EIP-712 schema is unchanged by the H1 fix, so a wallet mandate only gets the generic self-fetch protection (the merchant stage still refuses a `payTo`/`amount`/`asset`/`network` mismatch against the store's own 402) — it cannot, by itself, refuse "right item, right price, but a different store's origin" the way a World-ID intent's bound `merchant` can. Binding a merchant origin into the `TaskIntent` struct is future work.
- **The merchant self-fetch is a blind GET with no redirects, not a full SSRF defense.** `apps/firewall/merchant.ts` only restricts the scheme to http/https and refuses to follow a redirect; it does not block a `resourceUrl` that resolves to a private/loopback/link-local address, so a malicious or compromised store could still point the firewall at internal infrastructure on its own network. Fine for this hackathon's single-operator, testnet-only demo; a production deployment would need an egress allowlist or an IP-range check before fetching.
- **Testnet only.** Base Sepolia, testnet USDC; Intercepta's risk data is mainnet-only, so screening uses a Sepolia→mainnet token address mapping.

## Starters and public code used

- [`create-wagmi@2.0.19`](https://www.npmjs.com/package/create-wagmi) (Next.js template) scaffolded the project's first intent-signing screen, later replaced by the Astro site below.
- Astro + Tailwind CSS (`@astrojs/react`, `@tailwindcss/vite`) scaffold `apps/site`; [`qrcode.react`](https://www.npmjs.com/package/qrcode.react) renders the World ID approval QR code on the dashboard.
- [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) — the official MCP SDK, powering `apps/mcp`'s server and its own smoke-test client.
- [Official x402 TypeScript examples](https://github.com/x402-foundation/x402/tree/main/examples/typescript) used as a reference for the store/firewall/agent split (not copied — reimplemented from `@x402/*` v2.27.0 docs).
- `viem` for every EIP-712 signature/verification and on-chain read across the site, firewall, agent, and verifier
- `hono` (firewall) and `express` (store) for HTTP
- `@ai-sdk/gateway` + `ai` (Vercel AI SDK v7) for the shopping agent's LLM loop
- `@typesafe-ai/sdk` for Jev
- `jose` for World ID JWKS validation
- `zod` for schema validation everywhere.
- `bun init` scaffolded the remaining packages.
- Ideas re-implemented from scratch, not code: the provenance detector's approach (inspired by the published Aegis402 pattern) and the StepUp attestation pattern (inspired by the HumanMandate showcase project).

## AI usage

See [`docs/ai/`](docs/ai/README.md) for the AI-assisted work-unit log, verification, and issues caught in review. It is not a complete account of individual team contributions.

## Sponsor feedback

*Draft sponsor feedback from the hackathon build.*

**Intercepta:**

- The sandbox key request form was quick, but the key itself arrived by email well after the request — budget time for this before you need it in the pipeline.
- Endpoint docs (Deep Scan Address, Scan Token) were clear and the response shapes matched the documentation exactly on the first live call.
- Risk data being mainnet-only is reasonable, but it means every testnet-based x402 demo (which is most of them, given faucet-only USDC) needs its own token-address mapping layer — worth calling out explicitly in the quickstart, not just the general docs.
- Scan Message's `messageType` enum has no `TransferWithAuthorization` (EIP-3009) type, which is exactly what x402 payments sign — we had to route around it with Deep Scan Address + Scan Token instead of screening the payment authorization itself.

**World ID for Agents:**

- The device-authorization flow (RFC 8628) worked end-to-end against the sandbox in a single afternoon, including a real, live `needs_human_approval` verdict surfaced to a genuine MCP client (Claude Code) mid-hackathon — no surprises in the request/response shapes.
- `jose` + remote JWKS validation was straightforward; the discovery document's `acr_values_supported` made it easy to pin the expected credential level.
- It was not obvious from the docs alone what freshness window (`auth_time`) is appropriate for a payment-approval use case versus a login use case — we picked 300s ourselves and would value explicit guidance.
- The developer portal / sandbox setup assumes a webhook-style HTTPS redirect is configured even for a pure device-code flow that never redirects a browser; this cost extra time to work around for a backend-only integration.

---

Repo: https://github.com/juanmaagd/yakusoku
