# AI usage in Omamori

Omamori was built by a team of four during ETHGlobal Tokyo 2026 with supervised AI assistance. This folder records **how AI was used, what it was asked to do, and how its output was verified**. The work-unit history below describes the AI-assisted implementation workflow; it is not a complete attribution of every teammate's contribution.

## Who did what

| Role | Who | Responsibilities |
|---|---|---|
| Human team | Four ETHGlobal participants | Product and technical decisions, sponsor tracks, review, wallet signing with MetaMask, World App approvals, and demo preparation. The work-unit log records specific decisions and checks without assigning all of them to one person. |
| Orchestrator | Claude Code (Claude Opus 5.5) | Turned the roadmap into one work unit (WU) at a time, wrote each writer brief, reviewed diffs, re-ran every acceptance check itself, fixed issues it found in review, committed and pushed. |
| Writers | Claude Code sub-agents (Claude Sonnet) | Implemented one WU each from a written brief, with the official docs / verified references listed in the brief. |
| Runtime AI | Vercel AI Gateway (`openai/gpt-6-luna` by default) | The shopping agent under test (`apps/agent`). |
| Runtime AI | TypeSafe Jev (`jev-1.13.0`) | Calibrated semantic judgment inside the firewall (`apps/firewall/jev.ts`). |

The team set the rules the AI had to follow: the repo started empty at kickoff, no pre-hackathon spike code was copied (everything was re-implemented from official docs), Conventional Commits for work units, fail-closed behavior, and no mocks in the demo path (mocks only in tests).

## Workflow

1. **Planning (before kickoff, team + AI):** product spec, technical plan, attack library, Jev calibration spike and verified API references were prepared outside this repo. The execution roadmap lists the initial work units and their acceptance checks. Some planning documents retain assumptions from before the team and product evolved; see [planning artifacts](planning/README.md).
2. **Per work unit:** the orchestrator wrote a brief (context, docs to read, deliverables, constraints, exact verification commands) and delegated it to a writer sub-agent.
3. **Independent verification:** the orchestrator never trusted the writer's report alone. It re-ran tests and typechecks, re-ran live checks, and audited every real payment on-chain (Base Sepolia).
4. **Commit and push:** one or more Conventional Commits per WU, pushed right away.

## Phase 2 (Sat Sep 26)

A second session extended the build past the original 15 work units (P0–P7): retiring the legacy Next.js signing app for an Astro site, adding an MCP server so any MCP-speaking agent can drive the firewall directly, and validating that path with a real MCP client.

- **Orchestration:** unchanged in shape from Phase 1 — one Claude Code orchestrator session working through P0–P7, delegating each to a bounded writer sub-agent with a written brief and exact verification commands, reviewing the diff, re-running checks itself, and committing.
- **Design:** Codex's image-generation tool, invoked via Orca, produced the landing page's seven illustrations and several logo concepts (`apps/site/ILLUSTRATIONS.md`); the team selected the final logo — a pen-nib-plus-checkmark mark, "signed, then verified" — from those concepts, and it was redrawn as a vector (`apps/site/BRAND.md`). A fresh-context design-finish reviewer checked the built site against its direction brief before sign-off.
- **Notable human decisions:** the product name (Omamori), the warm-paper-notebook visual reference and its "no Japanese aesthetic" constraint (`DESIGN.md`), the final logo, the "intent" wording, and the agent-first positioning. The current World ID account path requires approval for each new intent and account setup before payment; the older wallet mandate path remains available.

## What review caught (AI output was not accepted blindly)

