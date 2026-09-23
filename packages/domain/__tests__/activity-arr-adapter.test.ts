import { describe, expect, it } from 'vitest';
import {
  buildArrActivity,
  buildArrActivityAdapter,
  parseArrActivityRef,
  type ArrActivitySources,
} from '../src/activity/arr-adapter';
import { buildArrClientBundle } from '../src/arr-clients';
import type {
  LidarrHistoryRecord,
  LidarrQueueRecord,
  RadarrHistoryRecord,
  RadarrQueueRecord,
  SonarrQueueRecord,
} from '@hnet/arr';

// ADR-059 / DESIGN-030 D-08 (PLAN-048 — Activity / In-Flight) — the PURE *arr normalizer: the Radarr/Sonarr/
// Lidarr download queue + recent-import history → the shared Activity stage machine. The KEY *arr cases are
// the import_blocked strand (a completed download the importer refuses — the manual-import scenario) and the
// download_failed dead grab. Section is ALWAYS null (universal walls); the wall/id join keys are the fix
// targets the force-search + wall-badge dispatch read.

const NOW = new Date('2026-07-14T12:00:00Z');
const FRESH = '2026-07-14T11:55:00Z'; // 5 min before NOW → within the 15-min completed horizon
const STALE = '2026-07-14T11:00:00Z'; // 1h before NOW → past the horizon

const size = 1_000_000_000;

function radarrQueue(overrides: Partial<RadarrQueueRecord> & { movieId: number }): RadarrQueueRecord {
  return {
    id: overrides.id ?? overrides.movieId,
    status: overrides.status ?? 'downloading',
    trackedDownloadStatus: overrides.trackedDownloadStatus ?? 'ok',
    trackedDownloadState: overrides.trackedDownloadState ?? 'downloading',
    size: overrides.size ?? size,
    sizeleft: overrides.sizeleft ?? size / 2,
    title: overrides.title ?? `Movie.${overrides.movieId}.1080p.WEB-DL`,
    ...overrides,
  } as RadarrQueueRecord;
}
function sonarrQueue(overrides: Partial<SonarrQueueRecord> & { seriesId: number }): SonarrQueueRecord {
  return {
    id: overrides.id ?? overrides.seriesId,
    status: overrides.status ?? 'downloading',
    trackedDownloadStatus: overrides.trackedDownloadStatus ?? 'ok',
    trackedDownloadState: overrides.trackedDownloadState ?? 'downloading',
    size: overrides.size ?? size,
    sizeleft: overrides.sizeleft ?? size / 4,
    title: overrides.title ?? `Series.${overrides.seriesId}`,
    ...overrides,
  } as SonarrQueueRecord;
}
function lidarrQueue(overrides: Partial<LidarrQueueRecord> & { artistId: number }): LidarrQueueRecord {
  return {
    id: overrides.id ?? overrides.artistId,
    status: overrides.status ?? 'downloading',
    trackedDownloadStatus: overrides.trackedDownloadStatus ?? 'ok',
    trackedDownloadState: overrides.trackedDownloadState ?? 'downloading',
    size: overrides.size ?? size,
    sizeleft: overrides.sizeleft ?? 0,
    title: overrides.title ?? `Artist.${overrides.artistId}`,
    ...overrides,
  } as LidarrQueueRecord;
}

function empty(): ArrActivitySources {
  return {
    radarr: { queue: [], history: [] },
    sonarr: { queue: [], history: [] },
    lidarr: { queue: [], history: [] },
  };
}

function build(partial: Partial<ArrActivitySources>) {
  return buildArrActivity({ ...empty(), ...partial }, { now: NOW, completedHorizonMs: 15 * 60 * 1000 });
}

