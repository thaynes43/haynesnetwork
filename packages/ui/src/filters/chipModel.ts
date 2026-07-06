// The UNIFIED, multi-value filter-chip model shared by Discover and Explore (PLAN-018 §3, D-1/D-2;
// DESIGN-007 §4.11). It is a pure UI mechanism — NOT a domain term (DDD-003 unchanged): the
// "chip" consolidates a field's active values into ONE editable token.
//
// Semantics (D-1): same-field values OR together (rendered as ONE chip in CSV form
// `State · InProgress, Complete`); separate chips AND across fields. The chip ✕ clears the whole
// field; removing the last value removes the chip. This module is field-agnostic — both tabs feed
// it their own (field → values) maps; the field's KIND (enum checklist vs unbounded typeahead) and
// its known enum values are supplied by the caller (so no reference-domain literal is baked in).

/** A consolidated chip: one field, its OR-ed values, and how its editor behaves. */
export interface ChipGroup<F extends string = string> {
  field: F;
  /** the OR-ed values for this field, in insertion order. */
  values: string[];
  /** enum → a checklist of `enumValues`; unbounded → a typeahead reusing the suggestions. */
  kind: 'enum' | 'unbounded';
  /** the field's known values (enum fields only) — drives the checklist. */
  enumValues?: readonly string[];
}

/** Group an ordered (field, value) list into per-field chips, preserving first-seen field order
 *  and per-field value order. Same field = one chip (CSV); used by Discover's flat `Pill[]`. */
export function groupPairs<F extends string>(
  pairs: ReadonlyArray<{ field: F; value: string }>,
  fieldKind: (field: F) => Pick<ChipGroup<F>, 'kind' | 'enumValues'>,
): ChipGroup<F>[] {
  const order: F[] = [];
  const byField = new Map<F, string[]>();
  for (const { field, value } of pairs) {
    let list = byField.get(field);
    if (!list) {
      list = [];
      byField.set(field, list);
      order.push(field);
    }
    if (!list.includes(value)) list.push(value);
  }
  return order.map((field) => ({ field, values: byField.get(field)!, ...fieldKind(field) }));
}

/** Render a chip's value list as the CSV label body (e.g. `InProgress, Complete`). The caller maps
 *  raw values to display labels first (e.g. enum → localized label) so this stays presentation-free. */
export function chipCsv(values: string[]): string {
  return values.join(', ');
}
