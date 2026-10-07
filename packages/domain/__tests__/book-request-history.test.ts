// Issue #792 (DESIGN-028 amendment 2026-10-07) — the one read of the Request Event record, `listRequestEvents`: a
// want's history newest first, a page at a time, with the person's name for a `user` event and the titles of the
// library items and collections the events name. Proves the order, the keyset paging (including events that share a
// transaction's timestamp and timestamps finer than a millisecond), that a deleted want keeps its history, and that the
// read never names anything it should not. Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { bookRequestEvents, bookRequests, booksCollections, booksItems, users } from '@hnet/db';
import {
  deleteBookRequests,
  insertBookRequest,
  listRequestEvents,
  syncBooks,
  syncBooksCollections,
  updateBookRequests,
  withRequestEventScope,
  type RequestEventCursor,
} from '../src';
import { inTransaction } from '../src/db-client';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});

beforeEach(async () => {
  await t.db.delete(bookRequestEvents);
  await t.db.delete(bookRequests);
  await t.db.delete(booksCollections);
});

const REQ = '11111111-1111-4111-8111-111111111111';

/** Insert one event at an exact time (the domain tests may write the table directly). */
async function event(
  createdAt: string,
  overrides: Partial<typeof bookRequestEvents.$inferInsert> = {},
): Promise<string> {
  const [row] = await t.db
    .insert(bookRequestEvents)
    .values({
      requestId: REQ,
      kind: 'update',
      reason: 'll_reconciled',
      writer: 'applyRequestReconcile',
      site: 'format-pairing',
      actor: 'sync',
      before: { ebook_status: 'wanted' },
      after: { ebook_status: 'missing' },
      // As text, so Postgres keeps the microseconds a JS Date cannot hold.
      createdAt: sql`${createdAt}::timestamptz`,
      ...overrides,
    })
    .returning({ id: bookRequestEvents.id });
  return row!.id;
}

/** Walk every page of a want's history, `limit` at a time. */
async function walk(requestId: string, limit: number): Promise<string[]> {
  const ids: string[] = [];
  let before: RequestEventCursor | null = null;
  for (let i = 0; i < 50; i++) {
    const page = await listRequestEvents({ db: t.db, requestId, before, limit });
    ids.push(...page.events.map((e) => e.id));
    if (!page.next) return ids;
    before = page.next;
  }
  throw new Error('paging never ended');
}

describe('listRequestEvents — order and paging', () => {
  it('lists one want newest first and never another want', async () => {
    const oldest = await event('2026-10-06T23:40:00Z', {
      kind: 'mint',
      reason: 'pairing_want_minted',
    });
    const middle = await event('2026-10-07T01:00:00Z');
    const newest = await event('2026-10-07T02:00:00Z', { reason: 'll_pushed' });
    await event('2026-10-07T03:00:00Z', { requestId: '22222222-2222-4222-8222-222222222222' });

    const page = await listRequestEvents({ db: t.db, requestId: REQ, limit: 20 });
    expect(page.events.map((e) => e.id)).toEqual([newest, middle, oldest]);
    expect(page.next).toBeNull();
    expect(page.events[2]).toMatchObject({
      kind: 'mint',
      reason: 'pairing_want_minted',
      actor: 'sync',
    });
  });

  it('pages without skipping or repeating, through shared timestamps and microseconds', async () => {
    // Three events of one transaction share its timestamp; two more differ only below a millisecond, which a cursor
    // carrying a JS Date would round away (and skip the older one).
    const shared = '2026-10-07T10:00:00.123456Z';
    const a = await event(shared);
    const b = await event(shared);
    const c = await event(shared);
    const fine1 = await event('2026-10-07T09:00:00.500900Z');
    const fine2 = await event('2026-10-07T09:00:00.500100Z');
    const first = await event('2026-10-07T08:00:00Z', { kind: 'mint' });

    const all = await walk(REQ, 20);
    expect(all).toHaveLength(6);
    for (const limit of [1, 2, 4]) {
      expect(await walk(REQ, limit)).toEqual(all);
    }
    // The shared-timestamp events come first (by id, newest-first order of the key), then the finer ones in time order.
    expect(all.slice(0, 3).sort()).toEqual([a, b, c].sort());
    expect(all.slice(3)).toEqual([fine1, fine2, first]);
  });

  it('carries the cursor at microsecond precision', async () => {
    await event('2026-10-07T10:00:00.123456Z');
    await event('2026-10-07T09:00:00Z');
    const page = await listRequestEvents({ db: t.db, requestId: REQ, limit: 1 });
    expect(page.next?.at).toBe('2026-10-07T10:00:00.123456Z');
  });

  it('an unknown want reads as an empty history', async () => {
    const page = await listRequestEvents({
      db: t.db,
      requestId: '33333333-3333-4333-8333-333333333333',
      limit: 20,
    });
    expect(page).toEqual({
      events: [],
      next: null,
      refs: { items: {}, collections: {} },
      want: { origin: null, collectionFormat: null },
    });
  });
});

