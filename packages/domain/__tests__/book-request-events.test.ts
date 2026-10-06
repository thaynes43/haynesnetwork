// ADR-101 / DESIGN-028 amendment 2026-10-06 (issue #741) — the Request Event. Every book_requests mint, change and
// delete a single writer makes records one append-only `book_request_events` row in the same transaction: the decision
// (`reason`), the writer, the job (`site`), who (`actor`) and the changed recorded fields before and after. Proves the
// write path (`updateBookRequests` / `insertBookRequest` / `deleteBookRequests` / `recordCascadedRequestDeletes` /
// `stampBookRequests`), the scope, the rollback, and the real writers that the sync jobs run hourly. Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  bookRequestEvents,
  bookRequests,
  booksCollections,
  type BookRequestEventRow,
} from '@hnet/db';
import {
  insertBookRequest,
  parkCollectionWant,
  repointRequestLlBook,
  revertLandedFormats,
  settleRequestLlGone,
  stampBookRequests,
  stampRequestsSearched,
  syncBooks,
  syncBooksCollections,
  syncCollectionWants,
  updateBookRequests,
  withRequestEventScope,
} from '../src';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
  await syncBooks({ db: t.db, syncedSources: ['kavita', 'audiobookshelf'], rows: [] });
});
afterAll(async () => {
  await t?.stop();
});

let collectionId: string;

