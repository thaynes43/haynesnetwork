// Pure reorder geometry (ADR-015). DOM-free — this workspace has no DOM env,
// so we exercise computeDropIndex/resolveReorderIndex directly; the pointer
// drag path is covered by e2e. Rows are 20px tall starting at top=0.

import { describe, expect, it } from 'vitest';
import { computeDropIndex, resolveReorderIndex } from '../src/controls/reorder';

const rows = [
  { top: 0, height: 20 }, // midpoint 10
  { top: 20, height: 20 }, // midpoint 30
  { top: 40, height: 20 }, // midpoint 50
];

describe('computeDropIndex', () => {
  it('above the first row midpoint → 0', () => {
    expect(computeDropIndex(rows, 5)).toBe(0);
  });

  it('in a row top half → that row index', () => {
    expect(computeDropIndex(rows, 25)).toBe(1); // in row 1's top half
    expect(computeDropIndex(rows, 45)).toBe(2); // in row 2's top half
  });

  it('in a gap between midpoints → the lower row index', () => {
    expect(computeDropIndex(rows, 35)).toBe(2); // past row1 mid, before row2 mid
  });

  it('below the last row → length', () => {
    expect(computeDropIndex(rows, 100)).toBe(3);
  });

  it('exactly on a midpoint → the next row (strict >)', () => {
    expect(computeDropIndex(rows, 10)).toBe(1); // row0 mid=10 is not > 10
    expect(computeDropIndex(rows, 30)).toBe(2);
  });

  it('empty rows → 0', () => {
    expect(computeDropIndex([], 0)).toBe(0);
  });
});

describe('resolveReorderIndex', () => {
  it('moving down (from < drop) shifts down by one', () => {
    expect(resolveReorderIndex(0, 2)).toBe(1);
  });

  it('moving up (from > drop) is unchanged', () => {
    expect(resolveReorderIndex(3, 1)).toBe(1);
  });

  it('no-op drop (from === drop) is unchanged', () => {
    expect(resolveReorderIndex(2, 2)).toBe(2);
  });

  it('a not-found source (fromIndex -1) is returned unchanged', () => {
    expect(resolveReorderIndex(-1, 3)).toBe(-1);
  });
});
