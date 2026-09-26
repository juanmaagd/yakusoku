---
version: 1
slug: "apps-site-src-pages-app-astro"
primary_target: "apps/site/src/pages/app.astro"
related_targets: ["apps/site/src/pages/app/dashboard.astro"]
---

# App (`apps/site`, routes `/app` and `/app/dashboard`)

Mode: Operate. Audience: the person delegating purchases to an AI agent, and ETHGlobal judges walking the demo on a laptop; the phone appears only for the World App approval. Jobs: sign in with the wallet, sign a promise, hand the agent its key, watch decisions live and step in, pause or revoke. Full spec (screens, copy, states, components, assets): `odd/tasks/app-redesign.md` in the parent folder of the repo. User-facing noun is "promise" (mandate/intent only in technical details and snippets).

## Direction contract

THESIS: The promise is a document you can see: you write it, see exactly what you sign, hand the agent a key bound to it, and read every payment against it. Refuses stacked bordered cards and raw internal jargon.

OWN-WORLD: The landing's world at Operate density: white canvas, hairline frame, Mona Sans headings mixed 400/600, Martian Mono data, black primary buttons, 6px radius, color only as state, 1-bit stipple art only in gate, empty states, handoff and approval.

STORY: Connect and sign in on one checklist, write a promise beside its live EIP-712 preview, store the one-time agent key, then watch two lanes: what the agent tried and what Omamorisan did, in plain language.

FIRST VIEWPORT: 64px shell bar with Promises and Live tabs, Pause all and wallet chip; content in the framed column; Live shows the two-lane feed with a detail drawer.

FORM: Established world, surface extension; spec approved by the user.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
