// Issue #792 (DESIGN-028 amendment 2026-10-07; owner ruling 2026-10-07: admins only) — `books.requestEvents`, a
// want's Request Events (ADR-101) for the History on the Wanted detail and the book detail's linked requests:
//   • ADMIN-ONLY at the tRPC layer: an anonymous caller is UNAUTHORIZED; every non-admin is FORBIDDEN, the person who
//     shelved the want included, whatever sections their role holds;
//   • an admin reads the events the real writers recorded, newest first, as wire rows (ISO times, column-keyed
//     before/after), a page at a time through an opaque cursor;
//   • a malformed cursor is BAD_REQUEST; an unknown (or deleted) want is an empty page, not NOT_FOUND.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  linkIntegration,
  syncBooks,
  syncGoodreadsIntegration,
  type EnrichedShelfItem,
} from '@hnet/domain';
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
let requesterCaller: Caller; // non-admin who linked Goodreads and shelved the want (books + integrations: edit)
let readerCaller: Caller; // non-admin household member with books read_only
let requestId: string;
let integrationId: string;
let shelf: EnrichedShelfItem[];

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_ERROR';
  } catch (err) {
    return (err as { code?: string }).code ?? 'UNKNOWN';
  }
}

beforeAll(async () => {
  t = await bootMigratedDb();
  const admin = await createUser(t.db, { admin: true, displayName: 'Admin Ada' });
  const requester = await createUser(t.db, { displayName: 'Requester Remy' });
  const reader = await createUser(t.db, { displayName: 'Reader Rae' });
  adminCaller = caller(makeCtx(t.db, sessionUser(admin)));
  requesterCaller = caller(
    makeCtx(t.db, sessionUser(requester, { books: 'edit', integrations: 'edit' })),
  );
  readerCaller = caller(makeCtx(t.db, sessionUser(reader, { books: 'read_only' })));

  const { integration } = await linkIntegration({
    db: t.db,
    userId: requester.id,
    provider: 'goodreads',
    externalUserId: '1001',
    profileRef: '1001',
    actorId: requester.id,
  });
  integrationId = integration.id;
  shelf = [
    {
      shelf: 'to-read',
      externalBookId: 'gr-hyp',
      title: 'Hyperion',
      author: 'Dan Simmons',
      isbn: null,
      gbVolumeId: 'gb-hyp',
      coverUrl: null,
      shelvedAt: new Date('2026-10-01T00:00:00Z'),
      isComic: false,
    },
  ];
  // Mint-only (no LazyLibrarian bundle): one `shelf_want_minted` Request Event per want.
  await syncGoodreadsIntegration({
    db: t.db,
    integrationId,
    items: shelf,
    syncedShelves: ['to-read'],
    pacer: async () => {},
  });
  const wanted = await adminCaller.books.wanted({ mediaKind: 'book' });
  requestId = wanted.items.find((i) => i.title === 'Hyperion')!.requestId;
});

afterAll(async () => {
  await t?.stop();
});

describe('books.requestEvents — admins only', () => {
  it('rejects an anonymous caller with UNAUTHORIZED', async () => {
    const anon = caller(makeCtx(t.db, null));
    expect(await codeOf(() => anon.books.requestEvents({ requestId }))).toBe('UNAUTHORIZED');
  });

  it('refuses the person who shelved the want (FORBIDDEN), though they can open its Wanted detail', async () => {
    await expect(requesterCaller.books.wantedDetail({ requestId })).resolves.toMatchObject({
      requestId,
    });
    expect(await codeOf(() => requesterCaller.books.requestEvents({ requestId }))).toBe(
      'FORBIDDEN',
    );
  });

  it('refuses a household member with books access (FORBIDDEN)', async () => {
    expect(await codeOf(() => readerCaller.books.requestEvents({ requestId }))).toBe('FORBIDDEN');
  });

  it('an admin reads the recorded events as wire rows', async () => {
    const page = await adminCaller.books.requestEvents({ requestId });
    expect(page.nextCursor).toBeNull();
    expect(page.events).toHaveLength(1);
    const [mint] = page.events;
    expect(mint).toMatchObject({
      kind: 'mint',
      reason: 'shelf_want_minted',
      writer: 'syncShelfRequests',
      actor: 'sync',
      actorName: null,
      before: {},
      detail: null,
    });
    expect(mint!.after).toMatchObject({
      origin: 'goodreads',
      title: 'Hyperion',
      ebook_status: 'requested',
      audio_status: 'requested',
    });
    expect(new Date(mint!.createdAt).toISOString()).toBe(mint!.createdAt);
    expect(page.refs).toEqual({ items: {}, collections: {} });
    expect(page.want).toEqual({ origin: 'goodreads', collectionFormat: null });
  });
});

describe('books.requestEvents — paging and odd input', () => {
  it('pages through an opaque cursor, newest first, and names the library title a change points at', async () => {
    // A second event: Hyperion lands in the library, and the next shelf pass matches the want to it.
    await syncBooks({
      db: t.db,
      syncedSources: ['kavita'],
      rows: [
        {
          source: 'kavita',
          mediaKind: 'book',
          externalId: 'k-hyp',
          libraryId: '1',
          libraryName: 'Books',
          title: 'Hyperion',
          sortTitle: 'hyperion',
          author: 'Dan Simmons',
          narrator: null,
          seriesName: null,
          year: null,
          releasedAt: null,
          genres: [],
          coverRef: null,
          deepLinkUrl: 'https://kavita/hyp',
          pageCount: null,
          wordCount: null,
          durationSeconds: null,
          sizeBytes: null,
          attrs: {},
          sourceAddedAt: null,
          sourceUpdatedAt: null,
        },
      ],
    });
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId,
      items: shelf,
      syncedShelves: ['to-read'],
      pacer: async () => {},
    });

    const all = await adminCaller.books.requestEvents({ requestId });
    expect(all.events.map((e) => e.reason)).toEqual(['shelf_want_refreshed', 'shelf_want_minted']);
    const matched = all.events[0]!.after.matched_books_item_id as string;
    expect(all.refs.items[matched]).toEqual({ title: 'Hyperion', live: true });

    const first = await adminCaller.books.requestEvents({ requestId, limit: 1 });
    expect(first.events.map((e) => e.id)).toEqual([all.events[0]!.id]);
    expect(first.nextCursor).not.toBeNull();
    const second = await adminCaller.books.requestEvents({
      requestId,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.events.map((e) => e.id)).toEqual([all.events[1]!.id]);
    expect(second.nextCursor).toBeNull();
  });

  it('a malformed cursor is BAD_REQUEST', async () => {
    expect(
      await codeOf(() => adminCaller.books.requestEvents({ requestId, cursor: 'not-a-cursor' })),
    ).toBe('BAD_REQUEST');
    const wrongShape = Buffer.from(JSON.stringify(['yesterday', 'x']), 'utf8').toString(
      'base64url',
    );
    expect(
      await codeOf(() => adminCaller.books.requestEvents({ requestId, cursor: wrongShape })),
    ).toBe('BAD_REQUEST');
  });

  it('an unknown want is an empty page, not NOT_FOUND (a deleted want keeps its events)', async () => {
    const page = await adminCaller.books.requestEvents({
      requestId: '00000000-0000-4000-8000-000000000000',
    });
    expect(page).toEqual({
      events: [],
      refs: { items: {}, collections: {} },
      want: { origin: null, collectionFormat: null },
      nextCursor: null,
    });
  });
});
