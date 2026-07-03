// DESIGN-005 D-14 incremental sync: bootstrap paged walk, cursor-driven
// /history/since polling, (source, source_event_id) dedupe, D-07 normalization, and
// exactly-once cursor advance under a mid-run failure (events + cursor share one tx).
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerEvents, mediaItems, syncState } from '@hnet/db/schema';
import { runSync } from '../src/index';
import {
  bootMigratedDb,
  fixture,
  historyPage,
  seriesJson,
  sonarrHistoryJson,
  sonarrStub,
  type TestDb,
} from './helpers';

const sonarrEvents = (t: TestDb) =>
  t.db.select().from(ledgerEvents).where(eq(ledgerEvents.source, 'sonarr'));

const sonarrCursor = async (t: TestDb) => {
  const [row] = await t.db.select().from(syncState).where(eq(syncState.source, 'sonarr'));
  return row?.historyCursor ?? null;
};

describe('incremental sync (DESIGN-005 D-14)', () => {
  let t: TestDb;
  let seriesRowId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    // Seed one ledger item so history events resolve their media_items FK.
    await runSync({
      mode: 'full',
      sources: ['sonarr'],
      db: t.db,
      clients: {
        sonarr: sonarrStub([
          { path: '/api/v3/series', body: [seriesJson(42)] },
          { path: '/api/v3/qualityprofile', body: fixture('sonarr.qualityprofile') },
          { path: '/api/v3/tag', body: fixture('sonarr.tag') },
        ]),
      },
    });
    const [row] = await t.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(eq(mediaItems.arrKind, 'sonarr'), eq(mediaItems.arrItemId, 42)));
    seriesRowId = row!.id;
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('mid-run failure before the ingest tx leaves the cursor untouched; the retry ingests exactly once', async () => {
    // Bootstrap (no cursor) → paged /history walk, newest-first, 2 records per page.
    const page1 = [
      sonarrHistoryJson(204, 'downloadFolderImported', '2026-07-03T12:04:00Z', 42),
      sonarrHistoryJson(203, 'grabbed', '2026-07-03T12:03:00Z', 42),
    ];
    const page2 = [
      sonarrHistoryJson(202, 'episodeFileRenamed', '2026-07-03T12:02:00Z', 42), // dropped (D-07)
      sonarrHistoryJson(201, 'grabbed', '2026-07-03T12:01:00Z', 42),
    ];

    // Attempt 1: page 2 of the walk 500s → the source fails, NOTHING commits.
    const failing = await runSync({
      mode: 'incremental',
      sources: ['sonarr'],
      db: t.db,
      historyPageSize: 2,
      clients: {
        sonarr: sonarrStub([
          {
            path: '/api/v3/history',
            statusFor: (url) => (url.searchParams.get('page') === '2' ? 500 : 200),
            body: (url: URL) =>
              url.searchParams.get('page') === '2'
                ? { error: 'boom' }
                : historyPage(page1, 1, 2, 4),
          },
        ]),
      },
    });
    expect(failing.sources[0]).toMatchObject({ source: 'sonarr', status: 'failed' });
    expect(failing.totalFailure).toBe(true);
    expect(await sonarrEvents(t)).toHaveLength(0); // no partial ingest
    expect(await sonarrCursor(t)).toBeNull(); // cursor did not advance

    // Attempt 2 (the next CronJob tick): same feed, healthy → everything ingests once.
    const report = await runSync({
      mode: 'incremental',
      sources: ['sonarr'],
      db: t.db,
      historyPageSize: 2,
      clients: {
        sonarr: sonarrStub([
          {
            path: '/api/v3/history',
            body: (url: URL) =>
              url.searchParams.get('page') === '2'
                ? historyPage(page2, 2, 2, 4)
                : historyPage(page1, 1, 2, 4),
          },
        ]),
      },
    });
    expect(report.sources[0]!.status).toBe('succeeded');
    expect(report.sources[0]!.stats).toMatchObject({
      recordsFetched: 4,
      eventsIngested: 3,
      eventsDeduped: 0,
      eventsDropped: 1, // the rename is outside the D-07 map
      bootstrapTruncated: false,
    });

    const events = await sonarrEvents(t);
    expect(events).toHaveLength(3);
    // Normalization: raw type preserved, normalized type stored, FK + child ids set.
    const imported = events.find((e) => e.sourceEventId === '204')!;
    expect(imported.eventType).toBe('imported');
    expect(imported.mediaItemId).toBe(seriesRowId);
    expect(imported.payload).toMatchObject({
      rawEventType: 'downloadFolderImported',
      seriesId: 42,
      episodeId: 4201,
      quality: 'WEBDL-1080p',
      indexer: 'TestIndexer',
    });

    // Cursor = max fetched date (covers the dropped rename too).
    expect((await sonarrCursor(t))!.toISOString()).toBe('2026-07-03T12:04:00.000Z');
  });

  it('cursor-driven poll uses /history/since, dedupes overlap, advances the cursor', async () => {
    const overlap = sonarrHistoryJson(204, 'downloadFolderImported', '2026-07-03T12:04:00Z', 42);
    const fresh = [
      sonarrHistoryJson(205, 'grabbed', '2026-07-03T12:05:00Z', 42),
      sonarrHistoryJson(206, 'episodeFileDeleted', '2026-07-03T12:06:00Z', 42),
      sonarrHistoryJson(207, 'downloadIgnored', '2026-07-03T12:07:00Z', 42), // dropped
    ];
    const stub = sonarrStub([
      { path: '/api/v3/history/since', body: [overlap, ...fresh] },
    ]);

    const report = await runSync({
      mode: 'incremental',
      sources: ['sonarr'],
      db: t.db,
      clients: { sonarr: stub },
    });
    expect(report.sources[0]!.stats).toMatchObject({
      recordsFetched: 4,
      eventsIngested: 2, // 205 + 206; 204 deduped, 207 dropped
      eventsDeduped: 1,
      eventsDropped: 1,
    });

    const events = await sonarrEvents(t);
    expect(events).toHaveLength(5);
    const deleted = events.find((e) => e.sourceEventId === '206')!;
    expect(deleted.eventType).toBe('deleted');
    expect(deleted.payload).toMatchObject({ kind: 'file_deleted', rawEventType: 'episodeFileDeleted' });

    expect((await sonarrCursor(t))!.toISOString()).toBe('2026-07-03T12:07:00.000Z');

    // Re-delivering the exact same batch is a complete no-op (idempotent re-ingestion).
    const rerun = await runSync({
      mode: 'incremental',
      sources: ['sonarr'],
      db: t.db,
      clients: {
        sonarr: sonarrStub([{ path: '/api/v3/history/since', body: [overlap, ...fresh] }]),
      },
    });
    expect(rerun.sources[0]!.stats).toMatchObject({ eventsIngested: 0, eventsDeduped: 3 });
    expect(await sonarrEvents(t)).toHaveLength(5);
    expect((await sonarrCursor(t))!.toISOString()).toBe('2026-07-03T12:07:00.000Z');
  });

  it('history for an item the ledger does not know lands with a NULL FK (payload keeps ids)', async () => {
    const report = await runSync({
      mode: 'incremental',
      sources: ['sonarr'],
      db: t.db,
      clients: {
        sonarr: sonarrStub([
          {
            path: '/api/v3/history/since',
            body: [sonarrHistoryJson(300, 'grabbed', '2026-07-03T13:00:00Z', 999)],
          },
        ]),
      },
    });
    expect(report.sources[0]!.stats).toMatchObject({ eventsIngested: 1 });
    const [event] = await t.db
      .select()
      .from(ledgerEvents)
      .where(eq(ledgerEvents.sourceEventId, '300'));
    expect(event!.mediaItemId).toBeNull();
    expect(event!.payload).toMatchObject({ seriesId: 999 });
  });
});
