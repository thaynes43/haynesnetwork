# @hnet/ui

The theme + layout seam for the app. A wholesale port of the demo-console
theming mechanism (ADR-005) with a divergent visual identity layered on top
(DESIGN-006). Raw TS/TSX + two plain stylesheets — no build step, no Tailwind,
no shadcn. Consumed by `apps/web`; the icon key list is also imported by
`@hnet/api` (which is why the registry stays React-free — see below).

**Golden rule for anyone styling UI:** color is *data*, not code. All brand and
status color lives in `src/theme/tokens.css` and is themed by `data-theme` on
`<html>`. A rebrand is a `tokens.css` edit, never a component change.

## What's exported

Everything is re-exported from `src/index.ts`:

| Export | From | What it is |
|--------|------|-----------|
| `ThemeProvider`, `useTheme` | `theme/ThemeProvider.tsx` | the single post-hydration writer of `data-theme`; context for reading/setting the active theme |
| `REQUIRED_TOKENS`, `THEMES`, `DEFAULT_THEME`, `THEME_STORAGE_KEY`, `isThemeName`, `missingTokens`, `TokenName`, `ThemeName` | `theme/tokenContract.ts` | the token contract (see below) |
| `ICON_KEYS`, `isIconKey`, `IconKey` | `icons/registry.ts` | the code-shipped app-icon key list (React-free) |
| `AppIcon`, `GenericAppIcon`, `ICON_COMPONENTS` | `icons/components.tsx` | the inline-SVG glyphs behind those keys |
| `HeightBudget`, `ReservedPane`, `useAvailableHeight` (+ prop types) | `layout/*` | viewport-fit layout primitives (structural only) |

The two stylesheets are imported directly by the app's root layout:

```
@hnet/ui/theme/tokens.css    — the token seam (the ONLY raw-hex file)
@hnet/ui/layout/layout.css   — structural classes for the layout primitives
```

## Theming mechanism

The whole app re-skins by flipping one attribute — `data-theme` on
`<html>` — which selects a block of CSS-variable values in `tokens.css`; the
`--color-*` cascade repaints every component. Two shipped themes: `hnet-dark`
(the default) and `hnet-light` (`THEMES` / `DEFAULT_THEME` in
`tokenContract.ts`).

Two pieces cooperate to set that attribute, and the split matters:

1. **A pre-hydration inline script in the root layout** (`apps/web`, DESIGN-004
   D-03) stamps `data-theme` on `<html>` **once, before first paint**, reading
   the persisted choice / OS preference. This is what prevents a
   flash-of-unstyled-theme (FOUC) on SSR. It runs before React exists.
2. **`ThemeProvider`** (`theme/ThemeProvider.tsx`) is the **single writer of
   `data-theme` after hydration**. Nothing else may call
   `documentElement.setAttribute('data-theme', …)`. It seeds its initial value
   from `localStorage['hnet-theme']` (`THEME_STORAGE_KEY`) → the pre-stamped
   attribute → `prefers-color-scheme` → `DEFAULT_THEME`, and persists every
   change back to `localStorage`. Read/set the active theme only through
   `useTheme()`.

**Do not** write `data-theme` from anywhere else, and do not read the theme by
inspecting the DOM — go through `useTheme()`. Adding a competing writer
reintroduces the flash/desync ADR-005 driver 4 exists to prevent.

### Token structure in `tokens.css`

- `:root` holds the **structural, theme-independent** tokens: `--brand-name`,
  `--radius` / `--radius-sm`, `--space`, `--font` (the `--font-outfit`
  next/font variable with a system-ui fallback), `--color-nav-active` (aliased
  to `--color-accent`), and `--scrollbar-size`.
- `[data-theme='hnet-dark']` and `[data-theme='hnet-light']` each hold the full
  per-theme color palette + `--shadow`.

## RULES for anyone touching UI style

1. **Raw hex belongs in exactly one file: `src/theme/tokens.css`.** Everywhere
   else use `var(--color-*)`, `color-mix(…)`, or `currentColor`. This is
   CLAUDE.md hard rule 2 and is CI-enforced by `scripts/lint-css-hex.mjs`
   (`pnpm lint:css`), which scans `apps/**/*.css` + `packages/**/*.css` and
   fails on any `#RGB[A]`/`#RRGGBB[AA]` literal outside `tokens.css` (the sole
   allowlisted basename). ESLint never sees CSS, so this guard is the only thing
   standing between you and a hard-coded color — respect it.

2. **A NEW token must be added in TWO places or the contract test fails.** Add
   the CSS variable to **both** the `hnet-dark` **and** `hnet-light` blocks in
   `tokens.css`, **and** add its name to `REQUIRED_TOKENS` in
   `tokenContract.ts`. `missingTokens(el)` (used by the contract test) walks
   `REQUIRED_TOKENS` and fails for any theme where a required token resolves
   empty — so a token in the array but missing from a theme block, or present
   in both blocks but absent from the array, is a broken contract. Structural
   tokens (`--radius`, `--space`, `--font`, `--shadow`, etc.) are also in
   `REQUIRED_TOKENS`; keep the array and the stylesheet in lockstep.

