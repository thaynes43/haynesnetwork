// Unit tests for the generic client-side sort: the two-state cycle toggles the active column's
// direction (no cleared state), the arrow glyphs track the active column/direction, and the sort
// loop places null/empty cells LAST in both directions with a host-supplied stable tiebreaker
// (mirrors a backend whole-set sort).

import { describe, expect, it } from 'vitest';
import { arrowFor, cmpNum, cmpStr, nextSort, sortRowsClientSide, type FieldSpec } from './sort';

type Row = { id: string; name?: string | null; n?: number | null };
type Sort = 'name:asc' | 'name:desc' | 'n:asc' | 'n:desc' | 'seq';

const CYCLE = {
  name: { asc: 'name:asc' as Sort, desc: 'name:desc' as Sort },
  n: { asc: 'n:asc' as Sort, desc: 'n:desc' as Sort },
};

const FIELDS: Partial<Record<Sort, FieldSpec<Row>>> = {
  'name:asc': { get: (r) => r.name, compare: cmpStr as never, dir: 'asc' },
  'name:desc': { get: (r) => r.name, compare: cmpStr as never, dir: 'desc' },
  'n:asc': { get: (r) => r.n ?? null, compare: cmpNum as never, dir: 'asc' },
  'n:desc': { get: (r) => r.n ?? null, compare: cmpNum as never, dir: 'desc' },
};

const tiebreaker = (a: Row, b: Row): number => cmpStr(a.id, b.id);
const ids = (rows: Row[]): string[] => rows.map((r) => r.id);
const sort = (rows: Row[], s: Sort): Row[] => sortRowsClientSide(rows, s, { fields: FIELDS, tiebreaker });

describe('nextSort / arrowFor', () => {
  it('toggles the active column asc ↔ desc (no cleared state), entering other columns at asc', () => {
    expect(nextSort(undefined, 'name', CYCLE)).toBe('name:asc'); // unsorted → first direction
    expect(nextSort('name:asc' as Sort, 'name', CYCLE)).toBe('name:desc'); // toggle
    expect(nextSort('name:desc' as Sort, 'name', CYCLE)).toBe('name:asc'); // toggle back — never cleared
    expect(nextSort('name:asc' as Sort, 'n', CYCLE)).toBe('n:asc'); // a DIFFERENT column enters at asc
  });

  it('shows the arrow only for the active column + direction', () => {
    expect(arrowFor('n:asc' as Sort, 'n', CYCLE)).toBe(' ▲');
    expect(arrowFor('n:desc' as Sort, 'n', CYCLE)).toBe(' ▼');
    expect(arrowFor('n:asc' as Sort, 'name', CYCLE)).toBe('');
    expect(arrowFor(undefined, 'n', CYCLE)).toBe('');
  });
});

describe('sortRowsClientSide', () => {
  it('returns the SAME array (identity) when the sort has no field spec', () => {
    const rows: Row[] = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    expect(sort(rows, 'seq')).toBe(rows);
  });

  it('sorts a string column asc then desc (case-insensitive, numeric-aware)', () => {
    const rows: Row[] = [
      { id: '1', name: 'PC-1003' },
      { id: '2', name: 'PC-1001' },
      { id: '3', name: 'PC-1002' },
    ];
    expect(ids(sort(rows, 'name:asc'))).toEqual(['2', '3', '1']);
    expect(ids(sort(rows, 'name:desc'))).toEqual(['1', '3', '2']);
  });

  it('places null/empty cells LAST in BOTH directions, with a stable tiebreaker on ties', () => {
    const rows: Row[] = [
      { id: 'a', n: 3 },
      { id: 'b', n: null },
      { id: 'c', n: 1 },
    ];
    expect(ids(sort(rows, 'n:asc'))).toEqual(['c', 'a', 'b']);
    expect(ids(sort(rows, 'n:desc'))).toEqual(['a', 'c', 'b']);
  });

  it('keeps ties in tiebreaker order and does not mutate the input', () => {
    const rows: Row[] = [
      { id: 'z', name: 'same' },
      { id: 'a', name: 'same' },
    ];
    const before = ids(rows);
    expect(ids(sort(rows, 'name:asc'))).toEqual(['a', 'z']);
    expect(ids(rows)).toEqual(before);
  });
});
