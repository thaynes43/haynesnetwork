import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { bookRequests, booksItems, integrationShelfItems, permissionAudit, userIntegrations } from '@hnet/db';
import {
  advanceStatus,
  computeCoverage,
  computeShelfStats,
  getBookRequestDetail,
  getBookRequestsForIntegration,
  getShelfWallItems,
  getWantedBookRequests,
  isRequestSearchable,
  requestPhase,
  linkIntegration,
  listLinkedIntegrations,
  listIntegrationsForSync,
  markIntegrationSynced,
  noteIntegrationSyncBlip,
  ERROR_RETRY_BACKOFF_MS,
  loadLibraryMatcher,
  mapKapowarrVolumeStatus,
  mapLlStatus,
  parseGoodreadsProfile,
  pickBestVolume,
  recordManualSearch,
  runComicVolumeSearch,
  runManualBookSearch,
  syncGoodreadsIntegration,
  unlinkIntegration,
  type EnrichedShelfItem,
  type KapowarrClientBundle,
  type LazyLibrarianClientBundle,
} from '../src/index';
import type { KapowarrSearchCandidate } from '@hnet/kapowarr/read';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

// ADR-055 / DESIGN-028 (PLAN-044) — the Integration domain: link/unlink (audited), the shelf mirror + the
// request/Missing ledger, the LazyLibrarian both-format push (queueBook MANDATORY), comic parking, LL-status
// reconcile, coverage math, and the audited manual re-search.

interface LlCall {
  cmd: 'addBook' | 'queueBook' | 'searchBook';
  id: string;
  format?: string;
}

function stubLl(statusOf?: (id: string) => { ebookStatus: string | null; audioStatus: string | null } | null) {
  const calls: LlCall[] = [];
  const bundle = {
    write: {
      addBook: async (id: string) => {
        calls.push({ cmd: 'addBook', id });
        return 'OK';
      },
      queueBook: async (id: string, format: 'ebook' | 'audiobook') => {
        calls.push({ cmd: 'queueBook', id, format });
        return 'OK';
      },
      searchBook: async (id: string, format: 'ebook' | 'audiobook') => {
        calls.push({ cmd: 'searchBook', id, format });
        return 'OK';
      },
    },
    read: {
      // The real client returns a Map from ONE getAllBooks call; the stub backs `.get` with the per-id fn
      // (an id the fn nulls is one "LL doesn't know" — absent from the map).
      getAllBookStatuses: async () => ({
        get: (id: string) => {
          const s = statusOf ? statusOf(id) : { ebookStatus: 'Wanted', audioStatus: 'Wanted' };
          return s ? { bookId: id, ebookStatus: s.ebookStatus, audioStatus: s.audioStatus } : undefined;
        },
      }),
    },
  } as unknown as LazyLibrarianClientBundle;
  return { calls, bundle };
}

// ADR-056 (PLAN-046) — an in-memory Kapowarr stub: `searchVolumes` returns canned ComicVine candidates,
// `addVolume` mints a monitored volume + records it, `getVolume` reports its live counts (drives the reconcile),
// and `searchVolume` records the force-search. No network.
interface KapoCall {
  op: 'search' | 'add' | 'searchVolume' | 'getVolume';
  query?: string;
  comicvineId?: number;
  rootFolderId?: number;
  id?: number;
}
function stubKapowarr(opts?: {
  candidates?: (query: string) => KapowarrSearchCandidate[];
  rootFolders?: Array<{ id: number; folder: string | null }>;
  issuesDownloaded?: number;
  issueCount?: number;
}) {
  const calls: KapoCall[] = [];
  const volumes = new Map<number, { monitored: boolean; issueCount: number; issuesDownloaded: number }>();
  let nextId = 500;
  const bundle = {
    read: {
      searchVolumes: async (query: string) => {
        calls.push({ op: 'search', query });
        return opts?.candidates ? opts.candidates(query) : [];
      },
      getVolume: async (id: number) => {
        calls.push({ op: 'getVolume', id });
        const v = volumes.get(id);
        return v ? { id, comicvineId: null, title: null, ...v } : null;
      },
      listVolumes: async () => [...volumes.entries()].map(([id, v]) => ({ id, comicvineId: null, title: null, ...v })),
      getRootFolders: async () => opts?.rootFolders ?? [{ id: 1, folder: '/Comics' }],
    },
    write: {
      addVolume: async (input: { comicvineId: number; rootFolderId: number }) => {
        const id = nextId++;
        volumes.set(id, {
          monitored: true,
          issueCount: opts?.issueCount ?? 6,
          issuesDownloaded: opts?.issuesDownloaded ?? 0,
        });
        calls.push({ op: 'add', comicvineId: input.comicvineId, rootFolderId: input.rootFolderId });
        return id;
      },
      setMonitored: async () => {},
      searchVolume: async (id: number) => {
        calls.push({ op: 'searchVolume', id });
      },
    },
  } as unknown as KapowarrClientBundle;
  return { calls, bundle, volumes };
}

// The live-shaped Scott Pilgrim + Batman ComicVine candidates (from the real Kapowarr search 2026-07-14) —
// the resolver must pick the ORIGINAL editions (Oni Press cv 25478; DC "Batman: Zero Year" cv 138641).
const SCOTT_PILGRIM_CANDIDATES: KapowarrSearchCandidate[] = [
  { comicvineId: 61857, title: 'Scott Pilgrim', year: 2010, volumeNumber: 1, publisher: 'Panini Verlag', issueCount: 6, translated: true, alreadyAdded: null },
  { comicvineId: 25478, title: 'Scott Pilgrim', year: 2004, volumeNumber: 1, publisher: 'Oni Press', issueCount: 6, translated: false, alreadyAdded: null },
  { comicvineId: 151348, title: 'Scott Pilgrim', year: null, volumeNumber: 1, publisher: 'Debols!llo', issueCount: 6, translated: false, alreadyAdded: null },
  { comicvineId: 51110, title: 'Scott Pilgrim Color', year: 2012, volumeNumber: 1, publisher: 'Oni Press', issueCount: 6, translated: false, alreadyAdded: null },
];
const BATMAN_CANDIDATES: KapowarrSearchCandidate[] = [
  { comicvineId: 138641, title: 'Batman: Zero Year', year: 2021, volumeNumber: 1, publisher: 'DC Comics', issueCount: 1, translated: false, alreadyAdded: null },
  { comicvineId: 65957, title: "Batman Zero Year Director's Cut", year: 2013, volumeNumber: 1, publisher: 'DC Comics', issueCount: 1, translated: false, alreadyAdded: null },
  { comicvineId: 145504, title: 'Year Zero', year: 2022, volumeNumber: 1, publisher: 'AWA Studios', issueCount: 5, translated: false, alreadyAdded: null },
];

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(bookRequests);
  await t.db.delete(integrationShelfItems);
  await t.db.delete(userIntegrations);
  await t.db.delete(booksItems);
  await t.db.delete(permissionAudit);
});

