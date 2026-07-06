// Pure, framework-free FilterMap helpers (PLAN-018 §3 D-2) — the multi-value filter state that
// backs the editable chip bar + the client-side OR narrowing. Each field carries an ORDERED list of
// OR-ed values; attribute fields accumulate multiple values (same-field OR), cascade DRILL fields
// stay single-value (a drill REPLACES) but share the array shape so the chip bar + URL-sync treat
// every field uniformly.
//
// This module is field-AGNOSTIC: it is generic over the host's field-union type `F`. The host owns
// the union (and which fields drill vs toggle); these helpers never reference a reference-domain
// literal. Originally Work's `stores/draftStore` helpers — lifted here so Inventory can reuse the
// identical semantics behind its own field union.

/** The active filter map: each field → an ORDERED list of OR-ed values. Generic over the host's
 *  field union `F` (defaults to `string` for unconstrained callers). */
export type FilterMap<F extends string = string> = Partial<Record<F, string[]>>;

/** First value of a field (cascade-drill use + the single-valued wire param). */
export function filterFirst<F extends string>(filters: FilterMap<F>, field: F): string | undefined {
  return filters[field]?.[0];
}

/** All OR-ed values of a field (chips + client-side multi-value narrowing). */
export function filterValues<F extends string>(filters: FilterMap<F>, field: F): string[] {
  return filters[field] ?? [];
}

/** Is `value` an active value of `field`? (the FilterCell `active` highlight). A null/empty cell is
 *  never active. */
export function filterHas<F extends string>(
  filters: FilterMap<F>,
  field: F,
  value: string | null | undefined,
): boolean {
  if (value == null || value === '') return false;
  return (filters[field] ?? []).includes(value);
}

/** Toggle one ATTRIBUTE value (same-field OR): add if absent, remove if present; drop empty fields. */
export function toggleFilterValue<F extends string>(filters: FilterMap<F>, field: F, value: string): FilterMap<F> {
  const cur = filters[field] ?? [];
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  const out = { ...filters };
  if (next.length === 0) delete out[field];
  else out[field] = next;
  return out;
}

/** Add one value to a field (the chip editor's OR-in / typeahead add), de-duped. */
export function addFilterValue<F extends string>(filters: FilterMap<F>, field: F, value: string): FilterMap<F> {
  const v = value.trim();
  if (!v) return filters;
  const cur = filters[field] ?? [];
  if (cur.includes(v)) return filters;
  return { ...filters, [field]: [...cur, v] };
}

/** Remove one value from a field; drop the field when it empties. */
export function removeFilterValue<F extends string>(filters: FilterMap<F>, field: F, value: string): FilterMap<F> {
  const next = (filters[field] ?? []).filter((v) => v !== value);
  const out = { ...filters };
  if (next.length === 0) delete out[field];
  else out[field] = next;
  return out;
}

/** Set a DRILL field to a single value (a drill replaces — it advances the grain). */
export function setDrillFilter<F extends string>(filters: FilterMap<F>, field: F, value: string): FilterMap<F> {
  return { ...filters, [field]: [value] };
}
