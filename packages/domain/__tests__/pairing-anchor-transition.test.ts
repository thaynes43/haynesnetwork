// Issue #825 — cap/quota and partial detail reads cannot cancel a format during a Kavita series split.
// Embedded PostgreSQL 16; real Request Events writers and a bounded, recording LazyLibrarian stub.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  bookRequestEvents,
  bookRequests,
  booksFormatPairs,
  booksItems,
  gbCallBudget,
  gbQuotaState,
  llFormatReleases,
  permissionAudit,
} from '@hnet/db';
import {
  drainLlReleases,
  loadPairingCoverage,
  liveLlFormatOwners,
  recordLlReleases,
  runFormatPairing,
  runManualBookSearch,
  runEnglishEditionPass,
  settleRemovedPairingWants,
  repairOneBookPairingPark,
  syncFormatPairs,
  withRequestEventScope,
  type GbBudgetTracker,
  type LazyLibrarianClientBundle,
  type LlSnapshotRow,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

let t: TestDb;
let seq = 0;
const NOW = new Date('2026-10-07T23:32:00Z');
const noPace = async () => {};
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(permissionAudit);
  await t.db.delete(bookRequestEvents);
  await t.db.delete(llFormatReleases);
  await t.db.delete(bookRequests);
  await t.db.delete(booksFormatPairs);
  await t.db.delete(booksItems);
  await t.db.delete(gbCallBudget);
  await t.db.delete(gbQuotaState);
});

async function item(
  title = 'Mockingjay',
  options: { removed?: boolean; audio?: boolean; unknown?: boolean; author?: string | null } = {},
) {
  seq += 1;
  const author = options.author === undefined ? 'Suzanne Collins' : options.author;
  const [row] = await t.db
    .insert(booksItems)
    .values({
      source: options.audio ? 'audiobookshelf' : 'kavita',
      mediaKind: options.audio ? 'audiobook' : 'book',
      externalId: `split-${seq}`,
      libraryId: '1',
      libraryName: 'Books',
      title,
      sortTitle: title.toLowerCase(),
      author,
      deepLinkUrl: 'https://books.example',
      deletedAt: options.removed ? NOW : null,
      attrs: options.audio || options.unknown ? {} : { heldBooks: [{ title, author, isbn: null }] },
    })
    .returning();
  return row!;
}
async function want(
  anchorId: string,
  options: {
    title?: string;
    llId?: string | null;
    status?: 'wanted' | 'landed' | 'requested';
  } = {},
) {
  const [row] = await t.db
    .insert(bookRequests)
    .values({
      origin: 'pairing',
      pairingBooksItemId: anchorId,
      title: options.title ?? 'Mockingjay',
      author: 'Suzanne Collins',
      llBookId: options.llId === undefined ? 'gb-mockingjay' : options.llId,
      ebookStatus: 'landed',
      audioStatus: options.status ?? 'wanted',
      createdAt: NOW,
    })
    .returning();
  return row!;
}
function ll(audioStatus = 'Wanted', title = 'Mockingjay') {
  const calls: Array<{ cmd: string; id: string; format?: string }> = [];
  const row: LlSnapshotRow = { title, author: 'Suzanne Collins', ebookStatus: 'Open', audioStatus };
  const bundle = {
    read: { getAllBookStatuses: async () => new Map([['gb-mockingjay', row]]) },
    write: {
      addBook: async (id: string) => void calls.push({ cmd: 'addBook', id }),
      queueBook: async (id: string, format: string) =>
        void calls.push({ cmd: 'queueBook', id, format }),
      searchBook: async (id: string, format: string) =>
        void calls.push({ cmd: 'searchBook', id, format }),
      unqueueBook: async (id: string, format: string) =>
        void calls.push({ cmd: 'unqueueBook', id, format }),
    },
  } as unknown as LazyLibrarianClientBundle;
  return { bundle, calls };
}
const gb = { resolveVolume: async () => ({ volumeId: 'gb-mockingjay' }) };