describe('parseGoodreadsProfile', () => {
  it('extracts an id from numeric / user-show / review-list forms, null for a vanity url', () => {
    expect(parseGoodreadsProfile('202652880')).toEqual({ externalUserId: '202652880' });
    expect(parseGoodreadsProfile('https://www.goodreads.com/user/show/202652880-manofoz')).toEqual({
      externalUserId: '202652880',
    });
    expect(parseGoodreadsProfile('https://www.goodreads.com/review/list_rss/202652880?shelf=to-read')).toEqual(
      { externalUserId: '202652880' },
    );
    expect(parseGoodreadsProfile('https://www.goodreads.com/haynesnetwork')).toBeNull();
  });
});

describe('mapLlStatus / advanceStatus', () => {
  it('maps LL statuses and never regresses a positive', () => {
    expect(mapLlStatus('Open')).toBe('landed');
    expect(mapLlStatus('Have')).toBe('landed');
    expect(mapLlStatus('Snatched')).toBe('grabbed');
    expect(mapLlStatus('Wanted')).toBe('wanted');
    expect(mapLlStatus('Skipped')).toBe('missing');
    expect(mapLlStatus('weird')).toBeNull();
    expect(advanceStatus('landed', 'wanted')).toBe('landed');
    expect(advanceStatus('grabbed', 'missing')).toBe('grabbed');
    expect(advanceStatus('wanted', 'missing')).toBe('missing');
    expect(advanceStatus('wanted', 'landed')).toBe('landed');
  });
});

describe('link / unlink (audited)', () => {
  it('links, audits, and lists; re-link is idempotent-friendly; unlink audits once', async () => {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '202652880',
      profileRef: 'https://www.goodreads.com/haynesnetwork',
      actorId: user.id,
    });
    expect(integration.status).toBe('linked');
    expect(integration.externalUserId).toBe('202652880');

    const linkAudits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'link_integration'));
    expect(linkAudits).toHaveLength(1);

    const linked = await listLinkedIntegrations({ db: t.db, provider: 'goodreads' });
    expect(linked).toHaveLength(1);

    const { changed } = await unlinkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      actorId: user.id,
    });
    expect(changed).toBe(true);
    const again = await unlinkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      actorId: user.id,
    });
    expect(again.changed).toBe(false); // no-op writes no second audit
    const unlinkAudits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'unlink_integration'));
    expect(unlinkAudits).toHaveLength(1);
    expect(await listLinkedIntegrations({ db: t.db, provider: 'goodreads' })).toHaveLength(0);
  });
});

// ADR-057 amend (goodreads-sync resilience) — the self-healing worklist + the soft transient-blip writer.
async function linkFor(externalUserId: string): Promise<{ userId: string; integrationId: string }> {
  const user = await createUser(t.db);
  const { integration } = await linkIntegration({
    db: t.db,
    userId: user.id,
    provider: 'goodreads',
    externalUserId,
    profileRef: `https://www.goodreads.com/user/show/${externalUserId}`,
    actorId: user.id,
  });
  return { userId: user.id, integrationId: integration.id };
}

describe('listIntegrationsForSync (the self-healing worklist)', () => {
  it('returns linked + stale-error rows; excludes unlinked (never resurrected) and fresh-error (backoff)', async () => {
    const now = new Date('2026-07-19T12:00:00Z');

    const linked = await linkFor('1'); // 'linked' — always due

    const unlinked = await linkFor('2'); // 'unlinked' — never on the worklist
    await unlinkIntegration({ db: t.db, userId: unlinked.userId, provider: 'goodreads', actorId: unlinked.userId });

    const freshErr = await linkFor('3'); // 'error' updated_at == now → held back by the backoff
    await markIntegrationSynced({ db: t.db, integrationId: freshErr.integrationId, error: 'boom', now });

    const staleErr = await linkFor('4'); // 'error' updated_at older than the backoff → due
    const stale = new Date(now.getTime() - ERROR_RETRY_BACKOFF_MS - 60_000);
    await markIntegrationSynced({ db: t.db, integrationId: staleErr.integrationId, error: 'boom', now: stale });

    const due = await listIntegrationsForSync({ db: t.db, provider: 'goodreads', now });
    const ids = due.map((r) => r.id).sort();
    expect(ids).toEqual([linked.integrationId, staleErr.integrationId].sort());
    expect(due.map((r) => r.status)).not.toContain('unlinked');
  });
});

describe('noteIntegrationSyncBlip (soft transient-blip note)', () => {
  it('records the note + bumps updated_at on a linked row WITHOUT changing status or last_synced_at', async () => {
    const { integrationId } = await linkFor('10');
    const later = new Date('2026-07-19T13:00:00Z');
    await noteIntegrationSyncBlip({ db: t.db, integrationId, note: 'HTTP 502', now: later });

    const [row] = await t.db.select().from(userIntegrations).where(eq(userIntegrations.id, integrationId));
    expect(row!.status).toBe('linked'); // unchanged
    expect(row!.lastSyncError).toBe('HTTP 502');
    expect(row!.updatedAt.getTime()).toBe(later.getTime());
    expect(row!.lastSyncedAt).toBeNull(); // never advanced
  });

  it('is a NO-OP on an unlinked row (the ne(status, "unlinked") guard is preserved)', async () => {
    const { userId, integrationId } = await linkFor('11');
    await unlinkIntegration({ db: t.db, userId, provider: 'goodreads', actorId: userId });
    await noteIntegrationSyncBlip({ db: t.db, integrationId, note: 'HTTP 502' });

    const [row] = await t.db.select().from(userIntegrations).where(eq(userIntegrations.id, integrationId));
    expect(row!.status).toBe('unlinked'); // never resurrected
    expect(row!.lastSyncError).toBeNull(); // untouched
  });

  it('leaves an "error" row "error" but bumps updated_at + note (backoff clock advances)', async () => {
    const { integrationId } = await linkFor('12');
    await markIntegrationSynced({ db: t.db, integrationId, error: 'first' });
    const later = new Date('2026-07-19T14:00:00Z');
    await noteIntegrationSyncBlip({ db: t.db, integrationId, note: 'HTTP 503', now: later });

    const [row] = await t.db.select().from(userIntegrations).where(eq(userIntegrations.id, integrationId));
    expect(row!.status).toBe('error'); // stays broken — the note sets no status
    expect(row!.lastSyncError).toBe('HTTP 503');
    expect(row!.updatedAt.getTime()).toBe(later.getTime());
  });
});