describe('listRequestEvents — who, and what the events name', () => {
  it('names the person for a user event, and nobody once the account is gone', async () => {
    const person = await createUser(t.db, { displayName: 'Reader Rae' });
    const withUser = await event('2026-10-07T10:00:00Z', {
      actor: 'user',
      actorUserId: person.id,
      reason: 'force_search_reopened',
    });
    // A sync event never carries a name, whatever its actor_user_id says.
    await event('2026-10-07T09:00:00Z', { actorUserId: person.id });

    let page = await listRequestEvents({ db: t.db, requestId: REQ, limit: 20 });
    expect(page.events.map((e) => [e.id === withUser, e.actorName])).toEqual([
      [true, 'Reader Rae'],
      [false, null],
    ]);

    await t.db.delete(users).where(eq(users.id, person.id));
    page = await listRequestEvents({ db: t.db, requestId: REQ, limit: 20 });
    expect(page.events[0]).toMatchObject({ actor: 'user', actorName: null });
  });

  it('returns the titles of the library items and collections the page names', async () => {
    await syncBooks({
      db: t.db,
      syncedSources: ['kavita'],
      rows: [
        {
          source: 'kavita',
          mediaKind: 'book',
          externalId: 'k-1',
          libraryId: '1',
          libraryName: 'Books',
          title: 'The Way of Kings',
          sortTitle: 'way of kings',
          author: 'Brandon Sanderson',
          narrator: null,
          seriesName: null,
          year: null,
          releasedAt: null,
          genres: [],
          coverRef: null,
          deepLinkUrl: 'https://kavita/1',
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
    const [item] = await t.db
      .select({ id: booksItems.id })
      .from(booksItems)
      .where(eq(booksItems.externalId, 'k-1'));
    await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: 'kavita',
          externalId: 'stormlight',
          kind: 'collection',
          libraryId: null,
          title: 'The Stormlight Archive',
          itemCount: 0,
          ordered: false,
          createdBy: 'libretto',
          librettoRecipeId: 'recipe-stormlight',
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      scopedFamilies: [],
    });
    const [collection] = await t.db.select({ id: booksCollections.id }).from(booksCollections);
    const gone = '44444444-4444-4444-8444-444444444444';

    await event('2026-10-07T10:00:00Z', {
      reason: 'shelf_want_refreshed',
      before: { matched_books_item_id: gone },
      after: { matched_books_item_id: item!.id },
    });
    await event('2026-10-07T09:00:00Z', {
      kind: 'mint',
      reason: 'collection_want_minted',
      before: {},
      after: {
        collection_id: collection!.id,
        pairing_books_item_id: 'not-a-uuid',
        title: 'Oathbringer',
      },
    });

    const page = await listRequestEvents({ db: t.db, requestId: REQ, limit: 20 });
    expect(page.refs).toEqual({
      items: { [item!.id]: { title: 'The Way of Kings', live: true } },
      collections: { [collection!.id]: 'The Stormlight Archive' },
    });
  });
});

describe('listRequestEvents — the real writers', () => {
  it('a deleted want keeps its whole history: mint, change, delete', async () => {
    // A pairing want needs its library anchor: mint one against a live item.
    await syncBooks({
      db: t.db,
      syncedSources: ['kavita'],
      rows: [
        {
          source: 'kavita',
          mediaKind: 'book',
          externalId: 'k-anchor',
          libraryId: '1',
          libraryName: 'Books',
          title: 'Mistborn',
          sortTitle: 'mistborn',
          author: 'Brandon Sanderson',
          narrator: null,
          seriesName: null,
          year: null,
          releasedAt: null,
          genres: [],
          coverRef: null,
          deepLinkUrl: 'https://kavita/2',
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
    const [anchor] = await t.db
      .select({ id: booksItems.id })
      .from(booksItems)
      .where(eq(booksItems.externalId, 'k-anchor'));

    const want = await inTransaction(t.db, (tx) =>
      insertBookRequest(
        tx,
        { writer: 'upsertPairingWant', reason: 'pairing_want_minted', site: 'format-pairing' },
        {
          origin: 'pairing',
          pairingBooksItemId: anchor!.id,
          title: 'Mistborn',
          author: 'Brandon Sanderson',
          ebookStatus: 'landed',
          audioStatus: 'requested',
        },
      ),
    );
    await inTransaction(t.db, (tx) =>
      updateBookRequests(
        tx,
        { writer: 'markPairingWantPushed', reason: 'll_pushed', site: 'format-pairing.mint-push' },
        eq(bookRequests.id, want!.id),
        { audioStatus: 'wanted', llBookId: 'gb-mistborn' },
      ),
    );
    await withRequestEventScope({ actor: 'repair', site: 'a-repair' }, () =>
      inTransaction(t.db, (tx) =>
        deleteBookRequests(
          tx,
          { writer: 'aRepairScript', reason: 'removed_anchor_settled' },
          eq(bookRequests.id, want!.id),
        ),
      ),
    );
    const [row] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, want!.id));
    expect(row).toBeUndefined();

    const page = await listRequestEvents({ db: t.db, requestId: want!.id, limit: 20 });
    expect(page.events.map((e) => [e.kind, e.reason])).toEqual([
      ['delete', 'removed_anchor_settled'],
      ['update', 'll_pushed'],
      ['mint', 'pairing_want_minted'],
    ]);
    expect(page.events[0]).toMatchObject({ actor: 'repair', site: 'a-repair', after: {} });
    expect(page.events[0]!.before).toMatchObject({ title: 'Mistborn', ll_book_id: 'gb-mistborn' });
    expect(page.events[1]).toMatchObject({
      site: 'format-pairing.mint-push',
      before: { audio_status: 'requested', ll_book_id: null },
      after: { audio_status: 'wanted', ll_book_id: 'gb-mistborn' },
    });
    // Gone, so the want's origin comes from its mint's snapshot; a pairing want has no collection format.
    expect(page.want).toEqual({ origin: 'pairing', collectionFormat: null });
    // The mint names its anchor, which is live, so the read carries its title.
    expect(page.refs.items[anchor!.id]).toEqual({ title: 'Mistborn', live: true });
  });
});

describe('listRequestEvents — the want it describes', () => {
  async function seedCollection(
    source: 'kavita' | 'audiobookshelf',
    externalId: string,
  ): Promise<string> {
    await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source,
          externalId,
          kind: 'collection',
          libraryId: null,
          title: `Collection ${externalId}`,
          itemCount: 0,
          ordered: false,
          createdBy: 'libretto',
          librettoRecipeId: `recipe-${externalId}`,
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      scopedFamilies: [],
    });
    const [row] = await t.db
      .select({ id: booksCollections.id })
      .from(booksCollections)
      .where(eq(booksCollections.externalId, externalId));
    return row!.id;
  }

  it('names a live collection want’s one format, and keeps it after the want is deleted', async () => {
    const audioCollection = await seedCollection('audiobookshelf', 'abs-1');
    const want = await inTransaction(t.db, (tx) =>
      insertBookRequest(
        tx,
        { writer: 'syncCollectionWants', reason: 'collection_want_minted' },
        {
          origin: 'collection',
          collectionId: audioCollection,
          collectionMemberRef: 'isbn:1',
          title: 'Oathbringer',
          author: 'Brandon Sanderson',
          ebookStatus: 'landed',
          audioStatus: 'requested',
        },
      ),
    );
    let page = await listRequestEvents({ db: t.db, requestId: want!.id, limit: 20 });
    expect(page.want).toEqual({ origin: 'collection', collectionFormat: 'audiobook' });

    await inTransaction(t.db, (tx) =>
      deleteBookRequests(
        tx,
        { writer: 'syncCollectionWants', reason: 'collection_want_dropped' },
        eq(bookRequests.id, want!.id),
      ),
    );
    page = await listRequestEvents({ db: t.db, requestId: want!.id, limit: 20 });
    expect(page.want).toEqual({ origin: 'collection', collectionFormat: 'audiobook' });
  });

  it('a Kavita collection is the ebook format', async () => {
    const ebookCollection = await seedCollection('kavita', 'kav-1');
    const want = await inTransaction(t.db, (tx) =>
      insertBookRequest(
        tx,
        { writer: 'syncCollectionWants', reason: 'collection_want_minted' },
        {
          origin: 'collection',
          collectionId: ebookCollection,
          collectionMemberRef: 'isbn:2',
          title: 'Rhythm of War',
          author: 'Brandon Sanderson',
          ebookStatus: 'requested',
          audioStatus: 'landed',
        },
      ),
    );
    const page = await listRequestEvents({ db: t.db, requestId: want!.id, limit: 20 });
    expect(page.want).toEqual({ origin: 'collection', collectionFormat: 'ebook' });
  });
});
