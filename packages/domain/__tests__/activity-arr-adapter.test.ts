import { describe, expect, it } from 'vitest';
import {
  buildArrActivity,
  parseArrActivityRef,
  type ArrActivitySources,
} from '../src/activity/arr-adapter';
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
