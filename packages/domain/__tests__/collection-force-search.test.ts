// ADR-072 / DESIGN-043 D-14 (PLAN-052 PR4c) — the cron FORCE-SEARCH leg for the find-missing knob. Proves:
// only collections whose Libretto recipe has acquisitionEnabled ON get their origin='collection' wants
// force-searched; each force-search drives the confined LazyLibrarian chain (addBook→queueBook→searchBook),
// stamps last_searched_at, and writes ONE request_book_search audit; the cooldown makes it idempotent
// (a recently-searched want is skipped); an unresolved want (no llBookId) is skipped; a Libretto outage
// skips the whole pass. Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { bookRequests, booksCollections, permissionAudit } from '@hnet/db';
import { LibrettoUnreachableError } from '@hnet/libretto';
import {
  forceSearchFindMissingCollections,
  syncBooksCollections,
  syncCollectionWants,
  type CollectionWantsLibretto,
} from '../src';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(bookRequests);
  await t.db.delete(booksCollections);
  await t.db.delete(permissionAudit);
});

/** Seed a Libretto-managed mirror collection and return its local id. */
async function seedCollection(externalId: string, recipeId: string): Promise<string> {
  await syncBooksCollections({
    db: t.db,
    collections: [
      {
        source: 'kavita',
        externalId,
        kind: 'collection',
        libraryId: null,
        title: `Collection ${externalId}`,
        itemCount: 0,
        ordered: false,
        createdBy: 'libretto',
        librettoRecipeId: recipeId,
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
    .where(and(eq(booksCollections.externalId, externalId), eq(booksCollections.kind, 'collection')));
  return row!.id;
}

/** A recording LazyLibrarian write stub bundle. */
function stubLl() {
  const calls: Array<{ step: string; id: string; format?: string }> = [];
  const bundle = {
    write: {
      addBook: async (id: string) => void calls.push({ step: 'addBook', id }),
      queueBook: async (id: string, format: string) => void calls.push({ step: 'queueBook', id, format }),
      searchBook: async (id: string, format: string) => void calls.push({ step: 'searchBook', id, format }),
    },
  } as unknown as Parameters<typeof forceSearchFindMissingCollections>[0]['ll'];
  return { calls, bundle };
}

/** A Libretto read stub whose recipes carry the given acquisitionEnabled map (recipeId → on). */
function stubLibretto(acq: Record<string, boolean>, opts?: { unreachable?: boolean }): CollectionWantsLibretto {
  return {
    listRecipes: async () => {
      if (opts?.unreachable) throw new LibrettoUnreachableError('GET', '/api/recipes');
      return {
        recipes: Object.entries(acq).map(([id, on]) => ({
          id,
          builder: { type: 'hardcover_series', ref: id },
          variables: { acquisitionEnabled: on },
        })),
        issues: [],
      };
    },
  } as unknown as CollectionWantsLibretto;
}

const noPace = () => Promise.resolve();

describe('forceSearchFindMissingCollections — the cron acquisition leg', () => {
  it('force-searches only acquisition-ON collections’ resolved wants, stamps + audits each', async () => {
    const onId = await seedCollection('on', 'recipe-on');
    const offId = await seedCollection('off', 'recipe-off');
    // Two resolved wants on the ON collection (searchable), one on the OFF collection (must be skipped).
    await syncCollectionWants({
      db: t.db,
      collectionId: onId,
      format: 'ebook',
      members: [
        { memberRef: 'isbn:1', title: 'One', author: null, llBookId: 'gb1' },
        { memberRef: 'isbn:2', title: 'Two', author: null, llBookId: 'gb2' },
      ],
    });
    await syncCollectionWants({
      db: t.db,
      collectionId: offId,
      format: 'ebook',
      members: [{ memberRef: 'isbn:9', title: 'Nine', author: null, llBookId: 'gb9' }],
    });

    const ll = stubLl();
    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: stubLibretto({ 'recipe-on': true, 'recipe-off': false }),
      ll: ll.bundle,
      pacer: noPace,
    });

    expect(report.findMissingCollections).toBe(1);
    expect(report.searched).toBe(2);
    expect(report.failed).toBe(0);
    // The confined LL chain fired for both ON wants (addBook→queueBook→searchBook each), none for OFF.
    expect(ll.calls.filter((c) => c.step === 'searchBook').map((c) => c.id).sort()).toEqual(['gb1', 'gb2']);
    expect(ll.calls.some((c) => c.id === 'gb9')).toBe(false);
    // last_searched_at stamped on the ON wants only.
    const stamped = await t.db
      .select({ id: bookRequests.id, lastSearchedAt: bookRequests.lastSearchedAt, collectionId: bookRequests.collectionId })
      .from(bookRequests);
    for (const r of stamped) {
      if (r.collectionId === onId) expect(r.lastSearchedAt).not.toBeNull();
      else expect(r.lastSearchedAt).toBeNull();
    }
    // One request_book_search audit per force-search, tagged via find_missing_cron.
    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'request_book_search'));
    expect(audits).toHaveLength(2);
    expect((audits[0]!.detail as { via: string }).via).toBe('find_missing_cron');
  });

  it('is IDEMPOTENT via the cooldown — a want searched within the window is skipped next run', async () => {
    const id = await seedCollection('c', 'recipe-on');
    await syncCollectionWants({
      db: t.db,
      collectionId: id,
      format: 'ebook',
      members: [{ memberRef: 'isbn:1', title: 'One', author: null, llBookId: 'gb1' }],
    });
    const libretto = stubLibretto({ 'recipe-on': true });
    const first = await forceSearchFindMissingCollections({ db: t.db, libretto, ll: stubLl().bundle, pacer: noPace });
    expect(first.searched).toBe(1);
    const second = await forceSearchFindMissingCollections({ db: t.db, libretto, ll: stubLl().bundle, pacer: noPace });
    expect(second.candidates).toBe(0);
    expect(second.searched).toBe(0);
  });

  it('skips an unresolved want (no llBookId) — a visible tile, not yet force-searchable', async () => {
    const id = await seedCollection('c', 'recipe-on');
    await syncCollectionWants({
      db: t.db,
      collectionId: id,
      format: 'ebook',
      members: [{ memberRef: 'isbn:1', title: 'One', author: null, llBookId: null }],
    });
    const ll = stubLl();
    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: stubLibretto({ 'recipe-on': true }),
      ll: ll.bundle,
      pacer: noPace,
    });
    expect(report.searched).toBe(0);
    expect(ll.calls).toHaveLength(0);
  });

  it('DEGRADES on Libretto unreachable — the whole pass is skipped, nothing searched', async () => {
    const id = await seedCollection('c', 'recipe-on');
    await syncCollectionWants({
      db: t.db,
      collectionId: id,
      format: 'ebook',
      members: [{ memberRef: 'isbn:1', title: 'One', author: null, llBookId: 'gb1' }],
    });
    const ll = stubLl();
    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: stubLibretto({ 'recipe-on': true }, { unreachable: true }),
      ll: ll.bundle,
      pacer: noPace,
    });
    expect(report.unreachable).toBe(true);
    expect(report.searched).toBe(0);
    expect(ll.calls).toHaveLength(0);
    const [row] = await t.db
      .select({ lastSearchedAt: bookRequests.lastSearchedAt })
      .from(bookRequests)
      .where(eq(bookRequests.collectionId, id));
    expect(row?.lastSearchedAt).toBeNull();
  });
});
