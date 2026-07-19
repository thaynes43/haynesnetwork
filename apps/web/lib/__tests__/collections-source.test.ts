// Owner ruling 2026-07-18 — the /collections SOURCE-filter classification (the immutable "Locked" tag +
// the multi-select hide filter). Asserts the row-state mapping: which rows are Locked, which category each
// row filters under, and that unchecking a category (e.g. "Locked") hides exactly those rows.
import { describe, expect, it } from 'vitest';
import {
  SOURCE_CATEGORY_LABELS,
  handSourceCategory,
  presentSourceCategories,
  recipeSourceCategory,
  visibleSourceCategories,
  type SourceCategory,
} from '../collections-source';

describe('handSourceCategory — the Locked mapping', () => {
  it('an editable hand-file collection stays "Kometa config"', () => {
    expect(handSourceCategory(true)).toBe('config');
  });
  it('a non-editable row (too custom OR a Kometa-Defaults mirror) is "Locked"', () => {
    // Both non-editable kinds share editable:false, so both land under Locked (the immutable tag).
    expect(handSourceCategory(false)).toBe('locked');
  });
});

describe('recipeSourceCategory', () => {
  it('a Kometa recipe is "Added here"', () => {
    expect(recipeSourceCategory(true)).toBe('added');
  });
  it('a books recipe is "Managed here"', () => {
    expect(recipeSourceCategory(false)).toBe('managed');
  });
});

describe('presentSourceCategories — only what the list holds, in a fixed order', () => {
  it('a Kometa list with an added recipe + an editable hand row + a locked row offers all three', () => {
    expect(
      presentSourceCategories({
        isKometa: true,
        recipeCount: 2,
        hand: [{ editable: true }, { editable: false }],
        readOnlyCount: 0,
      }),
    ).toEqual(['added', 'config', 'locked']);
  });

  it('omits "Locked" when nothing is locked (no dangling option)', () => {
    expect(
      presentSourceCategories({
        isKometa: true,
        recipeCount: 1,
        hand: [{ editable: true }],
        readOnlyCount: 0,
      }),
    ).toEqual(['added', 'config']);
  });

  it('a Kometa list with only locked rows offers just "Locked"', () => {
    expect(
      presentSourceCategories({
        isKometa: true,
        recipeCount: 0,
        hand: [{ editable: false }, { editable: false }],
        readOnlyCount: 0,
      }),
    ).toEqual(['locked']);
  });

  it('a books list splits managed recipes vs read-only library rows', () => {
    expect(
      presentSourceCategories({
        isKometa: false,
        recipeCount: 3,
        hand: [],
        readOnlyCount: 2,
      }),
    ).toEqual(['managed', 'library']);
  });
});

describe('visibleSourceCategories — unchecking a category hides its rows', () => {
  const present: SourceCategory[] = ['added', 'config', 'locked'];

  it('nothing hidden shows every category (chip seeded all-on)', () => {
    expect(visibleSourceCategories(present, [])).toEqual(['added', 'config', 'locked']);
  });

  it('hiding "locked" drops the immutable rows and keeps the rest', () => {
    expect(visibleSourceCategories(present, ['locked'])).toEqual(['added', 'config']);
  });

  it('hiding everything present leaves nothing visible', () => {
    expect(visibleSourceCategories(present, ['added', 'config', 'locked'])).toEqual([]);
  });
});

describe('SOURCE_CATEGORY_LABELS — owner tone, no em-dashes', () => {
  it('maps every token to a plain label with no em-dash', () => {
    for (const label of Object.values(SOURCE_CATEGORY_LABELS)) {
      expect(label).not.toContain('—');
    }
    expect(SOURCE_CATEGORY_LABELS.locked).toBe('Locked');
    expect(SOURCE_CATEGORY_LABELS.added).toBe('Added here');
    expect(SOURCE_CATEGORY_LABELS.config).toBe('Kometa config');
  });
});
