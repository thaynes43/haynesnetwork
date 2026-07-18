// DESIGN-044 — the collection builder's search + live-preview orchestrator (read-only). Covers the D-04 ref
// search (books ⇒ Libretto, movies ⇒ the *arr franchise/ id lookup) and the D-05/D-10 held-vs-missing split
// against the app's OWN mirrors: books by ISBN with the DESIGN-037 title fallback, movies/TV by tmdb/tvdb id,
// plus the honest edges (a URL ref, a 0-member resolve, a provider outage). Providers are stubbed (ADR-010).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { booksItems } from '@hnet/db';
import { LibrettoUnreachableError } from '@hnet/libretto';
import { ArrError } from '@hnet/arr';
import {
  previewCollectionMembers,
  searchCollectionRefs,
  upsertMediaItemsBatch,
  type ArrClientBundle,
} from '../src';
import type { LibrettoClientBundle } from '../src/libretto-clients';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;

/** A minimal books_items row (only the mirror columns the held-match reads matter). */
async function seedBook(over: {
  source: 'kavita' | 'audiobookshelf';
  externalId: string;
  title: string;
  author?: string | null;
  isbn?: string | null;
}) {
  await t.db.insert(booksItems).values({
    source: over.source,
    mediaKind: over.source === 'audiobookshelf' ? 'audiobook' : 'book',
    externalId: over.externalId,
    libraryId: '1',
    libraryName: 'Lib',
    title: over.title,
    sortTitle: over.title.toLowerCase(),
    author: over.author ?? null,
    isbn: over.isbn ?? null,
    deepLinkUrl: `https://example.test/${over.externalId}`,
  });
}

/** A recording Libretto stub — only the read methods the builder uses (search + preview). */
function stubLibretto(opts: {
  search?: unknown;
  preview?: unknown;
  searchThrows?: unknown;
  previewThrows?: unknown;
}): LibrettoClientBundle {
  return {
    read: {
      search: async () => {
        if (opts.searchThrows) throw opts.searchThrows;
        return opts.search;
      },
      preview: async () => {
        if (opts.previewThrows) throw opts.previewThrows;
        return opts.preview;
      },
    },
  } as unknown as LibrettoClientBundle;
}

/** A stub *arr bundle — only the read lookups the builder uses. */
function stubArr(read: Partial<ArrClientBundle['read']>): ArrClientBundle {
  return { read, write: {} } as unknown as ArrClientBundle;
}

beforeAll(async () => {
  t = await bootMigratedDb();
  // The Kavita book library (books tab). One row has an ISBN; one is ISBN-null (the title-fallback case).
  await seedBook({ source: 'kavita', externalId: 'k1', title: 'The Way of Kings', author: 'Brandon Sanderson', isbn: '9780765326355' });
  await seedBook({ source: 'kavita', externalId: 'k2', title: 'Words of Radiance', author: 'Brandon Sanderson', isbn: null });
  // An audiobook (different tab/source) that must NOT count as held for the books tab.
  await seedBook({ source: 'audiobookshelf', externalId: 'a1', title: 'Oathbringer', author: 'Brandon Sanderson', isbn: null });
  // The movie mirror: Radarr holds tmdbId 120 (Fellowship), not 121 (Two Towers).
  await upsertMediaItemsBatch({
    db: t.db,
    arrKind: 'radarr',
    items: [
      {
        arrItemId: 1,
        tmdbId: 120,
        title: 'The Fellowship of the Ring',
        sortTitle: 'fellowship',
        year: 2001,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'HD',
        rootFolder: '/data/movies',
      },
    ],
  });
});

afterAll(async () => {
  await t?.stop();
});

