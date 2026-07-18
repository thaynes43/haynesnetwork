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
  capMeter,
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

describe('DESIGN-044 cap meter (D-05)', () => {
  it('reads "N of cap", flags at/over the cap, and clamps the fill', () => {
    const under = capMeter(18, 25, false);
    expect(under.label).toBe('18 of 25');
    expect(under.over).toBe(false);
    expect(under.fraction).toBeCloseTo(18 / 25);

    const over = capMeter(40, 25, false);
    expect(over.over).toBe(true);
    expect(over.fraction).toBe(1); // clamped

    // An admin (cap-exempt) is never "over" — the meter is informational only.
    expect(capMeter(40, 25, true).over).toBe(false);
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
