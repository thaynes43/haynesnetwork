// ADR-046 / DESIGN-024 (PLAN-023) — the Books Library tRPC surface. The plan's acceptance proof:
//   • the `books` section LEVEL SEAM: a Disabled caller (default for non-admins) is server-REFUSED
//     (FORBIDDEN) even calling directly; a Read-Only role row opts a member in; Admin always sees it.
//   • books.search filters by media kind + query and offset-paginates; books.filterFacets returns the
//     distinct genres. Seeded through the sanctioned domain syncBooks single-writer (never a direct
//     insert — the no-direct-state-writes guard).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncBooks, type BooksItemInput } from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';

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

  await syncBooks({
    db: t.db,
    syncedSources: ['kavita', 'audiobookshelf'],
    rows: [
      bookRow({ mediaKind: 'book', externalId: 'k1', title: 'Alpha', author: 'Zed Author' }),
      bookRow({ mediaKind: 'book', externalId: 'k2', title: 'Beta', author: 'Amy Author' }),
      bookRow({ mediaKind: 'comic', externalId: 'k3', title: 'Comic One', libraryId: '2', libraryName: 'Comics' }),
      bookRow({
        mediaKind: 'audiobook',
        externalId: 'a1',
        title: 'Listen One',
        durationSeconds: 3600,
        genres: ['Fantasy', 'Adventure'],
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
    expect(audio.items[0]?.durationSeconds).toBe(3600);
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
    expect(res.items[0]?.posterUrl).toBe('/api/books/cover?source=kavita&id=k1&v=v1_c1.png');
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

describe('books.filterFacets (ADR-046)', () => {
  it('returns the distinct genres for a media kind', async () => {
    const audio = await adminCaller.books.filterFacets({ mediaKind: 'audiobook' });
    expect(audio.genres).toEqual(['Adventure', 'Fantasy']);
    const book = await adminCaller.books.filterFacets({ mediaKind: 'book' });
    expect(book.genres).toEqual([]); // Kavita series carry no genres
  });
});