describe('searchCollectionRefs (D-04)', () => {
  it('proxies Libretto for a books series search, shaping name/author/count', async () => {
    const libretto = stubLibretto({
      search: {
        results: [{ ref: '42', name: 'The Stormlight Archive', author: 'Brandon Sanderson', workCount: 5 }],
        truncated: false,
      },
    });
    const res = await searchCollectionRefs({
      libretto,
      arr: stubArr({}),
      builderType: 'hardcover_series',
      q: 'stormlight',
    });
    expect(res.reachable).toBe(true);
    expect(res.results[0]).toMatchObject({ ref: '42', name: 'The Stormlight Archive', subtitle: 'Brandon Sanderson', detail: '5 books' });
  });

  it('reads a movie franchise from Radarr lookup, and disables a movie with no franchise', async () => {
    const arr = stubArr({
      radarr: {
        lookupMovie: async () => [
          { title: 'The Fellowship of the Ring', year: 2001, tmdbId: 120, collection: { name: 'The Lord of the Rings Collection', tmdbId: 119 } },
          { title: 'The Two Towers', year: 2002, tmdbId: 121, collection: { title: 'The Lord of the Rings Collection', tmdbId: 119 } },
          { title: 'A Standalone', year: 2010, tmdbId: 900 },
        ],
      } as unknown as ArrClientBundle['read']['radarr'],
    });
    const res = await searchCollectionRefs({ libretto: stubLibretto({}), arr, builderType: 'tmdb_collection_details', q: 'lord' });
    // The franchise dedups (both films share collection 119) → one enabled pick + the disabled standalone.
    const enabled = res.results.filter((r) => !r.disabled);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({ ref: '119', name: 'The Lord of the Rings Collection' });
    const disabled = res.results.find((r) => r.disabled);
    expect(disabled?.disabledReason).toBe('this movie is not part of a franchise');
  });

  it('degrades to unreachable (manual entry) on a provider outage', async () => {
    const libretto = stubLibretto({ searchThrows: new LibrettoUnreachableError('GET', '/api/search') });
    const res = await searchCollectionRefs({ libretto, arr: stubArr({}), builderType: 'nyt_list', q: 'fiction' });
    expect(res.reachable).toBe(false);
    expect(res.results).toEqual([]);
  });

  it('returns nothing for an empty query without calling a provider', async () => {
    const res = await searchCollectionRefs({ libretto: stubLibretto({}), arr: stubArr({}), builderType: 'hardcover_series', q: '  ' });
    expect(res).toEqual({ results: [], truncated: false, reachable: true });
  });
});

describe('previewCollectionMembers — books held/missing split (D-05/D-10)', () => {
  it('splits by ISBN and the conservative title+author fallback, flagging title matches honestly', async () => {
    const libretto = stubLibretto({
      preview: {
        total: 3,
        truncated: false,
        members: [
          { title: 'The Way of Kings', author: 'Brandon Sanderson', isbn: '978-0-7653-2635-5', identifiers: ['isbn:9780765326355'] },
          { title: 'Words of Radiance', author: 'Brandon Sanderson', isbn: null, identifiers: [] },
          { title: 'Wind and Truth', author: 'Brandon Sanderson', isbn: '9999999999999', identifiers: [] },
        ],
      },
    });
    const res = await previewCollectionMembers({
      db: t.db,
      libretto,
      arr: stubArr({}),
      mediaType: 'books',
      builderType: 'hardcover_series',
      ref: '42',
    });
    expect(res.available).toBe(true);
    expect(res.total).toBe(3);
    expect(res.heldCount).toBe(2); // ISBN hit + title fallback hit
    expect(res.missingCount).toBe(1); // Wind and Truth — not in the library
    const held = res.members.filter((m) => m.held);
    const byIsbn = held.find((m) => m.title === 'The Way of Kings');
    const byTitle = held.find((m) => m.title === 'Words of Radiance');
    expect(byIsbn?.matchedByTitle).toBe(false); // exact ISBN match
    expect(byTitle?.matchedByTitle).toBe(true); // the honest title-fallback flag (Q-03)
  });

  it('does not count an audiobook-source row as held for the books tab', async () => {
    const libretto = stubLibretto({
      preview: { total: 1, truncated: false, members: [{ title: 'Oathbringer', author: 'Brandon Sanderson', isbn: null }] },
    });
    const res = await previewCollectionMembers({
      db: t.db,
      libretto,
      arr: stubArr({}),
      mediaType: 'books',
      builderType: 'hardcover_series',
      ref: '42',
    });
    // Oathbringer exists only under audiobookshelf, so the books tab sees it as Missing.
    expect(res.missingCount).toBe(1);
    expect(res.heldCount).toBe(0);
  });

  it('reports an honest 0-member resolve, never a fabricated tile', async () => {
    const libretto = stubLibretto({ preview: { total: 0, truncated: false, members: [] } });
    const res = await previewCollectionMembers({
      db: t.db,
      libretto,
      arr: stubArr({}),
      mediaType: 'books',
      builderType: 'hardcover_series',
      ref: 'empty',
    });
    expect(res.available).toBe(true);
    expect(res.total).toBe(0);
    expect(res.members).toEqual([]);
  });

  it('degrades to unavailable on a Libretto outage (never a save gate)', async () => {
    const libretto = stubLibretto({ previewThrows: new LibrettoUnreachableError('GET', '/api/search') });
    const res = await previewCollectionMembers({
      db: t.db,
      libretto,
      arr: stubArr({}),
      mediaType: 'audiobooks',
      builderType: 'hardcover_series',
      ref: '42',
    });
    expect(res.available).toBe(false);
    expect(res.unavailableReason).toContain('unreachable');
  });
});

