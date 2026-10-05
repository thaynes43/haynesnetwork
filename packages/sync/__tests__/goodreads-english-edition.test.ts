// Issue #719 — the goodreads-sync run hosts the English-edition pass (DESIGN-028 amendment 2026-10-05). The Azazel
// case end to end on embedded PG16 with RSS / GB / LL stubbed offline (ADR-010): the first run resolves the Spanish
// volume and, because LazyLibrarian labels it `es`, queues nothing; the next run's pass asks Google Books for the English
// edition (by title and author, `language: 'en'`), switches the request, and the same run's push takes the English book.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bookRequests,
  gbCallBudget,
  integrationShelfItems,
  permissionAudit,
  userIntegrations,
} from '@hnet/db';
import { clearGbQuotaBreaker, createGbCallMeter, linkIntegration, type LazyLibrarianClientBundle, type LlSnapshotRow } from '@hnet/domain';
import type { GoodreadsRssClient, GoogleBooksClient } from '@hnet/goodreads';
import { runGoodreadsSync, type GoodreadsSourceBundle } from '../src/goodreads';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

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
  await t.db.delete(permissionAudit);
  await clearGbQuotaBreaker({ db: t.db }); // the single-writer clear (guarded table)
});

const rss = {
  fetchShelf: async (_u: string, shelf: string) =>
    shelf === 'to-read'
      ? [{ externalBookId: 'gr-azazel', title: 'Azazel', author: 'Isaac Asimov', isbn: null, coverUrl: null, shelvedAt: null }]
      : [],
} as unknown as GoodreadsRssClient;

function stubGb(english: { volumeId: string; language: string; title: string; authors: string[] } | null) {
  const queries: Array<{ title: string; author?: string | null; language?: string | null }> = [];
  const meter = createGbCallMeter();
  return {
    queries,
    meter,
    client: {
      resolveVolume: async (q: { title: string; author?: string | null; language?: string | null }) => {
        queries.push(q);
        meter.onCall();
        if (q.language === 'en') return english;
        // The shelf enrichment's plain resolve lands on the Spanish edition.
        return { volumeId: 'PitFPgAACAAJ', isbn13: null, categories: [], isComic: false, language: 'es', title: 'Azazel', authors: ['Isaac Asimov'] };
      },
    } as unknown as GoogleBooksClient,
  };
}

function stubLl() {
  const calls: Array<{ cmd: string; id: string; format?: string }> = [];
  const rows = new Map<string, LlSnapshotRow>([
    ['filler', { title: 'Something Else', author: 'Nobody', ebookStatus: 'Open', audioStatus: 'Skipped' }],
    ['PitFPgAACAAJ', { title: 'Azazel', author: 'Isaac Asimov', language: 'es', ebookStatus: 'Skipped', audioStatus: 'Skipped' }],
  ]);
  const bundle = {
    write: {
      addBook: async (id: string) => void calls.push({ cmd: 'addBook', id }),
      queueBook: async (id: string, format: string) => void calls.push({ cmd: 'queueBook', id, format }),
      searchBook: async (id: string, format: string) => void calls.push({ cmd: 'searchBook', id, format }),
    },
    read: { getAllBookStatuses: async () => new Map(rows) },
  } as unknown as LazyLibrarianClientBundle;
  return { calls, bundle };
}

const NOW = new Date('2026-10-06T12:00:00Z');

describe('runGoodreadsSync — the English-edition pass (Azazel)', () => {
  it('switches a request on a Spanish LazyLibrarian book to the English edition, and pushes only that', async () => {
    const user = await createUser(t.db);
    await linkIntegration({ db: t.db, userId: user.id, provider: 'goodreads', externalUserId: '42', profileRef: 'p', shelves: ['to-read'], actorId: user.id });
    const gb = stubGb({ volumeId: 'en-azazel', language: 'en', title: 'Azazel', authors: ['Isaac Asimov'] });
    const ll = stubLl();
    const source = { rss, googleBooks: gb.client } satisfies GoodreadsSourceBundle;

    // Run 1: the request mints on the Spanish volume; LazyLibrarian already shows it as Spanish, so nothing is queued.
    const first = await runGoodreadsSync({ db: t.db, goodreads: source, ll: ll.bundle, meter: gb.meter, now: NOW });
    expect(first.englishEditions?.switched ?? 0).toBe(0);
    expect(ll.calls).toEqual([]);

    // Run 2: the pass switches it, and this run's push takes the English book.
    const second = await runGoodreadsSync({ db: t.db, goodreads: source, ll: ll.bundle, meter: gb.meter, now: new Date(NOW.getTime() + 3_600_000) });
    expect(second.englishEditions).toMatchObject({ switched: 1, parked: 0, looked: 1 });
    expect(gb.queries.filter((q) => q.language === 'en')).toEqual([{ title: 'Azazel', author: 'Isaac Asimov', language: 'en' }]);
    expect(ll.calls.filter((c) => c.id === 'PitFPgAACAAJ')).toEqual([]);
    expect(ll.calls.map((c) => `${c.cmd}:${c.id}`)).toEqual(
      expect.arrayContaining(['addBook:en-azazel', 'queueBook:en-azazel', 'searchBook:en-azazel']),
    );
    const [row] = await t.db.select().from(bookRequests);
    expect(row).toMatchObject({ llBookId: 'en-azazel', unroutableReason: null, ebookStatus: 'wanted', audioStatus: 'wanted' });
    // The lookup's GB legs were charged to the 'goodreads' slice (meter delta → gb_call_budget).
    const [budget] = await t.db.select().from(gbCallBudget);
    expect(budget?.goodreadsCalls).toBeGreaterThan(0);
  });

  it('parks the request when Google Books has no English edition, and a third run asks nothing more that quota-day', async () => {
    const user = await createUser(t.db);
    await linkIntegration({ db: t.db, userId: user.id, provider: 'goodreads', externalUserId: '42', profileRef: 'p', shelves: ['to-read'], actorId: user.id });
    const gb = stubGb(null);
    const ll = stubLl();
    const source = { rss, googleBooks: gb.client } satisfies GoodreadsSourceBundle;

    await runGoodreadsSync({ db: t.db, goodreads: source, ll: ll.bundle, meter: gb.meter, now: NOW });
    const second = await runGoodreadsSync({ db: t.db, goodreads: source, ll: ll.bundle, meter: gb.meter, now: new Date(NOW.getTime() + 3_600_000) });
    expect(second.englishEditions).toMatchObject({ switched: 0, parked: 1 });
    const [row] = await t.db.select().from(bookRequests);
    expect(row).toMatchObject({ llBookId: 'PitFPgAACAAJ', unroutableReason: 'no_english_edition', ebookStatus: 'missing', audioStatus: 'missing' });

    const third = await runGoodreadsSync({ db: t.db, goodreads: source, ll: ll.bundle, meter: gb.meter, now: new Date(NOW.getTime() + 2 * 3_600_000) });
    expect(third.englishEditions).toMatchObject({ looked: 0, due: 0 });
    expect(gb.queries.filter((q) => q.language === 'en')).toHaveLength(1);
    expect(ll.calls).toEqual([]);
  });
});