describe('loadLibraryMatcher', () => {
  it('matches by normalized title + author against live books_items', async () => {
    await t.db.insert(booksItems).values({
      source: 'kavita',
      mediaKind: 'book',
      externalId: 'k1',
      libraryId: '1',
      libraryName: 'EBooks',
      title: 'The Way of Kings',
      sortTitle: 'way of kings',
      author: 'Brandon Sanderson',
      deepLinkUrl: 'http://x',
    });
    const match = await loadLibraryMatcher(t.db);
    expect(match('The Way of Kings', 'Brandon Sanderson')?.mediaKind).toBe('book');
    expect(match('Way of Kings: A Novel', 'Sanderson')).not.toBeNull(); // subtitle + partial author
    expect(match('A Different Book', null)).toBeNull();
  });
});

describe('syncGoodreadsIntegration (the vertical)', () => {
  async function seed() {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '202652880',
      profileRef: '202652880',
      actorId: user.id,
    });
    // A library book that matches one shelf want (→ covered / landed).
    await t.db.insert(booksItems).values({
      source: 'kavita',
      mediaKind: 'book',
      externalId: 'lib-rpo',
      libraryId: '1',
      libraryName: 'EBooks',
      title: 'Ready Player One',
      sortTitle: 'ready player one',
      author: 'Ernest Cline',
      deepLinkUrl: 'http://x',
    });
    return { user, integration };
  }

  const items: EnrichedShelfItem[] = [
    // matched → we HAVE it (no LL push)
    { shelf: 'to-read', externalBookId: 'gr-rpo', title: 'Ready Player One', author: 'Ernest Cline', isbn: '9780307887436', gbVolumeId: 'gb-rpo', coverUrl: null, shelvedAt: new Date(), isComic: false },
    // routable, unmatched, has a GB id → push BOTH formats
    { shelf: 'to-read', externalBookId: 'gr-tog', title: 'Throne of Glass', author: 'Sarah J. Maas', isbn: '9781619630345', gbVolumeId: 'gb-tog', coverUrl: null, shelvedAt: new Date(), isComic: false },
    // comic → parked out of LL (Kapowarr's domain)
    { shelf: 'to-read', externalBookId: 'gr-sp', title: 'Scott Pilgrim, Vol. 1', author: 'Bryan Lee O’Malley', isbn: null, gbVolumeId: 'gb-sp', coverUrl: null, shelvedAt: new Date(), isComic: true },
  ];

  it('mirrors, mints, pushes BOTH formats via queueBook, parks comics, reconciles, and computes coverage', async () => {
    const { integration } = await seed();
    // The routable book comes back Ignored from LL → the DEAD-END per-format Missing entry (raw Skipped
    // now auto-requeues via the sweep — covered by its own tests below).
    const ll = stubLl((id) => (id === 'gb-tog' ? { ebookStatus: 'Ignored', audioStatus: 'Ignored' } : null));

    const report = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: async () => {},
    });

    // 3 shelf items mirrored, 3 requests minted, 1 pushed (only the routable-unmatched).
    expect(report.shelfItemsUpserted).toBe(3);
    expect(report.requestsMinted).toBe(3);
    expect(report.requestsPushed).toBe(1);

    // The push queued BOTH formats and used queueBook (mandatory after addBook) + searchBook.
    const forTog = ll.calls.filter((c) => c.id === 'gb-tog');
    expect(forTog.filter((c) => c.cmd === 'addBook')).toHaveLength(1);
    expect(forTog.filter((c) => c.cmd === 'queueBook').map((c) => c.format).sort()).toEqual([
      'audiobook',
      'ebook',
    ]);
    expect(forTog.filter((c) => c.cmd === 'searchBook')).toHaveLength(2);
    // The comic never touched LazyLibrarian.
    expect(ll.calls.some((c) => c.id === 'gb-sp')).toBe(false);

    const requests = await getBookRequestsForIntegration({ db: t.db, integrationId: integration.id });
    const byTitle = Object.fromEntries(requests.map((r) => [r.title, r]));
    expect(byTitle['Ready Player One']!.ebookStatus).toBe('landed'); // matched
    expect(byTitle['Ready Player One']!.matchedBooksItemId).not.toBeNull();
    expect(byTitle['Throne of Glass']!.ebookStatus).toBe('missing'); // pushed then Ignored → Missing
    expect(byTitle['Scott Pilgrim, Vol. 1']!.unroutableReason).toBe('comic');
    expect(byTitle['Scott Pilgrim, Vol. 1']!.ebookStatus).toBe('missing');

    // Coverage: 1 of 3 in the library.
    expect(report.coverage).toEqual({ total: 3, covered: 1, pct: 33 });
    expect(await computeCoverage({ db: t.db, integrationId: integration.id })).toEqual({
      total: 3,
      covered: 1,
      pct: 33,
    });
  });

  // DESIGN-028 amendment (2026-07-15) — the Skipped-want sweep: a live want LL parked as raw `Skipped`
  // (the addBook race / the pre-searchBook PLAN-044 backlog) is re-queued + re-searched on the next sync,
  // usenet-first by LL's provider priority. `Ignored` (owner ruling) is NEVER swept.
  it('re-queues + re-searches a want LL reports as raw Skipped; the request advances to wanted', async () => {
    const { integration } = await seed();
    // Run 1: LL doesn't know the book yet (absent from getAllBooks) — push fires, no reconcile.
    const first = stubLl(() => null);
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: first.bundle,
      pacer: async () => {},
    });

    // Run 2: LL now reports the want raw-Skipped → sweep re-queues + re-searches BOTH formats.
    const second = stubLl((id) => (id === 'gb-tog' ? { ebookStatus: 'Skipped', audioStatus: 'Skipped' } : null));
    const report = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: second.bundle,
      pacer: async () => {},
    });
    expect(report.requestsRequeued).toBe(1);

    const forTog = second.calls.filter((c) => c.id === 'gb-tog');
    expect(forTog.filter((c) => c.cmd === 'addBook')).toHaveLength(0); // already pushed — no re-add
    expect(forTog.filter((c) => c.cmd === 'queueBook').map((c) => c.format).sort()).toEqual(['audiobook', 'ebook']);
    expect(forTog.filter((c) => c.cmd === 'searchBook').map((c) => c.format).sort()).toEqual(['audiobook', 'ebook']);

    const requests = await getBookRequestsForIntegration({ db: t.db, integrationId: integration.id });
    const tog = requests.find((r) => r.llBookId === 'gb-tog')!;
    expect(tog.ebookStatus).toBe('wanted');
    expect(tog.audioStatus).toBe('wanted');
    expect(tog.lastSearchedAt).not.toBeNull();
  });

  it('sweeps ONLY the Skipped format — a Snatched sibling advances to grabbed untouched', async () => {
    const { integration } = await seed();
    const first = stubLl(() => null);
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: first.bundle,
      pacer: async () => {},
    });

    const second = stubLl((id) =>
      id === 'gb-tog' ? { ebookStatus: 'Skipped', audioStatus: 'Snatched' } : null,
    );
    const report = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: second.bundle,
      pacer: async () => {},
    });
    expect(report.requestsRequeued).toBe(1);

    const forTog = second.calls.filter((c) => c.id === 'gb-tog');
    expect(forTog.filter((c) => c.cmd === 'queueBook').map((c) => c.format)).toEqual(['ebook']);
    expect(forTog.filter((c) => c.cmd === 'searchBook').map((c) => c.format)).toEqual(['ebook']);

    const requests = await getBookRequestsForIntegration({ db: t.db, integrationId: integration.id });
    const tog = requests.find((r) => r.llBookId === 'gb-tog')!;
    expect(tog.ebookStatus).toBe('wanted'); // swept
    expect(tog.audioStatus).toBe('grabbed'); // reconciled, not swept
  });

  it('manual re-search on a Missing request is audited and fires a real LL searchBook', async () => {
    const { user, integration } = await seed();
    const ll = stubLl((id) => (id === 'gb-tog' ? { ebookStatus: 'Ignored', audioStatus: 'Ignored' } : null));
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: async () => {},
    });
    // The ROUTABLE Missing request (ToG) — the parked comic is also 'missing' but has no LL id.
    const [missing] = await t.db
      .select()
      .from(bookRequests)
      .where(
        and(
          eq(bookRequests.integrationId, integration.id),
          eq(bookRequests.ebookStatus, 'missing'),
          eq(bookRequests.llBookId, 'gb-tog'),
        ),
      );
    expect(missing).toBeDefined();
    expect(missing!.unroutableReason).toBeNull();

    ll.calls.length = 0;
    const result = await runManualBookSearch({
      db: t.db,
      requestId: missing!.id,
      userId: user.id,
      actorId: user.id,
      ll: ll.bundle,
    });
    expect(result.searched).toBe(true);
    expect(ll.calls.filter((c) => c.cmd === 'searchBook').length).toBeGreaterThanOrEqual(1);

    const searchAudits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'request_book_search'));
    expect(searchAudits).toHaveLength(1);

    // recordManualSearch stamps last_searched_at.
    const stamped = await recordManualSearch({
      db: t.db,
      requestId: missing!.id,
      userId: user.id,
      actorId: user.id,
    });
    expect(stamped.request.lastSearchedAt).not.toBeNull();
  });

  it('runManualBookSearch narrows to ONE format when given (the detail page per-format button)', async () => {
    const { user, integration } = await seed();
    const ll = stubLl((id) => (id === 'gb-tog' ? { ebookStatus: 'Ignored', audioStatus: 'Ignored' } : null));
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: async () => {},
    });
    const [tog] = await t.db
      .select()
      .from(bookRequests)
      .where(and(eq(bookRequests.integrationId, integration.id), eq(bookRequests.llBookId, 'gb-tog')));

    ll.calls.length = 0;
    const result = await runManualBookSearch({
      db: t.db,
      requestId: tog!.id,
      userId: user.id,
      actorId: user.id,
      ll: ll.bundle,
      format: 'audiobook',
    });
    expect(result.searched).toBe(true);
    expect(result.formats).toEqual(['audiobook']);
    const searches = ll.calls.filter((c) => c.cmd === 'searchBook');
    expect(searches).toHaveLength(1);
    expect(searches[0]!.format).toBe('audiobook');
  });

  it('getBookRequestDetail resolves shelf, owner, household attribution, cover match, and per-format status', async () => {
    const { user, integration } = await seed();
    const ll = stubLl((id) => (id === 'gb-tog' ? { ebookStatus: 'Ignored', audioStatus: 'Ignored' } : null));
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: async () => {},
    });

    // The routable, UNMATCHED want — a glyph tile (no matched cover), owner + shelf + attribution present.
    const [tog] = await t.db
      .select()
      .from(bookRequests)
      .where(and(eq(bookRequests.integrationId, integration.id), eq(bookRequests.llBookId, 'gb-tog')));
    const togDetail = await getBookRequestDetail({ db: t.db, requestId: tog!.id });
    expect(togDetail).not.toBeNull();
    expect(togDetail!.title).toBe('Throne of Glass');
    expect(togDetail!.shelf).toBe('to-read');
    expect(togDetail!.integrationUserId).toBe(user.id);
    expect(togDetail!.requestedBy.length).toBeGreaterThanOrEqual(1);
    expect(togDetail!.requestedBy.every((n) => typeof n === 'string' && n.length > 0)).toBe(true);
    expect(togDetail!.matched).toBeNull();
    expect(togDetail!.matchedBooksItemId).toBeNull();
    expect(togDetail!.ebookStatus).toBe('missing');
    expect(togDetail!.isComic).toBe(false);

    // The MATCHED want (Ready Player One) — carries the library cover keys (the cover-proxy art source).
    const [rpo] = await t.db
      .select()
      .from(bookRequests)
      .where(and(eq(bookRequests.integrationId, integration.id), eq(bookRequests.llBookId, 'gb-rpo')));
    const rpoDetail = await getBookRequestDetail({ db: t.db, requestId: rpo!.id });
    expect(rpoDetail!.matchedBooksItemId).not.toBeNull();
    expect(rpoDetail!.matched?.source).toBe('kavita');
    expect(rpoDetail!.matched?.externalId).toBe('lib-rpo');

    // An unknown id resolves to null (⇒ the API surfaces NOT_FOUND).
    expect(
      await getBookRequestDetail({ db: t.db, requestId: '00000000-0000-0000-0000-000000000000' }),
    ).toBeNull();
  });
});

