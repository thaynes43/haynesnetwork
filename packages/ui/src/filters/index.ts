// ADR-018 / DESIGN-008 D-10 — the shared FILTER/SORT engine, ported ONCE from demo-console's
// `packages/shared/filters` (mechanism only — hnet keeps its own look via the token seam and the
// `hnet-` class namespace; see memory `distinct-visual-identity-per-app`). Library uses it now;
// PLAN-005 (Ledger) and PLAN-006 (Trash) reuse it verbatim.
//
// Every component is i18n-FREE (the host injects `labels`) and theme-FREE (the host picks the
// class namespace via `classPrefix`, default `hnet`); all hues come from the global `--color-*`
// tokens. The `hnet-` structural classes live in `filters.css`, imported by the app root layout
// (`@hnet/ui/filters/filters.css`) — NOT a JS side-effect import, so node/test consumers of the
// barrel never touch CSS.
export { chipCsv, groupPairs } from './chipModel';
export type { ChipGroup } from './chipModel';

export { FilterChip } from './FilterChip';
export type { FilterChipProps, FilterChipLabels } from './FilterChip';

export { Autocomplete, filterSuggestions } from './Autocomplete';
export type { AutocompleteProps, AutocompleteLabels } from './Autocomplete';

export { FilterCell, BinChip, CopyableId } from './cells';
export type { FilterCellProps, FilterCellLabels, CopyableIdLabels, BinChipLabels } from './cells';

export {
  filterFirst,
  filterValues,
  filterHas,
  toggleFilterValue,
  addFilterValue,
  removeFilterValue,
  setDrillFilter,
} from './filterMap';
export type { FilterMap } from './filterMap';

export { cmpStr, cmpNum, nextSort, arrowFor, sortRowsClientSide } from './sort';
export type { FieldSpec } from './sort';
