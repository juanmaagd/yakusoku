# Illustration provenance

The first set (flat line art for the Notion-style world, `public/illustrations/`) was
removed with that world on Sat Sep 26; its sources stay in
`/Users/juanma/Desktop/eth-global/assets/illustrations/` (outside the repo).

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

Post-processing (all nine): each source PNG is resized to 512px and converted to a
1-bit Floyd-Steinberg stipple (ink coverage = darkness x alpha, dots in `#0b0d12` on
transparency; saturated blue accent pixels kept as `#1f5bff`), upscaled 2x
nearest-neighbour and encoded as lossless WebP. Script:
`/Users/juanma/Desktop/eth-global/assets/art-v2/dither.py` (outside the repo). Each
sidecar records it under `postProcess`.

## App set

Three more images added to the same set, same shared style prefix, same source
directory (`/Users/juanma/Desktop/eth-global/assets/art-v2/`) and model (OpenAI
image generation via the Codex CLI, built-in `image_gen` tool).

| File | Used for | Prompt summary |
|---|---|---|
| `wallet.webp` | Sign-in gate | Compact black hardware wallet / folded billfold lying at an angle, one blue indicator light |
| `pass.webp` | The agent's scoped credential | Black access pass badge card on a lanyard clip, blank face with an embossed chip (not a key) |
| `pause.webp` | Kill switch: all agents paused | Heavy industrial breaker lever switch on a small block, lever down/off |

`public/art/app/` holds small-display variants (96-180px usage) for six images —
the three above plus `intent`, `agent`, and `approval` — dithered at a working
size of 256px (vs. 512px for the landing set) and upscaled 4x nearest-neighbour,
so the stipple stays legible at small sizes instead of smoothing into grey mush.
Each has its own `<file>.webp.json` sidecar under `public/art/app/`.
