# Planning artifacts

ETHGlobal rule: when a spec-driven flow is used, all specs, prompts and planning artifacts must live in the repo. These are the specs the AI writers were pointed to (see `../README.md` for the per-work-unit briefs).

These are dated planning records, not a description of the final team or current product. Early drafts assume one developer and a Next.js signing app; the project was built by a team of four, and the current site is Astro with both World ID account promises and legacy wallet mandates. See the root [`README.md`](../../../README.md) and [`apps/mcp/README.md`](../../../apps/mcp/README.md) for current behavior.

- **Written before kickoff** (planning only, mostly in Spanish): product spec, technical plan, attack library, Jev design, decisions log, Intercepta and World ID implementation guides, and the verified API references (`ref-*.md`). Code blocks in them are API notes and design sketches taken from official documentation — the application code in `apps/` and `packages/` was written after kickoff.
- **Living document:** `roadmap.md` is a snapshot of the execution roadmap (work units, acceptance checks and the progress log with evidence), updated during the hackathon.
- **Not included:** the reports of the pre-kickoff throwaway spikes (x402 signing and Jev calibration), because they document code written before the hackathon started. Their conclusions (verified API facts, calibrated Jev questions and thresholds) are summarized in these specs.

| File | What it is |
|---|---|
| `roadmap.md` | Execution roadmap: work units, acceptance checks, progress log with commits and on-chain evidence |
| `20-producto.md` | Product spec and demo script |
| `13-decisiones.md` | Decisions log (modality, idea, name, sponsor tracks) |
| `plan-tecnico.md` | Technical plan: API, data shapes, fail-closed rules |
| `casos-de-ataque.md` | Attack library used for store traps and test scenarios |
| `jev-diseno.md` | Design of the Jev (TypeSafe) intent-matching layer |
| `intercepta-implementacion.md` | Intercepta (Web3 Antivirus) integration guide |
| `world-id-implementacion.md` | World ID for Agents integration guide (device flow, StepUp) |
| `ref-*.md` | Verified API references (x402, AI SDK + Gateway, wagmi/viem, TypeSafe + Hono, World ID + Intercepta) |
