// Generic client-side sort model (PLAN-018 task #5, decision D-5) — the reusable half of Work's
// `jobSort`. It sorts the LOADED rows in the browser when the filtered result is fully loaded (the
// common case); the comparators mirror a typical backend's whole-set order (string keys
// case-insensitive, nulls last, with a host-supplied stable tiebreaker) so the client-sort and the
// wire-sort paths agree. The host binds the row type, the wire-sort enum, and the per-sort field
// spec; this module owns only the generic cycle + comparator + sort loop (no reference-domain
// literal). Originally `apps/work/.../explorer/jobSort.ts` — lifted here so Inventory reuses the
// identical ordering rules behind its own columns.

/** Case-insensitive, numeric-aware string comparator (mirrors a typical SQL `COLLATE`). */
export const cmpStr = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** Numeric comparator. */
export const cmpNum = (a: number, b: number): number => a - b;

/** How to read + compare one sortable column's cell (ascending). The direction, nulls-last, and the
 *  host's stable tiebreaker are applied by {@link sortRowsClientSide}. `compare` is `never`-typed so
 *  a column can pin `cmpStr`/`cmpNum` without the cell's union widening the call site. */
export interface FieldSpec<Row> {
  get: (row: Row) => string | number | null | undefined;
  compare: (a: never, b: never) => number;
  dir: 'asc' | 'desc';
}

/** Tri-state cycle for a column header (PLAN-018): unsorted → asc → desc → cleared (`undefined` =
 *  the host's default order). Given the CURRENT sort, return the next one for `col`. `cycle` maps
 *  each column key to its asc/desc wire-sort values. */
export function nextSort<S, C extends string>(
  current: S | undefined,
  col: C,
  cycle: Record<C, { asc: S; desc: S }>,
): S | undefined {
  const { asc, desc } = cycle[col];
  if (current === asc) return desc;
  if (current === desc) return undefined;
  return asc;
}

/** The arrow glyph for a column under the current sort (▲ asc / ▼ desc / none). */
export function arrowFor<S, C extends string>(
  current: S | undefined,
  col: C,
  cycle: Record<C, { asc: S; desc: S }>,
): string {
  if (current === cycle[col].asc) return ' ▲';
  if (current === cycle[col].desc) return ' ▼';
  return '';
}

/** Sort `rows` in the browser by the chosen wire sort. Returns the SAME array when `sort` has no
 *  field spec (the host's default order) so the caller can cheaply skip. Null/empty cells sort LAST
 *  in either direction; equal cells fall back to the host's stable `tiebreaker` — mirrors a backend
 *  whole-set sort. The host passes its per-sort `fields` spec map + the `tiebreaker`. */
export function sortRowsClientSide<Row, S extends string>(
  rows: Row[],
  sort: S,
  { fields, tiebreaker }: { fields: Partial<Record<S, FieldSpec<Row>>>; tiebreaker: (a: Row, b: Row) => number },
): Row[] {
  const spec = fields[sort];
  if (!spec) return rows;
  const dir = spec.dir === 'desc' ? -1 : 1;
  const { get, compare } = spec;
  const copy = [...rows];
  copy.sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    const na = va == null || va === '';
    const nb = vb == null || vb === '';
    if (na || nb) {
      if (na && nb) return tiebreaker(a, b); // both null → stable tiebreaker
      return na ? 1 : -1; // nulls last, regardless of direction
    }
    const c = compare(va as never, vb as never);
    return c !== 0 ? c * dir : tiebreaker(a, b);
  });
  return copy;
}
