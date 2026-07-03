// @hnet/ui — the demo-console theme/layout port (ADR-005, DESIGN-004).
// Theme: CSS-token theming via `data-theme` on <html>; ThemeProvider is the
// single post-hydration writer of that attribute. Layout: viewport-fit
// height-budget primitives (structural only — no colors).
//
// CSS ships as plain stylesheets, imported by the app's root layout:
//   @hnet/ui/theme/tokens.css   — the token seam (the only raw-hex file)
//   @hnet/ui/layout/layout.css  — structural classes for the layout primitives

export {
  REQUIRED_TOKENS,
  THEMES,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isThemeName,
  missingTokens,
} from './theme/tokenContract';
export type { TokenName, ThemeName } from './theme/tokenContract';

export { ThemeProvider, useTheme } from './theme/ThemeProvider';

export { HeightBudget } from './layout/HeightBudget';
export type { HeightBudgetProps } from './layout/HeightBudget';
export { ReservedPane } from './layout/ReservedPane';
export type { ReservedPaneProps } from './layout/ReservedPane';
export { useAvailableHeight } from './layout/useAvailableHeight';