describe('buildArrActivity — the *arr queue/import stage machine', () => {
  it('maps a downloading movie to `downloading` with progress + radarr attribution, universal wall', () => {
    const items = build({
      radarr: {
        queue: [radarrQueue({ movieId: 601, size, sizeleft: size * 0.4, title: 'The.Fixture.2022.1080p' })],
        history: [],
      },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'arr:radarr:601',
      kind: 'movie',
      wall: 'movies',
      section: null,
      sourceApp: 'radarr',
      stage: 'downloading',
      progress: 60,
    });
    expect(items[0]!.actions).toEqual([]);
    expect(items[0]!.title).toBe('The Fixture 2022 1080p');
  });

  it('THE MANUAL-IMPORT CASE: an importBlocked movie → failed / import_blocked carrying the status message', () => {
    const items = build({
      radarr: {
        queue: [
          radarrQueue({
            movieId: 604,
            status: 'completed',
            trackedDownloadStatus: 'warning',
            trackedDownloadState: 'importBlocked',
            sizeleft: 0,
            statusMessages: [{ title: 'Blocked', messages: ['One or more episodes expected in this release were not imported'] }],
          }),
        ],
        history: [],
      },
    });
    const item = items[0]!;
    expect(item.stage).toBe('failed');
    expect(item.failureKind).toBe('import_blocked');
    expect(item.failureReason).toMatch(/not imported/i);
    // A blocked import is retry-import-able AND re-searchable.
    expect(item.actions).toEqual(['retry_import', 'force_research']);
  });

  it('maps a failed download to failed / download_failed (re-search only)', () => {
    const items = build({
      radarr: {
        queue: [radarrQueue({ movieId: 605, status: 'failed', trackedDownloadState: 'failed', errorMessage: 'Download client reported failure' })],
        history: [],
      },
    });
    const item = items[0]!;
    expect(item).toMatchObject({ stage: 'failed', failureKind: 'download_failed' });
    expect(item.failureReason).toMatch(/failure/i);
    expect(item.actions).toEqual(['force_research']); // a dead grab can't be retry-imported
  });

  it('maps an importing tv queue item to `importing` and encodes seriesId:episodeId', () => {
    const items = build({
      sonarr: {
        queue: [sonarrQueue({ seriesId: 501, episodeId: 50110, status: 'completed', trackedDownloadState: 'importPending', sizeleft: 0 })],
        history: [],
      },
    });
    expect(items[0]).toMatchObject({ id: 'arr:sonarr:501:50110', kind: 'tv', wall: 'tv', stage: 'importing' });
  });

  it('encodes lidarr artistId:albumId and skips an ignored queue item', () => {
    const items = build({
      lidarr: {
        queue: [
          lidarrQueue({ artistId: 701, albumId: 7011, status: 'downloading', sizeleft: size * 0.1 }),
          lidarrQueue({ artistId: 702, albumId: 7022, trackedDownloadState: 'ignored' }),
        ],
        history: [],
      },
    });
    const ids = items.map((i) => i.id);
    expect(ids).toContain('arr:lidarr:701:7011');
    expect(ids).not.toContain('arr:lidarr:702:7022'); // ignored → skipped
    expect(items.find((i) => i.id === 'arr:lidarr:701:7011')).toMatchObject({ kind: 'music', wall: 'music', progress: 90 });
  });

  it('surfaces a FRESH import from history as `completed`, and drops a STALE one', () => {
    const items = build({
      radarr: {
        queue: [],
        history: [
          { id: 1, eventType: 'downloadFolderImported', date: FRESH, movieId: 610, sourceTitle: 'Fresh.Import.2024' } as RadarrHistoryRecord,
          { id: 2, eventType: 'downloadFolderImported', date: STALE, movieId: 611, sourceTitle: 'Old.Import' } as RadarrHistoryRecord,
          { id: 3, eventType: 'grabbed', date: FRESH, movieId: 612, sourceTitle: 'Just.Grabbed' } as RadarrHistoryRecord,
        ],
      },
    });
    const completed = items.filter((i) => i.stage === 'completed');
    expect(completed.map((i) => i.id)).toEqual(['arr:radarr:610']);
  });

  it('lets a live queue item WIN over a same-parent history import (dedup by id)', () => {
    const items = build({
      radarr: {
        queue: [radarrQueue({ movieId: 620, status: 'completed', trackedDownloadState: 'importPending', sizeleft: 0 })],
        history: [
          { id: 9, eventType: 'movieFolderImported', date: FRESH, movieId: 620, sourceTitle: 'Same.Movie' } as RadarrHistoryRecord,
        ],
      },
    });
    const forId = items.filter((i) => i.id === 'arr:radarr:620');
    expect(forId).toHaveLength(1);
    expect(forId[0]!.stage).toBe('importing'); // the live queue stage, not the history completed
  });

  it('skips a queue record with no parent id (an unknown/removed item)', () => {
    const items = build({
      radarr: { queue: [radarrQueue({ movieId: undefined as unknown as number })], history: [] },
    });
    expect(items).toHaveLength(0);
  });

  it('folds a lidarr import from history (trackFileImported) keyed artistId:albumId', () => {
    const items = build({
      lidarr: {
        queue: [],
        history: [
          { id: 4, eventType: 'trackFileImported', date: FRESH, artistId: 701, albumId: 7011, sourceTitle: 'Album' } as LidarrHistoryRecord,
        ],
      },
    });
    expect(items[0]).toMatchObject({ id: 'arr:lidarr:701:7011', kind: 'music', stage: 'completed' });
  });

  it('threads the Admin-only downstream base URL per instance', () => {
    const items = buildArrActivity(
      { ...empty(), radarr: { queue: [radarrQueue({ movieId: 601 })], history: [] } },
      { now: NOW, baseUrls: { radarr: 'http://radarr.internal:7878' } },
    );
    expect(items[0]!.downstreamUrl).toBe('http://radarr.internal:7878');
  });
});

