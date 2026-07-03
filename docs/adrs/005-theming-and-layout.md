# ADR-005: Port demo-console's CSS-token theming and viewport-fit layout

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

The UI must be responsive on phones, tablets, and PCs (PRD-001 R-60, AC-10) with light/dark
theming and no raw hex outside token files (R-61; CLAUDE.md hard rule 2). The sibling repo
`../demo-console` is the designated UI donor: a proven CSS-custom-property token system
themed by `data-theme` on `<html>`, a token contract test, a hex-lint guard, and
viewport-fit layout primitives (its ADR-005 and ADR-010). We must decide how much ports,
what haynesnetwork adds, and the initial palette — noting this deliberately diverges from
todos-for-dues' Tailwind + shadcn choice (ADR-001 C-06).

## Decision drivers

1. R-61 mandates the demo-console token system by name; hard rule 2 makes hex-linting law.
2. Phones are first-class (R-60, US-08): no page-level scrollbars, panes scroll internally.
3. Rebranding must be a data change (edit `tokens.css`), never a code change.
4. Theme state needs exactly one writer to avoid flash/desync across routes.

## Considered options

- **Option A** — Port demo-console's token + layout system wholesale, plain CSS in the shell.
- **Option B** — Tailwind + shadcn/ui (the todos-for-dues donor default).

## Decision outcome

Chosen option: **Option A — port demo-console's token system and layout primitives** —
because it is proven in both themes, satisfies R-61 verbatim, and keeps every color a
single-file data concern. Tailwind/shadcn would bring a second styling system whose
utility classes bypass the token contract. **No Tailwind or shadcn in the UI shell** —
plain CSS + tokens.

Ported from demo-console:

- **Tokens:** all colors as CSS custom properties in `tokens.css`, defined under
  `[data-theme='hnet-dark']` and `[data-theme='hnet-light']`; **dark is the default**.
- **ThemeProvider:** the single writer of `data-theme` on `<html>` — no other code touches it.
- **Token contract:** `tokenContract.ts` exports `REQUIRED_TOKENS`; a `missingTokens()`
  test fails if any theme is missing a required token.
- **Hex guard:** `scripts/lint-css-hex.mjs` forbids raw hex outside `tokens.css`,
  CI-enforced (hard rule 2).
- **Icons:** inline SVG using `currentColor`, so icons theme for free.
- **Layout:** viewport-fit height-budget primitives — `HeightBudget`, `ReservedPane`,
  `useAvailableHeight` — ported from demo-console `packages/shared/layout` (its ADR-010).

**Initial palette:** keep demo-console's token *values* as placeholders — they are proven
legible in both light and dark. Rebranding later means editing `tokens.css` only (driver 3).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: one theming mechanism, structurally lint-enforced; a rogue hex fails CI, a missing token fails tests. |
| C-02 | Good: viewport-fit primitives deliver AC-10's "panes scroll internally, no page scrollbars" by construction rather than per-page fixes. |
| C-03 | **Addition over demo-console:** ThemeProvider gains localStorage persistence and `prefers-color-scheme` seeding — first visit follows the OS (falling back to dark), and the choice sticks across sessions (R-61). |
| C-04 | **Addition over demo-console:** phone-width breakpoints in the shell CSS and a phone-inclusive Playwright resize matrix — AC-10's full list: 375×667, 390×844, 412×915, 768×1024, 820×1180, 1280×800, 1920×1080, 2560×1440 (demo-console's matrix was desktop/tablet-leaning). |
| C-05 | Bad: no utility-class ecosystem — spacing/typography conventions are hand-rolled in `packages/ui`; agents must follow them rather than reach for Tailwind idioms. |
| C-06 | Bad: placeholder palette means the launch look is demo-console's, not a haynesnetwork brand; acceptable, and confined to `tokens.css` when rebranding happens. |
| C-07 | Note: theme names `hnet-dark`/`hnet-light` differ from demo-console's; the port must rename consistently in `tokens.css`, ThemeProvider, and the token-contract test. |
| C-08 | Note: SSR must avoid a theme flash — the persisted/seeded theme is applied before first paint (inline script or equivalent); mechanism is a design-doc detail. |

## More information

- PRD-001: R-60, R-61, R-66; AC-10; US-08.
- CLAUDE.md hard rule 2 (no raw hex outside `tokens.css`).
- Donor rationale: `../demo-console/docs/adrs/005-theming.md` (tokens, contract, hex lint)
  and `../demo-console/docs/adrs/010-viewport-fit-layout.md` (height-budget primitives);
  source at `../demo-console/packages/shared/layout/` and
  `../demo-console/scripts/lint-css-hex.mjs`.
- Sibling ADRs: ADR-001 (`packages/ui` placement; divergence from todos-for-dues' Tailwind
  noted there as C-06), ADR-004 (dashboard data the themed tiles render).
