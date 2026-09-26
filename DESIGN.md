# Design reference — warm paper notebook

> **Rule (builder, Sat Sep 26):** the product is named Omamorisan, but the design must NOT use any Japanese aesthetic (no kanji, torii, washi, seals, cherry blossoms or vermilion-as-Japan). Follow this reference only.
>
> Supplied by the builder as the binding visual direction for the site (`apps/site`). It describes a style analyzed from a public product marketing site ("warm paper notebook under afternoon sun"). We use the **style only**: no third-party names, logos, illustrations or proprietary fonts ship in this project. Implementation substitutes: **Inter** for the sans (proprietary original), **Source Serif 4** for the editorial serif (proprietary original). Token names in code are product-neutral (see the mapping at the end).

**Theme:** light

Source measurements are normalized; roles and recommendations are interpreted. Font summary lists are independent, not paired by position. HTML examples are reconstructions, not source components.

The style reads like a well-loved paper notebook under afternoon light: a warm off-white canvas (#f6f5f4) that feels tactile rather than clinical, generous sans typography that gives editorial weight to product copy, and color used as sparse punctuation — peachy pills highlight verbs, a single blue anchors the primary action, and a rotating cast of accent hues (coral, amber, sky, midnight) paints the feature card backgrounds like sticky notes. Cards sit on the canvas with 1px hairline borders and 12px corners — no shadows, no chrome — like ruled sections in a notebook. Motion is playful and springy, with 200ms ease transitions and bouncy character-mark animations that make the interface feel alive without ever being decorative.

## Tokens — Colors

| Name | Value | Role |
|------|-------|------|
| Primary Blue | `#0075de` | Primary CTA fill, active nav accent, filled action buttons — the single chromatic commitment in a near-monochrome system |
| Paper Warmth | `#f6f5f4` | Page canvas, hero background, section backgrounds |
| Pure White | `#ffffff` | Card surfaces, elevated panels, contrast text on dark cards |
| Ink Black | `#000000` | Primary text, nav links, headings — at varying alpha (100%, 95%, 90%, 60%, 40%, 20%) to build hierarchy |
| Charcoal | `#111111` | Dark text variant where pure black feels too harsh |
| Stone | `#757575` | Secondary nav text, muted helper text, deactivated labels |
| Graphite | `#615d59` | Body text with warm cast |
| Slate | `#696969` | Card body text, secondary content within cards |
| Sky Tint | `#e6f3fe` | Ghost CTA background, soft blue wash, tinted hover states |
| Marigold | `#ffb110` | Hero pill highlights, feature card background, warm accent for callouts |
| Coral | `#f64932` | Decorative card backgrounds, hero pill alternates |
| Saffron | `#e89d01` | Secondary warm yellow for background washes |
| Vermillion | `#e32d14` | Deep coral for saturated section backgrounds, signal-warm accent |
| Mocha | `#b18164` | Warm brown accent for section panels |
| Signal Blue | `#097fe8` | Decorative card backgrounds, secondary blue |
| Sky Wash | `#62aef0` | Lightest blue — decorative backgrounds, heading accent highlights |
| Midnight Ink | `#02093a` | Dark island cards, decorative bands, soft emphasis behind content |

## Tokens — Typography

**Sans (substitute: Inter)** — 400 body, 500 nav/UI, 600–700 display headings. Aggressive negative letter-spacing at large sizes (-4.6px at 96px, -2px at 72px) so headlines feel confident and compact. Sizes: 12, 14, 16, 20, 22, 24, 40, 42, 48, 54, 72, 96px. OpenType: `"lnum"`.

**Editorial serif (substitute: Source Serif 4)** — 400 only, 18px and 32px; reserved for a few section intros and pull-quote moments. Never for UI labels or navigation.

| Role | Size | Line height | Letter spacing |
|------|------|-------------|----------------|
| caption | 12px | 1.33 | 0.12px |
| body-sm | 14px | 1.43 | — |
| body | 16px | 1.5 | — |
| subheading | 20px | 1 | — |
| heading-sm | 22px | 1.27 | -0.242px |
| heading | 40px | 1.5 | — |
| heading-lg | 48px | 1.5 | — |
| display-sm | 54px | 1.04 | -1.89px |
| display | 72px | 1.21 | -2.016px |
| display-lg | 96px | 1.04 | -4.608px |

## Tokens — Spacing & Shapes

Base unit 4px, comfortable density. Spacing: 4, 8, 12, 16, 20, 24, 28, 32, 36, 64, 80px.

| Element | Radius |
|---------|--------|
| cards | 12px |
| pills | 9999px |
| small | 4px |
| buttons | 8px |

Layout: page max-width 1440px, section gap 80px, card padding 24px, element gap 8px.

## Components

- **Primary CTA button:** `#0075de` fill, white 14px/500 text, 8px radius, padding 6px 15px. The only filled chromatic button in any view.
- **Ghost CTA button:** `#e6f3fe` fill, `#0075de` text, 8px radius. The lower-commitment alternative beside the primary.
- **Ghost text button:** transparent, ink at 95% alpha, 8px radius. Tertiary actions.
- **Outlined text button:** transparent, 1px border ink 90%, 4px radius, padding 5px 10px. Compact inline actions.
- **Muted nav link:** ink at 54% alpha, darkens to 100% on hover, never underlined.
- **Pill tag:** colored fill, black or white text, 9999px radius, padding 4px 12px — status labels.
- **White feature card:** white, 12px radius, 24px padding, 1px border `rgba(0,0,0,0.08)`, no shadow.
- **Accent feature card:** one accent hue as full background, 12px radius, 24px padding, no border.
- **Dark feature card:** `#02093a` with white text — a dark island, never a full dark theme.
- **Hero highlight pill:** accent fill (peach `#f6d5b8`, marigold `#ffb110` or coral `#f64932`) behind one verb of the hero sentence, 9999px radius, padding 8px 24px — the signature typographic device.
- **Task card (product mockup):** white, 8px radius, padding 8px 12px, hairline border, 14px/500 text, optional small status pill.
- **Section header:** 48–54px, weight 500–700, tight tracking, optional 18px serif subhead.

## Do's and Don'ts

Do:
- `#f6f5f4` canvas with `#ffffff` cards — never a warm card on a white page.
- One `#0075de` primary action per screen; everything else ghost or text.
- Negative letter-spacing on every display size; body at normal tracking.
- 1px `rgba(0,0,0,0.08)` borders instead of shadows.
- 12px cards, 8px buttons, 9999px only for pills.
- Paint feature blocks with accent hues rather than borders or shadows.
- 200ms ease for hovers and transitions; spring motion only for hero elements and character marks.

Don't:
- Pure white page background.
- Shadows on content cards (only the sticky nav and the product UI mockup carry one).
- More than one filled chromatic button in a view.
- 100% black for all text — build hierarchy with alpha.
- The serif for UI labels or navigation.
- Radius larger than 12px on rectangular content.
- Gradients — strictly flat fills.

## Surfaces and elevation

| Level | Value | Purpose |
|-------|-------|---------|
| 0 Page canvas | `#f6f5f4` | Warm off-white base |
| 1 Card surface | `#ffffff` | Surfaces that sit on top of the page |
| 2 Accent card | `#ffb110` (or another accent) | Colored feature blocks |
| 3 Dark card | `#02093a` | Dark island blocks |

- Sticky nav shadow: `0px 0.7px 1.462px 0px rgb(0% 0% 0% / 0.015), 0px 3px 9px 0px rgb(0% 0% 0% / 0.03)`
- Product UI mockup shadow: `0px 4px 12px rgba(0, 0, 0, 0.1)`

## Imagery

Illustration-first, photography-free: flat illustrated marks in 2px colored circles, hand-drawn squiggles, sparkles and arrows as punctuation, and real product UI mockups as the only "real" visuals (large, centered, one drop shadow). No lifestyle photos, stock imagery or 3D renders.

## Layout

Centered, max-width ~1440px. Hero as a centered stack: headline with an embedded highlight pill → subhead → two-button CTA row → large product UI mockup. Sections alternate between white-card grids and full-bleed accent panels; feature blocks use two columns (text + colored panel) alternating sides; a 2×2 card grid with a full-width top card. Section gaps ~80px. Fixed 64px top nav with centered items and right-aligned actions.

## Implementation token mapping (Tailwind v4 `@theme`)

| Reference | Code token |
|-----------|-----------|
| Primary Blue `#0075de` | `--color-primary` |
| Paper Warmth `#f6f5f4` | `--color-canvas` |
| Pure White | `--color-surface` |
| Ink Black | `--color-ink` |
| Charcoal | `--color-charcoal` |
| Stone / Graphite / Slate | `--color-stone`, `--color-graphite`, `--color-slate` |
| Sky Tint | `--color-sky-tint` |
| Marigold / Coral / Saffron / Vermillion / Mocha | `--color-marigold`, `--color-coral`, `--color-saffron`, `--color-vermillion`, `--color-mocha` |
| Signal Blue / Sky Wash / Midnight Ink | `--color-signal`, `--color-sky`, `--color-midnight` |
| Sans | `--font-sans` (Inter) |
| Serif | `--font-serif` (Source Serif 4) |
