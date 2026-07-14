import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { bookRequests, booksItems, integrationShelfItems, permissionAudit, userIntegrations } from '@hnet/db';
import {
  advanceStatus,
  computeCoverage,
  getBookRequestsForIntegration,
  linkIntegration,
  listLinkedIntegrations,
  loadLibraryMatcher,
  mapLlStatus,
  parseGoodreadsProfile,
  recordManualSearch,
  runManualBookSearch,
  syncGoodreadsIntegration,
  unlinkIntegration,
  type EnrichedShelfItem,
  type LazyLibrarianClientBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

// ADR-055 / DESIGN-028 (PLAN-044) — the Integration domain: link/unlink (audited), the shelf mirror + the
// request/Missing ledger, the LazyLibrarian both-format push (queueBook MANDATORY), comic parking, LL-status
// reconcile, coverage math, and the audited manual re-search.

interface LlCall {
  cmd: 'addBook' | 'queueBook' | 'searchBook';
  id: string;
  format?: string;
}

function stubLl(getBook?: (id: string) => { ebookStatus: string | null; audioStatus: string | null } | null) {
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
      getBook: async (id: string) => {
        const s = getBook ? getBook(id) : { ebookStatus: 'Wanted', audioStatus: 'Wanted' };
        return s ? { bookId: id, ebookStatus: s.ebookStatus, audioStatus: s.audioStatus } : null;
      },
    },
  } as unknown as LazyLibrarianClientBundle;
  return { calls, bundle };
}

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
    // The routable book comes back Skipped from LL → the per-format Missing entry.
    const ll = stubLl((id) => (id === 'gb-tog' ? { ebookStatus: 'Skipped', audioStatus: 'Skipped' } : null));

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
    expect(byTitle['Throne of Glass']!.ebookStatus).toBe('missing'); // pushed then Skipped → Missing
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

  it('manual re-search on a Missing request is audited and fires a real LL searchBook', async () => {
    const { user, integration } = await seed();
    const ll = stubLl((id) => (id === 'gb-tog' ? { ebookStatus: 'Skipped', audioStatus: 'Skipped' } : null));
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
});
