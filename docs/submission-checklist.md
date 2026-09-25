# Submission checklist

Status against `docs/02-reglas.md` (hackathon rules) and `docs/03-entrega-y-evaluacion.md` (submission/evaluation), and the verbatim qualification requirements in `docs/tracks/{intercepta,world,curvegrid}.md`. Legend: ✅ done, with evidence · ⏳ pending (human action still needed) · ❌ gap (not met, needs a decision).

## Hackathon rules (`docs/02-reglas.md`)

| Rule | Status | Evidence |
|---|:---:|---|
| Solo participation allowed | ✅ | Solo builder, applies individually on the platform — not a repo artifact. |
| From Scratch: repo starts empty at kickoff; public starters/libraries allowed and listed | ✅ | 22 commits from `fd2f5eb` (21:06 JST) onward; `README.md` "Starters and public code used" lists `create-wagmi@2.0.19`, official x402 examples, `bun init`. No pre-hackathon spike code copied (verified: spike lived under `/private/tmp/...`, never referenced from the repo). |
| Prior work declared in writing at submission | ⏳ | Not yet filled in the Hacker Dashboard submission form — this repo has no prior-work to declare (built entirely during the event), but the form field itself is still pending. |
| Git used throughout, frequent commits (not one giant commit) | ✅ | `git log --oneline` shows 22 commits, one or more per work unit, Conventional Commits style. |
| AI usage documented (where/how used, which files) | ✅ | `docs/ai/README.md` — roles, workflow, per-WU briefs, and a table of issues the human/orchestrator review caught in AI output. |
| AI assists but does not build the project alone | ✅ | `docs/ai/README.md` "Who did what" — every product/architecture decision (Jev calibration policy, agent model, demo scope, pipeline reordering) attributed to the human; independent verification step documented for every WU. |
| Spec-driven flow artifacts (specs/prompts/planning) live in the repo | ❌ | **Gap.** The execution roadmap and product/technical planning docs that `docs/ai/README.md` references ("The execution roadmap lists 16 work units...") live outside this repo, under the parent hackathon-prep folder — they were never copied into `docs/ai/` or elsewhere in `yakusoku/`. `docs/ai/README.md` narrates the process but does not include the actual roadmap/prompt artifacts. Recommend copying the roadmap (or a snapshot of it) into the repo before submission if this rule is read strictly. |

## Submission & demo video (`docs/03-entrega-y-evaluacion.md`)

| Requirement | Status | Evidence |
|---|:---:|---|
| Hacker Dashboard submission (title, description, repo link, prior-work declaration, AI usage doc, up to 3 sponsor prizes, video) | ⏳ | Not yet submitted. Repo link ready: https://github.com/juanmaagd/yakusoku. Three sponsor prizes selected: Intercepta, World ID for Agents, Curvegrid Best AI Agent Project (within the "up to 3" limit). |
| Demo video: 2–4 minutes | ⏳ | Not yet recorded. Script drafted at `docs/demo-script.md`, targeted 3:00–3:30. |
| Demo video: minimum 720p | ⏳ | Not yet recorded. |
| No sped-up video, no background music replacing narration, no phone recording, no AI-generated voice | ⏳ | Not yet recorded; script calls for a single take in the builder's own voice. |
| Slides (if any) ≤ 4 bullets each; intro < 20s | ⏳ | `docs/demo-script.md` Beat 1 keeps the intro under 20s and specifies a 4-bullet cap if a slide is used. |

## Intercepta — "Safe Agent-to-Agent Payments with x402" ($2,000)

