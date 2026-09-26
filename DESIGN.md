---
name: Omamori
description: A pre-signature firewall for AI agent payments, presented as a security-grade white gallery.
colors:
  ink: "#0b0d12"
  charcoal: "#1a1d24"
  graphite: "#5b606b"
  stone: "#8a8f99"
  canvas: "#ffffff"
  fog: "#f7f8fa"
  hairline: "#e6e8ec"
  hairline-strong: "#d5d8de"
  verified: "#1f5bff"
  verified-wash: "#eaf0ff"
  refuse: "#e5372a"
  refuse-wash: "#fdeceb"
  refuse-ink: "#b4231a"
  ask: "#b87400"
  ask-wash: "#fff4dc"
  ask-ink: "#85530a"
typography:
  display:
    fontFamily: "Mona Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "68px"
    fontWeight: 400
    lineHeight: 1.04
    letterSpacing: "-0.02em"
  heading:
    fontFamily: "Mona Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "38px"
    fontWeight: 400
    lineHeight: 1.12
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Mona Sans Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Martian Mono Variable, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.12em"
rounded:
  sm: "4px"
  card: "6px"
  btn: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  band: "64px"
  band-lg: "96px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.btn}"
    padding: "10px 18px"
  button-primary-hover:
    backgroundColor: "{colors.charcoal}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.btn}"
    padding: "10px 18px"
  card:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.card}"
---

# Design System: Omamori

## Overview

**Creative North Star: "The Gallery Console"**

A sober, security-grade white gallery, not a warm notebook and not a dark neon shield hero — both were explicitly rejected in favor of a hairline-framed, near-monochrome canvas where the signed intent and the agent's request appear as real product fragments and color only ever reports state. The craft bar was three pinned reference products (clutch.security, base.org, neverhack.com), borrowed for grammar only — white gallery canvas, mixed-weight grotesk headlines, technical line diagrams, mono uppercase labels, split hero with live product — never their logos, fonts, or exact colors. The world explicitly refuses any Japanese aesthetic despite the Japanese product name.

The landing (Persuade) and the app (Operate) share one world at two densities: the landing tells the story once, spaciously, with an animated intent-diff hero; the app is denser and quieter, its motion reserved for actual state changes (a new receipt sliding into the feed, a sheet opening), never decoration.

**Key Characteristics:**
- White canvas, hairline-framed 1200px column, near-zero shadow.
- Color is rationed to exactly three states: verified blue, refuse red, ask-human amber — nothing else in the system is colored.
- Mona Sans mixed 400/600 headlines paired with uppercase Martian Mono labels for data and metadata.
- Monochrome 1-bit stippled obsidian illustrations, used sparingly, never as generic decoration.
- Black is the only "confident" UI color: primary actions are ink-black, not blue.

## Colors

Color is rationed to mean state, never mood or decoration; everything else in the interface is ink, graphite, stone or hairline.

### Primary
- **Ink** (`#0b0d12`): primary text, headings, primary button fill — the system's one "confident" non-state color, doubling as the default action color.

### Secondary (state colors — the only chromatic vocabulary)
- **Verified Blue** (`#1f5bff`): matched-intent / paid / human-approved state — focus rings, verdict stamps, the firewall diagram's final node, and the accent pixel kept in the stippled art.
- **Refuse Red** (`#e5372a` fill / `#b4231a` ink variant): refused-payment state — verdict text, diff underline, danger buttons. The `-ink` variant is the AA-safe darker text color on white or on the red wash; the flat `#e5372a` is for fills only.
- **Ask Amber** (`#b87400` fill / `#85530a` ink variant): needs-human state, same fill/ink-variant split as refuse.

### Neutral
- **Canvas** (`#ffffff`): page and card background — the gallery white.
- **Fog** (`#f7f8fa`): hover backgrounds, subtle callout panels (e.g. the "fail-closed" strip).
- **Charcoal** (`#1a1d24`): primary button hover.
- **Graphite** (`#5b606b`): secondary/body-adjacent text, help text.
- **Stone** (`#8a8f99`): tertiary/muted labels, disabled text.
- **Hairline** (`#e6e8ec`) / **Hairline-strong** (`#d5d8de`): the only borders in the system — the frame rails, card edges, dividers, input strokes.

### Named Rules
**The State-Only Rule.** Blue, red and amber never appear as decoration. Each exists solely to report a firewall/intent state (verified, refused, needs-you); if a UI element isn't reporting one of those three states, it is ink, graphite, stone, or hairline.

