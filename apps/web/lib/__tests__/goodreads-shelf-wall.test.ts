// ADR-057 / DESIGN-029 (PLAN-045) — the Goodreads shelf-wall helpers. The SHELF CHIP semantics
// deliberately MIRROR the Helpdesk ticket state-chip spec (DESIGN-012 D-12 / helpdesk.spec.ts):
// multi-select additive OR, a SUPERSET "All", canonical-default-writes-no-param, the deliberate
// EMPTY sentinel, populated-value gating, unknown-value drop.
import { describe, expect, it } from 'vitest';
import {
  GOODREADS_SHELF_ORDER,
  SHELF_EMPTY_TOKEN,
  filterShelfWallItems,
  shelfLabel,
  shelfParamsForSelection,
  shelfSelectionFromParams,
  shelfSort,
  sortShelfWallItems,
  toggleShelf,
  type ShelfWallItemLike,
} from '../goodreads-shelf-wall';

const POPULATED = ['to-read', 'currently-reading', 'read'];

describe('shelf chip selection (the Helpdesk state-chip semantics)', () => {
  it('no params ⇒ the DEFAULT selection: ALL populated shelves (a library wall shows everything)', () => {
    const sel = shelfSelectionFromParams([], POPULATED);
    expect([...sel].sort()).toEqual([...POPULATED].sort());
  });

  it('explicit params ⇒ exactly those shelves; unknown/unpopulated values drop (mangled-link safety)', () => {
    const sel = shelfSelectionFromParams(['read', 'did-not-finish', 'garbage'], POPULATED);
    expect([...sel]).toEqual(['read']); // did-not-finish is unpopulated here (A3 gate), garbage unknown
  });

  it('the `none` sentinel ⇒ the deliberately-empty selection', () => {
    expect(shelfSelectionFromParams([SHELF_EMPTY_TOKEN], POPULATED).size).toBe(0);
  });

  it('toggling is additive multi-select (add ⇄ remove one shelf, others untouched)', () => {
    const start = shelfSelectionFromParams(['to-read'], POPULATED);
    const plusRead = toggleShelf(start, 'read');
    expect([...plusRead].sort()).toEqual(['read', 'to-read']);
    const minusToRead = toggleShelf(plusRead, 'to-read');
    expect([...minusToRead]).toEqual(['read']);
  });

  it('serialization: canonical default (all populated) writes NO param', () => {
    expect(shelfParamsForSelection(new Set(POPULATED), POPULATED)).toBeNull();
  });

  it('serialization: a subset writes repeated params in CANONICAL shelf order', () => {
    expect(shelfParamsForSelection(new Set(['read', 'to-read']), POPULATED)).toEqual([
      'to-read',
      'read',
    ]);
  });

  it('serialization: the deliberately-empty selection writes the sentinel', () => {
    expect(shelfParamsForSelection(new Set(), POPULATED)).toEqual([SHELF_EMPTY_TOKEN]);
  });

  it('"All" is a SUPERSET select: selecting every chip round-trips to the no-param default', () => {
    // The All chip writes the full populated set; that IS the canonical default → no param → a
    // fresh visit resolves back to the same selection (the Helpdesk URL contract).
    const all = new Set(POPULATED);
    const params = shelfParamsForSelection(all, POPULATED);
    expect(params).toBeNull();
    expect([...shelfSelectionFromParams([], POPULATED)].sort()).toEqual([...all].sort());
  });

  it('canonical order + labels cover the four shelves (DNF last)', () => {
    expect(shelfSort(['read', 'did-not-finish', 'to-read', 'currently-reading'])).toEqual([
      ...GOODREADS_SHELF_ORDER,
    ]);
    expect(GOODREADS_SHELF_ORDER.map(shelfLabel)).toEqual([
      'To read',
      'Currently reading',
      'Read',
      'Did not finish',
    ]);
    expect(shelfLabel('some-custom-shelf')).toBe('some-custom-shelf'); // unknown slugs pass through
  });
});

const item = (over: Partial<ShelfWallItemLike>): ShelfWallItemLike => ({
  title: 'T',
  author: 'A',
  shelves: ['to-read'],
  shelvedAt: '2026-07-01T00:00:00.000Z',
  phase: 'searching',
  ...over,
});

describe('items wall filter/sort', () => {
  it('filters by shelf membership (additive OR across the selected set)', () => {
    const items = [
      item({ title: 'want', shelves: ['to-read'] }),
      item({ title: 'done', shelves: ['read'] }),
      item({ title: 'both', shelves: ['read', 'did-not-finish'] }),
    ];
    const got = filterShelfWallItems(items, { query: '', shelves: new Set(['read']) });
    expect(got.map((i) => i.title)).toEqual(['done', 'both']);
    expect(filterShelfWallItems(items, { query: '', shelves: new Set() })).toEqual([]);
  });

  it('narrows by phase and by title/author text', () => {
    const items = [
      item({ title: 'Dune', author: 'Frank Herbert', phase: 'have' }),
      item({ title: 'Hyperion', author: 'Dan Simmons', phase: 'missing' }),
    ];
    const shelves = new Set(['to-read']);
    expect(filterShelfWallItems(items, { query: '', shelves, phase: 'missing' })).toHaveLength(1);
    expect(filterShelfWallItems(items, { query: 'herbert', shelves })[0]?.title).toBe('Dune');
    expect(filterShelfWallItems(items, { query: 'zzz', shelves })).toEqual([]);
  });

  it('sorts by shelved date (desc default), title and author — null authors LAST either way', () => {
    const items = [
      item({ title: 'B', author: null, shelvedAt: '2026-07-03T00:00:00.000Z' }),
      item({ title: 'A', author: 'Zed', shelvedAt: '2026-07-01T00:00:00.000Z' }),
      item({ title: 'C', author: 'Ann', shelvedAt: '2026-07-02T00:00:00.000Z' }),
    ];
    expect(sortShelfWallItems(items, 'shelved', 'desc').map((i) => i.title)).toEqual(['B', 'C', 'A']);
    expect(sortShelfWallItems(items, 'title', 'asc').map((i) => i.title)).toEqual(['A', 'B', 'C']);
    expect(sortShelfWallItems(items, 'author', 'asc').map((i) => i.title)).toEqual(['C', 'A', 'B']);
    expect(sortShelfWallItems(items, 'author', 'desc').map((i) => i.title)).toEqual(['A', 'C', 'B']);
  });
});