| Requirement (verbatim, paraphrased for the table) | Status | Evidence |
|---|:---:|---|
| A working agent payment flow, x402 preferred, testnet OK | ✅ | `apps/agent` → `apps/firewall` → `apps/store`, settling on Base Sepolia. Verified live tx: `0xc85d39e616d1dbbd97d66606f12418c92d13843b2a73d5815b841fdd60e2059e`. |
| At least one live Intercepta API call runs before signing/accepting and its result decides the outcome — mocks don't qualify | ⏳ | Code path is live and wired into the pipeline (`apps/firewall/intercepta.ts`, no runtime mocks — only `intercepta.test.ts` stubs `fetch`), but `INTERCEPTA_API_KEY` has not arrived yet, so `bun run intercepta-check` has not been run against the real API. Fail-closed behavior with the key absent has been verified live (`ask_human`, reason "Intercepta not configured"). **Blocking:** get the sandbox key and re-run `bun run intercepta-check`. |
| Mainnet addresses screened even on a testnet payment; known-risk test addresses used | ❌ | Sepolia→mainnet USDC token mapping is implemented and unit-tested (`mapAssetForScreening`). The sponsor's Discord-pinned known-risk test addresses were never obtained (not published in time); a public OFAC-sanctioned address (Roman Semenov) is used as a substitute in `intercepta-check.ts`, flagged in-code to re-verify the listing on demo day. Recommend swapping in the real pinned addresses if they become available before recording. |
| Demo shows one payment that goes through and one blocked/held, reason visible | ✅ | The pipeline demonstrably blocks the key attack case (via Jev) and auto-pays the legit purchase, both with the reason on the dashboard. An Intercepta-specific block (vs. a Jev block) has not yet been demonstrated live pending the API key. |
| Public repo; README points to the files where the API is called; 3–5 lines of feedback | ✅ | This README, "Sponsor usage → Intercepta" section: exact file/line references and a feedback paragraph. |

## World — "Best Use of World ID for Agents" ($7,500)

| Requirement (verbatim, paraphrased) | Status | Evidence |
|---|:---:|---|
| Integrate the official World ID for Agents dev/sandbox environment | ✅ | `apps/firewall/world-id.ts` — RFC 8628 device flow against `sandbox.auth.world.org`. |
| Demonstrate the complete journey: request → user completion → validated result → protected action | ⏳ | Fully implemented and covered by the automated `bun run scenarios` suite against the real sandbox. The device flow itself (`user_code`/`verification_uri`) was verified live during pre-hackathon planning with a real World App approval. A live World App approval *within this build* (protected action = signing a real payment) is pending — human was asleep when this WU ran. |
| Demonstrate a denied/expired/cancelled path where the action does not occur | ✅ (expiry) / ⏳ (deny) | Expiry verified live during WU11: an isolated firewall instance's approval window elapsed, verdict `refuse` (`world_id_expired`), budget restored. A real "deny" tap from the World App has not been exercised live yet in this build, though the code path (`settleRefused` with status `denied`) is unit-tested. |
| Validate identity results server-side; no client secrets exposed | ✅ | `validateIdToken` (`apps/firewall/world-id.ts:260`) runs entirely in the firewall process using `jose` + remote JWKS. `WORLD_CLIENT_ID`/`WORLD_CLIENT_SECRET` are read only by the firewall; `apps/web` and `apps/agent` never receive them. |
| Integration debrief/feedback | ✅ | README "Sponsor feedback → World ID for Agents". |

## Curvegrid — "Best AI Agent Project" ($1,000)

| Requirement (verbatim, paraphrased) | Status | Evidence |
|---|:---:|---|
| Public GitHub repo with project artifacts (contracts/tests/docs) and a solid README | ✅ (no custom contracts) | No Solidity contracts were written (deliberately out of scope — the firewall signs standard x402/USDC payments, no custom on-chain logic); tests (`bun test`, 108 passing) and documentation are present. |
| README: one-sentence summary | ✅ | README top line. |
| README: how MultiBaas was used (optional) | ✅ | README states plainly: not used, and why. |
| README: team intro + social handles | ⏳ | Team intro present; social handles are `TODO(human)` placeholders — unknown to this writer, must be filled by the builder. |
| README: clear setup and testing instructions | ✅ | README "Setup & testing". |
| README: MultiBaas experience/feedback (if used) | N/A | Not used, so not applicable. |

## Summary

- ✅ Done: 15
- ⏳ Pending (human action, mostly "arrives tomorrow" items already known to the team): 8
- ❌ Gap (needs a decision, not just a live check): 2 — (1) spec-driven planning artifacts not copied into the repo, (2) Discord-pinned Intercepta known-risk test addresses never obtained (public OFAC address used as a substitute).

No item marks a track's core qualification requirement as unmet by design — every ❌/⏳ is either an external dependency (a key that hasn't arrived, a phone approval that needs a human awake) or a documentation-completeness gap, not a missing feature.
