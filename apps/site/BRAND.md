# Omamori brand mark

Not served by the site — internal reference for anyone touching `public/brand/**`.

## What it means

A solid circle split by one centered vertical slot: a gate that only lets the right payment
through. It is also the "o" of omamori. No pen, no checkmark, no Japanese motifs (see
`PRODUCT.md` → Brand Commitments, `DESIGN.md` header) — just the gate.

## Files (`apps/site/public/brand/`)

| File | Use |
|---|---|
| `mark.svg` | The gate, ink black only. Standalone icon use (e.g. loading states, avatars). |
| `favicon.svg` | Same mark with a wider slot for legibility at 16–32 px. Ink on transparent. |
| `favicon-32.png`, `icon-512.png` | Raster fallbacks of the favicon/mark for browsers and PWA manifests that need a PNG. Transparent background. |
| `apple-touch-icon.png` | 180×180, mark padded ~20% on white (`#ffffff`), per Apple's icon convention. |
| `logo.svg` | Horizontal lockup — mark left, "omamori" wordmark right. Used in `Nav.astro` and `AppShell.tsx`. |
| `logo-stacked.svg` | Mark above the wordmark, centered. Use for square/vertical placements (README, share cards). |
| `og.png` | 1200×630 Open Graph / Twitter card image: white canvas, hairline frame, lockup + tagline. |

## Geometry

The mark is a circle, `viewBox="0 0 100 100"`, centered at `(50,50)` with `r=50`, split by two
arc paths that leave a centered vertical slot between them:

```
<path d="M45 .251A50 50 0 0 0 45 99.749Z"/>
<path d="M55 .251A50 50 0 0 1 55 99.749Z"/>
```

The slot is 10% of the diameter (10 units wide, `x` 45→55 in the 100-unit viewBox), centered on
the circle. Each path is a 50-radius arc from one chord endpoint to the other (large-arc-flag 0,
opposite sweep flags for the left/right halves), closed with a straight line along the chord —
that straight edge is what creates the slot.

`favicon.svg` widens the slot to 12% of the diameter (`x` 44→56) so it stays legible at 16–32 px.
The arc endpoints are recomputed for the new chord distance from center (`d=6` instead of `5`):
`y = 50 ± sqrt(2500 − 36)` ≈ `0.361` / `99.639`. Same two-path structure, same fill, no groove or
extra ornament — it stays a clean two-path SVG at every size.

The wordmark in `logo.svg` / `logo-stacked.svg` is **Mona Sans weight 600, outlined to paths**
(extracted from the project's `@fontsource-variable/mona-sans` package with `fontTools`: the
variable font instanced at `wght=600`/`wdth=100`, each glyph's outline exported with
`fontTools.pens.svgPathPen.SVGPathPen`, and the seven glyphs of "omamori" assembled using the
font's own advance widths with `-0.02em` letter-spacing applied between characters — no kerning
pairs apply to this word at this weight). The SVG needs no font at render time. Mark height is
cap height × 1.25, vertically centered on the cap-height band; the gap between mark and wordmark
is ≈ 0.3 × the mark's height. The same mark-height and gap rule is reused for the stacked lockup,
with the mark horizontally centered over the wordmark instead.

## Clear space & minimum size

- Keep clear space around the mark equal to at least the slot width × 2 (i.e. ≥20% of the mark's
  diameter) on every side — enough that the slot itself always reads as intentional negative
  space, not crowding.
- Don't render `mark.svg` below ~40 px — use `favicon.svg` instead, which is deliberately widened
  for small sizes.
- Don't stretch non-uniformly; always scale `width`/`height` (or just `height`) together.

## Colors

- Ink `#0b0d12` — the only color the mark or wordmark ever uses.
- Never recolor the mark into a state color (verified/refuse/ask, etc.) or brand blue — it stays
  ink-only in every context.
- Canvas `#ffffff` — background for `og.png` and `apple-touch-icon.png`. No gradients, no drop
  shadows, anywhere.

## Provenance

Concept generated with Codex `image_gen` as `assets/logo-v2/01-slot.png` (outside this repo); the
shipped vector geometry was authored by hand from measurements on that concept, not auto-traced.
The wordmark is Mona Sans 600, outlined to paths with `fontTools` as described above.

The wordmark was renamed to "omamori" (2026-09-27) by dropping the last three glyphs of the
original outline and trimming the viewBox; spacing and geometry are unchanged. `og.png` was
re-rendered with the same layout: `logo.svg` at 96 px tall at (80, 226), tagline in Mona Sans 600
at 35.3 px, 1 px `#e8e8e8` hairline frame.
