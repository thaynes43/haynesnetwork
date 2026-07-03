// DESIGN-005 D-15/D-17 — fix router integration tests: embedded PG16 + fetch-stubbed
// *arr bundles (ADR-010). Covers AC-07 (blocklist + search with the right ids), AC-08
// (delete + search fallback), the R-47 rate limit, the failure path, and R-46
// visibility (myFixes / adminList).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '@hnet/db/schema';
import { tombstoneMissingItems } from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  seedMediaItem,
  sessionUser,
  wireShape,
  type TestDb,
} from './helpers';
import { episodeJson, grabHistoryJson, historyPage, movieJson, stubArrBundle } from './arr-stubs';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await bootMigratedDb();
}, 120_000);

afterAll(async () => {
  await tdb.stop();
});

function sonarrHappyRoutes(grabId = 771) {
  return [
    {
      path: '/api/v3/episode',
      body: [episodeJson(50101, 1, 1), episodeJson(50102, 1, 2), episodeJson(50103, 1, 3)],
    },
    {
      path: '/api/v3/history',
      body: historyPage([
        grabHistoryJson(grabId, '2026-07-01T10:00:00Z', { episodeId: 50102, seriesId: 501 }),
      ]),
    },
    { method: 'POST', path: new RegExp(`^/api/v3/history/failed/\\d+$`), body: {} },
    {
      method: 'POST',
      path: '/api/v3/command',
      status: 201,
      body: { id: 9001, name: 'EpisodeSearch' },
    },
  ];
}

async function fixRow(fixId: string) {
  const [row] = await tdb.db
    .select()
    .from(schema.fixRequests)
    .where(eq(schema.fixRequests.id, fixId));
  if (!row) throw new Error(`fix ${fixId} not found`);
  return row;
}

async function eventsFor(mediaItemId: string) {
  return tdb.db
    .select({ eventType: schema.ledgerEvents.eventType, payload: schema.ledgerEvents.payload })
    .from(schema.ledgerEvents)
    .where(eq(schema.ledgerEvents.mediaItemId, mediaItemId))
    .orderBy(asc(schema.ledgerEvents.createdAt));
}

describe('fix.create — primary path (AC-07)', () => {
  it('blocklists the latest grab, triggers the search, and records everything', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Alpha Show', arrItemId: 501 });
    const stub = stubArrBundle(sonarrHappyRoutes());
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const result = await api.fix.create({
      mediaItemId: item.id,
      targetChildId: 50102,
      reason: 'wrong_language',
    });
    expect(result.status).toBe('search_triggered');
    expect(result.pathTaken).toBe('blocklist_search');
    expect(result.targetLabel).toBe('S01E02 · Episode 2');

    // The destructive calls hit the right *arr endpoints with the right ids.
    const failed = stub.callsFor('POST', '/api/v3/history/failed/');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.url.pathname).toBe('/api/v3/history/failed/771');
    const grabLookups = stub.callsFor('GET', '/api/v3/history');
    expect(grabLookups[0]!.url.searchParams.get('episodeId')).toBe('50102');
    expect(grabLookups[0]!.url.searchParams.get('eventType')).toBe('grabbed');
    const commands = stub.callsFor('POST', '/api/v3/command');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.body).toEqual({ name: 'EpisodeSearch', episodeIds: [50102] });

    // The fix row is the audit record (D-09): status, path, ordered actions.
    const row = await fixRow(result.id);
    expect(row.status).toBe('search_triggered');
    expect(row.pathTaken).toBe('blocklist_search');
    expect(row.targetArrChildId).toBe(50102);
    expect(row.reason).toBe('wrong_language');
    const steps = row.actionsTaken.map((a) => a.step);
    expect(steps).toEqual(['created', 'resolve_grab', 'mark_failed', 'trigger_search']);
    expect(row.actionsTaken[1]).toMatchObject({ grabHistoryId: 771, ok: true });
    expect(row.actionsTaken[3]).toMatchObject({ commandId: 9001, commandName: 'EpisodeSearch' });

    // Ledger events: fix_requested + fix_actioned (D-09 lifecycle markers).
    const events = await eventsFor(item.id);
    expect(events.map((e) => e.eventType)).toEqual(['fix_requested', 'fix_actioned']);
    expect(events[0]!.payload).toMatchObject({ fixRequestId: result.id, reason: 'wrong_language' });
  });

  it('requires an episode target for sonarr (FIX_TARGET_REQUIRED)', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Beta Show', arrItemId: 502 });
    const stub = stubArrBundle([]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const err = await api.fix
      .create({ mediaItemId: item.id, reason: 'wrong_content' })
      .catch((e: unknown) => e);
    const shape = wireShape(err, 'fix.create');
    expect(shape.data.code).toBe('UNPROCESSABLE_CONTENT');
    expect(shape.data.appCode).toBe('FIX_TARGET_REQUIRED');
    expect(stub.calls).toHaveLength(0); // rejected before any *arr call
  });

  it('rejects fixes on tombstoned items (LEDGER_ITEM_TOMBSTONED)', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Gone Movie', arrItemId: 601 });
    await tombstoneMissingItems({ db: tdb.db, arrKind: 'radarr', seenArrItemIds: [] });
    const stub = stubArrBundle([]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const err = await api.fix
      .create({ mediaItemId: item.id, reason: 'wont_play_corrupt' })
      .catch((e: unknown) => e);
    const shape = wireShape(err, 'fix.create');
    expect(shape.data.code).toBe('PRECONDITION_FAILED');
    expect(shape.data.appCode).toBe('LEDGER_ITEM_TOMBSTONED');
  });
});

