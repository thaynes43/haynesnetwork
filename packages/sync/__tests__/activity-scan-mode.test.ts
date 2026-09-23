// Issue #556 — the `activity-scan` standalone sync mode end to end, over REAL *arr read clients: it reads each
// WHOLE queue (Sonarr past 200 records), records every import failure in the durable ledger, writes NO
// notification_outbox row (ADR-090 / DESIGN-030 D-07a — the owner ruled no per-event push; the nightly
// failure digest reads the ledger), and a second run over the same queue served in a different order opens
// and closes NOTHING (no flap). Before #556 the scan read one 200-record page, so each run dropped a
// different tail of Sonarr's 212-item queue and every dropped failure flapped closed → re-opened.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isNull, sql } from 'drizzle-orm';
import { activityImportFailures, notificationOutbox } from '@hnet/db';
import { buildArrActivityAdapter } from '@hnet/domain';
import { runSync } from '../src/orchestrator';
import { bootMigratedDb, lidarrStub, radarrStub, sonarrStub, type TestDb } from './helpers';
import type { SyncClients } from '../src/clients';

let t: TestDb;

beforeAll(async () => {
  t = await bootMigratedDb();
});

afterAll(async () => {
  await t?.stop();
});

/** An *arr queue record the importer refused — `trackedDownloadState: importBlocked` (manual import needed). */
function blocked(id: number, parent: Record<string, number>) {
  return {
    id,
    status: 'completed',
    trackedDownloadStatus: 'warning',
    trackedDownloadState: 'importBlocked',
    size: 1000,
    sizeleft: 0,
    title: `Blocked.Release.${id}`,
    statusMessages: [{ title: 'Blocked.Release', messages: ['Episode was not found in the grabbed release'] }],
    ...parent,
  };
}

/**
 * A `/queue` body honouring the client's page/pageSize like the real *arr. `order()` picks the record order
 * for THIS read — the real default sort (timeleft) is not stable across runs, which is what made a single
 * truncated page drop a different tail each time.
 */
function pagedQueue(order: () => unknown[]) {
  return (url: URL) => {
    const all = order();
    const page = Number(url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
    return {
      page,
      pageSize,
      sortKey: 'timeleft',
      sortDirection: 'ascending',
      totalRecords: all.length,
      records: all.slice((page - 1) * pageSize, page * pageSize),
    };
  };
}

const emptyHistory = { page: 1, pageSize: 30, sortKey: 'date', sortDirection: 'descending', totalRecords: 0, records: [] };

describe('runSync --mode=activity-scan (issue #556)', () => {
  it('ledgers the whole queue, enqueues nothing, and does not flap on a re-ordered second read', async () => {
    const sonarrQueue = Array.from({ length: 212 }, (_, i) =>
      blocked(i + 1, { seriesId: 1000 + i, episodeId: 50_000 + i }),
    );
    const radarrQueue = Array.from({ length: 10 }, (_, i) => blocked(900 + i, { movieId: 600 + i }));
    let run = 0;
    const sonarrOrder = () => (run % 2 === 0 ? sonarrQueue : [...sonarrQueue].reverse());

    const adapter = buildArrActivityAdapter({
      sonarr: sonarrStub([
        { path: '/api/v3/queue', body: pagedQueue(sonarrOrder) },
        { path: '/api/v3/history', body: emptyHistory },
      ]),
      radarr: radarrStub([
        { path: '/api/v3/queue', body: pagedQueue(() => radarrQueue) },
        { path: '/api/v3/history', body: emptyHistory },
      ]),
      lidarr: lidarrStub([
        { path: '/api/v1/queue', body: pagedQueue(() => []) },
        { path: '/api/v1/history', body: emptyHistory },
      ]),
    });
    const scan = () =>
      runSync({ mode: 'activity-scan', clients: {} as SyncClients, db: t.db, arrActivityAdapter: adapter });

    const first = await scan();
    expect(first.totalFailure).toBe(false);
    expect(first.activity).toEqual({ seen: 222, opened: 222, resolved: 0 });
    expect(first.sources).toEqual([]);

    run += 1; // the same queue, served in the opposite order
    const second = await scan();
    expect(second.totalFailure).toBe(false);
    expect(second.activity).toEqual({ seen: 222, opened: 0, resolved: 0 });

    const open = await t.db
      .select()
      .from(activityImportFailures)
      .where(isNull(activityImportFailures.resolvedAt));
    expect(open).toHaveLength(222);
    expect(open.filter((r) => r.sourceApp === 'sonarr')).toHaveLength(212);
    expect(open.every((r) => r.failureKind === 'import_blocked')).toBe(true);
    // No per-failure outbox row — first sight included (the ~267-push first run the issue measured).
    expect(await t.db.select().from(notificationOutbox)).toHaveLength(0);
    // Standalone: no sync_runs row either.
    const runs = await t.db.execute(sql`SELECT count(*)::int AS n FROM sync_runs`);
    expect((runs.rows?.[0] as { n: number }).n).toBe(0);
  });
});