describe('Kavita replacement anchors', () => {
  it('a retired anchor never reconciles or requeues a Skipped format, and settlement records one event', async () => {
    const old = await item('Mockingjay', { removed: true });
    const request = await want(old.id);
    const stub = ll('Skipped');
    const report = await withRequestEventScope({ actor: 'sync', site: 'format-pairing' }, () =>
      runFormatPairing({
        db: t.db,
        ll: stub.bundle,
        gb,
        cap: 0,
        now: NOW,
        pacer: noPace,
      }),
    );
    expect(report).toMatchObject({
      reconciled: 0,
      requeued: 0,
      retiredAnchorsSettled: 1,
      retiredAnchorsDeferred: 0,
    });
    expect(stub.calls).toEqual([]);
    const [settled] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, request.id));
    expect(settled).toMatchObject({
      llBookId: null,
      audioStatus: 'missing',
      title: 'Mockingjay',
      pairingBooksItemId: old.id,
    });
    const events = await t.db
      .select()
      .from(bookRequestEvents)
      .where(eq(bookRequestEvents.requestId, request.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: 'removed_anchor_settled',
      actor: 'sync',
      site: 'format-pairing',
    });
    expect(await settleRemovedPairingWants({ db: t.db, now: NOW })).toMatchObject({
      retiredAnchorsSettled: 0,
    });
    expect(
      (await loadPairingCoverage(t.db, 'audiobook'))({
        title: 'Mockingjay',
        author: 'Suzanne Collins',
        llBookId: null,
      }),
    ).toBe(false);
  });

  it('a mint-cap gap protects an existing release without giving the retired want coverage or ownership', async () => {
    const old = await item('Mockingjay', { removed: true });
    await want(old.id);
    await item();
    await recordLlReleases(t.db, {
      llBookId: 'gb-mockingjay',
      formats: ['audiobook'],
      reason: 'reidentified',
      requestId: null,
      now: NOW,
    });
    const stub = ll();
    const report = await runFormatPairing({
      db: t.db,
      ll: stub.bundle,
      gb,
      cap: 0,
      now: NOW,
      pacer: noPace,
    });
    expect(report).toMatchObject({
      retiredAnchorsSettled: 0,
      retiredAnchorsDeferred: 1,
      llReleasesPending: 1,
      llOrphanWanted: 0,
    });
    expect(stub.calls).toEqual([]);
    expect((await liveLlFormatOwners(t.db)).has('gb-mockingjay')).toBe(false);
    expect(
      (await loadPairingCoverage(t.db, 'audiobook'))({
        title: 'Mockingjay',
        author: 'Suzanne Collins',
        llBookId: 'gb-mockingjay',
      }),
    ).toBe(false);
    // A different job's drain applies the same protection, rather than depending on this run's in-memory state.
    expect(
      (await drainLlReleases({ db: t.db, ll: stub.bundle, site: 'goodreads-sync.release' })).tally
        .llReleasesPending,
    ).toBe(1);
    expect(stub.calls).toEqual([]);
  });

  it('a quota gap also defers the predecessor, then a resolved successor claims it before release', async () => {
    const old = await item('Mockingjay', { removed: true });
    const prior = await want(old.id);
    const replacement = await item();
    const stub = ll();
    const budget: GbBudgetTracker = {
      consumer: 'pairing',
      canSpend: () => false,
      spend: async () => {},
      used: () => 700,
    };
    const blocked = await runFormatPairing({
      db: t.db,
      ll: stub.bundle,
      gb,
      budget,
      cap: 1,
      now: NOW,
      pacer: noPace,
    });
    expect(blocked).toMatchObject({
      skippedBudget: 1,
      retiredAnchorsDeferred: 1,
      retiredAnchorsSettled: 0,
    });
    expect(stub.calls).toEqual([]);
    const resumed = await runFormatPairing({
      db: t.db,
      ll: stub.bundle,
      gb,
      cap: 1,
      now: NOW,
      pacer: noPace,
    });
    expect(resumed).toMatchObject({
      retiredAnchorsSettled: 1,
      retiredAnchorsDeferred: 0,
      pushed: 1,
    });
    const [next] = await t.db
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.pairingBooksItemId, replacement.id));
    const [retired] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, prior.id));
    expect(next).toMatchObject({ llBookId: 'gb-mockingjay', audioStatus: 'wanted' });
    expect(retired).toMatchObject({ llBookId: null, audioStatus: 'missing' });
    expect(stub.calls.filter((c) => c.cmd === 'unqueueBook')).toEqual([]);
    expect(await t.db.select().from(llFormatReleases)).toEqual([]);
  });

  it('an unread replacement defers release until its held-book census is known', async () => {
    const old = await item('Mockingjay', { removed: true });
    await want(old.id);
    await item('A scanner name that is not yet trusted', { unknown: true });
    await recordLlReleases(t.db, {
      llBookId: 'gb-mockingjay',
      formats: ['audiobook'],
      reason: 'reidentified',
      requestId: null,
      now: NOW,
    });
    const stub = ll();
    const report = await runFormatPairing({
      db: t.db,
      ll: stub.bundle,
      gb,
      cap: 1,
      now: NOW,
      pacer: noPace,
    });
    expect(report).toMatchObject({
      retiredAnchorsDeferred: 1,
      retiredAnchorsSettled: 0,
      llReleasesPending: 1,
    });
    expect(stub.calls).toEqual([]);
  });

  it('same title by another author does not invent a successor obligation', async () => {
    const old = await item('Mockingjay', { removed: true });
    await want(old.id);
    await item('Mockingjay', { author: 'Other Writer' });
    const stub = ll();
    const report = await runFormatPairing({
      db: t.db,
      ll: stub.bundle,
      gb,
      cap: 0,
      now: NOW,
      pacer: noPace,
    });
    expect(report).toMatchObject({ retiredAnchorsSettled: 1, retiredAnchorsDeferred: 0 });
    expect(stub.calls).toEqual([{ cmd: 'unqueueBook', id: 'gb-mockingjay', format: 'audiobook' }]);
  });

  it('a replacement pair prevents revival of a still-live audio anchor', async () => {
    const old = await item();
    const audio = await item('Mockingjay', { audio: true });
    await syncFormatPairs({ db: t.db, now: NOW });
    await t.db.insert(bookRequests).values({
      origin: 'pairing',
      pairingBooksItemId: audio.id,
      title: 'Mockingjay',
      author: 'Suzanne Collins',
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });
    await t.db.update(booksItems).set({ deletedAt: NOW }).where(eq(booksItems.id, old.id));
    const replacement = await item();
    expect(await syncFormatPairs({ db: t.db, now: NOW })).toMatchObject({
      dropped: 1,
      added: 1,
      revived: 0,
    });
    expect((await t.db.select().from(booksFormatPairs))[0]).toMatchObject({
      bookItemId: replacement.id,
      audioItemId: audio.id,
    });
  });

  it('a changed book with no LL id cannot inherit the old book landed state', async () => {
    const anchor = await item('Assistant to the Villain');
    const prior = await want(anchor.id, {
      title: 'Accomplice to the Villain',
      llId: null,
      status: 'landed',
    });
    const stub = ll('Wanted', 'Assistant to the Villain');
    const report = await runFormatPairing({
      db: t.db,
      ll: stub.bundle,
      gb,
      cap: 1,
      now: NOW,
      pacer: noPace,
    });
    expect(report).toMatchObject({ reidentified: 1, retitled: 0, pushed: 1 });
    const [request] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, prior.id));
    expect(request).toMatchObject({
      title: 'Assistant to the Villain',
      llBookId: 'gb-mockingjay',
      ebookStatus: 'landed',
      audioStatus: 'wanted',
    });
    expect(stub.calls.some((c) => c.cmd === 'queueBook' && c.format === 'audiobook')).toBe(true);
  });

  it('a changed null-ID want lands only when a fresh live pair proves the new book held', async () => {
    const anchor = await item('Assistant to the Villain');
    await item('Assistant to the Villain', { audio: true });
    const prior = await want(anchor.id, {
      title: 'Accomplice to the Villain',
      llId: null,
      status: 'landed',
    });
    const stub = ll();
    const report = await runFormatPairing({
      db: t.db,
      ll: stub.bundle,
      gb,
      now: NOW,
      pacer: noPace,
    });
    expect(report).toMatchObject({ reidentified: 1, retitled: 0, pushed: 0 });
    expect(stub.calls).toEqual([]);
    const [request] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, prior.id));
    expect(request).toMatchObject({
      title: 'Assistant to the Villain',
      llBookId: null,
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });
  });
  it('a manual search on a retained historical want audits the click but acquires nothing', async () => {
    const old = await item('Mockingjay', { removed: true });
    const request = await want(old.id);
    const user = await createUser(t.db);
    const stub = ll();
    expect(
      await runManualBookSearch({
        db: t.db,
        requestId: request.id,
        userId: user.id,
        actorId: user.id,
        ll: stub.bundle,
      }),
    ).toMatchObject({ searched: false, reason: 'unroutable', formats: [] });
    expect(stub.calls).toEqual([]);
    expect(await t.db.select().from(permissionAudit)).toHaveLength(1);
  });

  it('edition repair leaves retired and unread anchors untouched', async () => {
    const retired = await item('Mockingjay', { removed: true });
    const unread = await item('Mockingjay', { unknown: true });
    await want(retired.id);
    await want(unread.id);
    let resolves = 0;
    const report = await runEnglishEditionPass({
      db: t.db,
      now: NOW,
      snapshot: new Map([
        [
          'gb-mockingjay',
          {
            title: 'Mockingjay',
            author: 'Suzanne Collins',
            language: 'es',
            ebookStatus: 'Open',
            audioStatus: 'Wanted',
          },
        ],
      ]),
      resolver: {
        consumer: 'goodreads',
        gb: {
          resolveVolume: async () => {
            resolves += 1;
            return null;
          },
        },
      },
    });
    expect(report).toMatchObject({ due: 0, looked: 0, switched: 0, parked: 0 });
    expect(resolves).toBe(0);
  });

  it('an unread live anchor neither revives a dropped pair nor sweeps its old want', async () => {
    const anchor = await item();
    const audio = await item('Mockingjay', { audio: true });
    await want(anchor.id, { status: 'landed' });
    await syncFormatPairs({ db: t.db, now: NOW });
    await t.db.update(booksItems).set({ attrs: {} }).where(eq(booksItems.id, anchor.id));
    await t.db.update(booksItems).set({ deletedAt: NOW }).where(eq(booksItems.id, audio.id));
    const stub = ll('Skipped');
    const report = await runFormatPairing({
      db: t.db,
      ll: stub.bundle,
      gb,
      cap: 0,
      now: NOW,
      pacer: noPace,
    });
    expect(report).toMatchObject({ dropped: 1, revived: 0, reconciled: 0, requeued: 0 });
    expect(stub.calls).toEqual([]);
  });
});