**The Black-Action Rule.** The primary/confident action color is ink-black (`#0b0d12`), not the accent blue. Blue is reserved for the "verified" state, so it never gets diluted into meaning "click here."

## Typography

**Display/Heading Font:** Mona Sans Variable (with `ui-sans-serif, system-ui, sans-serif` fallback)
**Label/Data Font:** Martian Mono Variable (with `ui-monospace, SFMono-Regular, Menlo, monospace` fallback)

**Character:** A variable grotesk carrying both the editorial hero voice and dense UI copy, paired with an uppercase monospace for anything that is data, metadata, or a system label — the pairing that reads "product marketing" next to "technical instrument" on the same screen.

### Hierarchy
- **Display** (400, 68px / hero up to `clamp` ~44–56px on landing, 1.04 line-height, -0.02em): the hero headline only; set as a `.headline` block mixing 400 body weight with a 600 `<strong>` span on the key phrase — never the whole sentence bolded.
- **Heading-lg** (400/600 mixed, 52px, 1.06): section headers ("Six stages...").
- **Heading** (400, 38px, 1.12, -0.015em): sub-section headers.
- **Heading-sm** (400, 24px, 1.25, -0.01em): card/verdict headings (e.g. the intent card's "Refused").
- **Body-lg / Body / Body-sm** (400, 18/16/14px, ~1.5): copy, subheads, help text; body copy is capped at roughly 46–52ch measure.
- **Label** (400, 11px, uppercase, 0.12em tracking, Martian Mono, `font-stretch: 90%`): stage numbers, nav-adjacent metadata, pill text, "You signed" / "Agent asks" data-row keys, the "Built with" strip.
- **Caption** (400, 12px, often mono/tabular for numbers): timestamps, addresses, resource paths.

### Named Rules
**The Mixed-Weight Headline Rule.** Headlines set at 400 weight with only the load-bearing phrase lifted to 600 (`.headline strong`) — never a uniform bold headline, never a separate kicker/eyebrow line above it.

**The Mono-Means-Data Rule.** Martian Mono is reserved for labels, stage indices, addresses, amounts, and timestamps — anything that is literally data or a system value. It never appears in sentence-form prose.

## Layout

The landing and app share one hairline-framed column: `.frame` centers content at `max-width: 1200px` with a 1px vertical hairline border on each side (`border-inline`), so the whole site reads as one long framed page rather than full-bleed sections. Landing sections are `.band` blocks — a top hairline divider with 64px vertical padding on mobile, 96px from the `md` breakpoint (768px) — giving the generous, spacious Persuade density.

The app (`/app`, `/app/dashboard`) runs the same frame and hairline vocabulary at a denser Operate rhythm: a 64px shell bar (matching the landing's 64px nav height) with tabs and a wallet chip, then the framed column holds tighter card stacks and a two-lane feed with a detail drawer instead of full `.band` sections. Card internal padding and list-row padding stay in the 12–16px range rather than the landing's 64–96px band gaps.

## Elevation & Depth

The system is flat by default: cards use a single hairline border (`border border-hairline`) and no shadow. Exactly one shadow token exists in the whole build, `--shadow-console` (`0 30px 60px -30px rgba(11,13,18,0.28), 0 2px 6px rgba(11,13,18,0.06)`), and it is applied to exactly one element — the hero's "intent" verdict card — to lift the one artifact the story asks the visitor to focus on. Depth everywhere else is conveyed by hairline framing and fog-tinted hover backgrounds, not shadow.

### Shadow Vocabulary
- **Console** (`0 30px 60px -30px rgba(11,13,18,0.28), 0 2px 6px rgba(11,13,18,0.06)`): the hero intent/verdict card only. Not used on any other card, panel, or dashboard element.

### Named Rules
**The One-Shadow Rule.** A single soft shadow token exists, reserved for the hero's intent card. Every other card, panel and row in the system is a flat hairline rectangle.

## Shapes

Corners are consistently small and understated: 6px on cards and buttons (`--radius-card`, `--radius-btn`), 4px on small/compact elements (chips, state tags, small badges), and fully round (`rounded-full`) only for the small circular status-mark rings in checklists. There is no pill-radius button or tag anywhere in the built system (unlike the retired notebook world, which used `9999px` pills throughout). Borders are hairline (1px, `#e6e8ec` / `#d5d8de`) everywhere; the frame itself is a pair of hairline rules bounding the whole 1200px column.

## Components

### Buttons
- **Shape:** 6px radius (`--radius-btn`), 10px/18px padding, 14px/500 text, 200ms color transitions.
- **Primary:** ink-black fill (`#0b0d12`), white text, charcoal hover (`#1a1d24`) — the only filled chromatic-free black button, used for "Launch app" and the confident default action.
- **Outline:** 1px ink border, transparent fill, fog hover background — the secondary/lower-commitment action.
- **Small/Ghost/Text variants:** compact row-scoped actions (Copy, Revoke, Retry) at the same 6px radius; ghost has no border, text-only underlines on hover.
- **Danger (outlined and filled):** built on the `refuse`/`refuse-ink` tokens exclusively for destructive actions (revoke); never used for ordinary secondary actions.

### Chips / State pills
- **Style:** `label` mono text, 4px radius (`rounded-sm`), selected state is solid ink fill; unselected is a hairline-strong outline. State pills (`StatusPill`) use only the four state washes (verified/refuse/ask/muted) plus a neutral hairline-outlined variant — never a decorative color.

### Cards / Containers
- **Corner Style:** 6px radius (`--radius-card`).
- **Background:** white surface on white/fog canvas.
- **Shadow Strategy:** none, except the single hero console shadow (see Elevation & Depth).
- **Border:** 1px hairline.
- **Internal Padding:** 16–24px on landing feature panels; 12–16px in dense app rows.

### Inputs / Fields
- **Style:** 1px hairline-strong border, 6px radius, white surface, graphite placeholder.
- **Focus:** border darkens to ink; global `:focus-visible` also draws a 2px verified-blue outline with 2px offset — the one place blue appears outside a verdict.
- **Error:** refuse-ink text below the field.

### Navigation
- Sticky 64px header, hairline bottom border, canvas background; nav links are graphite, darkening to ink on hover, never underlined; the black "Launch app" button sits right-aligned. The app shell reuses the same 64px bar height with Intents/Live tabs and a "Pause all" control instead of marketing links.

### Signature Component: The Intent-Diff Card
The hero's centerpiece: a hairline-framed, console-shadowed card showing a `dl` of "You signed" vs. "Agent asks" rows, a mismatched word underlined in a refuse-red gradient wash, a row of small passed-rule checkmarks in mono caption text, and a verdict line ("Refused — not what you signed"). On load (or on manual "Replay"), rows fade/slide in in sequence and the mismatch underline sweeps in via a `background-size` transition, timed 380–1500ms with `ease-out-soft`; it is the landing's only choreographed motion sequence and fully respects `prefers-reduced-motion`, defaulting to its final, fully-revealed state.

## Do's and Don'ts

### Do:
- **Do** ration color to exactly three states (verified blue, refuse red, ask amber) plus their washes and `-ink` text variants; everything else is ink/graphite/stone/hairline.
- **Do** use ink-black, not blue, for primary/confident actions.
- **Do** keep radius small and consistent: 6px for cards/buttons, 4px for compact chips, full round only for tiny status-mark rings.
- **Do** set headlines at 400 weight with only the key phrase lifted to 600 — never a fully bold headline.
- **Do** reserve Martian Mono for data/labels/metadata, never for prose sentences.
- **Do** keep the interface flat; the hero intent card is the one deliberate exception to the no-shadow rule.
- **Do** scope motion to actual state changes (a new decision arriving, a sheet opening) in the app, and to the hero's one intent-diff replay on the landing; always provide a fully-revealed reduced-motion final state.
- **Do** keep 1-bit stippled obsidian illustrations sparse and load-bearing (hero, gate, empty states, handoff, approval) rather than generic decoration.

### Don't:
- **Don't** use any Japanese aesthetic motif (kanji, torii, washi, seals, vermilion-as-Japan, cherry blossoms) despite the Japanese product name — this is a binding brand commitment, not a style option.
- **Don't** use pill/`9999px` radius on buttons or content cards; that belonged to the retired warm-notebook world and is gone from the shipped system.
- **Don't** add a second shadow token or shadow a second card; the system is otherwise flat by design.
- **Don't** invent a kicker/eyebrow line above headlines; the shipped hierarchy is mixed-weight headline direct to subhead, with mono labels reserved for actual data rows, not decorative overline text.
- **Don't** use glyph icon fonts; the built icon set is hand-authored 16px stroke SVGs at a single 1.5 stroke weight, `currentColor`-driven so state color always comes from the parent.
- **Don't** surface internal technical names (Jev, Intercepta, state-machine values) in primary product copy — the user-facing noun is "intent," and technical detail sits one click away in a disclosure.
