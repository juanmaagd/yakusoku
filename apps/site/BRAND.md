# Omamorisan brand mark

Not served by the site — internal reference for anyone touching `public/brand/**`.

## What it means

A fountain-pen nib with a checkmark emerging from its tip: **signed, then verified.** The nib
stands for the user's EIP-712 intent signature; the checkmark stands for the firewall's
verification of an agent's payment against that signature before it releases funds. No Japanese
motifs (see `PRODUCT.md` → Brand Commitments, `DESIGN.md` header) — the mark is a plain,
geometric pen-nib pictogram.

## Files (`apps/site/public/brand/`)

| File | Use |
|---|---|
| `mark.svg` | Nib + check, ink black only. Standalone icon use (e.g. loading states, avatars). |
| `mark-blue.svg` | Same nib, checkmark in `#0075de`. Use where a single accent color reads better than all-black. |
| `favicon.svg` | Simplified mark (no slit, no shoulder groove) for legibility at 16–32 px. Ink on transparent. |
| `favicon-32.png`, `icon-512.png` | Raster fallbacks of the favicon/mark for browsers and PWA manifests that need a PNG. |
| `apple-touch-icon.png` | 180×180, mark padded ~20% on the canvas color (`#f6f5f4`), per Apple's icon convention. |
| `logo.svg` | Horizontal lockup — mark left, "omamorisan" wordmark right. Used in `Nav.astro`. |
| `logo-stacked.svg` | Mark above the wordmark, centered. Use for square/vertical placements (README, share cards). |
| `og.png` | 1200×630 Open Graph / Twitter card image: canvas background, stacked logo, tagline. |

## Geometry

The mark is authored directly as hand-placed SVG paths in a 100×100 viewBox — it is **not** a
traced raster. It has three layers:

1. **Nib silhouette** — a single `fill-rule="evenodd"` path: the outer nib outline, a circular
   breather hole, a thin vertical slit, and a shoulder groove line, all as literal cut-out
   counters (so the mark stays correct on any background, not just the canvas color).
2. **Checkmark** — a separate stroked path (`stroke-linecap`/`linejoin: round`), vertex touching
   the nib's tip, short leg down-left / long leg up-right.
3. The wordmark in `logo.svg` / `logo-stacked.svg` is **Inter SemiBold (600) converted to outlined
   paths** (extracted from the project's `@fontsource-variable/inter` package with `fontTools`,
   instanced at weight 600, then each glyph's outline exported as an SVG path and hand-tracked at
   18 font units). The SVG needs no font at render time.

## Clear space & minimum size

- Keep clear space around the mark equal to at least the width of the nib's shoulder (roughly
  30% of the mark's own height) on every side.
- Don't render `mark.svg` (the detailed version, with slit/hole/groove) below ~40 px — use
  `favicon.svg` instead, which is deliberately simplified for small sizes.
- Don't stretch non-uniformly; always scale `width`/`height` (or just `height`) together.

## Colors

- Ink `#000000` — default color for the nib and, in `mark.svg`, the checkmark too.
- Primary blue `#0075de` — the only accent, used solely for the checkmark in `mark-blue.svg`. Never
  recolor the nib itself.
- Canvas `#f6f5f4` — background for padded square icons (`apple-touch-icon.png`, `icon-512.png`,
  `og.png`). No gradients, no drop shadows, anywhere.

## Provenance

Vector redrawn by hand (hand-placed path coordinates, no auto-trace) from Codex `image_gen`
concept 07 ("pen + check"). The reference raster (`assets/logo-concepts/concept-07-pen-check.png`,
outside this repo) was used only as a compositional reference and is not shipped.
