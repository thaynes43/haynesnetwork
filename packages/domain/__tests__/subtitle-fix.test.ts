// ADR-016 / DESIGN-005 D-19 — Subtitle Fix (reason 'missing_subtitles') routes to Bazarr.
// Embedded PG16 + fetch-stubbed *arr/Bazarr bundle (ADR-010, no live APIs). Proves: the
// Bazarr search fires with the right id; the ADR-007 blocklist/delete/search paths are NEVER
// touched (the media file is untouched); the row lands path_taken='bazarr_subtitle' at
// search_triggered with fix_requested + fix_actioned events; a Bazarr failure fails closed;
// lidarr is unsupported (no orphan row); and completeFixRequests never spuriously completes
// a subtitle fix from an unrelated import.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { fixRequests, ledgerEvents, mediaItems } from '@hnet/db/schema';
import {
  ArrUpstreamError,
  SubtitleFixUnsupportedError,
  buildArrClientBundle,
  completeFixRequests,
  fixReasonsForKind,
  ingestLedgerEvents,
  runFixRequest,
  upsertMediaItemsBatch,
  type ArrClientBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

interface RecordedCall {
  method: string;
  host: string;
  pathname: string;
  search: URLSearchParams;
  body: unknown;
}

interface StubRoute {
  method?: string;
  host?: string; // match by URL host when kinds share paths
  path: string | RegExp;
  status?: number;
  body?: unknown | ((url: URL) => unknown);
}

function stubBundle(routes: StubRoute[]): { bundle: ArrClientBundle; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({
      method,
      host: url.host,
      pathname: url.pathname,
      search: url.searchParams,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const route = routes.find(
      (r) =>
        (r.method ?? 'GET') === method &&
        (r.host === undefined || r.host === url.host) &&
        (typeof r.path === 'string' ? url.pathname === r.path : r.path.test(url.pathname)),
    );
    if (!route) {
      return new Response(JSON.stringify({ message: `no stub for ${method} ${url.pathname}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = typeof route.body === 'function' ? route.body(url) : route.body;
    // 204/queued responses carry NO body (the Response ctor rejects a body on 204).
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const opts = { apiKey: 'test-key', retryDelayMs: 0, fetchImpl } as const;
  return {
    bundle: buildArrClientBundle({
      sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
      radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
      lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
      bazarr: { baseUrl: 'http://bazarr.test:6767', ...opts },
    }),
    calls,
  };
}

function episodeJson(id: number, seasonNumber: number, episodeNumber: number) {
  return {
    id,
    seriesId: 501,
    seasonNumber,
    episodeNumber,
    title: `Chapter ${episodeNumber}`,
    airDateUtc: '2021-03-02T01:00:00Z',
    hasFile: true,
    monitored: true,
    episodeFileId: id * 10,
  };
}

const MISSING_EN = { name: 'English', code2: 'en', forced: false, hi: false };

describe('runSubtitleFix — missing_subtitles routes to Bazarr (ADR-016 / D-19)', () => {
  let t: TestDb;
  let memberId: string;
  let sonarrItemId: string;
  let radarrItemId: string;
  let radarrFailItemId: string;
  let radarrCompleteItemId: string;
  let lidarrItemId: string;

  beforeAll(async () => {
    t = await bootMigratedDb();
    memberId = (await createUser(t.db, { email: 'subs@example.com' })).id;
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 501,
          tvdbId: 990001,
          title: 'Breaking Prod',
          sortTitle: 'breaking prod',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/tv',
        },
      ],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'radarr',
      items: [
        {
          arrItemId: 601,
          tmdbId: 880001,
          title: 'The Fixture',
          sortTitle: 'fixture',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/movies',
        },
        // Distinct movies so the three radarr subtitle tests don't collide on the
        // one-open-fix-per-target dedupe (radarr item scope, null child).
        {
          arrItemId: 602,
          tmdbId: 880002,
          title: 'The Fixture Two',
          sortTitle: 'fixture two',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/movies',
        },
        {
          arrItemId: 603,
          tmdbId: 880003,
          title: 'The Fixture Three',
          sortTitle: 'fixture three',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Any',
          rootFolder: '/movies',
        },
      ],
    });
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'lidarr',
      items: [
        {
          arrItemId: 701,
          musicbrainzArtistId: '11111111-2222-3333-4444-555555550701',
          title: 'The Stub Band',
          sortTitle: 'stub band',
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'Standard',
          rootFolder: '/music',
        },
      ],
    });
    const items = await t.db.select().from(mediaItems);
    sonarrItemId = items.find((i) => i.arrKind === 'sonarr')!.id;
    radarrItemId = items.find((i) => i.arrKind === 'radarr' && i.arrItemId === 601)!.id;
    radarrFailItemId = items.find((i) => i.arrKind === 'radarr' && i.arrItemId === 602)!.id;
    radarrCompleteItemId = items.find((i) => i.arrKind === 'radarr' && i.arrItemId === 603)!.id;
    lidarrItemId = items.find((i) => i.arrKind === 'lidarr')!.id;
  });

  afterAll(async () => {
    await t?.stop();
  });

  const eventTypesFor = async (mediaItemId: string) =>
    (
      await t.db
        .select({ eventType: ledgerEvents.eventType })
        .from(ledgerEvents)
        .where(eq(ledgerEvents.mediaItemId, mediaItemId))
        .orderBy(ledgerEvents.createdAt)
    ).map((e) => e.eventType);

  it('sonarr episode: triggers the series-level Bazarr search; no blocklist/delete/search', async () => {
    const stub = stubBundle([
      { host: 'sonarr.test:8989', path: '/api/v3/episode', body: [episodeJson(50102, 1, 2)] },
      {
        host: 'bazarr.test:6767',
        path: '/api/episodes',
        body: { data: [{ sonarrSeriesId: 501, sonarrEpisodeId: 50102, season: 1, episode: 2, title: 'Chapter 2', missing_subtitles: [MISSING_EN] }] },
      },
      { method: 'PATCH', host: 'bazarr.test:6767', path: '/api/series', status: 204 },
    ]);

    const result = await runFixRequest({
      db: t.db,
      arr: stub.bundle,
      requesterId: memberId,
      mediaItemId: sonarrItemId,
      targetChildId: 50102,
      reason: 'missing_subtitles',
    });
    expect(result.status).toBe('search_triggered');
    expect(result.pathTaken).toBe('bazarr_subtitle');
    expect(result.targetLabel).toBe('S01E02 · Chapter 2');

    // The Bazarr series-level search fired with the right series id.
    const patch = stub.calls.find((c) => c.method === 'PATCH' && c.pathname === '/api/series');
    expect(patch).toBeDefined();
    expect(patch!.search.get('seriesid')).toBe('501');
    expect(patch!.search.get('action')).toBe('search-missing');
    // The ADR-007 destructive/re-grab surface was NEVER touched (file untouched).
    expect(stub.calls.some((c) => c.pathname.includes('/history/failed/'))).toBe(false);
    expect(stub.calls.some((c) => c.pathname.includes('/episodefile/'))).toBe(false);
    expect(stub.calls.some((c) => c.method === 'POST' && c.pathname.endsWith('/command'))).toBe(false);

    const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, result.id));
    expect(row).toMatchObject({ status: 'search_triggered', pathTaken: 'bazarr_subtitle' });
    expect(row!.actionsTaken.map((a) => a.step)).toEqual([
      'created',
      'bazarr_subtitle_state',
      'bazarr_subtitle_search',
    ]);
    expect(row!.actionsTaken[1]).toMatchObject({ missingSubtitles: ['en'] });
    expect(await eventTypesFor(sonarrItemId)).toEqual(['fix_requested', 'fix_actioned']);
  });

  it('radarr movie: PATCH /api/movies with radarrid; movie file untouched', async () => {
    const stub = stubBundle([
      {
        host: 'bazarr.test:6767',
        path: '/api/movies',
        body: { data: [{ radarrId: 601, title: 'The Fixture', missing_subtitles: [MISSING_EN] }] },
      },
      { method: 'PATCH', host: 'bazarr.test:6767', path: '/api/movies', status: 204 },
    ]);

    const result = await runFixRequest({
      db: t.db,
      arr: stub.bundle,
      requesterId: memberId,
      mediaItemId: radarrItemId,
      reason: 'missing_subtitles',
    });
    expect(result.pathTaken).toBe('bazarr_subtitle');
    expect(result.targetLabel).toBeNull(); // radarr targets the movie itself

    const patch = stub.calls.find((c) => c.method === 'PATCH' && c.pathname === '/api/movies');
    expect(patch!.search.get('radarrid')).toBe('601');
    expect(patch!.search.get('action')).toBe('search-missing');
    expect(stub.calls.some((c) => c.pathname.includes('/moviefile/'))).toBe(false);
    expect(stub.calls.some((c) => c.pathname.includes('/history/movie'))).toBe(false);
    expect(stub.calls.some((c) => c.method === 'POST' && c.pathname.endsWith('/command'))).toBe(false);

    const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, result.id));
    expect(row!.pathTaken).toBe('bazarr_subtitle');
    expect(await eventTypesFor(radarrItemId)).toEqual(['fix_requested', 'fix_actioned']);
  });

  it('sonarr SEASON scope routes to Bazarr (NOT runSeasonFix — no blocklist/delete)', async () => {
    const seasonUser = (await createUser(t.db, { email: 'season-subs@example.com' })).id;
    const stub = stubBundle([
      { method: 'PATCH', host: 'bazarr.test:6767', path: '/api/series', status: 204 },
    ]);

    const result = await runFixRequest({
      db: t.db,
      arr: stub.bundle,
      requesterId: seasonUser,
      mediaItemId: sonarrItemId,
      scope: 'season',
      seasonNumber: 3,
      reason: 'missing_subtitles',
    });
    expect(result.pathTaken).toBe('bazarr_subtitle');
    expect(result.targetLabel).toBe('Season 3');

    const patch = stub.calls.find((c) => c.method === 'PATCH' && c.pathname === '/api/series');
    expect(patch!.search.get('seriesid')).toBe('501');
    // Season scope: no pre-read (no single target), and NONE of runSeasonFix's surface.
    expect(stub.calls.some((c) => c.pathname === '/api/episodes')).toBe(false);
    expect(stub.calls.some((c) => c.pathname.includes('/history'))).toBe(false);
    expect(stub.calls.some((c) => c.pathname.includes('/episodefile/'))).toBe(false);

    const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, result.id));
    expect(row).toMatchObject({ targetScope: 'season', targetSeason: 3, pathTaken: 'bazarr_subtitle' });
  });

  it('a Bazarr failure fails closed → failed + fix_failed + ArrUpstreamError', async () => {
    const failUser = (await createUser(t.db, { email: 'fail-subs@example.com' })).id;
    const stub = stubBundle([
      {
        host: 'bazarr.test:6767',
        path: '/api/movies',
        body: { data: [{ radarrId: 601, title: 'The Fixture', missing_subtitles: [MISSING_EN] }] },
      },
      { method: 'PATCH', host: 'bazarr.test:6767', path: '/api/movies', status: 500, body: { message: 'boom' } },
    ]);

    await expect(
      runFixRequest({
        db: t.db,
        arr: stub.bundle,
        requesterId: failUser,
        mediaItemId: radarrFailItemId,
        reason: 'missing_subtitles',
      }),
    ).rejects.toThrow(ArrUpstreamError);

    const [row] = await t.db
      .select()
      .from(fixRequests)
      .where(
        and(eq(fixRequests.mediaItemId, radarrFailItemId), eq(fixRequests.requesterId, failUser)),
      );
    expect(row!.status).toBe('failed');
    expect(row!.actionsTaken.some((a) => a.step === 'bazarr_subtitle_search' && a.ok === false)).toBe(true);
    const events = await t.db
      .select({ eventType: ledgerEvents.eventType })
      .from(ledgerEvents)
      .where(eq(ledgerEvents.mediaItemId, radarrFailItemId));
    expect(events.some((e) => e.eventType === 'fix_failed')).toBe(true);
    // No file/re-grab surface was touched.
    expect(stub.calls.some((c) => c.pathname.includes('/moviefile/'))).toBe(false);
  });

  it('lidarr + missing_subtitles → SubtitleFixUnsupportedError, and NO fix_requests row', async () => {
    const stub = stubBundle([]);
    await expect(
      runFixRequest({
        db: t.db,
        arr: stub.bundle,
        requesterId: memberId,
        mediaItemId: lidarrItemId,
        targetChildId: 71, // a valid album target so resolveFixTarget passes first
        reason: 'missing_subtitles',
      }),
    ).rejects.toThrow(SubtitleFixUnsupportedError);

    const rows = await t.db
      .select({ id: fixRequests.id })
      .from(fixRequests)
      .where(eq(fixRequests.mediaItemId, lidarrItemId));
    expect(rows).toHaveLength(0); // guarded before createFixRequest — no orphan pending row
    expect(stub.calls).toHaveLength(0); // rejected before any Bazarr/*arr call
  });

  it('completeFixRequests never completes a bazarr_subtitle fix from an unrelated import', async () => {
    const closer = (await createUser(t.db, { email: 'closer-subs@example.com' })).id;
    // A radarr movie subtitle fix has a NULL child — without the D-19 exclusion, ANY later
    // import on the movie would spuriously complete it.
    const stub = stubBundle([
      {
        host: 'bazarr.test:6767',
        path: '/api/movies',
        body: { data: [{ radarrId: 601, title: 'The Fixture', missing_subtitles: [MISSING_EN] }] },
      },
      { method: 'PATCH', host: 'bazarr.test:6767', path: '/api/movies', status: 204 },
    ]);
    const { id: fixId } = await runFixRequest({
      db: t.db,
      arr: stub.bundle,
      requesterId: closer,
      mediaItemId: radarrCompleteItemId,
      reason: 'missing_subtitles',
    });

    // A normal, unrelated re-grab import lands on the same movie afterwards.
    await ingestLedgerEvents({
      db: t.db,
      source: 'radarr',
      events: [
        {
          mediaItemId: radarrCompleteItemId,
          eventType: 'imported',
          source: 'radarr',
          sourceEventId: 'subs:unrelated-import',
          occurredAt: new Date(Date.now() + 120_000),
          payload: { rawEventType: 'downloadFolderImported', sourceTitle: 'The.Fixture.1080p' },
        },
      ],
    });

    const { completed } = await completeFixRequests({ db: t.db });
    expect(completed.some((c) => c.fixRequestId === fixId)).toBe(false);
    const [row] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, fixId));
    expect(row!.status).toBe('search_triggered'); // still resting — never auto-completes
  });
});

describe('fixReasonsForKind (ADR-016 / D-19 offer rule)', () => {
  it('sonarr/radarr include missing_subtitles; lidarr excludes it', () => {
    expect(fixReasonsForKind('sonarr')).toContain('missing_subtitles');
    expect(fixReasonsForKind('radarr')).toContain('missing_subtitles');
    expect(fixReasonsForKind('lidarr')).not.toContain('missing_subtitles');
    // The exclusion is the ONLY difference — five reasons for lidarr, six otherwise.
    expect(fixReasonsForKind('lidarr')).toHaveLength(5);
    expect(fixReasonsForKind('sonarr')).toHaveLength(6);
  });
});
