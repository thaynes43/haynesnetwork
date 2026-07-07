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
    // Paged /history binds eventType to the INTEGER enum — grabbed === 1. The string
    // form 400s upstream (fix/history-eventtype-enum) and the strict stub now 400s too.
    expect(grabLookups[0]!.url.searchParams.get('eventType')).toBe('1');
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
      // A non-subtitle reason: missing_subtitles now routes to Bazarr (ADR-016), so it would
      // no longer take this blocklist path. This test exercises the *arr blocklist failure.
      .create({ mediaItemId: item.id, targetChildId: 50301, reason: 'wont_play_corrupt' })
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

describe('fix.forceSearch — roll-up scopes (media-hierarchy actions, D-17)', () => {
  it('whole-show search fires SeriesSearch and records a search_requested event', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Show A', arrItemId: 801 });
    const stub = stubArrBundle([
      { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 1, name: 'SeriesSearch' } },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const result = await api.fix.forceSearch({ mediaItemId: item.id, scope: 'show' });
    expect(result.commandName).toBe('SeriesSearch');
    expect(stub.callsFor('POST', '/api/v3/command')[0]!.body).toEqual({
      name: 'SeriesSearch',
      seriesId: 801,
    });
    // Search-only: NO blocklist / delete, one audited event.
    expect(stub.callsFor('POST', '/api/v3/history/failed/')).toHaveLength(0);
    const events = await eventsFor(item.id);
    expect(events.map((e) => e.eventType)).toEqual(['search_requested']);
    expect(events[0]!.payload).toMatchObject({ scope: 'show', targetArrChildId: null });
  });

  it('season search fires SeasonSearch with seriesId + seasonNumber', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Show B', arrItemId: 802 });
    const stub = stubArrBundle([
      { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 2, name: 'SeasonSearch' } },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const result = await api.fix.forceSearch({ mediaItemId: item.id, scope: 'season', seasonNumber: 3 });
    expect(result.targetLabel).toBe('Season 3');
    expect(stub.callsFor('POST', '/api/v3/command')[0]!.body).toEqual({
      name: 'SeasonSearch',
      seriesId: 802,
      seasonNumber: 3,
    });
  });

  it('whole-artist search fires ArtistSearch (lidarr)', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'lidarr', {
      title: 'Artist B',
      arrItemId: 88,
      rootFolder: '/data/media/music',
    });
    const stub = stubArrBundle([
      { method: 'POST', path: '/api/v1/command', status: 201, body: { id: 3, name: 'ArtistSearch' } },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const result = await api.fix.forceSearch({ mediaItemId: item.id, scope: 'artist' });
    expect(result.commandName).toBe('ArtistSearch');
    expect(stub.callsFor('POST', '/api/v1/command')[0]!.body).toEqual({
      name: 'ArtistSearch',
      artistId: 88,
    });
  });
});

describe('fix.create — season roll-up (media-hierarchy actions)', () => {
  it('blocklists each on-disk episode grab in the season, then fires SeasonSearch', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Season Show', arrItemId: 803 });
    const stub = stubArrBundle([
      {
        path: '/api/v3/episode',
        body: [
          episodeJson(80101, 1, 1, { seriesId: 803 }), // season 1 — untouched
          episodeJson(80301, 2, 1, { seriesId: 803 }), // season 2, on disk
          episodeJson(80302, 2, 2, { seriesId: 803 }), // season 2, on disk
          episodeJson(80303, 2, 3, { seriesId: 803, hasFile: false }), // season 2, missing
        ],
      },
      {
        path: '/api/v3/history',
        body: (url: URL) =>
          historyPage([
            grabHistoryJson(900_000 + Number(url.searchParams.get('episodeId')), '2026-07-01T10:00:00Z', {
              episodeId: Number(url.searchParams.get('episodeId')),
              seriesId: 803,
            }),
          ]),
      },
      { method: 'POST', path: /^\/api\/v3\/history\/failed\/\d+$/, body: {} },
      { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 9100, name: 'SeasonSearch' } },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const result = await api.fix.create({
      mediaItemId: item.id,
      scope: 'season',
      seasonNumber: 2,
      reason: 'wrong_version_quality',
    });
    expect(result.status).toBe('search_triggered');
    expect(result.pathTaken).toBe('blocklist_search');
    expect(result.targetLabel).toBe('Season 2');

    // Only the TWO on-disk season-2 episodes' grabs get blocklisted (E3 is missing).
    const failed = stub.callsFor('POST', '/api/v3/history/failed/').map((c) => c.url.pathname);
    expect(failed.sort()).toEqual([
      '/api/v3/history/failed/980301',
      '/api/v3/history/failed/980302',
    ]);
    // One SeasonSearch for the whole season.
    expect(stub.callsFor('POST', '/api/v3/command')[0]!.body).toEqual({
      name: 'SeasonSearch',
      seriesId: 803,
      seasonNumber: 2,
    });

    // The audit row carries the season scope (child null, season 2).
    const row = await fixRow(result.id);
    expect(row.targetScope).toBe('season');
    expect(row.targetSeason).toBe(2);
    expect(row.targetArrChildId).toBeNull();
    expect(row.status).toBe('search_triggered');
    const events = await eventsFor(item.id);
    expect(events.map((e) => e.eventType)).toEqual(['fix_requested', 'fix_actioned']);
  });
});

