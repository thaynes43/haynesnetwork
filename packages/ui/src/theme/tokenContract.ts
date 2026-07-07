// Theme token contract (ADR-005, DESIGN-004 D-01). The canonical required
// CSS-variable names every theme must define and every component must consume —
// never a hard-coded color literal (scripts/lint-css-hex.mjs enforces this).
// Values live in tokens.css; switching `data-theme` on <html> re-skins the app
// with no markup change.

export const REQUIRED_TOKENS = [
  '--color-accent',
  '--color-accent-contrast',
  '--color-bg',
  '--color-surface',
  '--color-surface-2',
  '--color-border',
  '--color-text',
  '--color-text-muted',
  '--color-topbar',
  '--color-nav-active',
  '--color-danger',
  '--color-danger-strong',
  '--color-warning',
  '--color-info',
  // ADR-028 action feedback: the live download/import "in motion" tone
  // (phase chips + progress meters).
  '--color-progress',
  // Persistent-scrollbar palette for internal scroll panes. Required so every
  // theme renders a visible, re-skinnable scrollbar in both Chrome and WebKit
  // (ADR-005).
  '--color-scrollbar-track',
  '--color-scrollbar-thumb',
  '--color-scrollbar-thumb-hover',
  '--radius',
  '--radius-sm',
  '--space',
  '--font',
  '--shadow',
] as const;

export type TokenName = (typeof REQUIRED_TOKENS)[number];

/** Shipped themes (ADR-005 / R-61): dark is the default. */
export const THEMES = ['hnet-dark', 'hnet-light'] as const;
export type ThemeName = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemeName = 'hnet-dark';

/** localStorage key the theme choice persists under (DESIGN-004 D-02/D-03). */
export const THEME_STORAGE_KEY = 'hnet-theme';

/** True only if `name` is one of the shipped themes. */
export function isThemeName(name: string | null | undefined): name is ThemeName {
  return (THEMES as readonly string[]).includes(name ?? '');
}

/** True only if every required token resolves to a non-empty value on `el`.
 *  Used by tests to prove a theme satisfies the contract (DESIGN-004). */
export function missingTokens(el: Element): TokenName[] {
  const style = getComputedStyle(el);
  return REQUIRED_TOKENS.filter((t) => style.getPropertyValue(t).trim() === '');
}
