// Issues #734 and #735 (DESIGN-028 / DESIGN-036 amendments 2026-10-06) — the app's per-format status follows
// LazyLibrarian's real state, and LazyLibrarian is told when the app gives a want up.
//
// #734: a `grabbed` format is only true while LazyLibrarian shows it `Snatched` (or holds it). LazyLibrarian puts a
// failed grab back to `Wanted`; the format then reads `wanted` (`Skipped` reads `missing`). One writer does it, the
// #715 `revertLandedFormats`, widened.
// #735: when a want is re-identified, parked, re-pointed or dropped (or its shelf item removed, or its account
// unlinked), the LazyLibrarian format the app had queued for it is recorded as a LazyLibrarian Release, and the drain
// unqueues it (`unqueueBook`, back to `Skipped`) once a fresh read shows it `Wanted`, nothing holds it, and no other
// live request asks for it — so another person's request is never cancelled.
//
// Embedded Postgres 16, a stub LazyLibrarian that records every write.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  bookRequests,
  booksCollections,
  booksFormatPairs,
  booksItems,
  gbCallBudget,
  gbQuotaState,
  integrationShelfItems,
  llFormatReleases,
  permissionAudit,
  userIntegrations,
} from '@hnet/db';
import {
  decideLlRelease,
  drainLlReleases,
  findGrabbedNotSnatched,
  findOrphanLlWants,
  linkIntegration,
  llAcquiredFormats,
  llQueuedFormats,
  parkCollectionWant,
  parkPairingWant,
  parkRequestNoEnglishEdition,
  recordLlReleases,
  reidentifyPairingWant,
  revertLandedFormats,
  runFormatPairing,
  switchRequestToEnglishEdition,
  syncCollectionWants,
  syncGoodreadsIntegration,
  unlinkIntegration,
  unqueueOrphanLlWants,
  type EnrichedShelfItem,
  type LazyLibrarianClientBundle,
  type LlSnapshotRow,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);
const noPace = async () => {};

type Row = Partial<LlSnapshotRow>;
type Call = { cmd: string; id: string; format?: string };

/** A stub LazyLibrarian: a real snapshot Map (a filler row keeps it non-empty), every write recorded. */
function stubLl(rows: Record<string, Row> = {}, opts: { failUnqueue?: boolean; emptyRead?: boolean } = {}) {
  const calls: Call[] = [];
  const state: Record<string, Row> = { ...rows };
  const snapshot = (): Map<string, LlSnapshotRow> => {
    if (opts.emptyRead) return new Map();
    const map = new Map<string, LlSnapshotRow>([
      ['filler-1', { title: 'Something Else Entirely', author: 'Nobody Here', ebookStatus: 'Open', audioStatus: 'Open' }],
    ]);
    for (const [id, r] of Object.entries(state)) map.set(id, { ...r });
    return map;
  };
  const bundle = {
    write: {
      addBook: async (id: string) => {
        calls.push({ cmd: 'addBook', id });
        return 'true';
      },
      queueBook: async (id: string, format: string) => void calls.push({ cmd: 'queueBook', id, format }),
      searchBook: async (id: string, format: string) => void calls.push({ cmd: 'searchBook', id, format }),
      unqueueBook: async (id: string, format: string) => {
        if (opts.failUnqueue) throw new Error('LazyLibrarian said no');
        calls.push({ cmd: 'unqueueBook', id, format });
        // LazyLibrarian's `_unqueuebook`: the format goes `Skipped`.
        const row = state[id];
        if (row) state[id] = { ...row, ...(format === 'audiobook' ? { audioStatus: 'Skipped' } : { ebookStatus: 'Skipped' }) };
        return 'OK';
      },
    },
    read: { getAllBookStatuses: async () => snapshot() },
  } as unknown as LazyLibrarianClientBundle;
  return { calls, bundle, state, snapshot };
}

const unqueues = (calls: Call[]) => calls.filter((c) => c.cmd === 'unqueueBook');

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(llFormatReleases);
  await t.db.delete(bookRequests);
  await t.db.delete(booksFormatPairs);
  await t.db.delete(integrationShelfItems);
  await t.db.delete(userIntegrations);
  await t.db.delete(booksItems);
  await t.db.delete(booksCollections);
  await t.db.delete(permissionAudit);
  await t.db.delete(gbQuotaState);
  await t.db.delete(gbCallBudget);
});

let seq = 0;
async function getRequest(id: string) {
  const [row] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, id));
  return row!;
}
const releases = () => t.db.select().from(llFormatReleases);