describe('parseArrActivityRef — the wall-join + force-search dispatch target', () => {
  it('parses a radarr ref (movie is the target)', () => {
    expect(parseArrActivityRef('arr:radarr:601')).toEqual({ arrKind: 'radarr', parentId: 601, targetId: null });
  });
  it('parses a sonarr ref (series parent + episode target)', () => {
    expect(parseArrActivityRef('arr:sonarr:501:50110')).toEqual({ arrKind: 'sonarr', parentId: 501, targetId: 50110 });
  });
  it('parses a lidarr ref with a missing child (:x)', () => {
    expect(parseArrActivityRef('arr:lidarr:701:x')).toEqual({ arrKind: 'lidarr', parentId: 701, targetId: null });
  });
  it('returns null for a non-*arr ref (a books ref)', () => {
    expect(parseArrActivityRef('books:ll:abc:ebook')).toBeNull();
    expect(parseArrActivityRef('arr:bogus:1')).toBeNull();
  });
});

// Issue #556 — the LIVE adapter (the `activity-scan` + `activity.list` read) over REAL *arr read clients: it
// must read each instance's WHOLE queue. It used the single-page `getQueue()` (200 records, unfiltered), so
// Sonarr's 212-item queue lost its tail and those failures flapped open/closed between scans.
describe('buildArrActivityAdapter — reads the WHOLE queue (issue #556)', () => {
  /** A paging `/queue` + empty `/history` *arr stub; honours the client's page/pageSize like the real API. */
  function stubArrHosts(queues: { sonarr: unknown[]; radarr: unknown[]; lidarr: unknown[] }) {
    const queueCalls: URL[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = new URL(String(input));
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 20);
      if (/\/api\/v[13]\/history$/.test(url.pathname)) {
        return json({ page, pageSize, sortKey: 'date', sortDirection: 'descending', totalRecords: 0, records: [] });
      }
      if (/\/api\/v[13]\/queue$/.test(url.pathname)) {
        queueCalls.push(url);
        const all = url.host.startsWith('sonarr') ? queues.sonarr : url.host.startsWith('radarr') ? queues.radarr : queues.lidarr;
        return json({
          page,
          pageSize,
          sortKey: 'timeleft',
          sortDirection: 'ascending',
          totalRecords: all.length,
          records: all.slice((page - 1) * pageSize, page * pageSize),
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const opts = { apiKey: 'test-api-key', retryDelayMs: 0, fetchImpl } as const;
    const bundle = buildArrClientBundle({
      sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
      radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
      lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
      bazarr: { baseUrl: 'http://bazarr.test:6767', ...opts },
    });
    return { read: bundle.read, queueCalls };
  }

  const blocked = (id: number, parent: Record<string, number>) => ({
    id,
    status: 'completed',
    trackedDownloadStatus: 'warning',
    trackedDownloadState: 'importBlocked',
    size: 1000,
    sizeleft: 0,
    title: `Blocked.Release.${id}`,
    statusMessages: [{ title: 'Blocked.Release', messages: ['Episode was not found in the grabbed release'] }],
    ...parent,
  });

  it("surfaces all 212 of Sonarr's import_blocked items (a single 200-record page dropped 12)", async () => {
    const sonarr = Array.from({ length: 212 }, (_, i) => blocked(i + 1, { seriesId: 1000 + i, episodeId: 50_000 + i }));
    const radarr = Array.from({ length: 10 }, (_, i) => blocked(900 + i, { movieId: 600 + i }));
    const stub = stubArrHosts({ sonarr, radarr, lidarr: [] });
    const items = await buildArrActivityAdapter(stub.read, { now: () => NOW }).list();

    const failed = items.filter((i) => i.stage === 'failed');
    expect(failed.filter((i) => i.sourceApp === 'sonarr')).toHaveLength(212);
    expect(failed.filter((i) => i.sourceApp === 'radarr')).toHaveLength(10);
    expect(failed.every((i) => i.failureKind === 'import_blocked')).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    // The whole-queue read: unfiltered, paged by the client (250/page), never the 200-record single page.
    for (const u of stub.queueCalls) {
      expect(u.searchParams.get('pageSize')).toBe('250');
      expect(['seriesIds', 'movieIds', 'artistIds'].some((k) => u.searchParams.has(k))).toBe(false);
    }
  });

  it('follows the pages past 250 until totalRecords', async () => {
    const sonarr = Array.from({ length: 530 }, (_, i) => blocked(i + 1, { seriesId: 1000 + i, episodeId: 50_000 + i }));
    const stub = stubArrHosts({ sonarr, radarr: [], lidarr: [] });
    const items = await buildArrActivityAdapter(stub.read, { now: () => NOW }).list();
    expect(items.filter((i) => i.sourceApp === 'sonarr' && i.stage === 'failed')).toHaveLength(530);
    const sonarrPages = stub.queueCalls.filter((u) => u.host.startsWith('sonarr')).map((u) => u.searchParams.get('page'));
    expect(sonarrPages).toEqual(['1', '2', '3']);
  });
});
