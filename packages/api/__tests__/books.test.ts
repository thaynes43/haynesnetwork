// ADR-046 / DESIGN-024 (PLAN-023) — the Books Library tRPC surface. The plan's acceptance proof:
//   • the `books` section LEVEL SEAM: a Disabled caller (default for non-admins) is server-REFUSED
//     (FORBIDDEN) even calling directly; a Read-Only role row opts a member in; Admin always sees it.
//   • books.search filters by media kind + query and offset-paginates; books.filterFacets returns the
//     distinct genres. Seeded through the sanctioned domain syncBooks single-writer (never a direct
//     insert — the no-direct-state-writes guard).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncBooks, type BooksItemInput } from '@hnet/domain';
import type { BooksSearchEntry } from '../src';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';


/** PLAN-056 — narrow the composed stream to its ON-DISK rows (these assertions target library
 *  items; wanted entries carry no item metadata). */
const onDisk = (items: BooksSearchEntry[]) => items.flatMap((i) => (i.kind === 'item' ? [i] : []));

let t: TestDb;
let adminCaller: Caller;
let disabledCaller: Caller; // Default member — books section disabled (the no-row default)
let readerCaller: Caller; // member whose role opts into books read_only

function bookRow(o: Partial<BooksItemInput> & Pick<BooksItemInput, 'mediaKind' | 'externalId' | 'title'>): BooksItemInput {
  return {
    source: o.mediaKind === 'audiobook' ? 'audiobookshelf' : 'kavita',
    libraryId: '1',
    libraryName: 'Books',
    sortTitle: (o.sortTitle ?? o.title).toLowerCase(),
    author: null,
    narrator: null,
    seriesName: null,
    year: null,
    releasedAt: null,
    genres: [],
    coverRef: 'v1_c1.png',
    deepLinkUrl: 'https://kavita.haynesnetwork.com/library/1/series/1',
    pageCount: null,
    wordCount: null,
    durationSeconds: null,
    sizeBytes: null,
    attrs: {},
    sourceAddedAt: null,
    sourceUpdatedAt: null,
    ...o,
  };
}

beforeAll(async () => {
  t = await bootMigratedDb();
  const admin = await createUser(t.db, { admin: true, displayName: 'Admin Ada' });
  const disabled = await createUser(t.db, { displayName: 'Member Mia' });
  const reader = await createUser(t.db, { displayName: 'Reader Rae' });
  adminCaller = caller(makeCtx(t.db, sessionUser(admin)));
  disabledCaller = caller(makeCtx(t.db, sessionUser(disabled)));
  // A member whose role opts into the books section at read_only.
  readerCaller = caller(makeCtx(t.db, sessionUser(reader, { books: 'read_only' })));

  // PLAN-029 (DESIGN-026 D-03/D-08) — the rows carry the facet dimensions the registry offers:
  // Kavita format codes + page counts, ABS narrator/series/language/duration. Counts stay stable
  // for the pre-029 assertions (2 books, 1 comic; audiobooks gain one facet-disjoint second row).
  await syncBooks({
    db: t.db,
    syncedSources: ['kavita', 'audiobookshelf'],
    rows: [
      bookRow({
        mediaKind: 'book',
        externalId: 'k1',
        title: 'Alpha',
        author: 'Zed Author',
        pageCount: 500,
        attrs: { format: 3 }, // epub
        // DESIGN-025 D-08 — About/Details enrichment (Kavita: summary/publisher/genres/year; no isbn/size).
        summary: 'A sweeping opening volume.',
        publisher: 'Kavita Press',
        genres: ['Epic'],
        year: 2001,
        metadataSyncedAt: new Date('2026-07-17T00:00:00Z'),
      }),
      bookRow({
        mediaKind: 'book',
        externalId: 'k2',
        title: 'Beta',
        author: 'Amy Author',
        pageCount: 150,
        attrs: { format: 4 }, // pdf
      }),
      bookRow({
        mediaKind: 'comic',
        externalId: 'k3',
        title: 'Comic One',
        libraryId: '2',
        libraryName: 'Comics',
        pageCount: 300,
        attrs: { format: 1 }, // archive (cbz/cbr)
      }),
      bookRow({
        mediaKind: 'audiobook',
        externalId: 'a1',
        title: 'Listen One',
        author: 'Zed Author',
        narrator: 'Nia Narrator',
        seriesName: 'The Long Saga',
        durationSeconds: 3600, // 'short' (<6 h)
        genres: ['Fantasy', 'Adventure'],
        attrs: { language: 'English' },
        // DESIGN-025 D-08 — ABS inline enrichment (summary/publisher/isbn/file_count/size all present).
        summary: 'An epic listen.',
        publisher: 'ABS Audio',
        isbn: '9781234567890',
        fileCount: 9,
        sizeBytes: 90_000_000,
      }),
      bookRow({
        mediaKind: 'audiobook',
        externalId: 'a2',
        title: 'Second Listen',
        author: 'Amy Author',
        durationSeconds: 50_400, // 14 h — 'long' (>12 h)
        attrs: { language: 'German' },
      }),
    ],
  });
});