/** A linked Goodreads account with one shelf item and its request (both formats `wanted` on `llBookId`). */
async function seedGoodreadsWant(llBookId: string, over: Partial<typeof bookRequests.$inferInsert> = {}) {
  seq += 1;
  const user = await createUser(t.db);
  const { integration } = await linkIntegration({
    db: t.db,
    userId: user.id,
    provider: 'goodreads',
    externalUserId: String(seq),
    profileRef: String(seq),
    actorId: user.id,
  });
  const title = (over.title as string | undefined) ?? 'Shared Book';
  const [shelf] = await t.db
    .insert(integrationShelfItems)
    .values({
      integrationId: integration.id,
      shelf: 'to-read',
      externalBookId: `gr-${seq}`,
      title,
      author: 'Some One',
      gbVolumeId: llBookId,
      shelvedAt: new Date(),
    })
    .returning({ id: integrationShelfItems.id });
  const [row] = await t.db
    .insert(bookRequests)
    .values({
      integrationId: integration.id,
      shelfItemId: shelf!.id,
      title,
      author: 'Some One',
      llBookId,
      ebookStatus: 'wanted',
      audioStatus: 'wanted',
      lastReconciledAt: daysAgo(1),
      ...over,
    })
    .returning({ id: bookRequests.id });
  return { id: row!.id, integrationId: integration.id, userId: user.id, shelfItemId: shelf!.id, title };
}

/** A library item (a Kavita book by default) and its pairing want for the other format. */
async function seedPairingWant(
  llBookId: string | null,
  over: Partial<typeof bookRequests.$inferInsert> = {},
  anchor: { mediaKind?: 'book' | 'audiobook'; language?: string; title?: string } = {},
) {
  seq += 1;
  const title = anchor.title ?? `Pairing Book ${seq}`;
  const mediaKind = anchor.mediaKind ?? 'book';
  const [item] = await t.db
    .insert(booksItems)
    .values({
      source: mediaKind === 'book' ? 'kavita' : 'audiobookshelf',
      mediaKind,
      externalId: `p-${seq}`,
      libraryId: '1',
      libraryName: 'L',
      title,
      sortTitle: title.toLowerCase(),
      author: 'Some Author',
      deepLinkUrl: 'http://x',
      attrs: {
        heldBooks: [{ title, author: 'Some Author', isbn: null }],
        ...(anchor.language ? { language: anchor.language } : {}),
      },
    })
    .returning({ id: booksItems.id });
  const missing = mediaKind === 'book' ? 'audioStatus' : 'ebookStatus';
  const held = mediaKind === 'book' ? 'ebookStatus' : 'audioStatus';
  const [want] = await t.db
    .insert(bookRequests)
    .values({
      origin: 'pairing',
      pairingBooksItemId: item!.id,
      title,
      author: 'Some Author',
      llBookId,
      [held]: 'landed',
      [missing]: 'wanted',
      lastReconciledAt: daysAgo(1),
      createdAt: daysAgo(30),
      ...over,
    })
    .returning({ id: bookRequests.id });
  return { id: want!.id, anchorId: item!.id, title };
}

/** A books collection (kavita ⇒ ebook) and one of its wants, force-searched once. */
async function seedCollectionWant(llBookId: string, over: Partial<typeof bookRequests.$inferInsert> = {}) {
  seq += 1;
  const [collection] = await t.db
    .insert(booksCollections)
    .values({ source: 'kavita', externalId: `c-${seq}`, kind: 'collection', title: `Collection ${seq}` })
    .returning({ id: booksCollections.id });
  const [want] = await t.db
    .insert(bookRequests)
    .values({
      origin: 'collection',
      collectionId: collection!.id,
      collectionMemberRef: `isbn:${seq}`,
      title: 'Collection Member',
      author: 'Some Author',
      llBookId,
      ebookStatus: 'requested',
      audioStatus: 'landed',
      lastSearchedAt: daysAgo(1),
      lastReconciledAt: daysAgo(1),
      ...over,
    })
    .returning({ id: bookRequests.id });
  return { id: want!.id, collectionId: collection!.id };
}

// ---------------------------------------------------------------------------
// The pure rules.
// ---------------------------------------------------------------------------

