// PLAN-056 / DESIGN-029 amendment 3 — the composed-Wanted SORT PARTICIPATION + the three-state
// Wanted filter, server-side:
//   • a wanted row participates HONESTLY in the active sort (title/author from the request
//     snapshot; created_at for the Added sort; NULLS LAST for the edition-metadata sorts a want
//     cannot answer) — the old head-of-grid PINNING is gone;
//   • the three states: 'hide' excludes the wanted rows server-side, 'only' returns them alone
//     (in the active sort), 'all' (default) composes both into one paged stream;
//   • the D-09 honesty rule rides the server now: a want answers only the text query — any other
//     refinement excludes wants from the 'all' stream;
//   • the composed offset cursor pages the UNION, so a wanted card never duplicates across pages.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  linkIntegration,
  syncBooks,
  syncGoodreadsIntegration,
  type EnrichedShelfItem,
} from '@hnet/domain';
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

let t: TestDb;
let api: Caller;

const titlesOf = (items: BooksSearchEntry[]) => items.map((i) => i.title);
const kindsOf = (items: BooksSearchEntry[]) => items.map((i) => i.kind);

beforeAll(async () => {
  t = await bootMigratedDb();
  const owner = await createUser(t.db, { admin: true, displayName: 'Owner Odin' });
  api = caller(makeCtx(t.db, sessionUser(owner)));

  // Two on-disk Kavita books bracketed alphabetically by the two wants below.
  await syncBooks({
    db: t.db,
    syncedSources: ['kavita'],
    rows: [
      {
        source: 'kavita',
        mediaKind: 'book',
        externalId: 'k-beta',
        libraryId: '1',
        libraryName: 'Books',
        title: 'Beta House',
        sortTitle: 'beta house',
        author: 'Amy Author',
        narrator: null,
        seriesName: null,
        year: null,
        releasedAt: null,
        genres: [],
        coverRef: 'v1.png',
        deepLinkUrl: 'https://kavita/beta',
        pageCount: 150,
        wordCount: null,
        durationSeconds: null,
        sizeBytes: null,
        attrs: {},
        sourceAddedAt: new Date('2026-01-02T00:00:00Z'),
        sourceUpdatedAt: null,
      },
      {
        source: 'kavita',
        mediaKind: 'book',
        externalId: 'k-yonder',
        libraryId: '1',
        libraryName: 'Books',
        title: 'Yonder',
        sortTitle: 'yonder',
        author: 'Zed Author',
        narrator: null,
        seriesName: null,
        year: null,
        releasedAt: null,
        genres: [],
        coverRef: 'v1.png',
        deepLinkUrl: 'https://kavita/yonder',
        pageCount: 500,
        wordCount: null,
        durationSeconds: null,
        sizeBytes: null,
        attrs: {},
        sourceAddedAt: new Date('2026-01-01T00:00:00Z'),
        sourceUpdatedAt: null,
      },
    ],
  });

  // Two unmet goodreads wants: 'Aardvark Adventures' sorts FIRST under Title A–Z, 'Zulu Zebra'
  // (author-less) sorts LAST — the pinning regression is unmistakable either way.
  const { integration } = await linkIntegration({
    db: t.db,
    userId: owner.id,
    provider: 'goodreads',
    externalUserId: '42',
    profileRef: '42',
    actorId: owner.id,
  });
  const items: EnrichedShelfItem[] = [
    {
      shelf: 'to-read',
      externalBookId: 'gr-aardvark',
      title: 'Aardvark Adventures',
      author: 'Wanda Writer',
      isbn: null,
      gbVolumeId: 'gb-aardvark',
      coverUrl: null,
      shelvedAt: new Date('2026-07-10T00:00:00Z'),
      isComic: false,
    },
    {
      shelf: 'to-read',
      externalBookId: 'gr-zulu',
      title: 'Zulu Zebra',
      author: null,
      isbn: null,
      gbVolumeId: 'gb-zulu',
      coverUrl: null,
      shelvedAt: new Date('2026-07-09T00:00:00Z'),
      isComic: false,
    },
  ];
  await syncGoodreadsIntegration({
    db: t.db,
    integrationId: integration.id,
    items,
    syncedShelves: ['to-read', 'currently-reading', 'read', 'did-not-finish'],
    pacer: async () => {},
  });
});

afterAll(async () => {
  await t?.stop();
});

