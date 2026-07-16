# DESIGN-034: About/Help page — dashboard entry card + accordion content

- **Status:** Accepted
- **Last updated:** 2026-07-16
- **Satisfies:** PRD-001 R-190..R-191; governed by ADR-063, ADR-015 (reflow-free + sanctioned
  in-place expansion), ADR-013 (catalog links unrelated — the About card is app chrome, not a
  catalog row)

## Overview

Two pieces: (1) an **About entry card** at the top of the logged-in dashboard, visually kin to
the SSO `.tile` cards but inverted, separated from them by a **perforated rule**; (2) a new
ungated `(app)` route **`/about`** — a mobile-first help page: short intro + haynes-ops info
pane, then collapsed `<details>` sections users expand one at a time.

## Detailed design

- **D-01 — Entry card.** In `apps/web/app/(app)/page.tsx`, between `<Greeting/>` and the tile
  grid: a full-width `<Link href="/about" className="tile tile--about">` reusing the tile
  anatomy (`.tile__icon` info glyph, `.tile__name` "About haynesnetwork.com", `.tile__desc`
  one-liner, `.tile__ext` "→" — internal link, no `target="_blank"`). **Inverted** via the
  established accent-fill idiom (`.btn.primary` precedent): `background: var(--color-accent);
  color: var(--color-accent-contrast);` hover deepens color only (ADR-015 — never layout). No
  new tokens.
- **D-02 — Perforation.** A dedicated `.tile-rule` element between the About card and
  `.tile-grid`: `border-top: 1px dashed var(--color-border)` (existing dashed idiom,
  app.css:3522 precedent), `margin: var(--space) 0`. Pure separator, zero interaction.
- **D-03 — Route.** `apps/web/app/(app)/about/page.tsx` (server component) — inherits the
  session gate + TopBar from the `(app)` layout; **no section permission** (ADR-063 C-04,
  visible to every logged-in user). Content is static TSX in co-located components
  (`apps/web/app/(app)/about/*.tsx`); styles are new `.about*` classes in `app.css`,
  tokens-only.
- **D-04 — Accordion.** Native `<details>/<summary>` (the repo's blessed ADR-015 in-place
  expansion idiom — `.season__head` / `.batch-past__summary` precedents). One `<details
  className="about-sec">` per section, `<summary>` = header row (glyph + title + chevron),
  all collapsed by default. Each carries a stable `id` so `/about#fix`-style deep links work;
  a section targeted by the URL hash renders pre-expanded (tiny client effect).
- **D-05 — Sections** (order): intro (not collapsible) + haynes-ops **info pane** (a `.card`
  aside linking https://github.com/thaynes43/haynes-ops) → `#plex-servers` Plex Servers →
  `#fix` Fix broken media & find missing → `#tickets` Still have an issue? → `#trash` Trash →
  `#requests` Request media → `#goodreads` Goodreads integration → `#reading` Reading ebooks
  & comics → `#audiobooks` Listening to audiobooks → `#watching` Watching Movies & TV →
  `#music` Listening to music.
- **D-06 — Live values, not stale copy.** The page renders the **live save-window default**
  (`app_settings.trash_default_window_days`) inline in the Trash section ("currently
  {N} days") via the existing read helper — the single dynamic read on the page. Everything
  else is static copy; snapshot-ish facts (e.g. future Haynestower play totals) are labeled
  "as of".
- **D-07 — Copy contract.** Copy uses only real product labels from the verified fact sheet
  (My Plex, Tickets, Fix / Force Search, card badges Searching · Downloading · Importing ·
  Stuck · Just added, failure kinds Stranded · Import failed · Download failed · Blocked).
  In-app destinations are `<Link>`s (`/library/plex`, `/trash`, `/bulletin`,
  `/integrations/goodreads`, `/library?tab=activity`); external destinations
  (plex.tv, GitHub, app stores) open `target="_blank" rel="noopener noreferrer"`.
- **D-08 — Flagged content.** Instructions the owner hasn't validated yet (iOS Panels steps;
  Plex language-settings recipe) carry a muted "verify" note styled `.about-flag` until he
  confirms; sections describing currently-admin-gated surfaces (Goodreads, books Fix) are
  written member-facing — their visibility rides the owner's pending role flips (PLAN-049
  Q-07).
- **D-09 — Mobile-first.** Single column, `max-width: 720px` centered; summaries are
  ≥44px tap targets; no page-level horizontal scroll at 375/390px (the demo-console viewport
  discipline); long link URLs wrap (`overflow-wrap: anywhere`).

## Alternatives considered

- A `@hnet/ui` Accordion component — rejected: `<details>` is the established idiom; no other
  consumer yet (rule of three).
- Putting the About card inside `.tile-grid` as the first tile — rejected: the owner wants it
  set apart ("perforation line to separate it"), and a full-width inverted card above the
  grid reads as chrome, not another app.
- MDX/markdown content pipeline — rejected: one page doesn't justify a toolchain; TSX keeps
  Link components and the live settings read trivial.

## Test strategy

- e2e smoke (`apps/web/e2e/about.spec.ts`): dashboard shows the About card first with the
  perforation; card navigates to `/about`; sections start collapsed, expand/collapse
  in place; `#fix` hash deep-link arrives expanded; unauth `/about` redirects to `/login`.
- Hex lint + full local five-green gate; screenshots desktop + 390px, dark/light for the
  owner's morning review.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Mirrors PLAN-049 Q-01..Q-07 (audience, wording, play totals, iOS app test, language-recipe validation, gated-section flips) | tracked in PLAN-049; defaults applied overnight |