describe('the pure rules', () => {
  it('decideLlRelease: owned first, then gone, held, downloading, unqueue, not wanted', () => {
    const wanted = { ebookStatus: 'Wanted', audioStatus: 'Wanted' };
    expect(decideLlRelease({ row: wanted, format: 'ebook', owned: true })).toBe('owned');
    expect(decideLlRelease({ row: undefined, format: 'ebook', owned: false })).toBe('gone');
    expect(decideLlRelease({ row: { ebookStatus: 'Open' }, format: 'ebook', owned: false })).toBe('held');
    // A `Wanted` row with a file is held: the unguarded unqueueBook would overwrite it.
    expect(decideLlRelease({ row: { ebookStatus: 'Wanted', ebookFile: '/b/x.epub' }, format: 'ebook', owned: false })).toBe(
      'held',
    );
    expect(decideLlRelease({ row: { audioStatus: 'Snatched' }, format: 'audiobook', owned: false })).toBe('downloading');
    expect(decideLlRelease({ row: wanted, format: 'audiobook', owned: false })).toBe('unqueue');
    expect(decideLlRelease({ row: { ebookStatus: 'Skipped' }, format: 'ebook', owned: false })).toBe('not_wanted');
    expect(decideLlRelease({ row: {}, format: 'ebook', owned: false })).toBe('not_wanted');
  });

  it('llAcquiredFormats: both for goodreads, the missing one for pairing, the source one for collection, none for a comic', () => {
    expect(llAcquiredFormats({ origin: 'goodreads' })).toEqual(['ebook', 'audiobook']);
    expect(llAcquiredFormats({ origin: 'goodreads', comicStatus: 'wanted' })).toEqual([]);
    expect(llAcquiredFormats({ origin: 'pairing' }, { anchorKind: 'book' })).toEqual(['audiobook']);
    expect(llAcquiredFormats({ origin: 'pairing' }, { anchorKind: 'audiobook' })).toEqual(['ebook']);
    expect(llAcquiredFormats({ origin: 'pairing' }, { anchorKind: 'comic' })).toEqual([]);
    expect(llAcquiredFormats({ origin: 'collection' }, { collectionSource: 'audiobookshelf' })).toEqual(['audiobook']);
    expect(llAcquiredFormats({ origin: 'collection' }, { collectionSource: 'kavita' })).toEqual(['ebook']);
  });

  it('llQueuedFormats: only what the app had LazyLibrarian working on', () => {
    const base = { origin: 'goodreads' as const, lastSearchedAt: null };
    expect(llQueuedFormats({ ...base, ebookStatus: 'wanted', audioStatus: 'grabbed' }, ['ebook', 'audiobook'])).toEqual([
      'ebook',
      'audiobook',
    ]);
    // Never pushed, settled, or landed: nothing the app queued.
    expect(llQueuedFormats({ ...base, ebookStatus: 'requested', audioStatus: 'missing' }, ['ebook', 'audiobook'])).toEqual(
      [],
    );
    expect(llQueuedFormats({ ...base, ebookStatus: 'landed', audioStatus: 'wanted' }, ['ebook'])).toEqual([]);
    // A collection want reads `requested` while it is searched: its evidence is the force-search stamp.
    const collection = { origin: 'collection' as const, ebookStatus: 'requested' as const, audioStatus: 'landed' as const };
    expect(llQueuedFormats({ ...collection, lastSearchedAt: new Date() }, ['ebook'])).toEqual(['ebook']);
    expect(llQueuedFormats({ ...collection, lastSearchedAt: null }, ['ebook'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #734 — `grabbed` follows LazyLibrarian.
// ---------------------------------------------------------------------------

describe('revertLandedFormats takes a format out of grabbed (#734)', () => {
  it('grabbed → wanted or missing; never grabbed → grabbed or landed; reports the formats that left grabbed', async () => {
    const { id } = await seedGoodreadsWant('ll-g1', { ebookStatus: 'grabbed', audioStatus: 'grabbed' });
    const result = await revertLandedFormats({ db: t.db, requestId: id, llBookId: 'll-g1', ebook: 'wanted', audio: 'grabbed' });
    expect(result).toEqual({ ebook: true, audio: false, comic: false, fromGrabbed: ['ebook'] });
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'grabbed' });
    expect((await revertLandedFormats({ db: t.db, requestId: id, llBookId: 'll-g1', audio: 'landed' })).audio).toBe(false);
    const skipped = await revertLandedFormats({ db: t.db, requestId: id, llBookId: 'll-g1', audio: 'missing' });
    expect(skipped.fromGrabbed).toEqual(['audiobook']);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'missing' });
  });

  it('a landed format still leaves landed for grabbed, and is not reported as a grab revert', async () => {
    const { id } = await seedGoodreadsWant('ll-g2', { ebookStatus: 'landed', audioStatus: 'wanted' });
    const result = await revertLandedFormats({ db: t.db, requestId: id, llBookId: 'll-g2', ebook: 'grabbed' });
    expect(result).toEqual({ ebook: true, audio: false, comic: false, fromGrabbed: [] });
  });

  it('refuses a request the library holds, and one that points at another book now', async () => {
    const [item] = await t.db
      .insert(booksItems)
      .values({
        source: 'kavita',
        mediaKind: 'book',
        externalId: 'm-734',
        libraryId: '1',
        libraryName: 'L',
        title: 'Held',
        sortTitle: 'held',
        author: 'Some One',
        deepLinkUrl: 'http://x',
      })
      .returning({ id: booksItems.id });
    const matched = await seedGoodreadsWant('ll-g3', { ebookStatus: 'grabbed', matchedBooksItemId: item!.id });
    expect((await revertLandedFormats({ db: t.db, requestId: matched.id, llBookId: 'll-g3', ebook: 'wanted' })).ebook).toBe(
      false,
    );
    const moved = await seedGoodreadsWant('ll-g4', { ebookStatus: 'grabbed' });
    expect((await revertLandedFormats({ db: t.db, requestId: moved.id, llBookId: 'll-other', ebook: 'wanted' })).ebook).toBe(
      false,
    );
    expect((await getRequest(moved.id)).ebookStatus).toBe('grabbed');
  });

  it("a comic's grabbed is not this writer's (it follows its Kapowarr volume through the reconcile)", async () => {
    const { id } = await seedGoodreadsWant('ll-g5', { comicStatus: 'grabbed', llBookId: null });
    const result = await revertLandedFormats({ db: t.db, requestId: id, llBookId: null, comic: 'wanted' });
    expect(result.comic).toBe(false);
  });
});

describe('syncGoodreadsIntegration — a failed grab stops reading grabbed (#734)', () => {
  const item = (gbVolumeId: string): EnrichedShelfItem => ({
    shelf: 'to-read',
    externalBookId: 'gr-kingdom',
    title: 'Kingdom of Ash',
    author: 'Sarah J. Maas',
    isbn: null,
    gbVolumeId,
    coverUrl: null,
    shelvedAt: new Date(),
    isComic: false,
  });

  async function seed(ebook: string, audio: string) {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '734',
      profileRef: '734',
      actorId: user.id,
    });
    const ll = stubLl({
      'mCl-EAAAQBAJ': { title: 'Kingdom of Ash', author: 'Sarah J. Maas', ebookStatus: 'Snatched', audioStatus: 'Snatched', language: 'en' },
    });
    const run = () =>
      syncGoodreadsIntegration({
        db: t.db,
        integrationId: integration.id,
        items: [item('mCl-EAAAQBAJ')],
        syncedShelves: ['to-read'],
        ll: ll.bundle,
        pacer: noPace,
      });
    await run(); // mint + push: the push is not this test's subject
    const [row] = await t.db.select().from(bookRequests).where(eq(bookRequests.integrationId, integration.id));
    await run(); // LazyLibrarian shows both formats `Snatched`: the request reads grabbed/grabbed
    expect(await getRequest(row!.id)).toMatchObject({ ebookStatus: 'grabbed', audioStatus: 'grabbed' });
    ll.state['mCl-EAAAQBAJ'] = { ...ll.state['mCl-EAAAQBAJ'], ebookStatus: ebook, audioStatus: audio };
    ll.calls.length = 0;
    return { id: row!.id, run, ll };
  }

  it('LazyLibrarian put the failed grab back to Wanted: the format reads wanted, the other stays grabbed', async () => {
    const { id, run, ll } = await seed('Wanted', 'Snatched');
    const report = await run();
    expect(report.requestsGrabReverted).toBe(1);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'grabbed' });
    // Nothing is written to LazyLibrarian: it is already searching the format again.
    expect(ll.calls.filter((c) => c.cmd !== 'searchBook')).toEqual([]);
    // And every run after that agrees.
    expect((await run()).requestsGrabReverted).toBe(0);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'grabbed' });
  });

  it('a Skipped format reads missing, and the Skipped sweep queues it again (back to wanted)', async () => {
    const { id, run, ll } = await seed('Skipped', 'Snatched');
    const report = await run();
    expect(report.requestsGrabReverted).toBe(1);
    expect(unqueues(ll.calls)).toEqual([]);
    expect(ll.calls.filter((c) => c.cmd === 'queueBook')).toEqual([{ cmd: 'queueBook', id: 'mCl-EAAAQBAJ', format: 'ebook' }]);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'grabbed' });
  });

  it('a grab that landed reads landed (the reconcile), never reverted', async () => {
    const { id, run } = await seed('Open', 'Snatched');
    const report = await run();
    expect(report.requestsGrabReverted).toBe(0);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'grabbed' });
  });
});