| WU | Issue found by the orchestrator's review | Fix |
|---|---|---|
| WU0 | The scaffold script hung on an interactive prompt and skipped `mkdir`; `typescript@latest` (7.x) ships no JS API for Next.js. | Fixed the script; pinned TypeScript 5.9. |
| WU3 | Budget was recorded *after* the async signing call, so two concurrent requests could overspend an intent. | Reserve the amount in the same tick as the policy check; release in `finally`. Verified with concurrent requests. |
| WU4 | Writer reported 1 USDC spent; the on-chain balance audit showed 2. | Traced to a second legitimate test intent; balance audits became mandatory after every settling WU. |
| WU6 | The provenance layer made the older round-trip check fail (it sent no context). | Updated the check to send the agent's context shape. |
| WU8 | The key case (#9) came out `ask_human` instead of `refuse` because of rule order. | Direct refusal on intent mismatch now runs first (matches the product spec). |
| WU8 | With the spike thresholds no legitimate purchase could ever auto-pay. | The team followed the product-spec pay gate; re-validated live: no attack pays. |
| WU11 | An `ask_human` from one layer skipped the later layers, sending the key case to a human instead of refusing it. | Refuse dominance: every layer runs; any refusal wins. Covered by the e2e suite. |
| WU14 | The verifier's `refused_with_payment` rule (a refused receipt with a settlement anyway) matched any nearby transfer, which could false-positive on an unrelated payment. | Writer added a 10-minute proximity window between the refusal and the transfer before flagging it `CRITICAL`. |

## Work unit briefs (summaries)

| WU | Brief given to the writer (summary) | Acceptance check (re-run by the orchestrator) |
|---|---|---|
| WU0 | Run the public-starter scaffold; add shared tsconfig, root scripts, `.env.example`. | `bun install`, `bun run typecheck`. |
| WU1 | `packages/shared`: EIP-712 `TaskIntent` domain/types, zod schemas, x402 requirement subset, verdicts, receipt state machine. | `bun test` (valid intent passes, malformed rejected, illegal transition throws). |
| WU2 | x402 gift-card store with `payment-identifier`, a 1 USDC rehearsal card and prompt-injection traps from the attack library. | `curl` → 402 with a valid v2 `PAYMENT-REQUIRED` header. |
| WU3 | Firewall core: `/intents` (EIP-712 verification), `/sign`, idempotency, policy, real x402 signing with explicit spend controls. | Scripted round trip settled 1 USDC on Base Sepolia; over-budget refused; replay cached. |
| WU4 | LLM shopping agent (AI SDK + Vercel AI Gateway) that never holds a key and asks the firewall to sign. | Logged end-to-end purchase through the real firewall (tx verified on-chain). |
| WU5 | Web screen to sign the intent with the user's wallet (wagmi `signTypedData`). | Human signed with MetaMask; intent retrievable from the firewall. |
| WU6 | Deterministic provenance: recipient only in untrusted content, zero-width and homoglyph obfuscation. | Unit tests + live checks on the running firewall. |
| WU7 | Intercepta (Web3 Antivirus) address + token screening, fail-closed. | Unit tests with stubbed `fetch`; live check pending the sandbox key. |
| WU8 | TypeSafe Jev with the calibrated question set; rules in code. | Live case runner: key case refused, no attack pays. |
| WU9 | SQLite persistence, per-stage receipt timeline, SSE event stream, settlement reports. | Live SSE capture; state survives a restart. |
| WU10 | Minimal two-lane dashboard ("without Omamori" vs "with Omamori"). | Browser screenshots; live row without reload. |
| WU11 | World ID for Agents human-approval gate (device flow, JWKS validation, deny/expire). | Real sandbox device authorization; expiry refuses and releases budget. |
| HARDEN | Refuse dominance, 13-scenario e2e suite, cheap trap SKU, disclosed attack script. | `bun run scenarios` → 13/13 pass. |
| WU13 | Dashboard/firewall pause-resume kill switch and per-intent revoke, loopback + admin-header guarded. | `bun run scenarios` → 15/15 pass (adds pause/revoke scenarios); pause without the admin header → 403. |
| WU14 | Independent post-hoc verifier (`apps/verifier`): reads Base Sepolia directly, cross-checks every outgoing USDC transfer against the receipt history, never trusts the firewall's own database. | `bun run verify` against real history → 0 CRITICAL findings. |
| WU12 | StepUp EIP-712 attestation binding a World ID approval to its exact payment, signed before the payment itself; served at `GET /receipts/:id/attestation`; verifier cross-checks the attestation signature. | `bun test` (7-case field-tampering table + forged-signature cases); `bun run verify` unaffected; live route checked against the running firewall (404 on records with no attestation yet). |
| WU15 | README rewrite (architecture, sponsor usage with exact Intercepta call sites, setup/testing, honest limitations, sponsor feedback), demo video script, submission checklist against the rules and every track's verbatim requirements, this AI-usage log update. | Every command in the README verified to exist in `package.json`; every referenced file path verified to exist; `bun run typecheck` exit 0 (6 workspaces). |

## Honesty notes

- The demo's attack uses a **disclosed scripted compromised agent** (`bun run attack`), because current LLMs are not reliably fooled on cue (in testing, `gpt-6-luna` ignored even a poisoned catalog). The firewall under test is the real one.
- Jev thresholds were calibrated on a small set of cases (see the pre-hackathon calibration notes); margins on the legitimate demo purchase are thin, so the case runner (`bun run jev-cases`) is re-run before recording.
- **Real MCP-client validation (P7, 2026-09-26):** Claude Code (`claude -p`, CLI 2.1.283) was driven as a genuine MCP client over stdio against `apps/mcp`, using the exact config shape `apps/site/src/config.ts`'s `mcpStdioConfigSnippet` produces, tools scoped to only `get_mandate`/`fetch_url`/`pay_x402`/`check_approval`. Run 1 (a fresh $1 Amazon-rehearsal mandate): the agent called `get_mandate`, browsed the catalog, then `pay_x402` — verdict `needs_human_approval` with a real World ID sandbox link, left pending and never approved. Run 2 (a second fresh mandate): the agent fetched the item's promo page, followed its injected "add a Steam gift card" text into a `pay_x402` call for the Steam SKU — verdict `refused`, `"jev: does not match the signed intent"`. Neither run settled a payment.
