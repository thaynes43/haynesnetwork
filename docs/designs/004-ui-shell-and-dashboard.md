# DESIGN-004: UI shell and dashboard (Phase 1)

- **Status:** Accepted — presentation details partially superseded by DESIGN-006 (visual identity: brand mark, typeface, radii, tile geometry); the mechanism and structure here remain normative
- **Last updated:** 2026-07-14
- **Satisfies:** PRD-001 R-10, R-12, R-14 (rendering side), R-60, R-61, R-66, AC-01, AC-04, AC-10; governed by ADR-005 (CSS-token theming via `data-theme`) and **ADR-012 (unified Role model)** — API consumed per DESIGN-003 / ADR-004 (API layer: tRPC v11).

> **Amended by ADR-012 (2026-07-05):** the admin permissions UI is now role-based.
> **`/admin/roles` replaces `/admin/tags`** (roles table + Add-role modal + edit-in-place, the
> same UX as `/admin/catalog`); the **user detail page is a single Role `<select>`** (no
> Family/Tags/Grants); the **`/admin` roster shows a Role column** only; **`/admin/catalog`
> dropped its "Default" column + defaultVisible checkbox**; the admin sub-nav entry **"Tags" →
> "Roles"**; and the Admin menu/gate switches on **`user.role.isAdmin`** (not `role === 'Admin'`).
> Sections D-08 and D-11 carry the amendments. A layout hardening also landed — see D-05.
>
> **Amended by ADR-014 (2026-07-05):** destructive-delete confirmation moves off native
> `window.confirm` to an inline two-step **`@hnet/ui` `ConfirmButton`** (arm-to-confirm). New
> section **D-13** carries the normative component contract; the catalog-row and role-row Delete
> buttons (D-11) are the two call sites. Explanatory/multi-field confirms (failsafe restore, Fix,
> Force-search) intentionally stay `Modal`s (DESIGN-005).
>
> **Amended by ADR-015 (2026-07-05):** page contents must not re-orient on interaction (CLAUDE.md
> hard rule 9). New section **D-14** carries the two consequences: (1) `/admin/catalog` reorder
> becomes native-HTML5 drag-and-drop + keyboard arrow-move + `aria-live` (replacing the `↑`/`↓`
> buttons), committing the full `orderedIds` to `catalog.reorder`; (2) the two-step confirm
> reserves width for the widest (armed) label with a specificity-correct selector and deepens the
> armed red via `--color-danger-strong` rather than reflowing (fixing the `.btn.sm`-outranks-
> `.confirm-btn` bug that defeated D-13's `min-width` reservation). D-11's `/admin/catalog` row is
> amended accordingly.
>
> **Amended by the settings-only-user-menu change (2026-07-05):** the user-menu popover is now
> **identity header + "Admin settings" (admin-only) + Sign out** — the **Library** and **My fixes**
> menu items are removed. Library now lives solely in the top-nav (`.topbar__nav`), which is **shown
> on phones** (its `display: none` under 600px is relaxed) so nothing becomes unreachable. The
> standalone `/my-fixes` route becomes a server redirect to **`/library?tab=my-fixes`** — My Fixes is
> now a Library sub-tab (DESIGN-005 D-17). Sections **D-08** and **D-11** carry the amendments.
>
> **Amended by ADR-032 (2026-07-07, owner-directed IA — recorded here as a dated note rather
> than a new plan):** the top row becomes the **universal section rail** (Home · Library ·
> Trash · Bulletin — the same candidate set for every role; a Disabled section still hides its
> entry) and the user menu becomes the **role-gated personal/tooling menu**: My Plex (everyone),
> Ledger (section ≠ Disabled — and the Ledger's no-row default flips to **Disabled**), Trash
> settings (`/settings/trash`, trash = Edit), Admin settings (admin), Sign out — with subtle
> group separators. The Trash **Rules** tab and the Batches tab's **settings card** relocate to
> the new `/settings/trash` page. New section **D-16** is normative; **D-08** and **D-11**
> carry the amendments; DESIGN-009 D-01 / DESIGN-010 D-09 / DESIGN-011 D-07 carry pointers.
>
> **Amended 2026-07-10 (owner design review of the live MOTD):** the MOTD message is now a
> **sanitized markdown subset** rendered React-element-only (links/bold/italic/code/breaks/lists —
> no HTML, no `dangerouslySetInnerHTML`, http(s)-only hrefs), the severity glyph is a **themed
> inline SVG** (the D-09 idiom — **never an OS emoji**), the banner layout is a first-line-aligned
> glyph · message · dismiss grid, and `/admin/motd` gains a real-component live preview + a
> "Markdown supported" affordance + an Insert-link helper. Message budget 280 → **500**. New
> section **D-17** is normative; **D-15** carries a pointer. ADR-027's plain-text message-format
> point (Open #2) is revised by D-17 with its no-injection-surface property preserved by
> construction; everything else in ADR-027 stands.
>
> **Amended by PLAN-036 (2026-07-11):** the tabbed hubs' screen-level view switches now `router.push`
> (a history entry) rather than `router.replace`, so browser Back/Forward navigate between tabs
> (restoring each tab's URL-carried filter state) instead of exiting the app screen; refinements
> (filter/sort/search/pagination) and canonicalizing redirects stay `router.replace`. New section
> **D-19** is normative (the history-navigation contract). No visual change; ADR-015 untouched.
>
> **Amended by ADR-058 (2026-07-14, PLAN-047):** every wall card across the estate (Library kinds,
> group aggregates, Goodreads items, Trash pending/batch tiles, Helpdesk ticket tiles) is now
> rendered by the **shared card family** in `apps/web/components/cards/` — typed slots, no children
> escape hatch — and the raw card-anatomy classes are lint-locked outside that package. New section
> **D-21** is normative (the component contract, the guard, and the `/e2e/card-gallery` drift gate).
> Pixel-neutral: the family emits the pre-refit markup verbatim.
>
> **Amended 2026-07-14 (owner-ratified from an approved mockup) — the NAV RESTRUCTURE:** the top row
> slims to FOUR entries — **Home · Library · Tickets · Trash** — and Metrics + Integrations move into
> the **user menu** (each gated exactly like its former tab). "Tickets" is the `bulletin` section
> under its **ratified name** (`HELPDESK_NAME` — a label change; route/section id stay `bulletin`);
> its page keeps the `[Tickets] [Feed]` inner tabs. Relocated routes leave no stale top-nav tab
> highlighted. New section **D-22** is normative; **D-16** carries the amendment. No route/grant/
> migration change; ADR-015 untouched.

- **Donors:** `../demo-console/apps/shell/src/shell/theme/` (tokens.css, tokenContract.ts, ThemeProvider.tsx, app.css), `../demo-console/packages/shared/layout/`, `../demo-console/apps/shell/src/shell/chrome/` (TopBar, SettingsDrawer), `../demo-console/scripts/lint-css-hex.mjs`.

## Overview

Phase 1 UI = the demo-console theme/layout system ported into the Next.js App Router
app, plus six pages: dashboard `/`, `/login`, and four admin pages. The port keeps the
demo-console **token names and initial values byte-identical** so a later rebrand is an
edit to `tokens.css` and nothing else (R-61, ADR-005). Additions over the donor:
localStorage theme persistence + `prefers-color-scheme` seeding, a pre-hydration
`data-theme` script (Next SSR has no static `index.html` to stamp), and the responsive
behaviors PRD R-60/AC-10 demand (auto-fill tile grid, collapsing topbar, table→card
admin lists).

File placement (as shipped — no `apps/web/src`; theme/layout/icons live in
`@hnet/ui`, routes in the Next App Router under `apps/web/app`):

```
packages/ui/src/theme/         tokens.css, tokenContract.ts, ThemeProvider.tsx
                               (imported as @hnet/ui and @hnet/ui/theme/tokens.css)
packages/ui/src/layout/        HeightBudget.tsx, ReservedPane.tsx, useAvailableHeight.ts, layout.css
                               (@hnet/ui + @hnet/ui/layout/layout.css)
packages/ui/src/icons/         registry.ts + components.tsx — inline currentColor SVG
                               registry (ICON_KEYS — DESIGN-003 D-10), imported as @hnet/ui/icons
apps/web/app/layout.tsx        root server layout: pre-hydration theme script (D-03),
                               next/font Outfit, ThemeProvider + TRPCProvider
apps/web/app/app.css           app-frame + component CSS (the demo-console app.css port)
apps/web/app/login/page.tsx    public login (outside the (app) group)
apps/web/app/(app)/            authed route group — layout.tsx (session gate + chrome),
                               page.tsx (dashboard), greeting.tsx, library/, my-fixes/,
                               admin/ (see D-11 for the full route inventory)
apps/web/components/           shared page-local components: top-bar.tsx, brand-mark.tsx,
                               kind-icon.tsx, modal.tsx
apps/web/lib/                  client/server helpers: initials.ts, route-gate.ts,
                               greeting.ts, auth-client.ts, trpc-*.ts
scripts/lint-css-hex.mjs       hex guard (ported)
```

## Detailed design

### D-01 — Theme tokens: same names, same values, new theme keys

`packages/ui/src/theme/tokens.css` (imported by the root layout as
`@hnet/ui/theme/tokens.css`) is the demo-console file with only the theme selector
keys and brand string changed:

- `[data-theme='hnet-dark']` — **default**; values copied from `demo-console-dark`
  (accent `#78be20`, bg `#000000`, surfaces `#111317`/`#1a1d22`, … verbatim).
- `[data-theme='hnet-light']` — values copied from `demo-console-light`.
- `:root` structural block unchanged (`--radius`, `--radius-sm`, `--space`, `--font`,
  `--scrollbar-size`, `--color-nav-active: var(--color-accent)`) except
  `--brand-name: 'haynesnetwork'`.

The full required-token list is exactly demo-console's `REQUIRED_TOKENS` (accent,
accent-contrast, bg, surface, surface-2, border, text, text-muted, topbar, nav-active,
danger, warning, info, the three scrollbar colors, radius, radius-sm, space, font,
shadow). Rebranding later = edit `tokens.css` values only; no markup or component
change (ADR-005). Initial values keep the demo-console green — final palette is Q-03.

> **DESIGN-006 update:** the "same values" rule now applies to the _palette_
> only. The identity pass diverged the structural values — `--radius` 16px,
> `--radius-sm` 10px, `--font` = self-hosted Outfit via the `--font-outfit`
> next/font variable (system-ui fallback chain). Token names untouched.

`tokenContract.ts` ports verbatim with:

```ts
export const THEMES = ['hnet-dark', 'hnet-light'] as const;
export const DEFAULT_THEME: ThemeName = 'hnet-dark';
export const THEME_STORAGE_KEY = 'hnet-theme';
```

`missingTokens(el)` stays as the test hook proving both themes satisfy the contract.

### D-02 — ThemeProvider (client component) with persistence

Donor `ThemeProvider.tsx` extended, shipped at `packages/ui/src/theme/ThemeProvider.tsx`
and consumed via `@hnet/ui` (`ThemeProvider` in the root layout, `useTheme()` in the
TopBar). It remains **the single writer of `<html data-theme>`** after hydration:

```tsx
'use client';
function initialTheme(): ThemeName {
  if (typeof document === 'undefined') return DEFAULT_THEME; // SSR pass of a client component
  const existing = document.documentElement.getAttribute('data-theme');
  return THEMES.includes(existing as ThemeName) ? (existing as ThemeName) : DEFAULT_THEME;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<ThemeName>(initialTheme);

  // Adopt whatever the pre-hydration script stamped (D-03) — covers the SSR
  // pass having seeded DEFAULT_THEME.
  useEffect(() => {
    setCurrent(initialTheme());
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', current);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, current);
    } catch {
      /* private mode */
    }
  }, [current]);
  // ...context identical to donor: { current, setTheme }
}
```

Port notes: add `'use client'`; the donor's `JSX.Element` return annotations become
`React.ReactElement` (no global JSX namespace under the React 19 types).

### D-03 — Pre-hydration `data-theme` script (no theme flash)

demo-console is a static Vite `index.html` that hard-codes
`<html data-theme="demo-console-dark">`. Next SSR needs the same guarantee **before
first paint**, so the root layout server-renders the default attribute and an inline
blocking script in `<head>` corrects it from storage / OS preference before any
content paints:

```tsx
// apps/web/app/layout.tsx (root server component)
const themeInit = `(function(){try{
  var t=localStorage.getItem('hnet-theme');
  if(t!=='hnet-dark'&&t!=='hnet-light'){
    t=window.matchMedia('(prefers-color-scheme: light)').matches?'hnet-light':'hnet-dark';
  }
  document.documentElement.setAttribute('data-theme',t);
}catch(e){document.documentElement.setAttribute('data-theme','hnet-dark');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // outfit.variable carries the --font-outfit next/font var (DESIGN-006 D-02).
    <html lang="en" data-theme="hnet-dark" className={outfit.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <ThemeProvider>
          <TRPCProvider>{children}</TRPCProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
```

Rules encoded here (R-61):

- **Seeding order:** stored `hnet-theme` value wins; otherwise `prefers-color-scheme`
  (light → `hnet-light`, everything else → `hnet-dark`); dark is the no-JS/failed-JS
  fallback via the server-rendered attribute.
- `suppressHydrationWarning` on `<html>` only — React must not warn when the script's
  attribute differs from the server-rendered default.
- The script is inline and blocking (a plain `<script>` in head, not `next/script`),
  so it runs before body paint; it must stay dependency-free ES5.
- The script writes the attribute **once**; ThemeProvider owns it afterwards (D-02).

### D-04 — Hex-lint guard + CI (CLAUDE.md hard rule 2)

Port `demo-console/scripts/lint-css-hex.mjs` unchanged in behavior: scan `apps/**` and
`packages/**` for `*.css`, fail on any hex literal outside a file named `tokens.css`.
Wire as `pnpm lint:css`, included in `pnpm lint`, and run in the required
`lint-and-typecheck` CI job (R-65). Non-CSS color literals are kept out of TSX by code
review + the same guard extended to inline `style=` strings if violations ever appear
(donor precedent: an eslint `no-restricted-syntax` rule — adopt if needed).

### D-05 — Layout primitives (packages/ui) and the app frame

`HeightBudget`, `ReservedPane`, `useAvailableHeight`, and `layout.css` port verbatim
from `demo-console/packages/shared/layout/` into `packages/ui/src/layout/` (exported via
`@hnet/ui` + `@hnet/ui/layout/layout.css`; structural only — no colors, per the donor's
normative comment). The authed app frame lives in `apps/web/app/(app)/layout.tsx`
(56px topbar `flex:none` + `<main>` scroll region); frame rules from the ported
`apps/web/app/app.css`:

- `html, body { height: 100%; margin: 0; overflow: hidden; }` — **the page never
  scrolls** (AC-10: no page-level scrollbars at any matrix size). `overflow: hidden` is on
  **`html` too**, not just `body`: with only `body` clipping, the documentElement still
  reports the internally-scrolled `<main>`'s overflow as a phantom page scroll.
- App shell = flex column: topbar (56px, `flex: none`) + `<main>` (`flex: 1 1 auto;
min-height: 0; overflow: auto`) — content scrolls internally.

> **Layout hardening (shipped alongside ADR-012):** `apps/web/app/app.css` `.app` is now
> `position: fixed; inset: 0` (plus `display: flex; flex-direction: column; overflow: hidden`)
> — the shell is pinned out of normal flow so the document itself has **no** scrollable content
> and `<main>` is the only scroll pane. This fixes a phantom page scroll Chromium reports for a
> tall, internally-scrolled flex column (AC-10 / R-60); the resize matrix proves it.

- Admin pages that need multi-pane budgets use `HeightBudget rows="auto minmax(0,1fr)"`
  - `ReservedPane`, same contract as the donor.

### D-06 — Responsive additions (R-60, AC-10)

Beyond the donor (which is desktop-console-shaped), three phone-first behaviors:

1. **Tile grid** — `.tile-grid { display: grid; grid-template-columns:
repeat(auto-fill, minmax(160px, 1fr)); gap: var(--space); }`. At
   `@media (max-width: 480px)`: `gap: 10px`, main padding drops to `12px`. Yields 2
   columns at 375–412px, no horizontal scroll.
   _(DESIGN-006: tiles are now horizontal cards on `minmax(280px, 1fr)` — one
   column on phones; the no-horizontal-scroll invariant is unchanged and still
   proven by the resize matrix.)_
2. **Topbar collapse** — under 480px the user-menu trigger drops the displayName text
   and renders the avatar/initial only (`.usermenu__name { display: none }`); brand
   text stays. All triggers keep ≥44px hit area.
3. **Admin tables → card lists under 760px** — CSS-only, no second component tree.
   Every `<td>` carries `data-label` matching its column header:

   ```css
   @media (max-width: 759px) {
     .admin-table thead {
       position: absolute;
       clip-path: inset(50%); /* sr-only */
     }
     .admin-table,
     .admin-table tbody,
     .admin-table tr,
     .admin-table td {
       display: block;
     }
     .admin-table tr {
       background: var(--color-surface);
       border: 1px solid var(--color-border);
       border-radius: var(--radius);
       margin-bottom: 10px;
     }
     .admin-table td {
       display: flex;
       justify-content: space-between;
       gap: 12px;
     }
     .admin-table td::before {
       content: attr(data-label);
       font-weight: 600;
       color: var(--color-text-muted);
     }
   }
   ```

   Known caveat: `display: block` drops table semantics for screen readers in card
   mode; source order stays label-then-value so content remains linear-readable.
   Acceptable for the household-scale admin surface; revisit if it ever grows.

Proven by the Playwright resize matrix (AC-10): 375×667, 390×844, 412×915, 768×1024,
820×1180, 1280×800, 1920×1080, 2560×1440 — no page scrollbars, no off-screen controls,
panes scroll internally.

### D-07 — Dashboard `/` (R-10, R-12, AC-04, AC-05)

Data: `catalog.myApps` (DESIGN-003 D-06) — never `profile.me` — prefetched server-side
via the tRPC server caller, hydrated into React Query. Default React Query
`refetchOnWindowFocus`/`refetchOnMount` satisfies AC-05's "next dashboard query (or
live refresh)" without sockets.

- Greeting: time-of-day (`Good morning/afternoon/evening, {displayName}`), computed
  client-side; `profile.me` supplies the name.
- Tile = one `<a>` (whole tile is the target, min-height well above the 44px touch
  minimum): icon (inline `currentColor` SVG by the entry's `icon` registry key;
  null/unknown key → generic glyph — DESIGN-003 D-10), name, one-line clamped
  description, and an external-link `↗` affordance (decorative, `aria-hidden`, not a
  separate target). Accessible name = app name + visually-hidden "(opens in new tab)".
- Tiles open in a new tab: `target="_blank" rel="noopener noreferrer"` — the hub stays
  behind the launched app (launchpad convention).
- Hrefs come straight from the API and are guaranteed to be a valid `http(s)` URL
  (ADR-013: any host allowed; normalized at write time, DESIGN-003 D-04); the UI never
  constructs the URL. Tiles still open with `target="_blank" rel="noopener noreferrer"`.
- Empty state (no visible apps — possible if an admin unsets defaults): a `.card`
  saying "No apps yet — ask your admin", no dead grid.

### D-08 — Chrome: TopBar, theme toggle, user menu

`apps/web/components/top-bar.tsx` (a `'use client'` component rendered by the authed
`(app)/layout.tsx`) ports the donor's structure (`.topbar`, `.brand`,
`.topbar__spacer`, `.topbar__actions`, `.iconbtn`) minus i18n (copy is hard-coded
English; no i18n in this app) and minus the notifications button:

- **Brand:** the hub-and-spoke mark (`apps/web/components/brand-mark.tsx`,
  `currentColor` accent — DESIGN-006 D-01, resolving Q-01). The `haynesnetwork`
  wordmark text renders from the `--brand-name` token via `.brand__name` CSS `content`
  (with an `sr-only` copy for the accessible name), so a rebrand stays a
  `tokens.css`-only edit (R-61).
- **Primary nav** (Phase 2 addition — `.topbar__nav`, `<nav aria-label="Primary">`):
  **Home** (`/`) + **Library** (`/library`, every signed-in user — R-43), rendered
  between the brand and the spacer.
  > **Amended 2026-07-05:** the nav is **now shown on phones** — its `display: none`
  > under 600px is relaxed. Previously it hid under 600px and the collapsed
  > destinations lived in the user-menu popover; the user menu no longer carries them
  > (see the User-menu note below), so the top-nav must stay reachable at all widths.
  >
  > **Amended 2026-07-06 (PLAN-005 / DESIGN-009 D-01):** a **Ledger** entry (`/ledger`)
  > renders between Library and My Plex whenever the session's Ledger section level is
  > at least Read-Only (ADR-021; hidden for Disabled roles — the route is additionally
  > server-gated). With four links, a ≤479px rule tightens topbar gaps/padding so the
  > row still fits 375px phones.
  >
  > **Amended 2026-07-07 (ADR-032 — see D-16):** the row is now the **universal section
  > rail**: Home · Library · **Trash** · **Bulletin** only. **Ledger and My Plex moved to
  > the user menu.** With at most four links the phone rules scale UP instead of down:
  > 14px labels / 8px 14px padding at desktop, 13px / 8px 10px under 600px, and the ≤479px
  > rule now tightens only the chrome (topbar gap/padding, action gap) — labels stay 13px
  > with ≥44px targets at 375/390px. The wordmark still yields to the mark alone <600px.
  >
  > **Amended 2026-07-12 (nav-overlap fix — ADR-037 added a fifth link):** the Metrics
  > entry (`/metrics`, D-05 of DESIGN-016) landed after the four-link tuning above, so the
  > rail now carries **up to five** links (Home · Library · Trash · Bulletin · Metrics).
  > Below ~375px five links no longer fit, and because `.topbar__nav` had `min-width: 0`
  > with the default `overflow: visible` the surplus links overflowed **visibly** rightward
  > and slid under the theme toggle (owner-reported on a 360px-class phone; the resize matrix
  > never caught it because its smallest size is 375px, where five links still fit). Fix: the
  > rail is now a **self-contained horizontal scroll pane** — `overflow-x: auto`
  > (`overflow-y: hidden`, scrollbar hidden), links `flex: none; white-space: nowrap` so they
  > never squish/wrap, plus a 4px `padding-block` so the scroll clip doesn't eat link focus
  > rings. A track appears only when the links can't fit, so desktop and ≥375px phones are
  > untouched; page-level scroll stays impossible (D-05) and the confined overflow can no
  > longer overrun the actions. Swiping the rail moves nothing else (ADR-015-safe). No
  > hamburger/menu redesign — the visual identity is unchanged.
- **Theme toggle:** the donor SettingsDrawer's segmented dark/light control simplified
  to a single topbar `iconbtn` that flips `hnet-dark ↔ hnet-light` via
  `useTheme().setTheme`. Sun and moon SVGs are **both in the DOM**, shown/hidden by
  `[data-theme] .icon-sun/.icon-moon` CSS — no theme-dependent JSX, so no hydration
  mismatch with the pre-hydration attribute (D-03). The label is neutral
  ("Toggle theme") on the SSR + first client render and resolves to "Switch to light
  theme" / "Switch to dark theme" post-mount (`useSyncExternalStore` mounted flag),
  keeping `aria-label`/`aria-pressed` off the hydration path. No settings drawer in
  Phase 1 — the toggle is the only setting.
- **User menu:** button (avatar initial via `initialFor()` + displayName; name hidden
  <480px, D-06) opening a popover: displayName + email header, then menu items.
  > **Amended 2026-07-05 (settings-only user menu):** the popover is now purely a
  > settings/identity surface — displayName + email header, then **Admin settings**
  > (`/admin`, rendered only when `user.role.isAdmin` — ADR-012; label changed from the
  > former "Admin" to "Admin settings") and **Sign out** (Better Auth
  > `authClient.signOut()` → `router.push('/login')` + `router.refresh()`). The former
  > **Library** (`/library`) and **My fixes** (`/my-fixes`) menu items are **removed**:
  > Library lives solely in the top-nav (`.topbar__nav`, now shown on phones — see the
  > Primary-nav note) and My Fixes is now a Library sub-tab (`/library?tab=my-fixes`,
  > DESIGN-005 D-17). Popover behavior is otherwise unchanged: Esc closes and returns
  > focus to the trigger, click-outside (pointerdown) closes,
  > `aria-expanded`/`aria-haspopup="menu"` on the trigger, `role="menu"` +
  > `role="menuitem"` on the items.
  >
  > **Amended 2026-07-07 (ADR-032 — see D-16):** the popover is now the **role-gated
  > personal/tooling menu**: identity header → **My Plex** → separator → **Ledger** (section
  > ≠ Disabled) · **Trash settings** (trash = Edit) · **Admin settings** (admin) → separator
  > → **Sign out**. Behavior (Esc/click-outside/ARIA) unchanged; it remains an overlay, so
  > opening it never reflows the page (ADR-015).

Admin sub-nav (`apps/web/app/(app)/admin/layout.tsx`, `<nav aria-label="Admin
sections">`, `.admin-nav`): five entries — **Users** (`/admin`), **Catalog**
(`/admin/catalog`), **Roles** (`/admin/roles` — ADR-012, replaces the former **Tags**
`/admin/tags`), **Fixes** (`/admin/fixes`), **Restore** (`/admin/restore`). Flex row that
wraps on phones; renders only after the layout's server-side Admin gate passes (D-11).

### D-09 — Icons

All icons are inline `<svg>` with `stroke`/`fill` = `currentColor` (donor pattern) from
the `packages/ui/src/icons` registry (`registry.ts` + `components.tsx`, imported as
`@hnet/ui/icons`) keyed by `ICON_KEYS` (DESIGN-003 D-10). No icon fonts, no CDN, no
`<img>` for icons — they theme with the tokens and ship self-contained.

### D-10 — Accessibility & motion

- Global `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }`
  — keyboard focus always token-colored, visible in both themes.
- `@media (prefers-reduced-motion: reduce) { *, *::before, *::after {
transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; } }`
  — kills the popover/drawer transitions and any spinner rotation.
- Touch targets ≥44px (tiles, topbar buttons, card-list rows' action buttons).
- Semantic landmarks: `<header>` topbar, one `<main>`, `<nav>` for the admin sub-nav.

### D-11 — Pages & routing

Authoritative route inventory (Phase 1 + Phase 2 as shipped). Every route lives under
`apps/web/app`; the `(app)` group is the authed frame (`(app)/layout.tsx` session gate

- chrome), `/login` sits outside it. `apps/web/README.md` points here rather than
  re-listing routes.

| Route               | Access                             | Page file (under `apps/web/app`)  | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`            | public                             | `login/page.tsx`                  | Centered `.card`: brand mark + wordmark + single **Sign in** button → Better Auth Authentik OIDC flow (AC-01 — no password form). Session present → server-redirects to `/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/`                 | authed                             | `(app)/page.tsx`                  | Dashboard (D-07): greeting + app-launcher tile grid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/library`          | authed                             | `(app)/library/page.tsx`          | Synced media library (Phase 2). **Movies · TV · Music · My Fixes** sub-tabs (WAI-ARIA tablist, active tab via `?tab=`, default **Movies**, no "All" — 2026-07-05). Each media tab scopes the searchable/filterable *arr list to one `arrKind` (movies→radarr, TV→sonarr, music→lidarr); season grouping for series. The **My Fixes** tab hosts the caller's fix/force-search ledger (`fix.myFixes`, relocated from the account menu — DESIGN-005 D-17).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/library/[id]`     | authed                             | `(app)/library/[id]/page.tsx`     | Item detail + write-back actions: Fix, Force Search, roll-up scopes (ADR-011); `item-detail.tsx` + `fix-dialog.tsx` + `force-search-dialog.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `/my-fixes`         | authed                             | `(app)/my-fixes/page.tsx`         | **Legacy route — server-redirects to `/library?tab=my-fixes` (2026-07-05).** My Fixes is now a Library sub-tab; the redirect keeps old deep links working.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/ledger`           | authed, Ledger section ≥ Read-Only | `(app)/ledger/page.tsx`           | **(PLAN-005 — DESIGN-009.)** The Ledger section: Movies · TV · Music sub-tabs over a frozen-pane spreadsheet of the WHOLE ledger (tombstones included), the shared filter chips + `?mon`/`?file` dims, JSONL export of the current filter, and the Edit-gated bulk **Monitor & search** (Modal confirm → per-item run report). Disabled roles get a clean "not available" state (`ledger-client.tsx` renders the section; the server page gates).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/settings/trash`   | authed, Trash section = Edit       | `(app)/settings/trash/page.tsx`   | **(ADR-032 — D-16; TABBED hub as of build B, D-16a.)** The Trash settings hub: safety banner above a `?tab=`-driven tablist (`.library-tabs`) — **General** (admin gate + default save window + the Notifications delivery window, moved from `/admin/storage`), **Storage** (utilization meters + space targets + Space policy + Batch policy + the Grafana deep-link, all moved from `/admin/storage`), **Reclaim** (the reclaim-attribution report, moved from `/admin/storage`), and **Rules** (the Maintainerr rules list). Page gate is Trash-Edit; General/Storage/Reclaim read adminProcedures so they are admin-only tabs — a trash-edit-but-not-admin viewer sees only **Rules**. Reached from the user menu ("Trash settings"). Below Edit renders the clean "not available" state (`trash-settings-unavailable`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/admin`            | Admin                              | `(app)/admin/page.tsx`            | Users list: table (cards <760px) of displayName, email, **Role** (ADR-012 — no Family/Tags/Grants columns) → row links to detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/admin/users/[id]` | Admin                              | `(app)/admin/users/[id]/page.tsx` | A single **Role `<select>`** → `users.setRole` (ADR-012); the role's apps shown read-only for context (edit them on `/admin/roles`); LAST_ADMIN/not-found surface in the alert (`user-detail.tsx`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/admin/catalog`    | Admin                              | `(app)/admin/catalog/page.tsx`    | Entries table. **Add** opens a `Modal` (`components/modal.tsx`) with the create form; **Edit** expands the row _in place_ into an inline editor (no shared bottom form). The **URL is a plain text field** (ADR-013 — any `http(s)` URL, any host): the admin types a URL and the client normalizes it for live feedback via `normalizeCatalogUrl`/`catalogUrlError` (mirror in `lib/catalog-url.ts` of the authoritative `packages/domain` copy — DESIGN-003 D-04); the domain re-normalizes and is authoritative on write. Bare hosts default to `https://`, an explicit scheme is preserved; an unparseable/non-http(s) value surfaces inline. Icon picker, reorder → `catalog.reorder`. The slug input's `pattern` is `[a-z0-9\-]+` (the un-escaped `[a-z0-9-]+` is invalid under the browser `v`-flag regex engine and silently blocked the Add form's native submit); inline validation errors render as a prominent `.field-error` pill. Icon picker; **reorder is native-HTML5 drag-and-drop + keyboard arrow-move** (grip glyph `⠿` doubles as the keyboard handle, `aria-live` announces each move) — the whole row drags, and the drop commits the **full `orderedIds` array to `catalog.reorder`** optimistically (ADR-015 / D-14; replaces the old `↑`/`↓` buttons). _(ADR-012: the "Default" column + defaultVisible checkbox are removed.)_ |
| `/admin/roles`      | Admin                              | `(app)/admin/roles/page.tsx`      | **(ADR-012 — replaces `/admin/tags`.)** Roles table (name/description, app chips, member count, `superuser`/`default`/`all apps` badges) + **Add-role modal** + **edit-in-place** inline editor (name + description + app checklist), the same UX as `/admin/catalog`. The app checklist leads with an **"All apps"** checkbox (`grants_all` — every app incl. ones added later) that, when on, **greys out + disables the per-app list** and shows all boxes checked; a non-admin all-apps role gets an `all apps` badge and its Apps cell reads "All apps". Admin row locked (all apps · superuser, no edit/delete); Default row apps editable but no rename/delete. Assigning a role to a user happens on the user detail page. **2026-07-06 (PLAN-005 / ADR-021):** a **Ledger** column carries each role's section-access `<select>` (Edit / Read-only / Disabled, applies on change → `roles.setSectionPermission`); the Admin row shows its implicit Edit, uneditable. Trash is reserved for PLAN-006.                                                                                                                                                                                                                                                                                                                                              |
| `/admin/fixes`      | Admin                              | `(app)/admin/fixes/page.tsx`      | All-users fix/force-search ledger (Phase 2): cross-user audit view of write-back actions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/admin/restore`    | Admin                              | `(app)/admin/restore/page.tsx`    | Failsafe restore surface (Phase 2, ADR-008/011): re-push a ledger snapshot back to the *arrs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Signed-out landing: any route inside `(app)` without a session redirects to `/login`
— the gate is server-side in `(app)/layout.tsx` via `getServerSession` +
`protectedRouteRedirect` (`apps/web/lib/route-gate.ts`), no tRPC round-trip
(DESIGN-003 alternatives). `/admin/*` adds `protectedRouteRedirect(..., { requireAdmin:
true })` in `(app)/admin/layout.tsx`; non-Admin → `redirect('/')`. Both checks are
server-side; the client never sees admin markup it can't use.

### D-12 — Wireframes

Desktop dashboard (≥1280):

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ▦ haynesnetwork                                        (☾)  (T) Tom ▾      │ 56px, flex:none
├────────────────────────────────────────────────────────────────────────────┤
│  Good evening, Tom                                                         │
│                                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ ◍          ↗ │  │ ▶          ↗ │  │ ⬢          ↗ │  │ ⬡          ↗ │    │
│  │ Seerr        │  │ Plex         │  │ K8Plex       │  │ Immich       │    │  main:
│  │ Request …    │  │ Watch …      │  │ Watch (k8s)… │  │ Photos …     │    │  flex:1,
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │  min-height:0,
│  ┌──────────────┐                                                          │  scrolls
│  │ …            │   repeat(auto-fill, minmax(160px, 1fr))                  │  internally
│  └──────────────┘                                                          │
└────────────────────────────────────────────────────────────────────────────┘
   html/body overflow:hidden — the page itself never scrolls (AC-10)
```

Phone dashboard (375×667):

```
┌───────────────────────────┐
│ ▦ haynesnetwork   (☾)(T)  │  ← user-menu name collapsed (D-06)
├───────────────────────────┤
│ Good evening, Tom         │
│ ┌───────────┐ ┌─────────┐ │
│ │ ◍       ↗ │ │ ▶     ↗ │ │
│ │ Seerr     │ │ Plex    │ │  2 columns, gap 10px,
│ │ Request…  │ │ Watch…  │ │  12px page padding
│ └───────────┘ └─────────┘ │
│ ┌───────────┐ ┌─────────┐ │
│ │ ⬢       ↗ │ │ ⬡     ↗ │ │
│ │ K8Plex    │ │ Immich  │ │  ↕ grid scrolls inside main
│ └───────────┘ └─────────┘ │
└───────────────────────────┘
```

`/admin` users list — desktop table and its <760px card transform (D-06):

> **ADR-012 note:** the wireframe below predates the role model — the shipped roster columns
> are just **Name · Email · Role** (no Fam/Tags columns); the card view shows the same three.

```
Desktop (≥760px)                              Phone (<760px)
┌──────────────────────────────────────────┐  ┌─────────────────────────┐
│ ▦ haynesnetwork            (☾) (T) Tom ▾ │  │ ▦ haynesnetwork (☾)(T)  │
├──────────────────────────────────────────┤  ├─────────────────────────┤
│ Users                                    │  │ Users                   │
│ ┌──────────────────────────────────────┐ │  │ ┌─────────────────────┐ │
│ │ Name      Email      Role   Fam Tags │ │  │ │ Sam Haynes          │ │
│ ├──────────────────────────────────────┤ │  │ │ Email  sam@…        │ │
│ │ Sam H.    sam@…      Member ✓  fam   │ │  │ │ Role   Member       │ │
│ │ Tom H.    manofoz@…  Admin  ✓  —     │ │  │ │ Family ✓            │ │
│ │ Pat G.    pat@…      Member ─  media │ │  │ │ Tags   fam          │ │
│ └──────────────────────────────────────┘ │  │ └─────────────────────┘ │
│   rows link to /admin/users/[id]         │  │ ┌─────────────────────┐ │
│                                          │  │ │ Tom Haynes          │ │
└──────────────────────────────────────────┘  │ │ …  td::before =     │ │
                                              │ │    attr(data-label) │ │
                                              └─────────────────────────┘
```

### D-13 — Inline two-step confirmation: `ConfirmButton` / `useConfirm` (ADR-014)

> **Superseded in part by D-14 / ADR-015 (2026-07-05):** the armed look and width reservation
> below are OUT OF DATE — the armed state is now `--color-danger-strong` and the reservation is
> `.btn.confirm-btn { min-width: 6.5rem }` (specificity-correct). See **D-14** for the current
> normative contract; the paragraphs here are kept for history.

> **Added by ADR-014 (2026-07-05).** Destructive-delete confirmation is an inline two-step
> arm-to-confirm button, not native `window.confirm`. Mechanism ported from demo-console; the
> armed _look_ is ours (token-only `app.css`, port-mechanism-not-look — DESIGN-006).

`@hnet/ui` ships a `ConfirmButton` (thin wrapper) over a headless `useConfirm` hook at
`packages/ui/src/controls/ConfirmButton.tsx` (`'use client'`, re-exported from
`packages/ui/src/index.ts`). Normative contract:

- **Two-step / auto-revert:** first click **arms**; a second click within `CONFIRM_MS` (module
  constant, **3000ms**) fires `onConfirm`; otherwise a single timer **auto-reverts** after 3s.
  The only reverts are the timeout and firing — no blur / pointer-leave / Escape / outside-click.
  Disarm-before-fire + a per-instance armed boolean prevents a double fire (no disable/debounce).
- **Relabel + tint on arm:** armed, the button shows `confirmLabel` (default **"Confirm?"**),
  gains the `confirming` class, and sets `data-armed`. It always carries the base `confirm-btn`
  class. The armed look is `var(--color-danger)` (text + border + a `color-mix` background tint)
  from `apps/web/app/app.css` `.confirm-btn.confirming` — token-only, no raw hex (hard rule 2).
- **No-reflow width reservation:** `.confirm-btn { min-width: 5rem }` reserves width so
  relabeling to "Confirm?" cannot reflow the row.
- **Accessible name swaps:** resting `aria-label` **must end with "— click twice to confirm"**;
  armed, it becomes the caller's `confirmAriaLabel`. `onClick` calls `stopPropagation` so a row's
  own click never fires from the button.
- **`onConfirm` / `reArmOnFailure`:** `onConfirm` may return `void` or a `Promise<'ok' | 'failed'
| void>`; with `reArmOnFailure`, resolving the literal `'failed'` re-arms.
- **Scope:** replaces the **two** `window.confirm` sites — the catalog-row Delete and role-row
  Delete in D-11 (`data-testid` `catalog-row-delete` / `role-row-delete`, keeping their existing
  `btn sm danger` + disabled logic). Explanatory / multi-field confirms (failsafe restore, Fix,
  Force-search) **stay `Modal`s** (DESIGN-005) — this is not a modal-to-button conversion. The
  role-reassignment `<select>` on the user detail page has no confirm and is a deferred follow-up
  (ADR-014 C-05).
- **e2e:** target by `data-testid` (the name changes on arm), not by button text — click, assert
  the button reads "Confirm?", click again, assert the filtered row is gone. Native-dialog
  handlers are removed (ADR-014 C-04).

### D-14 — No layout reorientation on interaction (ADR-015)

> **Added by ADR-015 (2026-07-05).** Page contents must not re-orient when a user interacts
> (CLAUDE.md hard rule 9): an interaction may change color/emphasis but must NOT reflow or
> reposition neighbors. Sanctioned exceptions: in-place expansions (the catalog inline editor,
> D-11) and drag-and-drop reordering (below). Mechanisms ported from demo-console; the look is
> ours (token-only, port-mechanism-not-look — DESIGN-006).

**(1) `/admin/catalog` reorder — drag-and-drop + keyboard, full `orderedIds`.** The `↑`/`↓`
`.btn.sm` buttons are replaced by native-HTML5 drag-and-drop over the dependency-free `@hnet/ui`
`useReorderDnD` hook (pure geometry helpers `computeDropIndex` / `resolveReorderIndex`, DOM-free
and unit-tested). Normative contract:

- The whole data `<tr>` is `draggable`; a grip glyph (`⠿`) in the Order cell is the visual
  affordance AND the keyboard handle — focus it and **ArrowUp/ArrowDown move the row one slot**,
  each move announced through a visually-hidden `role="status" aria-live="polite"` region (e.g.
  "Moved <name> to position N of M"). `aria-keyshortcuts="ArrowUp ArrowDown"`.
- A **zero-height drop indicator** (`box-shadow: inset 0 2px 0 0 var(--color-accent)` on the
  target row via `tr.drop-before td`) marks the drop position without reflow; the dragged row
  dims (`tr.dragging { opacity: 0.4 }`). Both are token-only.
- The drop commits the **full reordered id array** to the unchanged `catalog.reorder` mutation,
  applied **optimistically** (`onMutate` snapshot + local reorder, `onError` restore) so the drop
  feels instant and never snap-backs; `onSettled` invalidates. Reorder is disabled while a row is
  in its inline editor (`editingId !== null`) or a mutation is in flight.
- The grip keeps its `data-label="Order"` `<td>` so it stays visible in the <760px stacked-card
  layout. Drag itself is not e2e-covered (Playwright `dragTo` is flaky, ADR-015 C-06); the
  keyboard arrow-move path is the e2e target and the geometry is unit-tested.

**(2) Two-step confirm — reserve for the widest label, deepen not reflow.** D-13's `.confirm-btn
{ min-width: 5rem }` reservation never applied: `.btn.sm` (specificity 0,2,0; `min-width: 34px`)
silently outranked `.confirm-btn` (0,1,0), so arming reflowed the row. Corrected here:

- `.btn.confirm-btn` (a specificity-correct 0,2,0 selector that beats `.btn.sm`) reserves
  `min-width: 6.5rem` with `white-space: nowrap` and centered text — sized for the **bold armed
  "Confirm?" label**, so the resting→armed relabel can never reflow neighbors.
- The armed state reads a shade or two **deeper** rather than moving: a new
  **`--color-danger-strong`** token (darker than `--color-danger` in both themes) drives the
  armed text/border and a `color-mix` background tint (`.confirm-btn.confirming`). Call sites keep
  `className="btn sm danger"`; resting stays danger red, armed deepens to danger-strong. This
  supersedes D-13's `var(--color-danger)`-only armed look and its `5rem` width claim.

### D-15 — Dashboard Message-of-the-Day banner (ADR-027 / PLAN-010, R-105)

> **Amended 2026-07-10 (see D-17):** the message is now a **sanitized markdown subset** (was plain
> text; budget 280 → 500), the severity glyph is a **themed inline SVG** (was a text/emoji glyph),
> and `/admin/motd` renders its live preview through the real `<MotdSurface>` with a markdown
> affordance + Insert-link helper. The data model, activation predicate, dismiss-version contract,
> ARIA roles, and audit path below are unchanged.

An optional admin-set banner broadcasts a notice to every signed-in user, mounted at the **top of the
dashboard `page.tsx`, above `<Greeting>`** (the D-07 neighbor). It is **present-when-set** and
**collapses cleanly on dismiss** — never a source of interaction reflow (D-14 / hard rule 9).

- **Data.** No bespoke table — the MOTD reuses the `app_settings` audited store under the key `motd`
  (ADR-027; a jsonb record `{ message, severity, enabled, startsAt, endsAt, updatedBy }`). The domain
  reader `getActiveMotd` returns the record only when **active** (`enabled` + non-blank message +
  within the optional `startsAt`/`endsAt` window; inclusive start, exclusive end) plus a `version`
  string (a hash of `updated_at` + content). Writes go through `setMotd`/`clearMotd` →
  `setAppSetting`, audited in the same tx (`update_app_setting`).
- **Mount + fetch.** `page.tsx` (server component) server-fetches `caller.motd.getActive()` alongside
  `catalog.myApps()` and passes it as a prop to `<MotdBanner motd={…} />` (no loading flash). The
  banner renders nothing when the prop is null.
- **Semantics + tokens.** `role="status"` for `info`, `role="alert"` for `warning`. The severity
  modifier class (`.motd--info` / `.motd--warning`) draws its border, left rule, tint, and icon from
  the **existing** `--color-info` / `--color-warning` tokens via `color-mix()` — **no new token, no
  raw hex** (hard rule 2). No `tokenContract` change.
- **Dismiss.** A dismiss button writes the current `version` to `localStorage['hnet-motd-dismissed']`
  and the banner unmounts. On mount it reads the key (via `useSyncExternalStore` with a neutral server
  snapshot — the hydration-safe pattern D-07's `<Greeting>` uses) and hides only when the stored
  version equals the current one, so an admin edit / re-enable (new `updated_at` → new version)
  **re-shows** it. Collapsing the banner is an **ADR-015-sanctioned deliberate removal** (like the
  catalog inline editor / drag exceptions) — the tile grid simply reclaims the space; nothing reflows
  on hover/arm.
- **Admin compose page `/admin/motd`.** A single static form mirroring the D-11 `/admin/catalog`
  form: a `<textarea maxLength={280}>` message, a severity `<select>`, an `enabled` checkbox, and
  optional `startsAt`/`endsAt` `<input type="datetime-local">` (converted to UTC ISO on the wire). A
  live preview reuses the real `.motd` classes; changing severity recolors **only** the preview, never
  the layout (D-14). **Save** → `motd.set`; **Clear** → `motd.clear` behind a `@hnet/ui`
  **`ConfirmButton`** (inline two-step — clearing removes something users see; never `window.confirm`,
  hard rule 8). The admin sub-nav (D-10) gains a **"MOTD"** link.

### D-16 — Universal top row + role-gated user menu (ADR-032, owner-directed 2026-07-07)

Owner direction (2026-07-07, verbatim intent): "My Plex" is user settings → the dropdown;
Ledger → the dropdown, role-gated, admin-only by default; the Trash rules + settings are real
settings → a settings page under the dropdown. This keeps the top row consistent for all
roles while admins get more dropdown items, and frees top-row space for larger touch targets
on mobile. Recorded here as the normative IA (a dated DESIGN-004 note per the owner's
process call — no new plan doc).

- **Top row (universal section rail):** `Home · Library · Trash · Bulletin` — the same
  candidate set for every role. Section gating unchanged: a `disabled` section hides its
  entry (Trash's no-row default IS disabled; Bulletin's is read_only) and every route stays
  server-gated. No role-variant items ride the row anymore. Sizing: 14px/8×14 desktop →
  13px/8×10 <600px → chrome-only tightening ≤479px (see the D-08 amendment).
- **User menu (personal / tooling groups, `.usermenu__sep` separators):**
  1. identity header (displayName + email);
  2. **My Plex** → `/library/plex` — everyone (personal, not a section);
  3. **Ledger** → `/ledger` — only when the session's ledger level ≠ `disabled`. **The
     no-row default is now `disabled`** (ADR-032 C-03 — flipped from ADR-021's read_only), so
     out of the box this is admin-only; a role row opts members back in via `/admin/roles`;
  4. **Trash settings** → `/settings/trash` — only at trash level `edit` (admins implicitly);
  5. **Admin settings** → `/admin` — admin only;
  6. **Sign out**.
     The popover is an overlay — opening it never reflows the page (ADR-015-sanctioned); Esc /
     click-outside / ARIA behavior is the D-08 contract, unchanged.
- **`/settings/trash`** (route table, D-11): the Rules list + the admin-only Batch-pipeline
  card, both relocated **verbatim** (same testids, same wire calls, same ADR-014 ceremony:
  skip-gate = two-step ConfirmButton, rule delete = two-step, arm/disarm = plain toggle).
  Server gate: `effectiveSectionLevel(role,'trash') === 'edit'`; the rules EDIT controls
  additionally need the `edit_rules` grant + a reachable Maintainerr (ADR-023 C-03); the
  pipeline card is admin-only (`trash.settings.*` is adminProcedure). `/trash` keeps
  Movies · TV · Batches · Recently Deleted · Activity (`?tab=rules` now falls back to
  Movies). The shared safety banner (`components/trash-safety.tsx`) renders on both pages —
  reserved height in every state (D-14/ADR-015).
- **Consequence for members (the default experience):** top row `Home · Library · Bulletin`
  (Trash appears once a role grants it), menu = header + My Plex + Sign out. No Ledger
  anywhere unless a role opts them in.

## Alternatives considered

- **`next-themes`** for persistence/seeding: rejected — the donor ThemeProvider is
  ~40 lines and the token contract/tests already exist; a dependency adds nothing but
  its own theme-name conventions.
- **Cookie-based theme (SSR-rendered attribute, no script):** correct-by-construction
  but couples theme to requests and caching; the inline-script approach is the
  established no-flash pattern and keeps theme purely client-side. Revisit only if the
  script ever shows a measurable flash.
- **Renaming tokens during the port** (e.g. `--hnet-*`): rejected — same-names/
  same-values is the whole point (rebrand = `tokens.css` edit only; donor tests and
  muscle memory carry over).
- **JS-driven responsive admin tables** (windowed table ↔ card components): rejected
  for Phase 1 — the CSS `data-label` transform is zero-JS and testable in the resize
  matrix; revisit if admin data outgrows household scale.
- **Settings drawer port:** deferred — one theme toggle doesn't justify a drawer;
  reintroduce the donor drawer when a second setting appears.

## Test strategy

- **Unit (vitest + jsdom):** token contract — `missingTokens()` empty for both
  `hnet-dark` and `hnet-light` with `tokens.css` loaded (donor `theme.test.tsx`
  approach); ThemeProvider — persists to `hnet-theme`, adopts pre-stamped attribute,
  survives localStorage throwing; theme-init logic extracted pure and table-tested
  (stored value / no value + prefers light / no value + prefers dark / garbage value).
- **Guard:** `pnpm lint:css` green repo-wide; a fixture violation fails it (script
  self-test), wired into `lint-and-typecheck` CI (R-65).
- **Playwright (R-66, AC-10):** resize matrix at all eight viewports on `/`, `/login`,
  `/admin`, `/admin/users/[id]` — assert no page-level scrollbars
  (`document.documentElement.scrollHeight <= clientHeight`, same for width), controls
  on-screen, internal pane scrolling; theme toggle flips `data-theme` and survives
  reload (localStorage); first-paint attribute already correct (no flash) by asserting
  `data-theme` before hydration completes; per-role visibility with stubbed OIDC —
  Member sees default tiles only (AC-04) and no Admin menu entry; Admin sees the admin
  link; every tile href is a valid `http(s)` URL (AC-04; ADR-013 dropped the host match).

### D-16a — Amendment 2026-07-09 (owner-directed, build B) — Trash Settings becomes a tabbed hub

`/settings/trash` is now a **tabbed hub** and `/admin/storage` is **retired**. Everything storage / target
/ policy / reclaim / notifications moved off the standalone `/admin/storage` page into the hub; the
`storage.*` (and `trash.settings.*` / `trash.tuning`) routers and procedures are **unchanged** — only the
UI moved.

- **Tabs** (URL `?tab=`-driven `role="tablist"` reusing `.library-tabs`, roving-tabindex keyboard nav — the
  same contract as `/trash` · `/library` · `/ledger`): **General** · **Storage** · **Reclaim** · **Rules**.
  The safety banner sits **above** the tab strip (it governs rule edits regardless of tab).
- **General** — the admin gate (a separate immediate ConfirmButton ceremony) + a single green Save form
  combining the default save window and the Notifications delivery window (moved from `/admin/storage`).
- **Storage** — utilization meters + per-array space targets (each keeps its optimistic tick save — a
  direct manipulation, ADR-015, not a form) + the Space policy card (enable ceremony / per-array opt-in /
  tuning + graduation) + the **Batch policy** #134 form (mode / min candidates / cooldown / per-kind caps,
  one green Save) + the Grafana deep-link.
- **Reclaim** — the reclaim-attribution report (window switcher + bang-for-buck bars + cumulative + per-batch
  table). A read surface, no Save.
- **Rules** — the Maintainerr rules list (arm/disarm/delete), unchanged.
- **Save discipline** — "single green primary Save per form per tab" (the #134 pattern): the knobs that
  logically commit together share ONE green Save; genuinely-separate immediate audited actions (the admin
  gate + the policy-enable ConfirmButtons, per-array opt-in) stay their own immediate ceremonies; and the
  per-array space-target editors keep their inline optimistic saves (ADR-015 direct manipulation).
- **Gating** — the page gate is Trash-Edit (ADR-032); admins imply it. General/Storage/Reclaim read
  adminProcedures, so those three tabs are **admin-only** (the tab strip lists only what the viewer can
  use); a trash-edit-but-not-admin viewer lands on **Rules**.
- **Routing** — `/admin/storage` server-redirects to `/settings/trash?tab=storage` (old deep links + book-
  marks stay alive, mirroring `/admin/restore` → `/trash`); the **Storage** item is removed from the admin
  sub-nav (other `/admin/*` links unchanged).

### D-17 — MOTD markdown + themed severity glyph + compose preview (2026-07-10, owner design review)

Owner review of the live banner (web + phone screenshots): the emoji severity icon renders as a
jarring OS emoji ("a big no no", worst on mobile), a pasted URL sits unclickable mid-sentence and
wraps hideously, and the icon/text/dismiss row is misaligned. D-17 amends **D-15** in three parts —
data model, activation, dismissal, ARIA and audit are all untouched.

- **Message format — sanitized markdown subset, rendered React-element-only.** The stored
  `motd.message` string is now interpreted as markdown by `apps/web/lib/motd-markdown.tsx`:
  `[text](https://…)` links, `**bold**`, `*italic*`/`_italic_`, `` `code` ``, `- ` bullet lists,
  single-newline hard breaks, blank-line paragraphs, and **bare-URL autolinking** (a pasted
  `https://…` becomes clickable — the exact complaint — so pre-D-17 messages improve without an
  edit). The parser emits an AST rendered to a fixed element set (`p/ul/li/a/strong/em/code/br`);
  there is **no HTML parsing, no `dangerouslySetInnerHTML`, zero new dependencies** — admin-authored
  `<script>`/HTML arrives as literal escaped text, and only absolute **http(s)** targets become
  anchors (`javascript:`/`data:`/relative stay literal). This preserves ADR-027's Open #2 _property_
  ("no injection surface") while revising its plain-text _format_; plain text is valid markdown, so
  **existing messages render unchanged** — no migration, the jsonb record is untouched. Links open
  in a new tab (`target="_blank" rel="noopener noreferrer"`) and are severity-toned + underlined
  (the `.status-note` tone-on-tint pairing, proven readable in both themes). Budget **280 → 500**
  (`MOTD_MAX_LENGTH` + the `motd.set` zod bound): one URL must not eat a third of the message.
- **Severity glyph — themed inline SVG, never emoji.** The D-09 icon idiom (24×24 round-capped
  frame, `stroke: currentColor`): a stroked circle-i for `info`, a rounded triangle-! for `warning`,
  and a stroked ✕ for dismiss, all colored by the token cascade (`--motd-tone` =
  `--color-info`/`--color-warning`) so they re-theme with `data-theme` and render identically on
  every OS. **No emoji anywhere in the MOTD.**
- **Layout — first-line-aligned grid.** `.motd` is a `auto · minmax(0,1fr) · auto` grid (glyph ·
  message · dismiss); the glyph box and the 32px dismiss target are each optically centered on the
  **first text line** (`--motd-line`), so multi-line/multi-paragraph messages stay top-aligned. The
  message column takes `overflow-wrap: anywhere` (no 390px overflow); hover states recolor/thicken
  underlines only (D-14). The shared presentational surface is exported as **`<MotdSurface>`**
  (`components/motd-banner.tsx`) so the banner and the compose preview can never drift.
- **Compose editor (`/admin/motd`).** Still a light textarea — deliberately **not a WYSIWYG** — plus:
  the live preview now renders the **real `<MotdSurface>`** (markdown + glyph included, placeholder
  text when empty); a char-count + **"Markdown supported"** affordance under the textarea; and an
  **Insert link** helper that wraps the selection in `[text](https://…)` and parks the caret at the
  URL slot. Preview refills recolors only itself; the helper edits only the textarea value (D-14).
- **Tests.** Unit: the parser AST + rendered-output safety matrix (`motd-markdown.test.ts` — HTML
  escaping, scheme rejection, back-compat plain text, autolink punctuation). API: the 500 bound.
  e2e: the member journey asserts the markdown link renders as a real new-tab anchor and the raw
  syntax never shows.

### D-18 — Amendment 2026-07-11 (PLAN-027, ADR-049) — roles-grid section capability map

The `/admin/roles` grid (D-11) stopped rendering no-op permission levels. A **section capability
map** (`apps/web/lib/role-sections.ts`, the single source of truth) declares, per section, which
control it renders — DERIVED from the actual gating code (which procedures pass `minLevel: 'edit'`),
not guessed:

- **`'tri'` — Edit / Read-only / Disabled.** Sections with a real `edit` rung: **Ledger**
  (`ledger.bulkAddAndSearch` = `sectionProcedure('ledger','edit')`) and **Trash**
  (`trash.saveRule`/`deleteRule` = `trashActionProcedure('edit_rules','edit')` + `/settings/trash`
  needs level `edit`).
- **`'toggle'` — Enabled / Disabled.** Sections that only ever gate on `read_only`: **Bulletin**
  (feed/messages both gate `('bulletin','read_only')`; post/moderate are message-action grants;
  Feed/Messages visibility is the ADR-049 sub-view grant), **Metrics** (the full|limited detail is a
  SEPARATE control), **ytdl-sub** and **Books** (read-only surfaces). "Enabled" persists the stored
  `read_only`; "Disabled" persists `disabled` — the `SECTION_PERMISSION_LEVELS` enum + DB values are
  UNCHANGED. A section that later gains a real Edit (e.g. ytdl-sub per PLAN-025) flips its map entry
  to `'tri'` — no grid rewrite.

The Bulletin cell additionally carries the **Feed/Messages sub-view checkboxes** (greyed when
Bulletin is Disabled) per DESIGN-012 D-09. Constant width across every section (ADR-015 — a section
swaps its own dropdown options / toggles its own checkboxes, never a neighbour row).

### D-19 — Amendment 2026-07-11 (PLAN-036) — the history-navigation contract

Browser **Back/Forward behave like SCREEN navigation.** The `?tab=`-driven tabbed hubs (D-11
Library / Ledger, D-05 Metrics, D-09 Trash, D-16 Trash settings, DESIGN-012 D-08 Bulletin) route
all URL edits through the App Router, and the choice of **`router.push` vs `router.replace`** is
what decides whether an edit is a history entry. The contract:

- **Screen-level view switches PUSH (a history entry).** Selecting a different tab — a Library kind
  tab (Movies · TV · Music · Peloton · YouTube · Books · Audiobooks · Comics · My Fixes), a Bulletin
  **Feed/Messages** tab, a Metrics sub-tab (Overview · Apps · Hardware · Network · AI), a Trash tab
  (Overview · Movies · TV · Recently Deleted · Activity — including the Overview cards' jump-to-kind
  affordances), a Trash-settings tab, or a Ledger tab — is a `router.push`, keeping only `?tab`
  (D-11: a fresh start per tab, so a filter never leaks between tabs). **Back restores the prior tab
  WITH whatever URL-synced filter/sort/search state that tab's URL carried; Forward re-applies it.**
  This works because a refinement (below) replaces in place _within_ the tab's single history entry,
  so the entry Back pops to already carries the filter set. The push keeps `{ scroll: false }`, so a
  tab switch's scroll behaviour is unchanged.
- **Refinements REPLACE (no history entry).** Filter chips, the sort bar, the debounced search text,
  pagination / infinite-scroll cursors, in-place expansions, and the intra-tab narrowers (the Feed's
  `?src`/`?media` segs, the Ledger Runs tab's `?kind=` filter) stay `router.replace` — the
  URL-mirror-of-state (D-09) semantics are unchanged **except the tab dimension**, so Back/Forward
  cross screens, not individual filter edits.
- **Canonicalizing redirects REPLACE.** Normalizing a bare or unknown `?tab` to the landing tab
  (Metrics, Trash settings) and folding the retired `?tab=batches` deep link into a per-kind tab
  (Trash, ADR-033) are `router.replace` — a redirect must not mint a spurious history entry that
  Back would then land on.

No visual change; deep links keep working; ADR-015 (no reorientation on interaction) is untouched —
this is purely a history-entry semantics change on the existing navigations. PLAN-029 (Library views
overhaul) inherits this contract for any new screen-level switch it adds. Reproduced and enforced by
`apps/web/e2e/history-navigation.spec.ts` (tab switch → `page.goBack()` restored the prior tab; on
the pre-fix replace-only build Back skipped past the app screen entirely).

### D-20 — Amendment 2026-07-11 (owner-directed) — branded link previews (Open Graph)

Pasting `https://haynesnetwork.com/` into Discord (or any chat) rendered a gray, imageless embed —
title _"Sign in — haynesnetwork"_, description _"SSO front door for \*.haynesnetwork.com"_, no color.
This makes the link preview **branded**: color, banner image, and plain owner-voiced copy.

**Where the tags live.** The scraper is **unauthenticated**, so the app redirects it to `/login`
(D-11 gate). The Open Graph / Twitter metadata is therefore exported from the **root layout**
(`app/layout.tsx`, via `apps/web/lib/site-metadata.ts`) where it applies to _every_ route the crawler
can reach — the sign-in page inherits it. The browser-tab `<title>` stays page-specific for humans
(`/login` still overrides it to "Sign in — haynesnetwork"); the **embed** title comes from `og:title`,
which is always the wordmark **haynesnetwork** (`og:site_name` matches).

**The one copy constant.** `SITE_DESCRIPTION` in `lib/site-metadata.ts` is the single, plain,
owner-editable string feeding `description` + `og:description` + `twitter:description`:

> Front door to the haynes-ops self hosted apps. Closed site — members only.

(Trimmed 2026-07-12 at the owner's embed review — "access isn't given out" is implied by
"members only".)

**The banner.** A 1200×630 image is generated on the fly by `app/og/route.tsx` (`next/og`
ImageResponse — Satori + resvg with the bundled Geist font, no external fetch, CSP-safe) and served
at the **public, un-gated** path `/og` (there is no global middleware — auth is per-page redirects —
so the crawler can fetch it, verified by unauthenticated `curl` → `200 image/png`). It is built from
THIS app's identity (DESIGN-006): the hub-and-spoke mark in accent green on the black brand field,
under the wordmark and a single accent rule. `og:image:width/height/alt` are set and
`twitter:card = summary_large_image` so Discord renders the large banner. `metadataBase` (from
`NEXT_PUBLIC_BASE_URL`, the bare apex in prod — the same origin the tRPC client uses) resolves the
relative `/og` to an absolute URL.

**Embed accent.** `theme-color` is exported via Next's `viewport` (`siteViewport`) using the brand
primary `#78be20`. The brand hex for the banner + theme-color is centralised in `apps/web/lib/brand.ts`
as constants mirroring the `hnet-dark` `--color-*` tokens — a **sanctioned** exception to hard rule 2:
`scripts/lint-css-hex.mjs` scans `.css` only (ESLint owns `.ts/.tsx`), the same allowance
`app/icon0.svg` already uses to draw the favicon in accent green. `pnpm lint:css` stays green.

No auth/routing behavior changes — this is metadata plus one public image route; the unauthenticated
page leaks nothing new beyond the deliberate branding. Covered by
`apps/web/lib/__tests__/site-metadata.test.ts` (exact copy, og/twitter tags, 1200×630, theme-color,
`metadataBase`). _Note: chat clients cache embeds — after deploy a `?v=2` cache-buster forces a refetch._

### D-21 — Amendment 2026-07-14 (ADR-058 / PLAN-047) — the shared card system + code-enforced cohesion

Owner ruling (PLAN-047): "our base library card is shared everywhere, even Helpdesk tickets, and
then is extended for different types of media and extended further for advanced use cases. I want
the code to guarantee the UX doesn't drift as we build." Motivated by the PLAN-045 "Wanted strip"
incident — card anatomy lived in per-surface JSX an agent could re-invent.

**The family** (`apps/web/components/cards/`, consumed ONLY via the `@/components/cards` barrel):

| Component | Serves | Anatomy notes |
| --- | --- | --- |
| `BaseCard` | the canonical poster idiom | typed `art` union (2:3 poster / group-art ladder) + title (year) · ≤1 subtitle · ONE badge row (≤ `MAX_CARD_BADGES` = 3) · typed flavor/focus/data knobs; **no children prop** |
| `MediaCard` | Movies · TV · Music · Peloton · YouTube | ★ rating / on-disk / tombstone badges; count pill on ytdl-sub walls |
| `BookCard` | Books · Audiobooks · Comics + composed Wanted | author subtitle; pages/duration badge on disk, Wanted/Missing badge on a want (null poster ⇒ KindIcon tile — never fake art) |
| `GroupCard` | author/genre aggregate walls | group-art ladder (portrait → cover fan → designed glyph) + label + member count |
| `RequestCard` | Goodreads items | shelf + dominant-status badges (max two); pre-mint want = same anatomy, non-interactive |
| `TicketCard` (+`TicketCategoryTile`) | Helpdesk twall | state puck top-right (recolor-only), poster or category tile art, caption/sub + ONE meta row (status badge · replies · when) |
| `TrashCard` | Trash pending + batch walls | state/action toggle puck top-right, `/library` nav puck top-left, caption + ONE meta row (size·★ text + person/eye chips) |
| `PosterGrid` / `TicketWall` / `TrashWall` (+ skeletons) | the wall containers | grid geometry + dim-in-place refresh + skeleton idioms owned by the package |
| `MediaPoster`, `PosterBox` | detail-head hero art / loading box | the only art primitives exported — never a card face |

**The guards (normative):**

1. `apps/web/lint/card-anatomy-guard.mjs` → `no-restricted-syntax` + `no-restricted-imports` in
   `apps/web/eslint.config.mjs`: outside `components/cards/`, the anatomy class tokens
   (`media-card`, `poster-card*`, `poster-grid`, `poster-box`, `bwall-*`, `twall-*`, `pwall-*`,
   `glyph-tile`, `group-card*`, `media-list`, …) may not appear in string/template literals, and
   the package may only be imported through its barrel. (`media-card__badges` deliberately stays
   available — it is the detail-head badge-row idiom, not a wall card.) e2e specs/support are out
   of scope (they select by these classes).
2. `apps/web/lib/__tests__/card-system-guard.test.ts` — the guard's executable proof (violating
   fixtures fail, the sanctioned form passes, deep imports confined) in the `test` CI job.
3. **The card gallery** — `/e2e/card-gallery` (dev-only route; 404 in production) renders every
   variant/state over inline fixtures; `apps/web/e2e/card-gallery.spec.ts` asserts each tile's
   DOM shape (one art box, one caption, ONE badge row ≤ 3, pucks only in reserved corners, no
   buttons on card faces) and always emits dark/light × desktop/390 captures — the standing
   reference artifact for owner review and future agent briefs.

**Extension contract:** a new media type or advanced state (e.g. PLAN-048 activity/in-flight)
extends the family — a typed prop/variant in the package + a gallery entry + a spec assertion in
the same change. Forking a card outside the package is a CI failure by construction.

ADR-015 (D-14) is unchanged and now structurally enforced on cards: reserved art boxes, fixed
caption heights, corner pucks that recolor in place.

### D-22 — Amendment 2026-07-14 (owner-ratified from an approved mockup) — the nav restructure

The owner reviewed nav-IA mockups and ratified this exact one (it is the contract):

```
TOP BAR:  Home | Library | Tickets | Trash        [theme] (avatar)
USER MENU (avatar dropdown):
  My Plex
  Integrations
  Metrics
  ────────
  Sign out
Tickets page keeps its inner tabs:  [Tickets] [Feed]
```

This amends **D-16** (the universal top row + role-gated user menu) in three parts. No route, section
id, grant row, or stored value changes — it is a labelling + placement change, ADR-015 untouched.

- **The top row slims to FOUR entries — `Home · Library · Tickets · Trash`.** Metrics and
  Integrations LEAVE the row (they had crept on past D-16's original four; see the D-08/`.topbar__nav`
  history). "Tickets" is the `bulletin` section under its ratified name — a LABEL change: the route
  stays `/bulletin`, the section id / sub-view grants / deep links stay `bulletin` / `messages`, and
  the entry stays level-gated (Bulletin's no-row default is `read_only`, so it shows for everyone; a
  Disabled role hides it). Section gating for the other three is unchanged. Four labels fit **320px**
  without the rail scrolling (proven by the nav-restructure 320px capture); the v0.46.3 sub-375px
  scroll-rail stays only as a **safety net** for a future fifth entry.
- **The user menu gains Integrations + Metrics**, placed with My Plex in the top group (no separator
  between), each gated **exactly like its former tab** (no-row default `disabled`, so a role without
  the `metrics` / `integrations` section sees no entry). A user gated to just those two therefore sees
  the mockup verbatim — `My Plex · Integrations · Metrics · ─── · Sign out`. The tooling group
  (Ledger / Trash settings / Admin settings, unchanged from D-16) and Sign out follow below the
  separator. Every item shares the `usermenu__item` styling; navigating is a `<Link>` **push** (D-19).
- **Active-state:** the universal bar carries **no** active-highlight mechanism (it never has), so a
  route that is no longer a tab — `/metrics`, `/integrations` — leaves **no** stale tab highlighted;
  that is the sane, tested treatment. Screen-level tab activeness stays where it belongs: exactly one
  active inner tab on a tabbed page (e.g. the Tickets page's `[Tickets] [Feed]`, #278 precedent).

**Tickets ratification (settled).** D-16's ADR-050 C-05 open choice — the ticket system's display
name — is **ratified as "Tickets" on 2026-07-14**. It is the single constant `HELPDESK_NAME`
(`apps/web/lib/bulletin.ts`), which now also drives the top-nav entry, the section page heading, and
the lead sub-tab. User-visible "Helpdesk" / section-brand "Bulletin" strings were swept to "Tickets"
(nav, page headings, empty-state + intake copy, back-links); code identifiers, testids, route/section
ids, the `/admin/roles` section column, and doc history keep their `bulletin` / `Helpdesk` names.

Enforced by `apps/web/e2e/nav-restructure.spec.ts` (four-tab bar at 320/390/desktop + no rail scroll
at 320; menu entries + role gating; the Tickets label + inner tabs; menu-item push/Back; no stale
active tab) with `nav-overlap.spec.ts` updated to the four-tab reality.

## Open questions

| ID   | Question                                                                                                                                                                                           | Resolution                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q-01 | Brand mark: the donor's placeholder four-square SVG ships initially — does the owner want a real haynesnetwork logo (SVG) for topbar + `/login`?                                                   | Resolved 2026-07-03: hub-and-spoke mark, DESIGN-006 D-01                                                                                                                 |
| Q-02 | Topbar avatar: initial-letter circle only, or render `users.image` (Better Auth stores the OIDC `picture` claim there — DESIGN-001 D-02) when present?                                             | Resolved: initial-letter circle only — `initialFor(displayName)` in `apps/web/lib/initials.ts` (first letter uppercased, `?` fallback). `users.image` is never rendered. |
| Q-03 | Final brand palette: initial tokens keep demo-console's green `#78be20` accent verbatim (D-01). What accent/surfaces does the owner want for the haynesnetwork rebrand (a `tokens.css`-only edit)? | Resolved 2026-07-03: palette values stay (owner: "colors are good"); identity comes from mark/type/shape — DESIGN-006                                                    |