describe('runFormatPairing — the missing format stops reading grabbed (#734)', () => {
  it('a failed grab reads wanted; a Snatched one stays grabbed; the held format is never touched', async () => {
    const failed = await seedPairingWant('ll-p1', { audioStatus: 'grabbed' });
    const snatched = await seedPairingWant('ll-p2', { audioStatus: 'grabbed' });
    const ll = stubLl({
      'll-p1': { title: failed.title, author: 'Some Author', ebookStatus: 'Skipped', audioStatus: 'Wanted', language: 'en' },
      'll-p2': { title: snatched.title, author: 'Some Author', ebookStatus: 'Skipped', audioStatus: 'Snatched', language: 'en' },
    });
    const report = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(report.requestsGrabReverted).toBe(1);
    expect(report.grabbedNotSnatched).toBe(0);
    expect(await getRequest(failed.id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'wanted' });
    expect(await getRequest(snatched.id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'grabbed' });
    expect(unqueues(ll.calls)).toEqual([]);
  });

  it('the census counts a live grabbed format LazyLibrarian is not downloading', async () => {
    const { id } = await seedGoodreadsWant('ll-c1', { ebookStatus: 'grabbed', audioStatus: 'grabbed' });
    const ll = stubLl({ 'll-c1': { title: 'Shared Book', ebookStatus: 'Wanted', audioStatus: 'Snatched' } });
    const found = await findGrabbedNotSnatched({ db: t.db, snapshot: ll.snapshot() });
    expect(found).toEqual([{ requestId: id, llBookId: 'll-c1', format: 'ebook', llStatus: 'Wanted' }]);
    // A parked want, or an unusable read, answers nothing.
    expect(await findGrabbedNotSnatched({ db: t.db, snapshot: new Map() })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #735 — the LazyLibrarian Release.
// ---------------------------------------------------------------------------

describe('recordLlReleases and drainLlReleases (#735)', () => {
  it('a foreign_language park releases the queued missing format, and the drain unqueues it', async () => {
    const want = await seedPairingWant('ll-f1', { audioStatus: 'wanted' });
    expect(await parkPairingWant({ db: t.db, requestId: want.id, reason: 'foreign_language', missing: 'audiobook' })).toBe(true);
    expect(await releases()).toMatchObject([
      { llBookId: 'll-f1', format: 'audiobook', reason: 'parked:foreign_language', requestId: want.id },
    ]);
    const ll = stubLl({ 'll-f1': { title: want.title, ebookStatus: 'Skipped', audioStatus: 'Wanted' } });
    const drain = await drainLlReleases({ db: t.db, ll: ll.bundle, site: 'test' });
    expect(drain.tally).toEqual({ llReleasesUnqueued: 1, llReleasesSettled: 0, llReleasesPending: 0, llReleasesFailed: 0 });
    expect(drain.unqueued).toEqual(['ll-f1:audiobook']);
    expect(unqueues(ll.calls)).toEqual([{ cmd: 'unqueueBook', id: 'll-f1', format: 'audiobook' }]);
    expect(await releases()).toEqual([]);
    // The parked want keeps its status (the park's own semantics); only LazyLibrarian changed.
    expect(await getRequest(want.id)).toMatchObject({ unroutableReason: 'foreign_language', audioStatus: 'wanted' });
  });

  it("another person's live request on the same book and format keeps it searching (owned: nothing written)", async () => {
    const other = await seedGoodreadsWant('ll-shared', { ebookStatus: 'wanted', audioStatus: 'wanted' });
    const want = await seedPairingWant('ll-shared', { audioStatus: 'wanted' });
    await parkPairingWant({ db: t.db, requestId: want.id, reason: 'foreign_language', missing: 'audiobook' });
    const ll = stubLl({ 'll-shared': { title: 'Shared Book', ebookStatus: 'Wanted', audioStatus: 'Wanted' } });
    const drain = await drainLlReleases({ db: t.db, ll: ll.bundle, site: 'test' });
    expect(drain.tally).toMatchObject({ llReleasesUnqueued: 0, llReleasesSettled: 1, llReleasesPending: 0 });
    expect(unqueues(ll.calls)).toEqual([]);
    expect(await releases()).toEqual([]);
    expect(await getRequest(other.id)).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'wanted' });
  });

  it('a live pairing want on the same book owns only its own format', async () => {
    // Two pairing wants on one book: the parked one wanted the audiobook, the live one wants the ebook.
    const parked = await seedPairingWant('ll-two', { audioStatus: 'wanted' });
    await seedPairingWant('ll-two', { ebookStatus: 'wanted' }, { mediaKind: 'audiobook' });
    await parkPairingWant({ db: t.db, requestId: parked.id, reason: 'foreign_language', missing: 'audiobook' });
    const ll = stubLl({ 'll-two': { title: parked.title, ebookStatus: 'Wanted', audioStatus: 'Wanted' } });
    await drainLlReleases({ db: t.db, ll: ll.bundle, site: 'test' });
    expect(unqueues(ll.calls)).toEqual([{ cmd: 'unqueueBook', id: 'll-two', format: 'audiobook' }]);
  });

  it('a request whose shelf item is gone, or a parked one, is not a live owner', async () => {
    const gone = await seedGoodreadsWant('ll-own');
    await t.db.update(integrationShelfItems).set({ deletedAt: new Date() }).where(eq(integrationShelfItems.id, gone.shelfItemId));
    await seedGoodreadsWant('ll-own', { unroutableReason: 'no_english_edition' });
    await recordLlReleases(t.db, { llBookId: 'll-own', formats: ['ebook'], reason: 'reidentified', requestId: null });
    const ll = stubLl({ 'll-own': { title: 'Shared Book', ebookStatus: 'Wanted', audioStatus: 'Wanted' } });
    await drainLlReleases({ db: t.db, ll: ll.bundle, site: 'test' });
    expect(unqueues(ll.calls)).toEqual([{ cmd: 'unqueueBook', id: 'll-own', format: 'ebook' }]);
  });

  it('a Snatched format stays pending until its download ends; then held settles it, Wanted unqueues it', async () => {
    await recordLlReleases(t.db, { llBookId: 'll-s1', formats: ['ebook', 'audiobook'], reason: 'reidentified', requestId: null });
    const ll = stubLl({ 'll-s1': { title: 'Snatch', ebookStatus: 'Snatched', audioStatus: 'Snatched' } });
    expect((await drainLlReleases({ db: t.db, ll: ll.bundle, site: 'test' })).tally).toMatchObject({
      llReleasesPending: 2,
      llReleasesUnqueued: 0,
    });
    expect(await releases()).toHaveLength(2);
    ll.state['ll-s1'] = { title: 'Snatch', ebookStatus: 'Open', audioStatus: 'Wanted' }; // one imported, one failed
    const drain = await drainLlReleases({ db: t.db, ll: ll.bundle, site: 'test' });
    expect(drain.tally).toEqual({ llReleasesUnqueued: 1, llReleasesSettled: 1, llReleasesPending: 0, llReleasesFailed: 0 });
    expect(unqueues(ll.calls)).toEqual([{ cmd: 'unqueueBook', id: 'll-s1', format: 'audiobook' }]);
    expect(await releases()).toEqual([]);
  });

  it('a book LazyLibrarian no longer has, or a Skipped format, is dropped with no write', async () => {
    await recordLlReleases(t.db, { llBookId: 'll-gone', formats: ['ebook'], reason: 'reidentified', requestId: null });
    await recordLlReleases(t.db, { llBookId: 'll-skip', formats: ['audiobook'], reason: 'reidentified', requestId: null });
    const ll = stubLl({ 'll-skip': { title: 'Skip', ebookStatus: 'Open', audioStatus: 'Skipped' } });
    const drain = await drainLlReleases({ db: t.db, ll: ll.bundle, site: 'test' });
    expect(drain.tally).toMatchObject({ llReleasesSettled: 2, llReleasesUnqueued: 0, llReleasesPending: 0 });
    expect(ll.calls).toEqual([]);
  });

  it('an empty read, a failed read or a failed unqueue decides nothing: the release stays pending', async () => {
    await recordLlReleases(t.db, { llBookId: 'll-e1', formats: ['ebook'], reason: 'reidentified', requestId: null });
    const empty = stubLl({}, { emptyRead: true });
    expect((await drainLlReleases({ db: t.db, ll: empty.bundle, site: 'test' })).tally.llReleasesPending).toBe(1);
    const failing = stubLl({ 'll-e1': { title: 'E', ebookStatus: 'Wanted' } }, { failUnqueue: true });
    expect((await drainLlReleases({ db: t.db, ll: failing.bundle, site: 'test' })).tally).toMatchObject({
      llReleasesFailed: 1,
      llReleasesPending: 1,
    });
    expect(await releases()).toHaveLength(1);
  });

  it('reads the book once more before the write, and never unqueues a format snatched since the first read', async () => {
    await recordLlReleases(t.db, { llBookId: 'll-race', formats: ['ebook'], reason: 'reidentified', requestId: null });
    const ll = stubLl({ 'll-race': { title: 'Race', ebookStatus: 'Wanted' } });
    let reads = 0;
    const racing = {
      ...ll.bundle,
      read: {
        getAllBookStatuses: async () => {
          reads += 1;
          // LazyLibrarian's backlog search snatches the format between the drain's read and its write.
          if (reads === 2) ll.state['ll-race'] = { title: 'Race', ebookStatus: 'Snatched' };
          return ll.snapshot();
        },
      },
    } as unknown as LazyLibrarianClientBundle;
    const drain = await drainLlReleases({ db: t.db, ll: racing, site: 'test' });
    expect(reads).toBe(2);
    expect(drain.tally).toMatchObject({ llReleasesUnqueued: 0, llReleasesPending: 1 });
    expect(unqueues(ll.calls)).toEqual([]);
    expect(await releases()).toHaveLength(1);
  });

  it("a re-record always moves updated_at forward, so the drain never deletes a release recorded after its read", async () => {
    const later = new Date('2026-10-06T10:00:00.000Z');
    await recordLlReleases(t.db, { llBookId: 'll-clock', formats: ['ebook'], reason: 'reidentified', requestId: null, now: later });
    const [first] = await releases();
    // A second want gives the same format up, on a run that started earlier (its `now` is older than the stored stamp).
    await recordLlReleases(t.db, {
      llBookId: 'll-clock',
      formats: ['ebook'],
      reason: 'parked:foreign_language',
      requestId: null,
      now: new Date('2026-10-06T09:00:00.000Z'),
    });
    const [second] = await releases();
    expect(second!.reason).toBe('parked:foreign_language');
    expect(second!.updatedAt.getTime()).toBeGreaterThan(first!.updatedAt.getTime());
  });

  it('nothing pending: no LazyLibrarian read at all', async () => {
    let reads = 0;
    const ll = { read: { getAllBookStatuses: async () => (reads++, new Map()) }, write: {} } as unknown as LazyLibrarianClientBundle;
    await drainLlReleases({ db: t.db, ll, site: 'test' });
    expect(reads).toBe(0);
  });
});

describe('every writer that gives a want up records its release (#735)', () => {
  it('re-identify (clear) releases the old book; a retitle does not', async () => {
    const want = await seedPairingWant('ll-r1', { audioStatus: 'grabbed' });
    const row = await getRequest(want.id);
    expect(
      await reidentifyPairingWant({
        db: t.db,
        want: row,
        identity: { title: 'Another Book', author: 'Some Author' },
        mode: 'clear',
        missing: 'audiobook',
        paired: false,
      }),
    ).toBe(true);
    expect(await getRequest(want.id)).toMatchObject({ llBookId: null, audioStatus: 'requested' });
    expect(await releases()).toMatchObject([{ llBookId: 'll-r1', format: 'audiobook', reason: 'reidentified' }]);

    const kept = await seedPairingWant('ll-r2');
    await reidentifyPairingWant({
      db: t.db,
      want: await getRequest(kept.id),
      identity: { title: 'Renamed', author: 'Some Author' },
      mode: 'retitle',
      missing: 'audiobook',
      paired: false,
    });
    expect((await releases()).map((r) => r.llBookId)).toEqual(['ll-r1']);
  });

  it('a never-pushed want (requested) records nothing when it is parked', async () => {
    const want = await seedPairingWant('ll-n1', { audioStatus: 'requested' });
    expect(await parkPairingWant({ db: t.db, requestId: want.id, reason: 'multi_book', missing: 'audiobook' })).toBe(true);
    expect(await releases()).toEqual([]);
  });

  it('a collection want parked wrong_volume, or dropped by the wants pass, releases its format', async () => {
    const parked = await seedCollectionWant('ll-cw1');
    expect(await parkCollectionWant({ db: t.db, requestId: parked.id, llBookId: 'll-cw1' })).toBe(true);
    expect(await releases()).toMatchObject([{ llBookId: 'll-cw1', format: 'ebook', reason: 'parked:wrong_volume' }]);

    const dropped = await seedCollectionWant('ll-cw2');
    await syncCollectionWants({ db: t.db, collectionId: dropped.collectionId, format: 'ebook', members: [] });
    expect((await releases()).find((r) => r.llBookId === 'll-cw2')).toMatchObject({
      format: 'ebook',
      reason: 'collection_want_dropped',
      requestId: dropped.id,
    });
  });

  it('the English-edition switch releases the foreign book; the no_english_edition park releases it too', async () => {
    const switched = await seedGoodreadsWant('ll-foreign-1');
    expect(
      await switchRequestToEnglishEdition({ db: t.db, requestId: switched.id, fromLlBookId: 'll-foreign-1', toLlBookId: 'll-en' }),
    ).toBe(true);
    const parked = await seedGoodreadsWant('ll-foreign-2', { audioStatus: 'grabbed' });
    expect(await parkRequestNoEnglishEdition({ db: t.db, requestId: parked.id, llBookId: 'll-foreign-2' })).toBe(true);
    const rows = (await releases()).map((r) => `${r.llBookId}:${r.format}:${r.reason}`).sort();
    expect(rows).toEqual([
      'll-foreign-1:audiobook:english_edition_switched',
      'll-foreign-1:ebook:english_edition_switched',
      'll-foreign-2:audiobook:parked:no_english_edition',
      'll-foreign-2:ebook:parked:no_english_edition',
    ]);
  });

  it('a Goodreads shelf item taken off the shelf releases its formats; re-shelving it takes them back', async () => {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '735',
      profileRef: '735',
      actorId: user.id,
    });
    const shelfItem: EnrichedShelfItem = {
      shelf: 'to-read',
      externalBookId: 'gr-twisted',
      title: 'Twisted Love',
      author: 'Ana Huang',
      isbn: null,
      gbVolumeId: '31AtzwEACAAJ',
      coverUrl: null,
      shelvedAt: new Date(),
      isComic: false,
    };
    const ll = stubLl({ '31AtzwEACAAJ': { title: 'Twisted Love', author: 'Ana Huang', ebookStatus: 'Wanted', audioStatus: 'Wanted', language: 'en' } });
    const sync = (items: EnrichedShelfItem[]) =>
      syncGoodreadsIntegration({ db: t.db, integrationId: integration.id, items, syncedShelves: ['to-read'], ll: ll.bundle, pacer: noPace });
    await sync([shelfItem]);
    await sync([shelfItem]);
    const [row] = await t.db.select().from(bookRequests).where(eq(bookRequests.integrationId, integration.id));
    expect(row).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'wanted' });
    await sync([]); // the person took it off the shelf
    expect((await releases()).map((r) => `${r.llBookId}:${r.format}:${r.reason}`).sort()).toEqual([
      '31AtzwEACAAJ:audiobook:shelf_removed',
      '31AtzwEACAAJ:ebook:shelf_removed',
    ]);
    await drainLlReleases({ db: t.db, ll: ll.bundle, site: 'test' });
    expect(unqueues(ll.calls).map((c) => c.format).sort()).toEqual(['audiobook', 'ebook']);
    // Back on the shelf: the reconcile reads `Skipped`, and the Skipped sweep queues both formats again.
    ll.calls.length = 0;
    await sync([shelfItem]);
    expect(ll.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.format).sort()).toEqual(['audiobook', 'ebook']);
    expect(await getRequest(row!.id)).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'wanted' });
  });

  it('unlinking a Goodreads account releases its wants', async () => {
    const want = await seedGoodreadsWant('ll-u1', { ebookStatus: 'grabbed', audioStatus: 'requested' });
    expect(await unlinkIntegration({ db: t.db, userId: want.userId, provider: 'goodreads', actorId: want.userId })).toEqual({
      changed: true,
    });
    expect(await releases()).toMatchObject([{ llBookId: 'll-u1', format: 'ebook', reason: 'unlinked', requestId: want.id }]);
  });
});