describe('sort participation (the pinning is GONE)', () => {
  it('Title A–Z: a wanted "Aardvark" sorts FIRST because the sort says so — and "Zulu" sorts LAST', async () => {
    const res = await api.books.search({ mediaKind: 'book', sort: 'title' });
    expect(titlesOf(res.items)).toEqual(['Aardvark Adventures', 'Beta House', 'Yonder', 'Zulu Zebra']);
    expect(kindsOf(res.items)).toEqual(['wanted', 'item', 'item', 'wanted']);
  });

  it('Title Z–A flips the wants with the stream (no head-of-grid pinning)', async () => {
    const res = await api.books.search({ mediaKind: 'book', sort: 'title', dir: 'desc' });
    expect(titlesOf(res.items)).toEqual(['Zulu Zebra', 'Yonder', 'Beta House', 'Aardvark Adventures']);
  });

  it('Author A–Z: the want sorts by its author snapshot; an author-less want is NULLS LAST', async () => {
    const res = await api.books.search({ mediaKind: 'book', sort: 'author' });
    // Amy (Beta House) · Wanda (Aardvark, wanted) · Zed (Yonder) · null-author Zulu LAST.
    expect(titlesOf(res.items)).toEqual(['Beta House', 'Aardvark Adventures', 'Yonder', 'Zulu Zebra']);
  });

  it('Pages (a sort a want cannot answer): the on-disk rows lead, the wants are NULLS LAST — NOT first', async () => {
    const res = await api.books.search({ mediaKind: 'book', sort: 'pages' });
    expect(titlesOf(res.items)).toEqual(['Yonder', 'Beta House', 'Aardvark Adventures', 'Zulu Zebra']);
    expect(res.items[0]!.kind).toBe('item');
  });

  it('Added: a want participates by its request created_at (fresh mint ⇒ newest-first leads honestly)', async () => {
    const desc = await api.books.search({ mediaKind: 'book', sort: 'added' });
    // The wants were minted TODAY (created_at now) — newer than the 2026-01 source_added_at rows.
    // One sync run mints both wants at one transaction instant: the tie breaks alphabetically.
    expect(titlesOf(desc.items)).toEqual(['Aardvark Adventures', 'Zulu Zebra', 'Beta House', 'Yonder']);
    const asc = await api.books.search({ mediaKind: 'book', sort: 'added', dir: 'asc' });
    expect(titlesOf(asc.items)).toEqual(['Yonder', 'Beta House', 'Aardvark Adventures', 'Zulu Zebra']);
  });

  it('the composed offset cursor pages the UNION (no duplicate/dropped wants across pages)', async () => {
    const seen: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = await api.books.search({ mediaKind: 'book', sort: 'title', limit: 2, cursor });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...titlesOf(page.items));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['Aardvark Adventures', 'Beta House', 'Yonder', 'Zulu Zebra']);
  });
});

describe('the three-state Wanted filter (server-authoritative)', () => {
  it("'all' (the default) includes both kinds", async () => {
    const res = await api.books.search({ mediaKind: 'book', sort: 'title', wanted: 'all' });
    expect(new Set(kindsOf(res.items))).toEqual(new Set(['item', 'wanted']));
  });

  it("'hide' excludes the wanted rows server-side", async () => {
    const res = await api.books.search({ mediaKind: 'book', sort: 'title', wanted: 'hide' });
    expect(titlesOf(res.items)).toEqual(['Beta House', 'Yonder']);
    expect(kindsOf(res.items)).toEqual(['item', 'item']);
  });

  it("'only' returns exclusively the wanted rows, in the active sort", async () => {
    const asc = await api.books.search({ mediaKind: 'book', sort: 'title', wanted: 'only' });
    expect(titlesOf(asc.items)).toEqual(['Aardvark Adventures', 'Zulu Zebra']);
    expect(kindsOf(asc.items)).toEqual(['wanted', 'wanted']);
    expect(asc.nextCursor).toBeNull();
    const desc = await api.books.search({ mediaKind: 'book', sort: 'title', dir: 'desc', wanted: 'only' });
    expect(titlesOf(desc.items)).toEqual(['Zulu Zebra', 'Aardvark Adventures']);
  });
});

describe('the D-09 honesty rule, server-side', () => {
  it('the text query narrows wants and items alike', async () => {
    const res = await api.books.search({ mediaKind: 'book', sort: 'title', query: 'aardvark' });
    expect(titlesOf(res.items)).toEqual(['Aardvark Adventures']);
    expect(res.items[0]!.kind).toBe('wanted');
  });

  it('a facet refinement excludes the wants from the composed stream (they cannot answer it)', async () => {
    const res = await api.books.search({ mediaKind: 'book', sort: 'title', authors: ['Amy Author'] });
    expect(titlesOf(res.items)).toEqual(['Beta House']);
    expect(kindsOf(res.items)).toEqual(['item']);
  });

  it('the A–Z letter jump is an item refinement too — wants drop out of the narrowed stream', async () => {
    const res = await api.books.search({ mediaKind: 'book', sort: 'title', letter: 'y' });
    expect(titlesOf(res.items)).toEqual(['Yonder']);
    expect(kindsOf(res.items)).toEqual(['item']);
  });
});