3. **`layout.css` is structural only — never put color or theme tokens in it.**
   The layout primitives (`.hb-grid`, `.rp-pane`) carry `display`,
   `min-height:0`, `height`, and `overflow` and nothing else. This is normative
   (see the file header and `ReservedPane.tsx`): layout primitives carry no
   theme. Skin things in `app.css`/`tokens.css`, lay them out with the
   primitives.

4. **Adding an app icon is a two-file code change.** Extend the `ICON_KEYS`
   tuple in `icons/registry.ts` **and** add the matching component to the
   `ICON_COMPONENTS` map in `icons/components.tsx`. The map is typed
   `Record<IconKey, …>`, so a key with no component (or a component with no key)
   is a type error. `registry.ts` is deliberately **React-free** — it holds only
   the key list + `isIconKey`, because `@hnet/api` imports the keys to validate
   `app_catalog.icon` and must not pull in React types. Keep all JSX in
   `components.tsx`. Every glyph is a self-contained 24×24 `<svg>` drawn with
   `stroke`/`fill: currentColor` (via the shared `frame()` helper) so icons
   theme through the token seam for free — no icon fonts, no CDN, no `<img>`.
   Unknown/null keys fall back to `GenericAppIcon` (`AppIcon` stays defensive on
   read even though writes are validated against `ICON_KEYS`).

5. **Brand mark and wordmark stay a tokens-only rebrand surface.** The mark is a
   single component, `apps/web/components/brand-mark.tsx` (DESIGN-006 D-01) —
   one `currentColor` SVG, never redrawn inline anywhere else; both the TopBar
   and `/login` use it, sized by CSS. The wordmark is **not** hard-coded text:
   it is the `--brand-name` token rendered via CSS `content`. Keep it that way
   so a rebrand remains a `tokens.css` edit (R-61) and not a hunt through JSX.

### The Chromium scrollbar footgun

Internal scroll panes use a **persistent** (always-visible, fixed-width)
scrollbar, not Chrome's overlay-fade default. `--scrollbar-size` (`:root`) and
the three `--color-scrollbar-*` tokens (per-theme, and part of
`REQUIRED_TOKENS`) exist for this. The trap: a fixed-width bar reserves its
track as part of the pane, so toggling overflow never shifts layout — but if you
add a new scroll surface and forget to wire these tokens (or you introduce a
theme without them), you get either an invisible overlay bar on Chrome or a
layout shift when it appears. Style scroll panes through the existing scrollbar
tokens; if you ever add a theme, define all three `--color-scrollbar-*` values
in it.

## Layout primitives (structural)

Viewport-fit, ported verbatim from demo-console (ADR-005 / DESIGN-004 D-05).
They deliver AC-10's "panes scroll internally, no page-level scrollbars" by
construction:

- **`HeightBudget`** — a CSS-grid region; caller passes `rows` as a
  `grid-template-rows` value using `minmax(0,1fr)`-style tracks (e.g.
  `"auto minmax(0,1fr)"`). Direct children get `min-height:0` so panes shrink
  and scroll instead of growing the page.
- **`ReservedPane`** — claims a grid slot; `scroll` (default `true`) surfaces
  overflow as a pane-level scroll (`data-scroll="false"` opts out, e.g. a
  paginated pane). Sets `min-height:0` inline so shrink-to-scroll holds even
  before the stylesheet loads.
- **`useAvailableHeight(ref)`** — a client hook that tracks a box's content-box
  height via `ResizeObserver` for panes that need an explicit pixel budget;
  returns `0` until first measured. `ref` is `RefObject<HTMLElement | null>`.

## Owner standing rule — distinct visual identity per app

Tom's apps share the *mechanism* and the *palette values*, never the *look*.
DESIGN-006 exists because the initial port looked "too much like a rip-off of
demo-console": same tokens and colors, but the square tiles gave it away. The
identity divergence (hub-and-spoke brand mark, Outfit typeface, horizontal-card
tiles, pill buttons, ghost topbar buttons, larger radii) lives in token *values*
+ `app.css`, with the ADR-005 mechanism untouched. When you change anything
visual: port mechanisms and palette between apps, never the look, and get
**screenshot approval from the owner** before it ships (DESIGN-006 Q-01 blocks
its PR on exactly this).

## References

- ADR-005 — theming + layout port decision (`docs/adrs/005-theming-and-layout.md`).
- DESIGN-004 — UI shell, token contract, pre-hydration script, icon registry.
- DESIGN-006 — visual identity (`docs/designs/006-visual-identity.md`).
- CLAUDE.md hard rule 2 — no raw hex outside `tokens.css`.
- `scripts/lint-css-hex.mjs` — the hex guard (`pnpm lint:css`).