describe('fix.create — fallback path (AC-08)', () => {
  it('deletes the file and searches when no grab history exists (radarr)', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Broken Movie', arrItemId: 602 });
    const stub = stubArrBundle([
      { path: '/api/v3/history/movie', body: [] }, // no grab history
      { path: '/api/v3/movie/602', body: movieJson(602, { movieFileId: 4501, hasFile: true }) },
      { method: 'DELETE', path: '/api/v3/moviefile/4501', body: {} },
      {
        method: 'POST',
        path: '/api/v3/command',
        status: 201,
        body: { id: 9002, name: 'MoviesSearch' },
      },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const result = await api.fix.create({ mediaItemId: item.id, reason: 'wrong_version_quality' });
    expect(result.status).toBe('search_triggered');
    expect(result.pathTaken).toBe('delete_search');
    expect(result.targetLabel).toBeNull(); // radarr targets the movie itself

    expect(stub.callsFor('DELETE', '/api/v3/moviefile/4501')).toHaveLength(1);
    expect(stub.callsFor('POST', '/api/v3/history/failed/')).toHaveLength(0);
    const commands = stub.callsFor('POST', '/api/v3/command');
    expect(commands[0]!.body).toEqual({ name: 'MoviesSearch', movieIds: [602] });

    const row = await fixRow(result.id);
    expect(row.pathTaken).toBe('delete_search');
    expect(row.actionsTaken.map((a) => a.step)).toEqual([
      'created',
      'resolve_grab',
      'delete_file',
      'trigger_search',
    ]);
    expect(row.actionsTaken[1]).toMatchObject({ grabHistoryId: null });
  });

  it('deletes every track file for a lidarr album fix', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'lidarr', {
      title: 'Artist Seven',
      arrItemId: 7,
      rootFolder: '/data/media/music',
    });
    const stub = stubArrBundle([
      {
        path: '/api/v1/album',
        body: [
          {
            id: 71,
            artistId: 7,
            foreignAlbumId: '11111111-2222-3333-4444-555555555555',
            title: 'First Light',
            albumType: 'Album',
            monitored: true,
            anyReleaseOk: true,
            releaseDate: '2019-05-17T00:00:00Z',
            statistics: { trackFileCount: 2, trackCount: 2, totalTrackCount: 2, sizeOnDisk: 9 },
          },
        ],
      },
      { path: '/api/v1/history', body: historyPage([]) }, // no grabs (import-list era, Q-08)
      {
        path: '/api/v1/trackfile',
        body: [
          { id: 9001, albumId: 71 },
          { id: 9002, albumId: 71 },
        ],
      },
      { method: 'DELETE', path: /^\/api\/v1\/trackfile\/\d+$/, body: {} },
      {
        method: 'POST',
        path: '/api/v1/command',
        status: 201,
        body: { id: 9003, name: 'AlbumSearch' },
      },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const result = await api.fix.create({
      mediaItemId: item.id,
      targetChildId: 71,
      reason: 'wont_play_corrupt',
    });
    expect(result.pathTaken).toBe('delete_search');
    expect(result.targetLabel).toBe('First Light');
    const deletes = stub.callsFor('DELETE', '/api/v1/trackfile/');
    expect(deletes.map((c) => c.url.pathname)).toEqual([
      '/api/v1/trackfile/9001',
      '/api/v1/trackfile/9002',
    ]);
    expect(stub.callsFor('POST', '/api/v1/command')[0]!.body).toEqual({
      name: 'AlbumSearch',
      albumIds: [71],
    });
  });
});

describe('fix.create — failures land failed + ARR_UPSTREAM_UNAVAILABLE', () => {
  it('records the failed step and surfaces BAD_GATEWAY when the blocklist call 500s', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Gamma Show', arrItemId: 503 });
    const stub = stubArrBundle([
      { path: '/api/v3/episode', body: [episodeJson(50301, 2, 1, { seriesId: 503 })] },
      {
        path: '/api/v3/history',
        body: historyPage([
          grabHistoryJson(881, '2026-07-01T10:00:00Z', { episodeId: 50301, seriesId: 503 }),
        ]),
      },
      {
        method: 'POST',
        path: /^\/api\/v3\/history\/failed\/\d+$/,
        status: 500,
        body: { message: 'boom' },
      },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const err = await api.fix
      .create({ mediaItemId: item.id, targetChildId: 50301, reason: 'missing_subtitles' })
      .catch((e: unknown) => e);
    const shape = wireShape(err, 'fix.create');
    expect(shape.data.code).toBe('BAD_GATEWAY');
    expect(shape.data.appCode).toBe('ARR_UPSTREAM_UNAVAILABLE');

    // The row is terminal 'failed' with the response captured (R-46).
    const [row] = await tdb.db
      .select()
      .from(schema.fixRequests)
      .where(eq(schema.fixRequests.mediaItemId, item.id));
    expect(row!.status).toBe('failed');
    const failedStep = row!.actionsTaken.find((a) => a.step === 'mark_failed');
    expect(failedStep).toMatchObject({ ok: false, status: 500 });
    const events = await eventsFor(item.id);
    expect(events.map((e) => e.eventType)).toEqual(['fix_requested', 'fix_failed']);
  });
});

describe('fix.create — rate limit (R-47)', () => {
  it('trips at the 6th request within an hour with FIX_RATE_LIMIT_EXCEEDED', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Delta Show', arrItemId: 504 });
    const stub = stubArrBundle([
      {
        path: '/api/v3/episode',
        body: Array.from({ length: 6 }, (_, i) =>
          episodeJson(50400 + i + 1, 1, i + 1, { seriesId: 504 }),
        ),
      },
      {
        path: '/api/v3/history',
        body: (url: URL) =>
          historyPage([
            grabHistoryJson(
              900 + Number(url.searchParams.get('episodeId')),
              '2026-07-01T10:00:00Z',
              {
                episodeId: Number(url.searchParams.get('episodeId')),
                seriesId: 504,
              },
            ),
          ]),
      },
      { method: 'POST', path: /^\/api\/v3\/history\/failed\/\d+$/, body: {} },
      {
        method: 'POST',
        path: '/api/v3/command',
        status: 201,
        body: { id: 1, name: 'EpisodeSearch' },
      },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    for (let i = 1; i <= 5; i++) {
      const res = await api.fix.create({
        mediaItemId: item.id,
        targetChildId: 50400 + i,
        reason: 'wrong_language',
      });
      expect(res.status).toBe('search_triggered');
    }
    const err = await api.fix
      .create({ mediaItemId: item.id, targetChildId: 50406, reason: 'wrong_language' })
      .catch((e: unknown) => e);
    const shape = wireShape(err, 'fix.create');
    expect(shape.data.code).toBe('TOO_MANY_REQUESTS');
    expect(shape.data.appCode).toBe('FIX_RATE_LIMIT_EXCEEDED');

    // Exactly 5 rows landed; the 6th never created a pending row.
    const rows = await tdb.db
      .select({ id: schema.fixRequests.id })
      .from(schema.fixRequests)
      .where(
        and(
          eq(schema.fixRequests.mediaItemId, item.id),
          eq(schema.fixRequests.requesterId, member.id),
        ),
      );
    expect(rows).toHaveLength(5);
  });

  it('dedupes an open fix on the same target (FIX_ALREADY_OPEN)', async () => {
    const member = await createUser(tdb.db);
    const other = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Epsilon Show', arrItemId: 505 });
    const stub = stubArrBundle([
      { path: '/api/v3/episode', body: [episodeJson(50501, 1, 1, { seriesId: 505 })] },
      {
        path: '/api/v3/history',
        body: historyPage([
          grabHistoryJson(991, '2026-07-01T10:00:00Z', { episodeId: 50501, seriesId: 505 }),
        ]),
      },
      { method: 'POST', path: /^\/api\/v3\/history\/failed\/\d+$/, body: {} },
      {
        method: 'POST',
        path: '/api/v3/command',
        status: 201,
        body: { id: 2, name: 'EpisodeSearch' },
      },
    ]);
    const first = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    await first.fix.create({
      mediaItemId: item.id,
      targetChildId: 50501,
      reason: 'wrong_language',
    });

    const second = caller(makeCtx(tdb.db, sessionUser(other), stub.bundle));
    const err = await second.fix
      .create({ mediaItemId: item.id, targetChildId: 50501, reason: 'wrong_content' })
      .catch((e: unknown) => e);
    const shape = wireShape(err, 'fix.create');
    expect(shape.data.code).toBe('CONFLICT');
    expect(shape.data.appCode).toBe('FIX_ALREADY_OPEN');
  });
});

describe('fix.myFixes / fix.adminList (R-46)', () => {
  it('members see exactly their own; admins see all with requester + raw actions', async () => {
    const member = await createUser(tdb.db);
    const admin = await createUser(tdb.db, { role: 'Admin' });
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Zeta Show', arrItemId: 506 });
    const stub = stubArrBundle([
      {
        path: '/api/v3/episode',
        body: [
          episodeJson(50601, 1, 1, { seriesId: 506 }),
          episodeJson(50602, 1, 2, { seriesId: 506 }),
        ],
      },
      {
        path: '/api/v3/history',
        body: (url: URL) =>
          historyPage([
            grabHistoryJson(
              1000 + Number(url.searchParams.get('episodeId')),
              '2026-07-01T10:00:00Z',
              {
                episodeId: Number(url.searchParams.get('episodeId')),
                seriesId: 506,
              },
            ),
          ]),
      },
      { method: 'POST', path: /^\/api\/v3\/history\/failed\/\d+$/, body: {} },
      {
        method: 'POST',
        path: '/api/v3/command',
        status: 201,
        body: { id: 3, name: 'EpisodeSearch' },
      },
    ]);

    const memberApi = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const created = await memberApi.fix.create({
      mediaItemId: item.id,
      targetChildId: 50601,
      reason: 'other',
      reasonText: 'audio drops out at 12:34',
    });
    const adminApi = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));
    await adminApi.fix.create({
      mediaItemId: item.id,
      targetChildId: 50602,
      reason: 'wrong_language',
    });

    const mine = await memberApi.fix.myFixes();
    expect(mine.some((f) => f.id === created.id)).toBe(true);
    expect(mine.every((f) => f.item.title.length > 0)).toBe(true);
    // Another user's fix on the same item never leaks into myFixes.
    const mineIds = new Set(mine.map((f) => f.id));
    const all = await adminApi.fix.adminList({});
    const admins = all.items.filter((f) => f.item.id === item.id && !mineIds.has(f.id));
    expect(admins.length).toBeGreaterThan(0);

    const memberRow = all.items.find((f) => f.id === created.id)!;
    expect(memberRow.requester?.displayName).toBe(member.displayName);
    expect(memberRow.reasonText).toBe('audio drops out at 12:34');
    expect(memberRow.actionsTaken.map((a) => a.step)).toContain('mark_failed');

    // Status filter narrows.
    const searchTriggered = await adminApi.fix.adminList({ status: 'search_triggered' });
    expect(searchTriggered.items.every((f) => f.status === 'search_triggered')).toBe(true);
  });

  it('rejects reasonText without reason=other at the schema edge', async () => {
    const member = await createUser(tdb.db);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stubArrBundle([]).bundle));
    await expect(
      api.fix.create({
        mediaItemId: '00000000-0000-4000-8000-00000000aaaa',
        reason: 'wrong_language',
        reasonText: 'should not be here',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
