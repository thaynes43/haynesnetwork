// ADR-067 / DESIGN-039 (PLAN-055) — the goodreads-sync run under GB quota weather. Proves the two
// run-level behaviors the domain tests can't: (1) an OPEN breaker makes the enrichment pass do
// ZERO GB calls with ONE skip log line (items mirror honestly un-enriched, counted as
// skippedEnrichment); (2) the run HOSTS the queued-book-fix retry pass — a fix queued by quota
// weather completes end-to-end (search_triggered, full LL chain) on the next run once the quota
// returns. Embedded PG16; RSS/GB/LL all stubbed offline (ADR-010).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  bookFixRequests,
  bookRequests,
  booksItems,
  gbQuotaState,
  integrationShelfItems,
  permissionAudit,
  userIntegrations,
} from '@hnet/db';
import {
  clearGbQuotaBreaker,
  createBookFixRequest,
  linkIntegration,
  runBookFixRequest,
  syncBooks,
  tripGbQuotaBreaker,
  type LazyLibrarianClientBundle,
} from '@hnet/domain';
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
  await t.db.delete(bookFixRequests);
  await t.db.delete(bookRequests);
  await t.db.delete(integrationShelfItems);
  await t.db.delete(userIntegrations);
  await t.db.delete(booksItems);
  await t.db.delete(permissionAudit);
  await clearGbQuotaBreaker({ db: t.db }); // the single-writer clear (guarded table)
});

function stubRss(items: Array<{ id: string; title: string; author: string }>) {
  return {
    fetchShelf: async (_userId: string, shelf: string) =>
      shelf === 'to-read'
        ? items.map((i) => ({
            externalBookId: i.id,
            title: i.title,
            author: i.author,
            isbn: null,
            coverUrl: null,
            shelvedAt: null,
          }))
        : [],
  } as unknown as GoodreadsRssClient;
}

function stubGb() {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      resolveVolume: async () => {
        calls += 1;
        return { volumeId: `gb-${calls}`, isbn13: null, categories: [], isComic: false };
      },
    } as unknown as GoogleBooksClient,
  };
}

function stubLl() {
  const calls: Array<{ cmd: string; id: string; format?: string }> = [];
  const bundle = {
    write: {
      addBook: async (id: string) => void calls.push({ cmd: 'addBook', id }),
      queueBook: async (id: string, format: string) => void calls.push({ cmd: 'queueBook', id, format }),
      searchBook: async (id: string, format: string) => void calls.push({ cmd: 'searchBook', id, format }),
    },
    read: {
      getAllBookStatuses: async () => new Map(),
    },
  } as unknown as LazyLibrarianClientBundle;
  return { calls, bundle };
}

function spyLogger() {
  const infos: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const errors: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    infos,
    errors,
    logger: {
      info: (msg: string, meta?: Record<string, unknown>) => void infos.push({ msg, ...(meta ? { meta } : {}) }),
      warn: () => {},
      error: (msg: string, meta?: Record<string, unknown>) => void errors.push({ msg, ...(meta ? { meta } : {}) }),
    },
  };
}

async function linkTestIntegration(): Promise<void> {
  const user = await createUser(t.db);
  // Through the domain single-writer (guarded table — the audited link).
  await linkIntegration({
    db: t.db,
    userId: user.id,
    provider: 'goodreads',
    externalUserId: '42',
    profileRef: 'https://www.goodreads.com/user/show/42',
    shelves: ['to-read'],
    actorId: user.id,
  });
}

/** Seed one landed book through the syncBooks single-writer (guarded mirror table). */
async function seedBooksItem(externalId: string, title: string): Promise<string> {
  await syncBooks({
    db: t.db,
    syncedSources: ['kavita'],
    rows: [
      {
        source: 'kavita',
        mediaKind: 'book',
        externalId,
        libraryId: '1',
        libraryName: 'EBooks',
        title,
        sortTitle: title.toLowerCase(),
        author: null,
        narrator: null,
        seriesName: null,
        year: null,
        releasedAt: null,
        genres: [],
        coverRef: null,
        pageCount: null,
        wordCount: null,
        durationSeconds: null,
        sizeBytes: null,
        attrs: {},
        sourceAddedAt: null,
        sourceUpdatedAt: null,
        deepLinkUrl: `http://kavita/${externalId}`,
      },
    ],
  });
  const [row] = await t.db.select().from(booksItems).where(eq(booksItems.externalId, externalId));
  return row!.id;
}

