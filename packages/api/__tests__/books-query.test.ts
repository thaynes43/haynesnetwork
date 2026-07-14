// PLAN-029 (DESIGN-026 D-04) — pure unit tests for the group-view aggregate helpers (no db):
// A–Z group order, member counts, the bounded cover sample in wall order, null-key skipping,
// the null-cover fallback (a group member without art contributes no cover URL), and the genre
// aggregate (group-card-art pass — multi-genre rows count once per genre; label + count only).
import { describe, expect, it } from 'vitest';
import {
  aggregateBookGenreGroups,
  aggregateBookGroups,
  type BooksGroupSourceRow,
} from '../src/books-query';

const row = (o: Partial<BooksGroupSourceRow> & Pick<BooksGroupSourceRow, 'author' | 'sortTitle'>): BooksGroupSourceRow => ({
  source: 'kavita',
  externalId: o.sortTitle,
  coverRef: 'v1.png',
  ...o,
});

describe('aggregateBookGroups', () => {
  it('groups by author, label-A–Z, counting members', () => {
    const groups = aggregateBookGroups([
      row({ author: 'Zed', sortTitle: 'z1' }),
      row({ author: 'Amy', sortTitle: 'a1' }),
      row({ author: 'Amy', sortTitle: 'a2' }),
    ]);
    expect(groups.map((g) => `${g.key}:${g.count}`)).toEqual(['Amy:2', 'Zed:1']);
  });

  it('caps the cover sample (3 — the D-11 art-density call) in the wall’s A–Z title order', () => {
    const groups = aggregateBookGroups([
      row({ author: 'Amy', sortTitle: 'd' }),
      row({ author: 'Amy', sortTitle: 'b' }),
      row({ author: 'Amy', sortTitle: 'a' }),
      row({ author: 'Amy', sortTitle: 'c' }),
    ]);
    expect(groups[0]?.count).toBe(4);
    expect(groups[0]?.coverUrls).toHaveLength(3);
    expect(groups[0]?.coverUrls[0]).toContain('id=a');
  });

  it('skips null/blank keys (reachable via the flat view — no unfilterable pseudo-group)', () => {
    const groups = aggregateBookGroups([
      row({ author: null, sortTitle: 'x' }),
      row({ author: '  ', sortTitle: 'y' }),
      row({ author: 'Amy', sortTitle: 'a' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['Amy']);
  });

  it('a member without cover art contributes count but no cover URL', () => {
    const groups = aggregateBookGroups([
      row({ author: 'Amy', sortTitle: 'a', coverRef: null }),
      row({ author: 'Amy', sortTitle: 'b' }),
    ]);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.coverUrls).toHaveLength(1);
  });

  it('ships imageUrl: null — the portrait is a router-level enrichment (ABS directory), not ours', () => {
    const groups = aggregateBookGroups([row({ author: 'Amy', sortTitle: 'a' })]);
    expect(groups[0]?.imageUrl).toBeNull();
  });
});

describe('aggregateBookGenreGroups (group-card-art pass — the abstract Genre dimension)', () => {
  it('counts a multi-genre row once per genre, label-A–Z out', () => {
    const groups = aggregateBookGenreGroups([
      { genres: ['Fantasy', 'Classics'] },
      { genres: ['Classics'] },
      { genres: ['Audiobook'] },
    ]);
    expect(groups.map((g) => `${g.key}:${g.count}`)).toEqual([
      'Audiobook:1',
      'Classics:2',
      'Fantasy:1',
    ]);
  });

  it('skips null/empty genre lists and blank tags (reachable via the flat view)', () => {
    const groups = aggregateBookGenreGroups([
      { genres: null },
      { genres: [] },
      { genres: ['  ', 'Mystery'] },
    ]);
    expect(groups.map((g) => g.key)).toEqual(['Mystery']);
  });

  it('ships NO art refs — an abstract dimension renders the designed glyph tile client-side', () => {
    const groups = aggregateBookGenreGroups([{ genres: ['Fantasy'] }]);
    expect(groups[0]?.coverUrls).toEqual([]);
    expect(groups[0]?.imageUrl).toBeNull();
  });
});