// ADR-056 (PLAN-046) — the Kapowarr comic-routing leg.

describe('pickBestVolume (ComicVine resolver)', () => {
  it('prefers the ORIGINAL edition over a translated reprint (Scott Pilgrim → Oni Press cv 25478)', () => {
    const pick = pickBestVolume("Scott Pilgrim's Precious Little Life (Scott Pilgrim, #1)", SCOTT_PILGRIM_CANDIDATES);
    expect(pick?.comicvineId).toBe(25478);
  });

  it('ranks by shared distinctive tokens (Batman Zero Year → cv 138641, beats a bare "Year Zero")', () => {
    const pick = pickBestVolume('Zero Year: Part 1 (DC Comics - The Legend of Batman #1)', BATMAN_CANDIDATES);
    expect(pick?.comicvineId).toBe(138641);
  });

  it('returns null when nothing shares a token (leave the comic parked, never a fabricated add)', () => {
    expect(pickBestVolume('A Totally Unrelated Novel', SCOTT_PILGRIM_CANDIDATES)).toBeNull();
    expect(pickBestVolume('Scott Pilgrim', [])).toBeNull();
  });

  it('rejects a single stray-token match on a multi-token title (the 2026-07-16 "Wings" misroute)', () => {
    // "The Serpent and the Wings of Night" (a prose novel, 6 distinctive tokens) must NOT match the 1982
    // Japanese magazine "Wings" (cv 100145) on the lone shared token — that live misroute added a 319-issue
    // junk volume whose auto-search rate-limited the whole getcomics pipeline.
    const wings: KapowarrSearchCandidate[] = [
      { comicvineId: 100145, title: 'Wings', year: 1982, volumeNumber: 1, publisher: 'Shinshokan', issueCount: 319, translated: false, alreadyAdded: null },
    ];
    expect(pickBestVolume('The Serpent and the Wings of Night (Crowns of Nyaxia, #1)', wings)).toBeNull();
  });

  it('keeps the single-token path for genuinely short titles (Hobbit)', () => {
    const hobbit: KapowarrSearchCandidate[] = [
      { comicvineId: 18166, title: 'The Hobbit', year: 1989, volumeNumber: 1, publisher: 'Eclipse Books', issueCount: 3, translated: false, alreadyAdded: null },
    ];
    expect(pickBestVolume('The Hobbit', hobbit)?.comicvineId).toBe(18166);
  });
});

