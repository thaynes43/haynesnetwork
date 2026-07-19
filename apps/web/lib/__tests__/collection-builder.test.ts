// DESIGN-044 — the builder page's client-safe helpers: the D-03 builder-card copy (VERBATIM, one source of
// truth for the page + the gallery), the cap meter (D-05), and the D-04 list-URL validation. The em-dash test
// enforces the owner tone rule against the shipped copy so a stray em-dash cannot slip into a card.
import { describe, expect, it } from 'vitest';
import {
  ALL_BUILDER_CARD_COPY,
  BOOKS_BUILDER_CARDS,
  MOVIES_BUILDER_CARDS,
  TV_BUILDER_CARDS,
  builderCard,
  builderCardsFor,
  collectionProgress,
  isValidListUrl,
} from '../collections';

describe('DESIGN-044 builder-card copy (D-03, verbatim)', () => {
  it('carries no em-dash or en-dash (the owner tone rule)', () => {
    for (const s of ALL_BUILDER_CARD_COPY) {
      expect(s.includes('—'), `em-dash in: ${s}`).toBe(false);
      expect(s.includes('–'), `en-dash in: ${s}`).toBe(false);
    }
  });

  it('orders each tab easiest-first with the verbatim explanations', () => {
    expect(BOOKS_BUILDER_CARDS.map((c) => c.builder)).toEqual([
      'hardcover_series',
      'nyt_list',
      'static_ids',
    ]);
    expect(MOVIES_BUILDER_CARDS[0]!.builder).toBe('tmdb_collection_details');
    expect(TV_BUILDER_CARDS[0]!.builder).toBe('tvdb_list_details');
    // A verbatim spot check (the exact D-03 string).
    expect(BOOKS_BUILDER_CARDS[0]!.explanation).toBe(
      'Every book in a series, in reading order. Type the series name and pick it, and the whole series comes along, even the ones the library does not have yet.',
    );
  });

  it('maps a media tab to its cards and looks one up by builder', () => {
    expect(builderCardsFor('audiobooks')).toBe(BOOKS_BUILDER_CARDS);
    expect(builderCard('movies', 'imdb_list')?.shape).toBe('url');
    expect(builderCard('books', 'hardcover_series')?.shape).toBe('search');
    expect(builderCard('books', 'static_ids')?.shape).toBe('multi');
    expect(builderCard('books', 'imdb_list')).toBeUndefined(); // wrong tab
  });
});

describe('DESIGN-044 gamified held/total (D-05, owner ruling 2026-07-18)', () => {
  it('celebrates a COMPLETE collection (held === total > 0) — caught em all', () => {
    const p = collectionProgress(2, 2); // the owner's complete 2-film franchise
    expect(p.complete).toBe(true);
    expect(p.empty).toBe(false);
    expect(p.held).toBe(2);
    expect(p.total).toBe(2);
    expect(p.missing).toBe(0);
  });

  it('reads held/total with the missing remainder for an INCOMPLETE collection', () => {
    const p = collectionProgress(1, 15); // a 15-member NYT list, 1 held
    expect(p.complete).toBe(false);
    expect(p.held).toBe(1);
    expect(p.total).toBe(15);
    expect(p.missing).toBe(14);
  });

  it('is EMPTY (no count, no celebration) when nothing resolved — never a fake caught-em-all', () => {
    const p = collectionProgress(0, 0);
    expect(p.empty).toBe(true);
    expect(p.complete).toBe(false); // total 0 is not a win
    expect(p.missing).toBe(0);
  });

  it('clamps a held count that overshoots the total (defensive, never negative missing)', () => {
    const p = collectionProgress(9, 4);
    expect(p.held).toBe(4);
    expect(p.total).toBe(4);
    expect(p.missing).toBe(0);
    expect(p.complete).toBe(true);
  });

  it('advertises no cap anywhere — the read is purely in-library vs total', () => {
    const p = collectionProgress(2, 2);
    // The shape carries only held/total/missing/complete/empty — no cap, no over, no fraction.
    expect(Object.keys(p).sort()).toEqual(['complete', 'empty', 'held', 'missing', 'total']);
  });
});

describe('DESIGN-044 list-URL validation (D-04)', () => {
  it('accepts a real IMDb / TVDb list URL and rejects junk', () => {
    expect(isValidListUrl('imdb_list', 'https://www.imdb.com/list/ls012345678/')).toBe(true);
    expect(isValidListUrl('imdb_list', 'not a url')).toBe(false);
    expect(isValidListUrl('tvdb_list_details', 'https://thetvdb.com/lists/some-list')).toBe(true);
    // A non-URL builder has no pattern — never blocks manual entry.
    expect(isValidListUrl('hardcover_series', 'the-stormlight-archive')).toBe(true);
  });
});