async function seedCollection(externalId = 'stormlight'): Promise<string> {
  await syncBooksCollections({
    db: t.db,
    collections: [
      {
        source: 'kavita',
        externalId,
        kind: 'collection',
        libraryId: null,
        title: 'The Stormlight Archive',
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

const member = (ref: string, title: string, llBookId: string | null = null) => ({
  memberRef: ref,
  title,
  author: 'Brandon Sanderson',
  llBookId,
});

async function wantId(ref: string): Promise<string> {
  const [row] = await t.db
    .select({ id: bookRequests.id })
    .from(bookRequests)
    .where(
      and(eq(bookRequests.collectionId, collectionId), eq(bookRequests.collectionMemberRef, ref)),
    );
  return row!.id;
}

async function eventsOf(requestId: string): Promise<BookRequestEventRow[]> {
  return t.db
    .select()
    .from(bookRequestEvents)
    .where(eq(bookRequestEvents.requestId, requestId))
    .orderBy(asc(bookRequestEvents.createdAt), asc(bookRequestEvents.id));
}

beforeEach(async () => {
  await t.db.delete(bookRequestEvents);
  await t.db.delete(bookRequests);
  await t.db.delete(booksCollections);
  collectionId = await seedCollection();
});

describe('the mint, the refresh and the drop (syncCollectionWants)', () => {
  it('a mint records every recorded field; an unchanged re-run records nothing; a change records only itself', async () => {
    await syncCollectionWants({
      db: t.db,
      collectionId,
      format: 'ebook',
      members: [member('isbn:wok', 'The Way of Kings', 'llWok')],
    });
    const id = await wantId('isbn:wok');
    const [mint] = await eventsOf(id);
    expect(mint).toMatchObject({
      kind: 'mint',
      reason: 'collection_want_minted',
      writer: 'syncCollectionWants',
      actor: 'sync',
      site: null,
      actorUserId: null,
      before: {},
    });
    expect(mint!.after).toMatchObject({
      origin: 'collection',
      collection_id: collectionId,
      collection_member_ref: 'isbn:wok',
      title: 'The Way of Kings',
      ll_book_id: 'llWok',
      ebook_status: 'requested',
      audio_status: 'landed',
      unroutable_reason: null,
    });
    // Bookkeeping stamps are not recorded.
    expect(Object.keys(mint!.after)).not.toContain('last_reconciled_at');
    expect(Object.keys(mint!.after)).not.toContain('updated_at');

    // The hourly re-run stamps last_reconciled_at and changes nothing recorded: no event.
    await syncCollectionWants({
      db: t.db,
      collectionId,
      format: 'ebook',
      members: [member('isbn:wok', 'The Way of Kings', 'llWok')],
      now: new Date(Date.now() + 60_000),
    });
    expect(await eventsOf(id)).toHaveLength(1);

    // A retitle records the title only.
    await syncCollectionWants({
      db: t.db,
      collectionId,
      format: 'ebook',
      members: [member('isbn:wok', 'The Way of Kings (Stormlight #1)', 'llWok')],
      now: new Date(Date.now() + 120_000),
    });
    const [, refresh] = await eventsOf(id);
    expect(refresh).toMatchObject({
      kind: 'update',
      reason: 'collection_want_refreshed',
      before: { title: 'The Way of Kings' },
      after: { title: 'The Way of Kings (Stormlight #1)' },
    });
  });

  it('a dropped want keeps its history after its row is gone', async () => {
    await syncCollectionWants({
      db: t.db,
      collectionId,
      format: 'ebook',
      members: [member('isbn:wok', 'The Way of Kings', 'llWok')],
    });
    const id = await wantId('isbn:wok');
    await syncCollectionWants({
      db: t.db,
      collectionId,
      format: 'ebook',
      members: [],
      now: new Date(Date.now() + 60_000),
    });
    expect(await t.db.select().from(bookRequests).where(eq(bookRequests.id, id))).toEqual([]);
    const events = await eventsOf(id);
    expect(events.map((e) => `${e.kind}:${e.reason}`)).toEqual([
      'mint:collection_want_minted',
      'delete:collection_want_dropped',
    ]);
    expect(events[1]!.after).toEqual({});
    expect(events[1]!.before).toMatchObject({ title: 'The Way of Kings', ll_book_id: 'llWok' });
  });

  it('a collection that left its server records a delete for each want it takes with it', async () => {
    await syncCollectionWants({
      db: t.db,
      collectionId,
      format: 'ebook',
      members: [
        member('isbn:wok', 'The Way of Kings', 'llWok'),
        member('isbn:wor', 'Words of Radiance'),
      ],
    });
    const ids = [await wantId('isbn:wok'), await wantId('isbn:wor')];
    // A fully-read kavita family that no longer lists the collection removes it (and cascades its wants).
    await syncBooksCollections({
      db: t.db,
      collections: [],
      scopedFamilies: [{ source: 'kavita', kind: 'collection' }],
      now: new Date(Date.now() + 60_000),
    });
    expect(await t.db.select().from(bookRequests)).toEqual([]);
    for (const id of ids) {
      const events = await eventsOf(id);
      expect(events.map((e) => `${e.kind}:${e.reason}:${e.writer}`)).toEqual([
        'mint:collection_want_minted:syncCollectionWants',
        'delete:collection_removed:syncBooksCollections',
      ]);
    }
  });
});

describe('the sync writers that change what is downloaded', () => {
  async function want(llBookId = 'llOld'): Promise<string> {
    await syncCollectionWants({
      db: t.db,
      collectionId,
      format: 'ebook',
      members: [member('isbn:oath', 'Oathbringer', llBookId)],
    });
    return wantId('isbn:oath');
  }

  it('a re-point records the id it left and the one it took, with its site', async () => {
    const id = await want();
    expect(
      await repointRequestLlBook({
        db: t.db,
        requestId: id,
        fromLlBookId: 'llOld',
        toLlBookId: 'llNew',
        site: 'books-collections-sync.gone',
      }),
    ).toBe(true);
    const last = (await eventsOf(id)).at(-1)!;
    expect(last).toMatchObject({
      kind: 'update',
      reason: 'll_book_gone_repointed',
      writer: 'repointRequestLlBook',
      site: 'books-collections-sync.gone',
      actor: 'sync',
      before: { ll_book_id: 'llOld' },
      after: { ll_book_id: 'llNew' },
    });
    // A refused write (the id moved on) records nothing.
    expect(
      await repointRequestLlBook({
        db: t.db,
        requestId: id,
        fromLlBookId: 'llOld',
        toLlBookId: 'llOther',
      }),
    ).toBe(false);
    expect((await eventsOf(id)).at(-1)!.id).toBe(last.id);
  });

  it('a settle, a landed revert and a park each record their decision', async () => {
    const id = await want();
    await settleRequestLlGone({ db: t.db, requestId: id, llBookId: 'llOld', formats: ['ebook'] });
    await t.db.transaction((tx) =>
      updateBookRequests(tx, { writer: 'test', reason: 'll_reconciled' }, eq(bookRequests.id, id), {
        ebookStatus: 'landed',
      }),
    );
    await revertLandedFormats({
      db: t.db,
      requestId: id,
      llBookId: 'llOld',
      ebook: 'wanted',
      cause: 'll_not_held',
    });
    await parkCollectionWant({ db: t.db, requestId: id, llBookId: 'llOld' });

    const events = (await eventsOf(id)).slice(1); // past the mint
    expect(events.map((e) => [e.reason, e.before, e.after])).toEqual([
      ['ll_book_gone_settled', { ebook_status: 'requested' }, { ebook_status: 'missing' }],
      ['ll_reconciled', { ebook_status: 'missing' }, { ebook_status: 'landed' }],
      ['landed_reverted', { ebook_status: 'landed' }, { ebook_status: 'wanted' }],
      [
        'parked',
        { ll_book_id: 'llOld', unroutable_reason: null },
        { ll_book_id: null, unroutable_reason: 'wrong_volume' },
      ],
    ]);
    expect(events[0]!.detail).toEqual({ llBookId: 'llOld', formats: ['ebook'] });
    expect(events[2]!.detail).toEqual({ cause: 'll_not_held', llBookId: 'llOld' });
  });

  it('a bookkeeping stamp records nothing, and a state field is refused there', async () => {
    const id = await want();
    await stampRequestsSearched(t.db, [id], new Date());
    expect(await eventsOf(id)).toHaveLength(1);
    await expect(
      stampBookRequests(t.db, eq(bookRequests.id, id), { ebookStatus: 'landed' } as never),
    ).rejects.toThrow(/not a bookkeeping stamp/);
  });
});

describe('who and where (withRequestEventScope)', () => {
  it('the scope names the actor and site; a call names its own leg; nested scopes inherit', async () => {
    const user = await createUser(t.db);
    await withRequestEventScope({ actor: 'repair', site: 'some-repair' }, async () => {
      await syncCollectionWants({
        db: t.db,
        collectionId,
        format: 'ebook',
        members: [member('isbn:a', 'Rhythm of War', 'llA')],
      });
      await withRequestEventScope({ actorUserId: user.id }, async () => {
        await repointRequestLlBook({
          db: t.db,
          requestId: await wantId('isbn:a'),
          fromLlBookId: 'llA',
          toLlBookId: 'llB',
          site: 'explicit-leg',
        });
      });
    });
    const [mint, repoint] = await eventsOf(await wantId('isbn:a'));
    expect(mint).toMatchObject({ actor: 'repair', site: 'some-repair', actorUserId: null });
    expect(repoint).toMatchObject({ actor: 'repair', site: 'explicit-leg', actorUserId: user.id });

    // Outside any scope: a sync write with no site.
    await repointRequestLlBook({
      db: t.db,
      requestId: await wantId('isbn:a'),
      fromLlBookId: 'llB',
      toLlBookId: 'llC',
    });
    expect((await eventsOf(await wantId('isbn:a'))).at(-1)).toMatchObject({
      actor: 'sync',
      site: null,
    });
  });
});

describe('the event shares the write transaction', () => {
  it('a failed event insert rolls the change back', async () => {
    await syncCollectionWants({
      db: t.db,
      collectionId,
      format: 'ebook',
      members: [member('isbn:x', 'Edgedancer', 'llX')],
    });
    const id = await wantId('isbn:x');
    await t.db.execute(sql`
      CREATE OR REPLACE FUNCTION fail_request_event() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'request event refused'; END; $$ LANGUAGE plpgsql`);
    await t.db.execute(sql`
      CREATE TRIGGER fail_request_event BEFORE INSERT ON book_request_events
      FOR EACH ROW EXECUTE FUNCTION fail_request_event()`);
    try {
      await expect(
        repointRequestLlBook({ db: t.db, requestId: id, fromLlBookId: 'llX', toLlBookId: 'llY' }),
      ).rejects.toThrow();
    } finally {
      await t.db.execute(sql`DROP TRIGGER fail_request_event ON book_request_events`);
      await t.db.execute(sql`DROP FUNCTION fail_request_event()`);
    }
    const [row] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, id));
    expect(row!.llBookId).toBe('llX');
  });

  it('a mint that loses its conflict records nothing', async () => {
    await syncCollectionWants({
      db: t.db,
      collectionId,
      format: 'ebook',
      members: [member('isbn:dup', 'Dawnshard')],
    });
    const before = (await t.db.select().from(bookRequestEvents)).length;
    const row = await t.db.transaction((tx) =>
      insertBookRequest(
        tx,
        { writer: 'test', reason: 'collection_want_minted' },
        {
          origin: 'collection',
          collectionId,
          collectionMemberRef: 'isbn:dup',
          title: 'Dawnshard',
          ebookStatus: 'requested',
          audioStatus: 'landed',
        },
        {
          onConflictDoNothing: {
            target: [bookRequests.collectionId, bookRequests.collectionMemberRef],
            where: sql`${bookRequests.origin} = 'collection'`,
          },
        },
      ),
    );
    expect(row).toBeNull();
    expect((await t.db.select().from(bookRequestEvents)).length).toBe(before);
  });
});