afterAll(async () => {
  await t.stop();
});

describe('books section level seam (ADR-046 C-04)', () => {
  it('REFUSES a Disabled (default non-admin) caller with FORBIDDEN', async () => {
    await expect(disabledCaller.books.search({ mediaKind: 'book' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(disabledCaller.books.filterFacets({ mediaKind: 'audiobook' })).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
  });

  it('access reports visibility per caller', async () => {
    expect(await disabledCaller.books.access()).toEqual({ level: 'disabled', visible: false });
    expect(await readerCaller.books.access()).toEqual({ level: 'read_only', visible: true });
    expect((await adminCaller.books.access()).visible).toBe(true);
  });

  it('a Read-Only role row opts a member in', async () => {
    const res = await readerCaller.books.search({ mediaKind: 'book' });
    expect(res.items.map((i) => i.title).sort()).toEqual(['Alpha', 'Beta']);
  });
});

describe('books.search (ADR-046)', () => {
  it('scopes to the media kind and defaults to title sort', async () => {
    const books = await adminCaller.books.search({ mediaKind: 'book' });
    expect(books.items.map((i) => i.title)).toEqual(['Alpha', 'Beta']);
    const comics = await adminCaller.books.search({ mediaKind: 'comic' });
    expect(comics.items.map((i) => i.title)).toEqual(['Comic One']);
    const audio = await adminCaller.books.search({ mediaKind: 'audiobook' });
    expect(onDisk(audio.items)[0]?.durationSeconds).toBe(3600);
  });

  it('filters by query over title/author', async () => {
    const byAuthor = await adminCaller.books.search({ mediaKind: 'book', query: 'Amy' });
    expect(byAuthor.items.map((i) => i.title)).toEqual(['Beta']);
    const byTitle = await adminCaller.books.search({ mediaKind: 'book', query: 'alph' });
    expect(byTitle.items.map((i) => i.title)).toEqual(['Alpha']);
  });

  it('sorts by author', async () => {
    const res = await adminCaller.books.search({ mediaKind: 'book', sort: 'author' });
    // Amy Author (Beta) before Zed Author (Alpha).
    expect(res.items.map((i) => i.title)).toEqual(['Beta', 'Alpha']);
  });

  it('builds an authed cover-proxy URL from the coverRef', async () => {
    const res = await adminCaller.books.search({ mediaKind: 'book' });
    expect(onDisk(res.items)[0]?.posterUrl).toBe('/api/books/cover?source=kavita&id=k1&v=v1_c1.png');
  });

  it('paginates with an offset cursor', async () => {
    const page1 = await adminCaller.books.search({ mediaKind: 'book', limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBe(1);
    const page2 = await adminCaller.books.search({ mediaKind: 'book', limit: 1, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.title).not.toBe(page1.items[0]?.title);
  });
});

describe('books.filterFacets (ADR-046 + PLAN-029 D-08)', () => {
  it('returns the distinct genres for a media kind', async () => {
    const audio = await adminCaller.books.filterFacets({ mediaKind: 'audiobook' });
    expect(audio.genres).toEqual(['Adventure', 'Fantasy']);
    const book = await adminCaller.books.filterFacets({ mediaKind: 'book' });
    // DESIGN-025 D-08 — Kavita books now carry genres from the metadata enrichment call (was []).
    expect(book.genres).toEqual(['Epic']);
  });

  it('returns the PLAN-029 facet lists — populated-value-gated by construction (ADR-051 C-06)', async () => {
    const audio = await adminCaller.books.filterFacets({ mediaKind: 'audiobook' });
    expect(audio.authors).toEqual(['Amy Author', 'Zed Author']);
    expect(audio.narrators).toEqual(['Nia Narrator']); // only a1 carries one — sparse, still offered
    expect(audio.series).toEqual(['The Long Saga']);
    expect(audio.languages).toEqual(['English', 'German']);
    expect(audio.formats).toEqual([]); // ABS rows carry no Kavita format — empty ⇒ no chip

    const book = await adminCaller.books.filterFacets({ mediaKind: 'book' });
    expect(book.authors).toEqual(['Amy Author', 'Zed Author']);
    expect(book.narrators).toEqual([]); // Kavita has no narrators — the honest empty
    expect(book.formats).toEqual([
      { key: 'epub', label: 'EPUB' },
      { key: 'pdf', label: 'PDF' },
    ]);

    const comic = await adminCaller.books.filterFacets({ mediaKind: 'comic' });
    expect(comic.formats).toEqual([{ key: 'archive', label: 'CBZ/CBR' }]);
  });
});

describe('books.search facets + direction + A–Z jump (PLAN-029 step 2/6)', () => {
  it('filters by genre (jsonb overlap — regression guard: the shipped ANY(array) form 22P02ed the first time the chips got UI)', async () => {
    const res = await adminCaller.books.search({ mediaKind: 'audiobook', genres: ['Fantasy'] });
    expect(res.items.map((i) => i.title)).toEqual(['Listen One']);
    const orEd = await adminCaller.books.search({ mediaKind: 'audiobook', genres: ['Fantasy', 'Nope'] });
    expect(orEd.items.map((i) => i.title)).toEqual(['Listen One']); // same-field OR
  });

  it('filters by author (same-field OR, cross-field AND — the chip semantics)', async () => {
    const res = await adminCaller.books.search({ mediaKind: 'book', authors: ['Amy Author'] });
    expect(res.items.map((i) => i.title)).toEqual(['Beta']);
    const both = await adminCaller.books.search({
      mediaKind: 'book',
      authors: ['Amy Author', 'Zed Author'],
    });
    expect(both.items).toHaveLength(2);
  });

  it('filters by narrator / series / language (the ABS facets)', async () => {
    const narr = await adminCaller.books.search({ mediaKind: 'audiobook', narrators: ['Nia Narrator'] });
    expect(narr.items.map((i) => i.title)).toEqual(['Listen One']);
    const ser = await adminCaller.books.search({ mediaKind: 'audiobook', series: ['The Long Saga'] });
    expect(ser.items.map((i) => i.title)).toEqual(['Listen One']);
    const lang = await adminCaller.books.search({ mediaKind: 'audiobook', languages: ['German'] });
    expect(lang.items.map((i) => i.title)).toEqual(['Second Listen']);
  });

  it('filters by Kavita format keys', async () => {
    const epub = await adminCaller.books.search({ mediaKind: 'book', formats: ['epub'] });
    expect(epub.items.map((i) => i.title)).toEqual(['Alpha']);
    const either = await adminCaller.books.search({ mediaKind: 'book', formats: ['epub', 'pdf'] });
    expect(either.items).toHaveLength(2);
  });

  it('filters by length buckets — duration for audiobooks, pages for Kavita (OR-ed ranges)', async () => {
    const short = await adminCaller.books.search({ mediaKind: 'audiobook', lengths: ['short'] });
    expect(short.items.map((i) => i.title)).toEqual(['Listen One']); // 1 h
    const long = await adminCaller.books.search({ mediaKind: 'audiobook', lengths: ['long'] });
    expect(long.items.map((i) => i.title)).toEqual(['Second Listen']); // 14 h
    const shortBook = await adminCaller.books.search({ mediaKind: 'book', lengths: ['short'] });
    expect(shortBook.items.map((i) => i.title)).toEqual(['Beta']); // 150 pp
    const orEd = await adminCaller.books.search({ mediaKind: 'book', lengths: ['short', 'long'] });
    expect(orEd.items).toHaveLength(2); // 150 pp OR 500 pp
  });

  it('the A–Z letter jump narrows the ACTIVE sort column (title vs author)', async () => {
    const byTitle = await adminCaller.books.search({ mediaKind: 'book', sort: 'title', letter: 'b' });
    expect(byTitle.items.map((i) => i.title)).toEqual(['Beta']); // 'alpha' < 'b'
    const byAuthor = await adminCaller.books.search({ mediaKind: 'book', sort: 'author', letter: 'z' });
    expect(byAuthor.items.map((i) => i.title)).toEqual(['Alpha']); // Zed Author only
  });

  it('an explicit dir flips the primary column (R5 "+direction"), nulls still last', async () => {
    const desc = await adminCaller.books.search({ mediaKind: 'book', sort: 'title', dir: 'desc' });
    expect(desc.items.map((i) => i.title)).toEqual(['Beta', 'Alpha']);
    const pagesAsc = await adminCaller.books.search({ mediaKind: 'book', sort: 'pages', dir: 'asc' });
    expect(onDisk(pagesAsc.items).map((i) => i.pageCount)).toEqual([150, 500]);
  });
});

describe('books.groups (PLAN-029 D-04 — the grouped view aggregate)', () => {
  it('REFUSES a Disabled caller (same booksProcedure gate as the wall)', async () => {
    await expect(
      disabledCaller.books.groups({ mediaKind: 'book', groupBy: 'author' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('aggregates one card per author with count + a bounded cover sample, label-A–Z', async () => {
    const res = await adminCaller.books.groups({ mediaKind: 'book', groupBy: 'author' });
    expect(res.groups.map((g) => ({ key: g.key, count: g.count }))).toEqual([
      { key: 'Amy Author', count: 1 },
      { key: 'Zed Author', count: 1 },
    ]);
    expect(res.groups[0]?.coverUrls[0]).toBe('/api/books/cover?source=kavita&id=k2&v=v1_c1.png');
  });

  it('groups audiobooks by author too (the R2 Audiobooks default)', async () => {
    const res = await adminCaller.books.groups({ mediaKind: 'audiobook', groupBy: 'author' });
    expect(res.groups.map((g) => `${g.label}:${g.count}`)).toEqual(['Amy Author:1', 'Zed Author:1']);
  });

  it('author cards carry imageUrl: null when ABS is unavailable (env absent — the fan fallback, never an error)', async () => {
    const res = await adminCaller.books.groups({ mediaKind: 'audiobook', groupBy: 'author' });
    expect(res.groups.every((g) => g.imageUrl === null)).toBe(true);
  });

  it('groups audiobooks by GENRE (group-card-art pass): label + count, no art refs (glyph tiles client-side)', async () => {
    await expect(
      disabledCaller.books.groups({ mediaKind: 'audiobook', groupBy: 'genre' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const res = await adminCaller.books.groups({ mediaKind: 'audiobook', groupBy: 'genre' });
    expect(res.groups.map((g) => `${g.label}:${g.count}`)).toEqual(['Adventure:1', 'Fantasy:1']);
    expect(res.groups.every((g) => g.coverUrls.length === 0 && g.imageUrl === null)).toBe(true);
  });
});

describe('books.detail — enrichment + collections + history (DESIGN-025 D-08)', () => {
  async function idFor(mediaKind: 'book' | 'audiobook', title: string): Promise<string> {
    const res = await adminCaller.books.search({ mediaKind });
    const item = res.items.flatMap((i) => (i.kind === 'item' ? [i] : [])).find((i) => i.title === title);
    if (!item) throw new Error(`no ${mediaKind} titled ${title}`);
    return item.id;
  }

  it('a Kavita book carries summary/publisher/genres/year + an EPUB format label; no isbn/size (the gap)', async () => {
    const id = await idFor('book', 'Alpha');
    const res = await adminCaller.books.detail({ id });
    expect(res.item.summary).toBe('A sweeping opening volume.');
    expect(res.item.publisher).toBe('Kavita Press');
    expect(res.item.genres).toEqual(['Epic']);
    expect(res.item.year).toBe(2001);
    expect(res.item.formatLabel).toBe('EPUB');
    // Kavita rows keep the honest gap (series-detail skipped).
    expect(res.item.isbn).toBeNull();
    expect(res.item.fileCount).toBeNull();
    // Empty history collapses (no fixes/requests/collections seeded for this item).
    expect(res.collections).toEqual([]);
    expect(res.fixes).toEqual([]);
    expect(res.requests).toEqual([]);
  });

  it('an ABS audiobook carries the inline enrichment (summary/publisher/isbn/file_count/size/language)', async () => {
    const id = await idFor('audiobook', 'Listen One');
    const res = await adminCaller.books.detail({ id });
    expect(res.item.summary).toBe('An epic listen.');
    expect(res.item.publisher).toBe('ABS Audio');
    expect(res.item.isbn).toBe('9781234567890');
    expect(res.item.fileCount).toBe(9);
    expect(res.item.sizeBytes).toBe(90_000_000);
    expect(res.item.language).toBe('English');
    expect(res.item.formatLabel).toBe('Audiobook');
    expect(res.item.narrator).toBe('Nia Narrator');
  });

  it('is refused for a Disabled caller (same books gate as the walls)', async () => {
    const id = await idFor('book', 'Alpha');
    await expect(disabledCaller.books.detail({ id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  // ADR-071 — the unified grant gating (canFix / canForceSearch) on the books detail + the
  // grant-gated forceSearch mutation. Admin implies both; a granted role gets them; a books-reader
  // without the grant gets neither and is refused the mutation (the ratified rule superseding the
  // #375 owns||isAdmin stopgap for the books force-search surface).
  it('admin sees canFix + canForceSearch; a books-reader without the grant sees neither', async () => {
    const id = await idFor('book', 'Alpha');
    const admin = await adminCaller.books.detail({ id });
    expect(admin.canFix).toBe(true);
    expect(admin.canForceSearch).toBe(true);

    const reader = await readerCaller.books.detail({ id });
    expect(reader.canFix).toBe(false);
    expect(reader.canForceSearch).toBe(false);
  });

  it('forceSearch is FORBIDDEN without the force_search_book grant', async () => {
    const id = await idFor('book', 'Alpha');
    await expect(readerCaller.books.forceSearch({ booksItemId: id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