describe('mapKapowarrVolumeStatus', () => {
  it('maps monitored + downloaded counts to a comic status', () => {
    expect(mapKapowarrVolumeStatus({ monitored: true, issueCount: 6, issuesDownloaded: 6 })).toBe('landed');
    expect(mapKapowarrVolumeStatus({ monitored: true, issueCount: 6, issuesDownloaded: 2 })).toBe('grabbed');
    expect(mapKapowarrVolumeStatus({ monitored: true, issueCount: 6, issuesDownloaded: 0 })).toBe('wanted');
    expect(mapKapowarrVolumeStatus({ monitored: false, issueCount: 6, issuesDownloaded: 0 })).toBe('missing');
  });
});

describe('comic routing (Kapowarr)', () => {
  // 2026-07-15 live-found regression: a GB daily-quota 429 made enrichment fail ⇒ item.isComic false
  // ⇒ the upsert CLOBBERED comic_status and the comic silently re-entered the LL book route. The
  // durable discriminator (comic_status IS NOT NULL) must survive an enrichment outage.
  it('an enrichment outage (isComic=false this run) never declassifies an existing comic', async () => {
    const { integration } = await seedComicOnly();
    const items: EnrichedShelfItem[] = [
      { shelf: 'to-read', externalBookId: 'gr-hobbit', title: 'The Hobbit, or There and Back Again', author: 'J.R.R. Tolkien', isbn: null, gbVolumeId: 'gb-hobbit', coverUrl: null, shelvedAt: new Date(), isComic: true },
    ];
    // Run 1: classified comic (no Kapowarr bundle ⇒ parked).
    const ll1 = stubLl(() => null);
    await syncGoodreadsIntegration({ db: t.db, integrationId: integration.id, items, syncedShelves: ['to-read'], ll: ll1.bundle, pacer: async () => {} });
    // Run 2: GB is down — the item arrives UNclassified.
    const ll2 = stubLl(() => null);
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items: items.map((i) => ({ ...i, isComic: false })),
      syncedShelves: ['to-read'],
      ll: ll2.bundle,
      pacer: async () => {},
    });
    const requests = await getBookRequestsForIntegration({ db: t.db, integrationId: integration.id });
    const hobbit = requests.find((r) => r.title.startsWith('The Hobbit'))!;
    expect(hobbit.comicStatus).not.toBeNull(); // still a comic
    expect(hobbit.unroutableReason).toBe('comic'); // still parked (no Kapowarr bundle)
    expect(ll2.calls.some((c) => c.id === 'gb-hobbit')).toBe(false); // NEVER pushed to LL
  });

  async function seedComicOnly() {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '202652880',
      profileRef: '202652880',
      actorId: user.id,
    });
    return { user, integration };
  }

  const comicItems: EnrichedShelfItem[] = [
    { shelf: 'to-read', externalBookId: 'gr-scott', title: "Scott Pilgrim's Precious Little Life (Scott Pilgrim, #1)", author: "Bryan Lee O'Malley", isbn: null, gbVolumeId: null, coverUrl: null, shelvedAt: new Date(), isComic: true },
  ];

  function candidatesFor(query: string): KapowarrSearchCandidate[] {
    return /scott|pilgrim/i.test(query) ? SCOTT_PILGRIM_CANDIDATES : [];
  }

  it('routes a comic to Kapowarr: resolves the volume, adds it monitored, reconciles, clears parking', async () => {
    const { integration } = await seedComicOnly();
    const kapo = stubKapowarr({ candidates: candidatesFor });

    const report = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items: comicItems,
      syncedShelves: ['to-read'],
      kapowarr: kapo.bundle,
      pacer: async () => {},
    });

    expect(report.comicsRouted).toBe(1);
    expect(report.comicsReconciled).toBe(1);
    // Added the ORIGINAL Oni volume under root folder 1.
    const add = kapo.calls.find((c) => c.op === 'add');
    expect(add).toMatchObject({ comicvineId: 25478, rootFolderId: 1 });

    const [req] = await t.db
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.integrationId, integration.id));
    expect(req!.comicStatus).toBe('wanted'); // monitored in Kapowarr → Wanted
    expect(req!.kapowarrVolumeId).not.toBeNull();
    expect(req!.comicvineId).toBe('25478');
    expect(req!.unroutableReason).toBeNull(); // no longer parked
    expect(req!.ebookStatus).toBe('missing'); // N/A for a comic (never pushed to LL)

    // A second run reconciles the existing volume (no re-add) and picks up a landed state.
    kapo.volumes.set(Number(req!.kapowarrVolumeId), { monitored: true, issueCount: 6, issuesDownloaded: 6 });
    const report2 = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items: comicItems,
      syncedShelves: ['to-read'],
      kapowarr: kapo.bundle,
      pacer: async () => {},
    });
    expect(report2.comicsRouted).toBe(0); // already routed
    expect(kapo.calls.filter((c) => c.op === 'add')).toHaveLength(1);
    const [req2] = await t.db.select().from(bookRequests).where(eq(bookRequests.integrationId, integration.id));
    expect(req2!.comicStatus).toBe('landed');
    expect(report2.coverage).toEqual({ total: 1, covered: 1, pct: 100 }); // a landed comic counts as covered
  });

  it('parks a comic when NO Kapowarr bundle (degraded run) or when ComicVine has no match', async () => {
    // (a) No Kapowarr bundle at all.
    const { integration } = await seedComicOnly();
    const report = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items: comicItems,
      syncedShelves: ['to-read'],
      pacer: async () => {},
    });
    expect(report.comicsRouted).toBe(0);
    const [parked] = await t.db.select().from(bookRequests).where(eq(bookRequests.integrationId, integration.id));
    expect(parked!.comicStatus).toBe('requested'); // minted, parked, awaiting Kapowarr
    expect(parked!.unroutableReason).toBe('comic');
    expect(parked!.kapowarrVolumeId).toBeNull();

    // (b) Kapowarr present but ComicVine returns no match → still parked, no add.
    const kapo = stubKapowarr({ candidates: () => [] });
    const report2 = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items: comicItems,
      syncedShelves: ['to-read'],
      kapowarr: kapo.bundle,
      pacer: async () => {},
    });
    expect(report2.comicsRouted).toBe(0);
    expect(kapo.calls.some((c) => c.op === 'add')).toBe(false);
    const [stillParked] = await t.db.select().from(bookRequests).where(eq(bookRequests.integrationId, integration.id));
    expect(stillParked!.comicStatus).toBe('requested');
    expect(stillParked!.unroutableReason).toBe('comic');
  });

  it('comic force-search audits request_book_search and fires Kapowarr auto_search', async () => {
    const { user, integration } = await seedComicOnly();
    const kapo = stubKapowarr({ candidates: candidatesFor });
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items: comicItems,
      syncedShelves: ['to-read'],
      kapowarr: kapo.bundle,
      pacer: async () => {},
    });
    const [req] = await t.db.select().from(bookRequests).where(eq(bookRequests.integrationId, integration.id));
    kapo.calls.length = 0;

    const result = await runComicVolumeSearch({
      db: t.db,
      requestId: req!.id,
      userId: user.id,
      actorId: user.id,
      kapowarr: kapo.bundle,
    });
    expect(result.searched).toBe(true);
    expect(kapo.calls.filter((c) => c.op === 'searchVolume')).toHaveLength(1);

    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'request_book_search'));
    expect(audits).toHaveLength(1);
  });

  it('comic force-search on a not-yet-routed comic audits but searches nothing', async () => {
    const { user, integration } = await seedComicOnly();
    // Mint the comic WITHOUT Kapowarr (parked, no volume id).
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items: comicItems,
      syncedShelves: ['to-read'],
      pacer: async () => {},
    });
    const [req] = await t.db.select().from(bookRequests).where(eq(bookRequests.integrationId, integration.id));
    const kapo = stubKapowarr();
    const result = await runComicVolumeSearch({
      db: t.db,
      requestId: req!.id,
      userId: user.id,
      actorId: user.id,
      kapowarr: kapo.bundle,
    });
    expect(result).toEqual({ searched: false, reason: 'no_kapowarr_id' });
    expect(kapo.calls.some((c) => c.op === 'searchVolume')).toBe(false);
    // Still audited (the intent is recorded).
    const audits = await t.db.select().from(permissionAudit).where(eq(permissionAudit.action, 'request_book_search'));
    expect(audits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ADR-057 (PLAN-045) — all shelves acquire (owner ruling: A1 OVERRULED) + the composed read-models.
// ---------------------------------------------------------------------------

describe('all-shelves sync + acquisition (ADR-057)', () => {
  async function seedAllShelves() {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '202652880',
      profileRef: '202652880',
      actorId: user.id,
    });
    // linkIntegration now defaults to ALL FOUR shelves (migration 0047's default).
    expect(integration.shelves).toEqual(['to-read', 'currently-reading', 'read', 'did-not-finish']);
    // One library book that matches the READ-shelf want (→ covered).
    await t.db.insert(booksItems).values({
      source: 'kavita',
      mediaKind: 'book',
      externalId: 'lib-owned',
      libraryId: '1',
      libraryName: 'EBooks',
      title: 'Project Hail Mary',
      sortTitle: 'project hail mary',
      author: 'Andy Weir',
      deepLinkUrl: 'http://x',
    });
    return { user, integration };
  }

  const at = (day: number) => new Date(Date.UTC(2026, 6, day));
  const allShelvesItems: EnrichedShelfItem[] = [
    // to-read: a routable want (the classic Missing path).
    { shelf: 'to-read', externalBookId: 'gr-tog', title: 'Throne of Glass', author: 'Sarah J. Maas', isbn: '9781619630345', gbVolumeId: 'gb-tog', coverUrl: null, shelvedAt: at(10), isComic: false },
    // currently-reading: an unmet want — MUST also acquire (A1 overruled).
    { shelf: 'currently-reading', externalBookId: 'gr-cr', title: 'The Martian', author: 'Andy Weir', isbn: null, gbVolumeId: 'gb-martian', coverUrl: null, shelvedAt: at(11), isComic: false },
    // read: one book we HOLD (matched → landed) …
    { shelf: 'read', externalBookId: 'gr-phm', title: 'Project Hail Mary', author: 'Andy Weir', isbn: null, gbVolumeId: 'gb-phm', coverUrl: null, shelvedAt: at(9), isComic: false },
    // … and one we do NOT — the READ-shelf acquisition assertion (mint + push, both formats).
    { shelf: 'read', externalBookId: 'gr-hyp', title: 'Hyperion', author: 'Dan Simmons', isbn: null, gbVolumeId: 'gb-hyp', coverUrl: null, shelvedAt: at(8), isComic: false },
    // read: a comic we don't hold — routes to Kapowarr from the READ shelf too.
    { shelf: 'read', externalBookId: 'gr-sp', title: 'Scott Pilgrim, Vol. 1', author: 'Bryan Lee O’Malley', isbn: null, gbVolumeId: 'gb-sp', coverUrl: null, shelvedAt: at(7), isComic: true },
    // did-not-finish: ABSENT on this account (A3) — no items handed in, shelf still synced.
  ];

  it('EVERY shelf\'s unmet items mint requests and push BOTH formats to LL (read/currently-reading included); comics route via Kapowarr', async () => {
    const { integration } = await seedAllShelves();
    const ll = stubLl(() => ({ ebookStatus: 'Wanted', audioStatus: 'Wanted' }));
    const kapo = stubKapowarr({ candidates: () => SCOTT_PILGRIM_CANDIDATES });

    const report = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items: allShelvesItems,
      // The DNF shelf was fetched-tolerant (404 ⇒ empty) — it still counts as SYNCED (tombstone scope).
      syncedShelves: ['to-read', 'currently-reading', 'read', 'did-not-finish'],
      ll: ll.bundle,
      kapowarr: kapo.bundle,
      pacer: async () => {},
    });

    expect(report.shelfItemsUpserted).toBe(5);
    expect(report.requestsMinted).toBe(5);
    // Pushed: to-read ToG + currently-reading Martian + read Hyperion (matched + comic excluded).
    expect(report.requestsPushed).toBe(3);
    expect(report.comicsRouted).toBe(1);

    // THE acquisition assertions: the READ-shelf and CURRENTLY-READING wants hit LL with BOTH formats.
    for (const id of ['gb-hyp', 'gb-martian']) {
      const calls = ll.calls.filter((c) => c.id === id);
      expect(calls.filter((c) => c.cmd === 'addBook'), id).toHaveLength(1);
      expect(calls.filter((c) => c.cmd === 'queueBook').map((c) => c.format).sort(), id).toEqual([
        'audiobook',
        'ebook',
      ]);
      expect(calls.filter((c) => c.cmd === 'searchBook'), id).toHaveLength(2);
    }
    // The matched read-shelf book and the comic never touched LL.
    expect(ll.calls.some((c) => c.id === 'gb-phm')).toBe(false);
    expect(ll.calls.some((c) => c.id === 'gb-sp')).toBe(false);

    // Per-shelf stats (the stats page read): canonical order, per-shelf coverage, phase rollup.
    const stats = await computeShelfStats({ db: t.db, integrationId: integration.id });
    expect(stats.shelves.map((s) => s.shelf)).toEqual(['to-read', 'currently-reading', 'read']);
    expect(stats.shelves.find((s) => s.shelf === 'read')).toEqual({
      shelf: 'read',
      total: 3,
      covered: 1,
      pct: 33,
    });
    expect(stats.shelves.find((s) => s.shelf === 'to-read')).toEqual({
      shelf: 'to-read',
      total: 1,
      covered: 0,
      pct: 0,
    });
    // Phases: 1 have (matched), 4 searching (3 LL-wanted + the routed comic), 0 missing/parked.
    expect(stats.phases).toEqual({ have: 1, searching: 4, missing: 0, parked: 0 });
  });

  it('getShelfWallItems groups a multi-shelf book into ONE tile wearing all its shelves', async () => {
    const { integration } = await seedAllShelves();
    const dup: EnrichedShelfItem[] = [
      { shelf: 'read', externalBookId: 'gr-dup', title: 'Dune', author: 'Frank Herbert', isbn: null, gbVolumeId: 'gb-dune', coverUrl: null, shelvedAt: at(5), isComic: false },
      { shelf: 'did-not-finish', externalBookId: 'gr-dup', title: 'Dune', author: 'Frank Herbert', isbn: null, gbVolumeId: 'gb-dune', coverUrl: null, shelvedAt: at(6), isComic: false },
      { shelf: 'read', externalBookId: 'gr-phm', title: 'Project Hail Mary', author: 'Andy Weir', isbn: null, gbVolumeId: 'gb-phm', coverUrl: null, shelvedAt: at(9), isComic: false },
    ];
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items: dup,
      syncedShelves: ['to-read', 'currently-reading', 'read', 'did-not-finish'],
      pacer: async () => {},
    });
    const wall = await getShelfWallItems({ db: t.db, integrationId: integration.id });
    expect(wall).toHaveLength(2);
    const dune = wall.find((w) => w.title === 'Dune')!;
    expect(dune.shelves).toEqual(['read', 'did-not-finish']); // canonical order, ONE tile
    expect(dune.requestId).not.toBeNull();
    expect(dune.shelvedAt?.toISOString()).toBe(at(6).toISOString()); // newest shelved-at wins
    // The matched book carries its library cover keys (the cover-proxy art path).
    const phm = wall.find((w) => w.title === 'Project Hail Mary')!;
    expect(phm.matched?.source).toBe('kavita');
    expect(phm.matched?.externalId).toBe('lib-owned');
  });

  it('getWantedBookRequests composes the household overlay: per-wall format, matched excluded, dedupe + requesters', async () => {
    // TWO users want the same unmet book; one also wants a comic; a third want is matched (excluded).
    const alice = await createUser(t.db);
    const bob = await createUser(t.db);
    const linkFor = async (userId: string, externalUserId: string) =>
      (await linkIntegration({ db: t.db, userId, provider: 'goodreads', externalUserId, profileRef: externalUserId, actorId: userId }))
        .integration;
    const ia = await linkFor(alice.id, '111');
    const ib = await linkFor(bob.id, '222');
    await t.db.insert(booksItems).values({
      source: 'kavita', mediaKind: 'book', externalId: 'lib-owned2', libraryId: '1', libraryName: 'EBooks',
      title: 'Project Hail Mary', sortTitle: 'project hail mary', author: 'Andy Weir', deepLinkUrl: 'http://x',
    });
    const wantHyp = (shelf: string): EnrichedShelfItem => ({
      shelf, externalBookId: 'gr-hyp', title: 'Hyperion', author: 'Dan Simmons', isbn: null,
      gbVolumeId: 'gb-hyp', coverUrl: null, shelvedAt: at(8), isComic: false,
    });
    const kapo = stubKapowarr({ candidates: () => SCOTT_PILGRIM_CANDIDATES });
    await syncGoodreadsIntegration({
      db: t.db, integrationId: ia.id,
      items: [
        wantHyp('to-read'),
        { shelf: 'read', externalBookId: 'gr-phm', title: 'Project Hail Mary', author: 'Andy Weir', isbn: null, gbVolumeId: 'gb-phm', coverUrl: null, shelvedAt: at(9), isComic: false },
        { shelf: 'read', externalBookId: 'gr-sp', title: 'Scott Pilgrim, Vol. 1', author: 'Bryan Lee O’Malley', isbn: null, gbVolumeId: 'gb-sp', coverUrl: null, shelvedAt: at(7), isComic: true },
      ],
      syncedShelves: ['to-read', 'currently-reading', 'read', 'did-not-finish'],
      kapowarr: kapo.bundle,
      pacer: async () => {},
    });
    await syncGoodreadsIntegration({
      db: t.db, integrationId: ib.id,
      items: [wantHyp('read')],
      syncedShelves: ['to-read', 'currently-reading', 'read', 'did-not-finish'],
      pacer: async () => {},
    });

    // Books wall (ebook leg): ONE deduped Hyperion tile with both requesters; PHM (matched) excluded;
    // the comic excluded (it compos es the Comics wall).
    const books = await getWantedBookRequests({ db: t.db, format: 'ebook' });
    expect(books).toHaveLength(1);
    expect(books[0]!.title).toBe('Hyperion');
    expect(books[0]!.shelf).toBe('to-read'); // canonical shelf priority picks Alice's to-read row
    expect(books[0]!.integrationUserId).toBe(alice.id);
    expect(books[0]!.requestedBy.sort()).toEqual([alice.displayName, bob.displayName].sort());
    expect(books[0]!.isComic).toBe(false);

    // Audiobooks wall mirrors the audio leg (same unmet want — both formats queue).
    const audio = await getWantedBookRequests({ db: t.db, format: 'audiobook' });
    expect(audio.map((a) => a.title)).toEqual(['Hyperion']);

    // Comics wall: the routed comic, wanted.
    const comics = await getWantedBookRequests({ db: t.db, format: 'comic' });
    expect(comics).toHaveLength(1);
    expect(comics[0]!.title).toBe('Scott Pilgrim, Vol. 1');
    expect(comics[0]!.isComic).toBe(true);
    expect(comics[0]!.status).toBe('wanted');

    // An UNLINKED integration's wants leave the walls (the overlay reads linked rows only).
    await unlinkIntegration({ db: t.db, userId: bob.id, provider: 'goodreads', actorId: bob.id });
    const after = await getWantedBookRequests({ db: t.db, format: 'ebook' });
    expect(after).toHaveLength(1);
    expect(after[0]!.requestedBy).toEqual([alice.displayName]);
  });
});

