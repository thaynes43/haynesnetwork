# DESIGN-006: Visual identity — mark, type, shape language

- **Status:** Draft
- **Last updated:** 2026-07-03
- **Satisfies:** PRD-001 R-60, R-61 (rebrand-as-data stays true); governed by ADR-005 (the theming MECHANISM is untouched: tokens, `data-theme`, ThemeProvider, layout primitives, hex guard). Partially supersedes DESIGN-004 D-01 (structural token values), D-06 (tile grid), D-07/D-08 (tile shape, brand mark) — noted inline there.

## Overview

Owner feedback on the staging screenshots (2026-07-03): the shipped look was
"too much of a rip off of demo-console — colors are good but the squares make
it look clearly like a copy of my other app". This design gives haynesnetwork
its **own identity** while keeping the donor's proven palette _values_ and the
entire ADR-005 mechanism:

- **Kept:** every token name, both theme palettes (accent `#78be20`, all
  surface/text/status hex values), ThemeProvider + pre-hydration script, layout
  primitives, focus-visible/reduced-motion rules, admin table→card transform,
  page structure and routes, the hex-lint guard.
- **Changed:** the brand mark, the typeface, and the shape language (radii,
  tile geometry, button/chrome styling) — i.e. everything that made it _look
  like_ demo-console rather than _work like_ it.

## Detailed design

### D-01 — Brand mark: hub-and-spoke network glyph

The donor four-square placeholder (DESIGN-004 Q-01) is replaced by an original
mark: a **ringed central hub with three connected satellite nodes** — the
front door and the three Plex servers it fronts (k8plex, plexops, legacy
haynestower). Implementation rules:

- One component, `apps/web/components/brand-mark.tsx`, used by both the TopBar
  and `/login` — the mark is never redrawn inline anywhere else.
- Single `currentColor` SVG on a 32-grid (ADR-005 icon convention): it themes
  through the token seam and needs no per-theme assets.
- Sized by CSS: 28px in the topbar (`.brand__mark`), 64px hero on the login
  card (`.login-brand .brand__mark`); silhouette stays legible at 20px.
- The wordmark remains the `--brand-name` token rendered via CSS `content`
  (DESIGN-004 D-08) — a rebrand is still a `tokens.css` edit (R-61).

### D-02 — Typeface: Outfit (variable, self-hosted)

- **Font:** [Outfit](https://github.com/Outfitio/Outfit-Fonts), SIL OFL 1.1 —
  a geometric sans whose circular forms echo the node-and-ring mark.
- **Vendored, never fetched:** `apps/web/fonts/Outfit-Variable.woff2` (45 KB,
  wght 100–900, converted from the variable TTF in google/fonts `ofl/outfit`)
  plus `apps/web/fonts/OFL.txt`. No external font requests (CSP posture).
- **Wiring:** `next/font/local` in the root layout exposes the family as the
  `--font-outfit` CSS variable (class on `<html>`); `tokens.css` consumes it:
  `--font: var(--font-outfit, 'Outfit'), 'Segoe UI', system-ui, …` — so type
  remains a token concern and degrades to the system stack anywhere the Next
  variable isn't present (unit tests, future non-Next consumers).

### D-03 — Shape language (tokens.css + app.css only)

The geometry that separates haynesnetwork from the donor's square-tile console
look. All of it lives in token values and `app.css` — no markup changes, no
new tokens, hex guard untouched:

| Rule                   | Value                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base radius `--radius` | 16px (was 10px); `--radius-sm` 10px (was 7px)                                                                                                                                                                                                                        |
| App tiles              | **Horizontal cards**: icon in a tinted circular well (`color-mix(accent 14%, transparent)`) left, name + description right, `↗` on the far edge; `calc(var(--radius) + 2px)` corners; min 76px tall; grid `minmax(280px, 1fr)` (was square-ish `minmax(160px, 1fr)`) |
| Tile markup bridge     | `.tile__top { display: contents }` lifts the existing DESIGN-004 D-07 markup into the card grid — DOM unchanged, selectors (`.tile`, `.tile__name`, …) stable for the e2e suite                                                                                      |
| Tile hover             | subtle accent ring (`box-shadow: 0 0 0 3px color-mix(accent 22%, transparent)`) + 1px lift                                                                                                                                                                           |
| Card surfaces          | barely-there brand gradient: `linear-gradient(155deg, color-mix(surface 97%, accent), surface 65%)` on `.card` and `.tile`                                                                                                                                           |
| Topbar buttons         | **ghost** — no bordered circles; transparent, 12px-radius hover fill (`surface-2`); user-menu trigger likewise (avatar disc is the anchor); hit areas stay ≥44px                                                                                                     |
| Buttons                | pills (`border-radius: 999px`), primary keeps accent fill                                                                                                                                                                                                            |
| Login card             | 400px, 32px padding, brand stacked (64px mark over 22px wordmark), pill sign-in button                                                                                                                                                                               |

### D-04 — Contrast notes (both themes checked at 390×844 and 1920×1080)

- The 2–3% accent tint on card surfaces does not measurably move text
  contrast in either theme.
- Dark theme: accent-on-tinted-well ≈ 6.4:1 — fine.
- Light theme: pure accent `#78be20` on the near-white tinted well is ~2.3:1,
  so `app.css` deepens light-theme tile icons to
  `color-mix(accent 62%, text)` (~3:1, visibly crisper). The topbar/login
  brand mark intentionally stays pure accent in both themes — it is the one
  full-strength brand-color moment, and the adjacent wordmark carries the
  name.

### D-05 — What this design explicitly does NOT touch

Token names and the token contract, ThemeProvider/pre-hydration script,
layout primitives, page structure and routes, admin table→card behavior,
focus-visible and reduced-motion rules, the app-icon registry (`ICON_KEYS`
glyphs are unchanged — only their presentation well is new).

## Alternatives considered

- **New palette too:** rejected — owner explicitly kept the colors ("colors
  are good"); identity had to come from mark/type/shape.
- **Mark candidates:** solid-hub molecule (too generic), stroked satellites
  (spokes read as entering open rings) — the ringed hub won on distinctive
  silhouette at 28px and non-resemblance to both the four squares and the
  stock "share" glyph.
- **Font candidates:** Outfit vs Sora. Outfit chosen: rounder geometry matches
  the mark, smaller file, wider optical range for the wordmark weight. Both
  OFL; either works via the same `--font-outfit` seam.
- **Google Fonts CDN:** rejected — external fetch (CSP, privacy); vendored
  woff2 is 45 KB.
- **Vertical tiles with bigger radii only:** rejected — still read as
  demo-console's squares in the side-by-side; the horizontal-card geometry is
  the visible break.

## Test strategy

- Existing suites prove the restyle regressed nothing: token contract (names
  unchanged), `pnpm lint:css` (no hex escaped tokens.css), full Playwright
  e2e including the AC-10 resize matrix (38/38 — selectors survived because
  the tile DOM is unchanged).
- Visual proof for owner approval: `identity-screenshots/` (gitignored) —
  login/dashboard/admin × 390×844/1920×1080 × dark/light, captured against
  the `dev:local` stack with the stub-OIDC admin persona.

## Open questions

| ID   | Question                                                                                                                                                         | Resolution |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Q-01 | Does the owner approve this identity from the screenshot set (PR blocks on this)?                                                                                | (open)     |
| Q-02 | Should the generic app icon (four rounded squares, `packages/ui/src/icons`) be redrawn to match the new identity? It only appears for unknown catalog icon keys. | (open)     |
