// Unit tests for the generic FilterMap helpers (PLAN-018 D-2): attribute fields OR multiple values
// (drop the field when it empties); add de-dupes; setDrillFilter REPLACES (single-value); the
// read helpers (first/values/has) read it back, and a null/empty cell is never active. Generic over
// the host's field union.

import { describe, expect, it } from 'vitest';
import {
  addFilterValue,
  filterFirst,
  filterHas,
  filterValues,
  removeFilterValue,
  setDrillFilter,
  toggleFilterValue,
  type FilterMap,
} from './filterMap';

type F = 'run' | 'state' | 'truck';

describe('FilterMap helpers', () => {
  it('toggleFilterValue ORs values in and removes on a repeat, dropping the empty field', () => {
    let f: FilterMap<F> = {};
    f = toggleFilterValue(f, 'state', 'InProgress');
    f = toggleFilterValue(f, 'state', 'Complete');
    expect(f.state).toEqual(['InProgress', 'Complete']);
    f = toggleFilterValue(f, 'state', 'InProgress');
    expect(f.state).toEqual(['Complete']);
    f = toggleFilterValue(f, 'state', 'Complete');
    expect(f.state).toBeUndefined();
  });

  it('addFilterValue de-dupes / trims; removeFilterValue drops the field when emptied', () => {
    let f: FilterMap<F> = {};
    f = addFilterValue(f, 'truck', 'TR-08');
    f = addFilterValue(f, 'truck', 'TR-08'); // dup — no change
    f = addFilterValue(f, 'truck', '  '); // blank — no change
    f = addFilterValue(f, 'truck', 'TR-09');
    expect(f.truck).toEqual(['TR-08', 'TR-09']);
    f = removeFilterValue(f, 'truck', 'TR-08');
    expect(f.truck).toEqual(['TR-09']);
    f = removeFilterValue(f, 'truck', 'TR-09');
    expect(f.truck).toBeUndefined();
  });

  it('setDrillFilter REPLACES (single-value); first/values/has read it back', () => {
    let f: FilterMap<F> = { run: ['ORD-1'] };
    f = setDrillFilter(f, 'run', 'ORD-2');
    expect(f.run).toEqual(['ORD-2']);
    expect(filterFirst(f, 'run')).toBe('ORD-2');
    expect(filterValues(f, 'run')).toEqual(['ORD-2']);
    expect(filterHas(f, 'run', 'ORD-2')).toBe(true);
    expect(filterHas(f, 'run', 'ORD-1')).toBe(false);
    expect(filterHas(f, 'run', null)).toBe(false);
    expect(filterHas(f, 'run', '')).toBe(false);
  });
});