describe('fix.create — missing_subtitles routes to Bazarr (ADR-016 / D-19)', () => {
  const MISSING_EN = { name: 'English', code2: 'en', forced: false, hi: false };

  it('sonarr episode: fires the Bazarr series search; no *arr blocklist/command/delete', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Subs Show', arrItemId: 507 });
    const stub = stubArrBundle([
      { path: '/api/v3/episode', body: [episodeJson(50701, 1, 1, { seriesId: 507 })] },
      {
        path: '/api/episodes', // Bazarr subtitle-state pre-read
        body: {
          data: [
            {
              sonarrSeriesId: 507,
              sonarrEpisodeId: 50701,
              season: 1,
              episode: 1,
              title: 'Chapter 1',
              missing_subtitles: [MISSING_EN],
            },
          ],
        },
      },
      { method: 'PATCH', path: '/api/series', status: 204 }, // Bazarr search-missing
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const result = await api.fix.create({
      mediaItemId: item.id,
      targetChildId: 50701,
      reason: 'missing_subtitles',
    });
    expect(result.status).toBe('search_triggered');
    expect(result.pathTaken).toBe('bazarr_subtitle');
    expect(result.targetLabel).toBe('S01E01 · Episode 1');

    // The Bazarr series-level search fired with the right series id.
    const patch = stub.callsFor('PATCH', '/api/series');
    expect(patch).toHaveLength(1);
    expect(patch[0]!.url.searchParams.get('seriesid')).toBe('507');
    expect(patch[0]!.url.searchParams.get('action')).toBe('search-missing');
    // The ADR-007 destructive/re-grab surface was NEVER touched.
    expect(stub.callsFor('POST', '/api/v3/history/failed/')).toHaveLength(0);
    expect(stub.callsFor('POST', '/api/v3/command')).toHaveLength(0);
    expect(stub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

    const row = await fixRow(result.id);
    expect(row.pathTaken).toBe('bazarr_subtitle');
    const events = await eventsFor(item.id);
    expect(events.map((e) => e.eventType)).toEqual(['fix_requested', 'fix_actioned']);
  });

  it('radarr movie: fires PATCH /api/movies (radarrid); movie file untouched', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'radarr', { title: 'Subs Movie', arrItemId: 607 });
    const stub = stubArrBundle([
      {
        path: '/api/movies', // Bazarr subtitle-state pre-read
        body: { data: [{ radarrId: 607, title: 'Subs Movie', missing_subtitles: [MISSING_EN] }] },
      },
      { method: 'PATCH', path: '/api/movies', status: 204 }, // Bazarr search-missing
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const result = await api.fix.create({ mediaItemId: item.id, reason: 'missing_subtitles' });
    expect(result.pathTaken).toBe('bazarr_subtitle');
    expect(result.targetLabel).toBeNull();

    const patch = stub.callsFor('PATCH', '/api/movies');
    expect(patch).toHaveLength(1);
    expect(patch[0]!.url.searchParams.get('radarrid')).toBe('607');
    expect(patch[0]!.url.searchParams.get('action')).toBe('search-missing');
    expect(stub.callsFor('POST', '/api/v3/history/failed/')).toHaveLength(0);
    expect(stub.callsFor('POST', '/api/v3/command')).toHaveLength(0);
    expect(stub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });

  it('lidarr: missing_subtitles is unsupported → UNPROCESSABLE_CONTENT / SUBTITLE_FIX_UNSUPPORTED', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'lidarr', {
      title: 'Subs Artist',
      arrItemId: 707,
      rootFolder: '/data/media/music',
    });
    const stub = stubArrBundle([]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    const err = await api.fix
      .create({ mediaItemId: item.id, targetChildId: 71, reason: 'missing_subtitles' })
      .catch((e: unknown) => e);
    const shape = wireShape(err, 'fix.create');
    expect(shape.data.code).toBe('UNPROCESSABLE_CONTENT');
    expect(shape.data.appCode).toBe('SUBTITLE_FIX_UNSUPPORTED');
    expect(stub.calls).toHaveLength(0); // rejected before any *arr/Bazarr call, no orphan row

    const rows = await tdb.db
      .select({ id: schema.fixRequests.id })
      .from(schema.fixRequests)
      .where(eq(schema.fixRequests.mediaItemId, item.id));
    expect(rows).toHaveLength(0);
  });
});

describe('fix.myFixes / fix.adminList (R-46)', () => {
  it('members see exactly their own; admins see all with requester + raw actions', async () => {
    const member = await createUser(tdb.db);
    const admin = await createUser(tdb.db, { admin: true });
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

// PLAN-015 / ADR-028 — the live Action Progress Phase queries (fix.progress / fix.searchProgress).
describe('fix.progress / fix.searchProgress (PLAN-015 action feedback)', () => {
  const queuePage = (records: unknown[]) => ({
    page: 1,
    pageSize: 200,
    sortKey: 'timeleft',
    sortDirection: 'ascending',
    totalRecords: records.length,
    records,
  });
  const downloadingQueueRec = (episodeId: number, seriesId: number) => ({
    id: 1,
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    size: 1000,
    sizeleft: 100,
    seriesId,
    episodeId,
  });

  it('fix.progress derives downloading + pct against the live queue; own-fix vs admin auth', async () => {
    const member = await createUser(tdb.db);
    const other = await createUser(tdb.db);
    const admin = await createUser(tdb.db, { admin: true });
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Prog Show', arrItemId: 907 });
    const stub = stubArrBundle([
      { path: '/api/v3/episode', body: [episodeJson(90701, 1, 1, { seriesId: 907 })] },
      {
        path: '/api/v3/history',
        body: historyPage([
          grabHistoryJson(7701, '2026-07-01T10:00:00Z', { episodeId: 90701, seriesId: 907 }),
        ]),
      },
      { method: 'POST', path: /^\/api\/v3\/history\/failed\/\d+$/, body: {} },
      { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 1, name: 'EpisodeSearch' } },
      { path: '/api/v3/queue', body: queuePage([downloadingQueueRec(90701, 907)]) },
    ]);

    const memberApi = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));
    const created = await memberApi.fix.create({
      mediaItemId: item.id,
      targetChildId: 90701,
      reason: 'wrong_language',
    });

    // Owner sees the live phase.
    const progress = await memberApi.fix.progress({ fixRequestId: created.id });
    expect(progress.phase).toBe('downloading');
    expect(progress.progressPct).toBe(90);

    // Admin sees any fix.
    const adminApi = caller(makeCtx(tdb.db, sessionUser(admin), stub.bundle));
    await expect(adminApi.fix.progress({ fixRequestId: created.id })).resolves.toMatchObject({
      phase: 'downloading',
    });

    // Another member cannot (NOT_FOUND — no leak).
    const otherApi = caller(makeCtx(tdb.db, sessionUser(other), stub.bundle));
    const err = await otherApi.fix.progress({ fixRequestId: created.id }).catch((e: unknown) => e);
    expect(wireShape(err, 'fix.progress').data.code).toBe('NOT_FOUND');
  });

  it('fix.searchProgress derives the phase for a Force-Search target', async () => {
    const member = await createUser(tdb.db);
    const item = await seedMediaItem(tdb.db, 'sonarr', { title: 'Search Show', arrItemId: 908 });
    const stub = stubArrBundle([
      { path: '/api/v3/episode', body: [episodeJson(90801, 1, 1, { seriesId: 908 })] },
      { method: 'POST', path: '/api/v3/command', status: 201, body: { id: 1, name: 'EpisodeSearch' } },
      { path: '/api/v3/queue', body: queuePage([downloadingQueueRec(90801, 908)]) },
    ]);
    const api = caller(makeCtx(tdb.db, sessionUser(member), stub.bundle));

    await api.fix.forceSearch({ mediaItemId: item.id, scope: 'episode', targetChildId: 90801 });
    const progress = await api.fix.searchProgress({
      mediaItemId: item.id,
      scope: 'episode',
      targetChildId: 90801,
    });
    expect(progress.phase).toBe('downloading');
    expect(progress.progressPct).toBe(90);
  });
});