describe('runGoodreadsSync — enrichment under an OPEN breaker (ADR-067 C-07)', () => {
  it('makes ZERO GB calls, logs ONE skip line, and reports skippedEnrichment', async () => {
    await linkTestIntegration();
    await tripGbQuotaBreaker({ db: t.db, kind: 'daily' });
    const gb = stubGb();
    const log = spyLogger();

    const report = await runGoodreadsSync({
      db: t.db,
      goodreads: {
        rss: stubRss([
          { id: 'b1', title: 'Whispers', author: 'Dean Koontz' },
          { id: 'b2', title: 'Dead Ever After', author: 'Charlaine Harris' },
          { id: 'b3', title: 'Hyperion', author: 'Dan Simmons' },
        ]),
        googleBooks: gb.client,
      } satisfies GoodreadsSourceBundle,
      logger: log.logger,
    });

    expect(report.synced).toBe(1);
    expect(report.skippedEnrichment).toBe(3);
    expect(gb.calls()).toBe(0);
    const skipLines = log.infos.filter((l) => l.msg.includes('GB quota exhausted'));
    expect(skipLines).toHaveLength(1); // ONE line, not one per item
    expect(log.errors.filter((l) => l.msg.includes('GB enrichment failed'))).toHaveLength(0);
    // The mirror still landed, honestly un-enriched.
    const mirrored = await t.db.select().from(integrationShelfItems);
    expect(mirrored).toHaveLength(3);
    expect(mirrored.every((m) => m.gbVolumeId === null)).toBe(true);
  });

  it('a mid-run daily 429 flips the skip for the REST of the run (one trip, one line)', async () => {
    await linkTestIntegration();
    let calls = 0;
    const gb429 = {
      resolveVolume: async () => {
        calls += 1;
        throw Object.assign(new Error("HTTP 429 — limit 'Queries per day'"), {
          status: 429,
          bodySnippet: "limit 'Queries per day'",
        });
      },
    } as unknown as GoogleBooksClient;
    const log = spyLogger();

    const report = await runGoodreadsSync({
      db: t.db,
      goodreads: {
        rss: stubRss([
          { id: 'b1', title: 'One', author: 'A' },
          { id: 'b2', title: 'Two', author: 'B' },
          { id: 'b3', title: 'Three', author: 'C' },
        ]),
        googleBooks: gb429,
      },
      logger: log.logger,
    });

    expect(calls).toBe(1); // the trip — everything after rides the breaker
    expect(report.skippedEnrichment).toBe(3); // the tripping item + the two behind it
    expect(log.infos.filter((l) => l.msg.includes('GB quota exhausted'))).toHaveLength(1);
    // The trip persisted for the other consumers.
    const [state] = await t.db.select().from(gbQuotaState);
    expect(state?.exhaustedUntil).not.toBeNull();
  });
});

describe('runGoodreadsSync — hosts the queued-fix retry pass (ADR-067 C-06)', () => {
  it('completes a quota-queued fix end-to-end on the next run once the quota returns', async () => {
    // Seed a landed book + a fix that met quota weather (the incident shape).
    const user = await createUser(t.db);
    const itemId = await seedBooksItem('ext-whispers', 'Whispers');
    const fix = await createBookFixRequest({
      db: t.db,
      requesterId: user.id,
      booksItemId: itemId,
      reason: 'corrupt_file',
    });
    await tripGbQuotaBreaker({ db: t.db, kind: 'daily' });
    const llQueued = stubLl();
    const queued = await runBookFixRequest({
      db: t.db,
      fix,
      ll: llQueued.bundle,
      gb: { resolveVolume: async () => null },
    });
    expect(queued.status).toBe('queued');

    // The quota returns (07:00 UTC passed) — the NEXT goodreads-sync run completes the fix.
    await clearGbQuotaBreaker({ db: t.db });
    const ll = stubLl();
    const log = spyLogger();
    const report = await runGoodreadsSync({
      db: t.db,
      goodreads: { rss: stubRss([]), googleBooks: stubGb().client },
      ll: ll.bundle,
      logger: log.logger,
    });

    expect(report.fixRetries).toMatchObject({ queued: 1, attempted: 1, completed: 1, failed: 0 });
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook', 'queueBook', 'searchBook']);
    const [fresh] = await t.db.select().from(bookFixRequests).where(eq(bookFixRequests.id, fix.id));
    expect(fresh!.status).toBe('search_triggered');
  });

  it('the pass is skipped honestly while the breaker is still open', async () => {
    const user = await createUser(t.db);
    const itemId = await seedBooksItem('ext-dea', 'Dead Ever After');
    const fix = await createBookFixRequest({
      db: t.db,
      requesterId: user.id,
      booksItemId: itemId,
      reason: 'bad_quality',
    });
    await tripGbQuotaBreaker({ db: t.db, kind: 'daily' });
    await runBookFixRequest({ db: t.db, fix, ll: stubLl().bundle, gb: { resolveVolume: async () => null } });

    const ll = stubLl();
    const report = await runGoodreadsSync({
      db: t.db,
      goodreads: { rss: stubRss([]), googleBooks: stubGb().client },
      ll: ll.bundle,
      logger: spyLogger().logger,
    });
    expect(report.fixRetries).toMatchObject({ queued: 1, attempted: 0, skippedQuota: 1 });
    expect(ll.calls).toHaveLength(0);
    const [fresh] = await t.db.select().from(bookFixRequests).where(eq(bookFixRequests.id, fix.id));
    expect(fresh!.status).toBe('queued');
  });
});
