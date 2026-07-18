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

export { ICON_KEYS, isIconKey } from './icons/registry';
export type { IconKey } from './icons/registry';
export { AppIcon, GenericAppIcon, ICON_COMPONENTS } from './icons/components';

export { ConfirmButton, useConfirm, createConfirmController, CONFIRM_MS } from './controls/ConfirmButton';
export type {
  ConfirmButtonProps,
  UseConfirmOptions,
  ConfirmController,
  ConfirmOutcome,
} from './controls/ConfirmButton';

// ADR-028 / DESIGN-005 D-21 — live *arr action-feedback primitives (structure only;
// tones map to app classes over the token palette, incl. --color-progress).
export { PhaseChip, ProgressMeter } from './controls/PhaseChip';
export type { PhaseChipProps, ProgressMeterProps, PhaseTone } from './controls/PhaseChip';

// ADR-071 / DESIGN-004 D-24 — the media-action system: the MEDIA_ACTIONS registry (the ONE
// canonical label+look per verb) and the components that render it reflow-safely (MediaAction,
// MediaActionBar, ConsumeLink, ReservedActionSlot, MediaHero). Every per-item Fix / Force Search /
// consume in the app renders through these — the `action-anatomy` guard forbids hand-rolling them.
export * from './actions';

export { useReorderDnD } from './controls/useReorderDnD';
export type {
  UseReorderDnDOptions,
  UseReorderDnD,
  ReorderContainerProps,
  ReorderRowProps,
  ReorderHandleProps,
} from './controls/useReorderDnD';
export { computeDropIndex, resolveReorderIndex } from './controls/reorder';

// ADR-018 / DESIGN-008 D-10 — the shared filter/sort engine (ported from demo-console;
// mechanism-shared, look-per-app). Reused by Library now and by PLAN-005/006.
export * from './filters';

export { HeightBudget } from './layout/HeightBudget';
export type { HeightBudgetProps } from './layout/HeightBudget';
export { ReservedPane } from './layout/ReservedPane';
export type { ReservedPaneProps } from './layout/ReservedPane';
export { useAvailableHeight } from './layout/useAvailableHeight';
