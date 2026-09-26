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