describe('scoped one-book park repair', () => {
  const repair = (requestId: string, dryRun: boolean, expectedTitle = 'Wool') =>
    repairOneBookPairingPark({
      db: t.db,
      requestId,
      expectedPark: 'multi_book',
      expectedTitle,
      expectedAuthor: 'Suzanne Collins',
      dryRun,
      now: NOW,
    });
  async function parked(
    options: { unknown?: boolean; removed?: boolean; llId?: string | null; reason?: string } = {},
  ) {
    const anchor = await item('Wool', options);
    const request = await want(anchor.id, {
      title: 'First Shift - Legacy',
      llId: options.llId ?? null,
      status: 'landed',
    });
    await t.db
      .update(bookRequests)
      .set({ unroutableReason: options.reason ?? 'multi_book' })
      .where(eq(bookRequests.id, request.id));
    return { anchor, request };
  }
  it('dry-run changes nothing, then apply reidentifies the exact freshly one-book unpaired park with a repair event', async () => {
    const { request } = await parked();
    expect(await repair(request.id, true)).toMatchObject({
      eligible: true,
      applied: false,
      title: 'Wool',
      paired: false,
    });
    expect(await t.db.select().from(bookRequestEvents)).toHaveLength(0);
    expect(await repair(request.id, false)).toMatchObject({ eligible: true, applied: true });
    expect((await t.db.select().from(bookRequests))[0]).toMatchObject({
      title: 'Wool',
      llBookId: null,
      unroutableReason: null,
      ebookStatus: 'landed',
      audioStatus: 'requested',
    });
    expect((await t.db.select().from(bookRequestEvents))[0]).toMatchObject({
      reason: 'unparked',
      writer: 'repairOneBookPairingPark',
      actor: 'repair',
      site: 'pairing-one-book-repair',
    });
    expect(await repair(request.id, false)).toMatchObject({ eligible: false, applied: false });
    expect(await t.db.select().from(bookRequestEvents)).toHaveLength(1);
  });
  it('only a pair whose live counterpart matches the new book keeps the missing format landed', async () => {
    const { request } = await parked();
    await item('Wool', { audio: true });
    await syncFormatPairs({ db: t.db, now: NOW });
    expect(await repair(request.id, false)).toMatchObject({ paired: true, applied: true });
    expect((await t.db.select().from(bookRequests))[0]).toMatchObject({
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });
  });
  it('a stale pair for the old held book does not land the replacement book', async () => {
    const { anchor, request } = await parked();
    const audio = await item('First Shift - Legacy', { audio: true });
    await t.db
      .insert(booksFormatPairs)
      .values({
        bookItemId: anchor.id,
        audioItemId: audio.id,
        matchedVia: 'title_author',
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      });
    expect(await repair(request.id, false)).toMatchObject({ paired: false });
    expect((await t.db.select().from(bookRequests))[0]).toMatchObject({ audioStatus: 'requested' });
  });
  it('refuses a changed expected identity, unread/removed anchor, pushed want and wrong-volume/language parks', async () => {
    const normal = await parked();
    expect(await repair(normal.request.id, false, 'First Shift - Legacy')).toMatchObject({
      eligible: false,
    });
    for (const options of [
      { unknown: true },
      { removed: true },
      { llId: 'gb-mockingjay' },
      { reason: 'wrong_volume' },
      { reason: 'foreign_language' },
    ]) {
      const { request } = await parked(options);
      expect(await repair(request.id, false)).toMatchObject({ eligible: false, applied: false });
    }
    expect(await t.db.select().from(bookRequestEvents)).toHaveLength(0);
  });
});