describe('runFormatPairing — a park in the run is released in the same run (#735)', () => {
  it('a want on an anchor now labelled German is parked and its LazyLibrarian audiobook unqueued', async () => {
    const want = await seedPairingWant('ll-de', { audioStatus: 'wanted' }, { language: 'de' });
    const ll = stubLl({ 'll-de': { title: want.title, author: 'Some Author', ebookStatus: 'Skipped', audioStatus: 'Wanted', language: 'en' } });
    const report = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(await getRequest(want.id)).toMatchObject({ unroutableReason: 'foreign_language' });
    expect(report).toMatchObject({ llReleasesUnqueued: 1, llReleasesPending: 0, llOrphanWanted: 0 });
    expect(unqueues(ll.calls)).toEqual([{ cmd: 'unqueueBook', id: 'll-de', format: 'audiobook' }]);
  });
});

describe('the Orphan LazyLibrarian Want census and the one-off repair (#735)', () => {
  it('counts every Wanted, unheld format no live request asks for, and the repair unqueues all but the keep list', async () => {
    await seedGoodreadsWant('ll-live'); // owned, both formats
    const parked = await seedPairingWant('ll-parked');
    await parkPairingWant({ db: t.db, requestId: parked.id, reason: 'foreign_language', missing: 'audiobook' });
    await t.db.delete(llFormatReleases); // the census is about the orphans that predate the release
    const ll = stubLl({
      'll-live': { title: 'Shared Book', ebookStatus: 'Wanted', audioStatus: 'Wanted' },
      'll-parked': { title: 'Parked', ebookStatus: 'Skipped', audioStatus: 'Wanted' },
      'll-none': { title: 'Abandoned', ebookStatus: 'Wanted', audioStatus: 'Skipped' },
      'll-hand': { title: 'Hand Re-want', ebookStatus: 'Wanted', audioStatus: 'Skipped' },
      'll-held': { title: 'Held', ebookStatus: 'Wanted', ebookFile: '/b/held.epub' },
      'll-snatch': { title: 'Snatched', ebookStatus: 'Snatched' },
    });
    const orphans = await findOrphanLlWants({ db: t.db, snapshot: ll.snapshot() });
    expect(orphans.map((o) => `${o.llBookId}:${o.format}`)).toEqual(['ll-hand:ebook', 'll-none:ebook', 'll-parked:audiobook']);

    const dry = await unqueueOrphanLlWants({ db: t.db, ll: ll.bundle, snapshot: ll.snapshot(), keep: new Set(['ll-hand:ebook']), dryRun: true });
    expect(dry).toMatchObject({ orphans: 3, unqueued: 0, kept: 1 });
    expect(ll.calls).toEqual([]);

    const applied = await unqueueOrphanLlWants({ db: t.db, ll: ll.bundle, snapshot: ll.snapshot(), keep: new Set(['ll-hand:ebook']), dryRun: false });
    expect(applied).toMatchObject({ orphans: 3, unqueued: 2, kept: 1, skipped: 0, failed: 0 });
    expect(unqueues(ll.calls)).toEqual([
      { cmd: 'unqueueBook', id: 'll-none', format: 'ebook' },
      { cmd: 'unqueueBook', id: 'll-parked', format: 'audiobook' },
    ]);
    // Idempotent: only the kept one is left.
    expect((await findOrphanLlWants({ db: t.db, snapshot: ll.snapshot() })).map((o) => o.llBookId)).toEqual(['ll-hand']);
  });

  it('the one-off skips an orphan LazyLibrarian snatched since its read', async () => {
    const ll = stubLl({ 'll-gone-by': { title: 'Gone By', ebookStatus: 'Wanted' } });
    const stale = ll.snapshot();
    ll.state['ll-gone-by'] = { title: 'Gone By', ebookStatus: 'Snatched' };
    const report = await unqueueOrphanLlWants({ db: t.db, ll: ll.bundle, snapshot: stale, keep: new Set(), dryRun: false });
    expect(report).toMatchObject({ orphans: 1, unqueued: 0, skipped: 1 });
    expect(unqueues(ll.calls)).toEqual([]);
  });
});
