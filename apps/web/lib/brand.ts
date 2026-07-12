// Brand color constants for NON-CSS surfaces — the Open Graph banner (app/og/route.tsx)
// and the `theme-color` meta (app/layout.tsx `viewport`). These MIRROR the `--color-*`
// theme tokens declared in packages/ui/src/theme/tokens.css for the default `hnet-dark`
// theme; the crawler / link embed is always the dark brand, so the dark values are canonical
// here.
//
// Why literals live outside tokens.css: CLAUDE.md hard rule 2 / ADR-005 keeps *CSS* color in
// tokens.css, enforced by scripts/lint-css-hex.mjs — which scans `.css` files ONLY. `.ts`/`.tsx`
// is outside that guard's scope BY DESIGN (the same sanctioned exception as apps/web/app/icon0.svg,
// which draws the favicon in the accent green). A rebrand still starts in tokens.css; keep these
// five in sync with the `hnet-dark` block there.
export const BRAND_ACCENT = '#78be20'; // --color-accent (hub-and-spoke mark, theme-color)
export const BRAND_BG = '#000000'; // --color-bg (dark) — banner backdrop
export const BRAND_SURFACE = '#111317'; // --color-surface (dark) — banner inner panel
export const BRAND_TEXT = '#f2f4f5'; // --color-text (dark) — wordmark
export const BRAND_TEXT_MUTED = '#a8acb2'; // --color-text-muted (dark) — banner subline
