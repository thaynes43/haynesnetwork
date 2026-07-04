# DESIGN-004: UI shell and dashboard (Phase 1)

- **Status:** Accepted — presentation details partially superseded by DESIGN-006 (visual identity: brand mark, typeface, radii, tile geometry); the mechanism and structure here remain normative
- **Last updated:** 2026-07-03
- **Satisfies:** PRD-001 R-10, R-12, R-14 (rendering side), R-60, R-61, R-66, AC-01, AC-04, AC-10; governed by ADR-005 (CSS-token theming via `data-theme`) — drafted in parallel, referenced by number; API consumed per DESIGN-003 / ADR-004 (API layer: tRPC v11).
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
  scrolls** (AC-10: no page-level scrollbars at any matrix size).
- App shell = flex column, `100dvh` (dvh, not vh — mobile URL-bar safe): topbar
  (56px, `flex: none`) + `<main>` (`flex: 1 1 auto; min-height: 0; overflow: auto`) —
  content scrolls internally.
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
- Hrefs come straight from the API and are already guaranteed
  `https://*.haynesnetwork.com` (R-14 enforced at write time, DESIGN-003 D-04); the UI
  never constructs URLs and never links `*.haynesops.com` (CLAUDE.md hard rule 3).
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
  between the brand and the spacer. Hidden under 600px via CSS; on phones the same
  destinations live in the user-menu popover so nothing becomes unreachable.
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
  <480px, D-06) opening a popover: displayName + email header, then menu items —
  **Library** (`/library`) and **My fixes** (`/my-fixes`) for every user (they carry
  the collapsed primary nav on phones), **Admin** (`/admin`, rendered only when
  `user.role === 'Admin'`), and **Sign out** (Better Auth `authClient.signOut()` →
  `router.push('/login')` + `router.refresh()`). Popover: Esc closes and returns focus
  to the trigger, click-outside (pointerdown) closes,
  `aria-expanded`/`aria-haspopup="menu"` on the trigger, `role="menu"` +
  `role="menuitem"` on the items.

Admin sub-nav (`apps/web/app/(app)/admin/layout.tsx`, `<nav aria-label="Admin
sections">`, `.admin-nav`): five entries — **Users** (`/admin`), **Catalog**
(`/admin/catalog`), **Tags** (`/admin/tags`), **Fixes** (`/admin/fixes`), **Restore**
(`/admin/restore`). Flex row that wraps on phones; renders only after the layout's
server-side Admin gate passes (D-11).

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
+ chrome), `/login` sits outside it. `apps/web/README.md` points here rather than
re-listing routes.

| Route               | Access | Page file (under `apps/web/app`)  | Content                                                                                                                                            |
| ------------------- | ------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`            | public | `login/page.tsx`                  | Centered `.card`: brand mark + wordmark + single **Sign in** button → Better Auth Authentik OIDC flow (AC-01 — no password form). Session present → server-redirects to `/`. |
| `/`                 | authed | `(app)/page.tsx`                  | Dashboard (D-07): greeting + app-launcher tile grid.                                                                                                |
| `/library`          | authed | `(app)/library/page.tsx`          | Synced media library (Phase 2): searchable/filterable list of *arr items across Sonarr/Radarr/Lidarr; season grouping for series.                  |
| `/library/[id]`     | authed | `(app)/library/[id]/page.tsx`     | Item detail + write-back actions: Fix, Force Search, roll-up scopes (ADR-011); `item-detail.tsx` + `fix-dialog.tsx` + `force-search-dialog.tsx`.    |
| `/my-fixes`         | authed | `(app)/my-fixes/page.tsx`         | The caller's own fix/force-search ledger history (attribution + status).                                                                           |
| `/admin`            | Admin  | `(app)/admin/page.tsx`            | Users list: table (cards <760px) of displayName, email, role, family, tags, grant count → row links to detail.                                     |
| `/admin/users/[id]` | Admin  | `(app)/admin/users/[id]/page.tsx` | Grants (checklist of catalog entries: direct grant toggle + provenance chips `default` / `direct` / `tag:<name>`, R-22), tags applied, family toggle (`user-detail.tsx`). |
| `/admin/catalog`    | Admin  | `(app)/admin/catalog/page.tsx`    | Entries table + create/edit form (URL field validated live against R-14; server authoritative), defaultVisible toggle, reorder → `catalog.reorder`. |
| `/admin/tags`       | Admin  | `(app)/admin/tags/page.tsx`       | Tags table + create/edit (name, description, bundle: app checklist + grants-family toggle); apply/remove happens on the user detail page.           |
| `/admin/fixes`      | Admin  | `(app)/admin/fixes/page.tsx`      | All-users fix/force-search ledger (Phase 2): cross-user audit view of write-back actions.                                                          |
| `/admin/restore`    | Admin  | `(app)/admin/restore/page.tsx`    | Failsafe restore surface (Phase 2, ADR-008/011): re-push a ledger snapshot back to the *arrs.                                                       |

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
  link; every tile href matches `https://*.haynesnetwork.com/*` (AC-04/R-14).

## Open questions

| ID   | Question                                                                                                                                                                                           | Resolution                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Q-01 | Brand mark: the donor's placeholder four-square SVG ships initially — does the owner want a real haynesnetwork logo (SVG) for topbar + `/login`?                                                   | Resolved 2026-07-03: hub-and-spoke mark, DESIGN-006 D-01                                                              |
| Q-02 | Topbar avatar: initial-letter circle only, or render `users.image` (Better Auth stores the OIDC `picture` claim there — DESIGN-001 D-02) when present?                                             | Resolved: initial-letter circle only — `initialFor(displayName)` in `apps/web/lib/initials.ts` (first letter uppercased, `?` fallback). `users.image` is never rendered. |
| Q-03 | Final brand palette: initial tokens keep demo-console's green `#78be20` accent verbatim (D-01). What accent/surfaces does the owner want for the haynesnetwork rebrand (a `tokens.css`-only edit)? | Resolved 2026-07-03: palette values stay (owner: "colors are good"); identity comes from mark/type/shape — DESIGN-006 |