describe('requestPhase / isRequestSearchable (the shared presentation + dispatch rules)', () => {
  it('collapses per-format statuses into the wall phase', () => {
    const base = { matchedBooksItemId: null, comicStatus: null, unroutableReason: null } as const;
    expect(requestPhase({ ...base, matchedBooksItemId: 'x', ebookStatus: 'missing', audioStatus: 'missing' })).toBe('have');
    expect(requestPhase({ ...base, ebookStatus: 'landed', audioStatus: 'missing' })).toBe('have');
    expect(requestPhase({ ...base, ebookStatus: 'wanted', audioStatus: 'missing' })).toBe('searching');
    expect(requestPhase({ ...base, ebookStatus: 'missing', audioStatus: 'missing' })).toBe('missing');
    expect(requestPhase({ ...base, ebookStatus: 'missing', audioStatus: 'missing', comicStatus: 'requested', unroutableReason: 'comic' })).toBe('parked');
    expect(requestPhase({ ...base, ebookStatus: 'missing', audioStatus: 'missing', comicStatus: 'wanted' })).toBe('searching');
    expect(requestPhase({ ...base, ebookStatus: 'missing', audioStatus: 'missing', comicStatus: 'landed' })).toBe('have');
  });

  it('gates force-search: LL id for books, Kapowarr volume for comics, landed excluded', () => {
    const book = { ebookStatus: 'wanted', audioStatus: 'wanted', comicStatus: null, kapowarrVolumeId: null, unroutableReason: null } as const;
    expect(isRequestSearchable({ ...book, llBookId: 'gb-x' })).toBe(true);
    expect(isRequestSearchable({ ...book, llBookId: null })).toBe(false);
    expect(isRequestSearchable({ ...book, llBookId: 'gb-x', ebookStatus: 'landed', audioStatus: 'landed' })).toBe(false);
    const comic = { ebookStatus: 'missing', audioStatus: 'missing', comicStatus: 'wanted', llBookId: null, unroutableReason: null } as const;
    expect(isRequestSearchable({ ...comic, kapowarrVolumeId: '7' })).toBe(true);
    expect(isRequestSearchable({ ...comic, kapowarrVolumeId: null })).toBe(false);
    expect(isRequestSearchable({ ...comic, kapowarrVolumeId: '7', comicStatus: 'landed' })).toBe(false);
  });
});
