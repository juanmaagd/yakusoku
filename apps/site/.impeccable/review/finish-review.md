# Landing finish review (round 1) — input for the P4b refinement pass

Reviewer: impeccable-finish-reviewer (fresh context), Sat Sep 26 ~11:00 JST, over the production preview.
Disposition: **fix** (no truth/claim issues found).

## Material fixes
1. **First viewport misses the thesis.** At 1440×900 only the top ~120px of the three stage cards is visible; the checklist and the verdict are below the fold, so the first screen reads as a conventional hero. Tighten `Hero.astro` vertical rhythm (`pt-14 md:pt-20`, `mt-6`, `mt-8`) and/or `Stage.astro`'s `mt-10` lead-in and card `p-6` so at least the verdict banner shows within the first viewport.
2. **"Paid to" row wraps** in the agent-request card (`Stage.astro` ~lines 108–114): the label separates from its icon + value when the value is long. Stack label above value, like "Justified by".
3. (Minor) The "↗" glyph stands in for an external-link icon in `Proof.astro`, `HumanApproval.astro`, `app.astro`; replace with a drawn SVG icon.

## Ceiling notes (not blocking)
- DESIGN.md devices not used yet: the springy character-mark motion, and the large centered product-UI mockup with its single drop shadow (natural once `/app` and the dashboard exist — use a real screenshot of the product).

## Keep
- The "Proof, not claims" section with the exact verified numbers (19/19, 0.02, 0 unexplained) and real tx hashes.
- The attack / legit replay toggle as the literal demonstration of the thesis — the first-viewport fix must not push it lower or shrink it into decoration.

## Still owed at the end of P4b
- Re-capture desktop + mobile, a verdict pass on these fixes, then the documenter pass (DESIGN.md from the built world) — "unreviewed and undocumented is unfinished".