describe('previewCollectionMembers — movies/TV (D-05/D-10)', () => {
  it('resolves a movie franchise from the Radarr collection read and splits held/missing by tmdbId', async () => {
    const arr = stubArr({
      radarr: {
        listCollections: async () => [
          {
            title: 'The Lord of the Rings Collection',
            tmdbId: 119,
            movies: [
              { tmdbId: 120, title: 'The Fellowship of the Ring' },
              { tmdbId: 121, title: 'The Two Towers' },
            ],
          },
        ],
      } as unknown as ArrClientBundle['read']['radarr'],
    });
    const res = await previewCollectionMembers({
      db: t.db,
      libretto: stubLibretto({}),
      arr,
      mediaType: 'movies',
      builderType: 'tmdb_collection_details',
      ref: '119',
    });
    expect(res.available).toBe(true);
    expect(res.total).toBe(2);
    expect(res.heldCount).toBe(1); // tmdbId 120 is in media_items
    expect(res.missingCount).toBe(1); // tmdbId 121 is not
  });

  it('previews a hand-picked movie id list, holding what the mirror has', async () => {
    const arr = stubArr({
      radarr: {
        lookupMovie: async (term: string) => {
          const id = Number(term.replace('tmdb:', ''));
          return [{ title: id === 120 ? 'The Fellowship of the Ring' : 'The Two Towers', year: 2001, tmdbId: id }];
        },
      } as unknown as ArrClientBundle['read']['radarr'],
    });
    const res = await previewCollectionMembers({
      db: t.db,
      libretto: stubLibretto({}),
      arr,
      mediaType: 'movies',
      builderType: 'tmdb_movie',
      ref: ['120', '121'],
    });
    expect(res.heldCount).toBe(1);
    expect(res.missingCount).toBe(1);
    expect(res.members.map((m) => m.title)).toContain('The Fellowship of the Ring');
  });

  it('renders the honest "preview unavailable" note for a URL-ref builder (Q-01)', async () => {
    const res = await previewCollectionMembers({
      db: t.db,
      libretto: stubLibretto({}),
      arr: stubArr({}),
      mediaType: 'movies',
      builderType: 'imdb_list',
      ref: 'https://www.imdb.com/list/ls012345678/',
    });
    expect(res.available).toBe(false);
    expect(res.unavailableReason).toContain('list link');
  });

  it('degrades honestly when the *arr lookup fails (never a save gate)', async () => {
    const arr = stubArr({
      radarr: {
        listCollections: async () => {
          throw new ArrError('radarr down');
        },
      } as unknown as ArrClientBundle['read']['radarr'],
    });
    const res = await previewCollectionMembers({
      db: t.db,
      libretto: stubLibretto({}),
      arr,
      mediaType: 'movies',
      builderType: 'tmdb_collection_details',
      ref: '119',
    });
    expect(res.available).toBe(false);
  });
});
