// DESIGN-005 D-24 — end to end through runSync: a grab the incremental poll ingests before the
// full sync has created its title's media_items row lands with a NULL FK, and the post-step attaches
// it as soon as the row exists. Nothing here involves Seerr: the relink covers every *arr event.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerEvents, mediaItems } from '@hnet/db/schema';
import { runSync } from '../src/index';
import {
  bootMigratedDb,
  fixture,
  seriesJson,
  sonarrHistoryJson,
  sonarrStub,
  type TestDb,
} from './helpers';

const eventFk = async (t: TestDb, sourceEventId: string) => {
  const [row] = await t.db
    .select({ mediaItemId: ledgerEvents.mediaItemId })
    .from(ledgerEvents)
    .where(and(eq(ledgerEvents.source, 'sonarr'), eq(ledgerEvents.sourceEventId, sourceEventId)));
  return row!.mediaItemId;
};

const fullSync = (t: TestDb, seriesIds: number[]) =>
  runSync({
    mode: 'full',
    sources: ['sonarr'],
    db: t.db,
    clients: {
      sonarr: sonarrStub([
        { path: '/api/v3/series', body: seriesIds.map((id) => seriesJson(id)) },
        { path: '/api/v3/qualityprofile', body: fixture('sonarr.qualityprofile') },
        { path: '/api/v3/tag', body: fixture('sonarr.tag') },
      ]),
    },
  });

const incrementalSync = (t: TestDb, records: unknown[]) =>
  runSync({
    mode: 'incremental',
    sources: ['sonarr'],
    db: t.db,
    clients: { sonarr: sonarrStub([{ path: '/api/v3/history/since', body: records }]) },
  });

describe('history relink post-step (DESIGN-005 D-24)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await bootMigratedDb();
    // The ledger already knows series 10, and a cursor exists, so later polls use /history/since.
    await fullSync(t, [10]);
    await runSync({
      mode: 'incremental',
      sources: ['sonarr'],
      db: t.db,
      clients: {
        sonarr: sonarrStub([
          {
            path: '/api/v3/history',
            body: {
              page: 1,
              pageSize: 100,
              sortKey: 'date',
              sortDirection: 'descending',
              totalRecords: 1,
              records: [sonarrHistoryJson(1, 'grabbed', '2026-07-04T00:00:00Z', 10)],
            },
          },
        ]),
      },
    });
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('a grab that beat its title row is attached by the next run that has the row; re-runs are no-ops', async () => {
    // 1. Series 20 is added to Sonarr and grabbed + imported before the next full sync.
    const early = await incrementalSync(t, [
      sonarrHistoryJson(21, 'grabbed', '2026-07-04T01:00:00Z', 20),
      sonarrHistoryJson(22, 'downloadFolderImported', '2026-07-04T01:05:00Z', 20),
      sonarrHistoryJson(23, 'grabbed', '2026-07-04T01:10:00Z', 30), // series 30 never reaches the ledger
    ]);
    expect(early.sources[0]!.stats).toMatchObject({ eventsIngested: 3 });
    expect(early.historyRelink).toEqual({ linked: { sonarr: 0, radarr: 0, lidarr: 0 }, total: 0 });
    expect(await eventFk(t, '21')).toBeNull();
    expect(await eventFk(t, '22')).toBeNull();

    // 2. The full sync creates series 20's row; its own post-step attaches the orphans.
    const full = await fullSync(t, [10, 20]);
    expect(full.historyRelink).toEqual({ linked: { sonarr: 2, radarr: 0, lidarr: 0 }, total: 2 });
    expect(full.historyRelinkError).toBeUndefined();
    const [series] = await t.db
      .select({ id: mediaItems.id })
      .from(mediaItems)
      .where(and(eq(mediaItems.arrKind, 'sonarr'), eq(mediaItems.arrItemId, 20)));
    expect(await eventFk(t, '21')).toBe(series!.id);
    expect(await eventFk(t, '22')).toBe(series!.id);
    // The title that never appeared stays unlinked without failing the run.
    expect(await eventFk(t, '23')).toBeNull();
    expect(full.totalFailure).toBe(false);

    // 3. The next run has nothing left to attach and changes nothing.
    const again = await incrementalSync(t, []);
    expect(again.historyRelink).toEqual({ linked: { sonarr: 0, radarr: 0, lidarr: 0 }, total: 0 });
    expect(await eventFk(t, '21')).toBe(series!.id);
    expect(await eventFk(t, '23')).toBeNull();
  });
});
