# AI usage in Yakusoku

Yakusoku was built during ETHGlobal Tokyo 2026 by a solo builder with heavy, supervised AI assistance. This folder records **how AI was used, what it was asked to do, and how its output was verified**, so judges can see which parts are human decisions and which parts were AI-generated.

## Who did what

| Role | Who | Responsibilities |
|---|---|---|
| Product owner | Human (solo participant) | Idea, product spec, sponsor tracks, every product decision (e.g. Jev calibration policy, agent model, demo scope), wallet signing with MetaMask, World App approvals, demo recording. |
| Orchestrator | Claude Code (Claude Opus 5.5) | Turned the roadmap into one work unit (WU) at a time, wrote each writer brief, reviewed diffs, re-ran every acceptance check itself, fixed issues it found in review, committed and pushed. |
| Writers | Claude Code sub-agents (Claude Sonnet) | Implemented one WU each from a written brief, with the official docs / verified references listed in the brief. |
| Runtime AI | Vercel AI Gateway (`openai/gpt-6-luna` by default) | The shopping agent under test (`apps/agent`). |
| Runtime AI | TypeSafe Jev (`jev-1.13.0`) | Calibrated semantic judgment inside the firewall (`apps/firewall/jev.ts`). |

The human set the rules the AI had to follow: the repo started empty at kickoff, no pre-hackathon spike code was copied (everything was re-implemented from official docs), one Conventional Commit per work unit, fail-closed everywhere, and no mocks in the demo path (mocks only in unit tests).

## Workflow

1. **Planning (before kickoff, human + AI):** product spec, technical plan, attack library, Jev calibration spike and verified API references were prepared outside this repo. The execution roadmap lists 16 work units, each with an acceptance check.
2. **Per work unit:** the orchestrator wrote a brief (context, docs to read, deliverables, constraints, exact verification commands) and delegated it to a writer sub-agent.
3. **Independent verification:** the orchestrator never trusted the writer's report alone. It re-ran tests and typechecks, re-ran live checks, and audited every real payment on-chain (Base Sepolia).
4. **Commit and push:** one or more Conventional Commits per WU, pushed right away.

## What review caught (AI output was not accepted blindly)

| WU | Issue found by the orchestrator's review | Fix |
|---|---|---|
| WU0 | The scaffold script hung on an interactive prompt and skipped `mkdir`; `typescript@latest` (7.x) ships no JS API for Next.js. | Fixed the script; pinned TypeScript 5.9. |
| WU3 | Budget was recorded *after* the async signing call, so two concurrent requests could overspend an intent. | Reserve the amount in the same tick as the policy check; release in `finally`. Verified with concurrent requests. |
| WU4 | Writer reported 1 USDC spent; the on-chain balance audit showed 2. | Traced to a second legitimate test intent; balance audits became mandatory after every settling WU. |
| WU6 | The provenance layer made the older round-trip check fail (it sent no context). | Updated the check to send the agent's context shape. |
| WU8 | The key case (#9) came out `ask_human` instead of `refuse` because of rule order. | Direct refusal on intent mismatch now runs first (matches the product spec). |
| WU8 | With the spike thresholds no legitimate purchase could ever auto-pay. | Human chose to follow the product-spec pay gate; re-validated live: no attack pays. |
| WU11 | An `ask_human` from one layer skipped the later layers, sending the key case to a human instead of refusing it. | Refuse dominance: every layer runs; any refusal wins. Covered by the e2e suite. |

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
| WU10 | Minimal two-lane dashboard ("without Yakusoku" vs "with Yakusoku"). | Browser screenshots; live row without reload. |
| WU11 | World ID for Agents human-approval gate (device flow, JWKS validation, deny/expire). | Real sandbox device authorization; expiry refuses and releases budget. |
| HARDEN | Refuse dominance, 13-scenario e2e suite, cheap trap SKU, disclosed attack script. | `bun run scenarios` → 13/13 pass. |

## Honesty notes

- The demo's attack uses a **disclosed scripted compromised agent** (`bun run attack`), because current LLMs are not reliably fooled on cue (in testing, `gpt-6-luna` ignored even a poisoned catalog). The firewall under test is the real one.
- Jev thresholds were calibrated on a small set of cases (see the pre-hackathon calibration notes); margins on the legitimate demo purchase are thin, so the case runner (`bun run jev-cases`) is re-run before recording.
