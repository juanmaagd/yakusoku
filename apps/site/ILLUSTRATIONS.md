# Illustration provenance

Not served by the site (lives outside `public/`). Source PNGs generated at
`/Users/juanma/Desktop/eth-global/assets/illustrations/`, converted to WebP
(alpha preserved) into `public/illustrations/`. Provenance is also embedded
per-file via `impeccable embed-prompt` (PNG tEXt where supported, a
`<file>.webp.json` sidecar for WebP).

Model for all seven: OpenAI built-in image generation tool (`image_gen`), via
Codex. Style: flat black line art, one accent color per character, no text,
no Japanese motifs.

| File | Accent | Used for | Prompt summary |
|---|---|---|---|
| `user.webp` | sky blue `#62aef0` | The person signing the intent | Calm person looking at their phone |
| `agent.webp` | marigold `#ffb110` | The shopping agent | Friendly small robot carrying a shopping bag |
| `guardian.webp` | blue `#0075de` | The firewall's verdict | Guardian with a clipboard checkmark, standing at a gate |
| `trickster.webp` | coral `#f64932` | Injected promo/prompt-injection copy | Mischievous sticky note / promo flyer with a sneaky face |
| `store.webp` | mocha `#b18164` | The store / payment recipient | Small shop stall with a striped awning |
| `promise.webp` | marigold `#ffb110` | The signed intent (Why rules miss it) | A hand signing a blank card |
| `approval.webp` | blue `#0075de` | World ID human approval | A hand holding a phone with a checkmark / X |

Full verbatim prompts: `/Users/juanma/Desktop/eth-global/assets/illustrations/manifest.json`
(outside the repo, not committed).

## Art set v2 (security world)

Not served by the site (lives outside `public/`). Source PNGs generated at
`/Users/juanma/Desktop/eth-global/assets/art-v2/`, converted to WebP (alpha
preserved) into `public/art/`. Provenance is also embedded per-file via
`impeccable embed-prompt` (a `<file>.webp.json` sidecar for WebP); `impeccable
embed-prompt --scan public/art` reports 0 missing.

Model for all nine: OpenAI image generation via the Codex CLI (`codex exec`,
built-in `image_gen` tool). Style: monochrome 3D renders, matte black obsidian
and dark graphite materials, fine stippled halftone dither grain over a soft
studio render, transparent background, three-quarter isometric view, no text,
no Japanese motifs, color reserved for a single electric blue (`#1f5bff`)
accent where noted.

| File | Used for | Prompt summary |
|---|---|---|
| `key.webp` | Hero: the agent never holds the key | Ornate black key floating inside an open wireframe cube cage, one blue indicator light on the cage |
| `intent.webp` | The promise the user signs | Matte black card slab with a fountain-pen nib resting on it, faint engraved signature line |
| `agent.webp` | The AI shopping agent | Compact rounded robot figure with an antenna, holding a small shopping bag |
| `firewall.webp` | The six-layer firewall | Monolith gate of six stacked slabs with a narrow slot through the middle, one blue check-shaped light |
| `bait.webp` | Prompt-injection bait in store copy | Perforated promo coupon ticket pierced by a black fishing hook |
| `approval.webp` | Fresh human approval (World ID for Agents) | Smartphone slab with a large blue checkmark on screen, a thumb hovering near it |
| `receipt.webp` | On-chain receipts / proof | Curling paper receipt strip emerging from a black block, linked to a heavy chain link |
| `terminal.webp` | The store asking to be paid | Small payment terminal kiosk on a short stand |
| `plug.webp` | Plug in your agent | Black cable plug about to connect into a matching socket block |

Full verbatim prompts: `/Users/juanma/Desktop/eth-global/assets/art-v2/manifest.json`
(outside the repo, not committed).
