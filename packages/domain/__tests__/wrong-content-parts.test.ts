import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fixWriters from '../src/fix-requests';
import * as releasePicks from '../src/release-pick';
import { eq } from 'drizzle-orm';
import {
  fixRequests,
  watchCarries,
  ledgerEvents,
  mediaItems,
  plexLibraries,
  mediaPlexMatches,
  SEEDED_PLEX_SERVER_IDS,
} from '@hnet/db';
import {
  buildArrClientBundle,
  upsertMediaItemsBatch,
  setRepairGuideRemedies,
  planWrongContentReplace,
  runWrongContentReplace,
  planWrongContentPartResume,
  runWrongContentPartResume,
  planWrongContentRetry,
  runWrongContentRetry,
  completeFixRequests,
  ingestLedgerEvents,
  resetReleaseSearchState,
  deferredWrongContentFailures,
  planOwnedSonarrImport,
} from '../src/index';
import { readWrongContentPartSelection, selectedPartBindings } from '../src/wrong-content-parts';
import { bootMigratedDb, type TestDb } from './helpers';
import { fakePlex } from './fake-plex-carry';
import { partHash } from '../src/wrong-content-parts';
import { historyRecordToLedgerEvent } from '../../sync/src/normalize';
import {
  ARR_QUEUE_CLEANUP_CONFIG_DEFAULT,
  evaluateQueueCleanup,
  type QueueCleanupInstanceClient,
  type QueueCleanupQueueItem,
} from '../src/queue-cleanup';
const quality = {
  quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 },
  revision: { version: 1, real: 0, isRepack: false },
};
const titles = ['Alpha Run', 'Bravo Night', 'Charlie Comes Home', 'Delta Force Five'];
const source = (guid: string, numbers: number[]) => ({
  guid,
  indexerId: 1,
  indexer: 'test',
  title: `Show.S01E${numbers.map((n) => String(n).padStart(2, '0')).join('E')}.${numbers.map((n) => titles[n - 1]!.replaceAll(' ', '.')).join('.')}.1080p.WEB-DL-GRP`,
  size: 600000000,
  quality,
  releaseGroup: 'GRP',
  approved: true,
  temporarilyRejected: false,
  rejected: false,
  rejections: [],
  customFormatScore: 0,
  languages: [{ id: 1, name: 'English' }],
  protocol: 'usenet',
  ageHours: 1,
  seasonNumber: 1,
  mappedSeasonNumber: 1,
  episodeNumbers: numbers,
  mappedEpisodeNumbers: numbers,
  fullSeason: false,
  downloadAllowed: true,
});
function world() {
  const episodes = titles.map((title, i) => ({
    id: 401 + i,
    seriesId: 439,
    seasonNumber: 1,
    episodeNumber: i + 1,
    title,
    monitored: true,
    hasFile: true,
    episodeFileId: 123,
  }));
  const files = [
    {
      id: 123,
      seriesId: 439,
      seasonNumber: 1,
      relativePath: 'Season 1/wrong.mkv',
      sceneName: 'Wrong.Show.S03E01.Other.Story',
      size: 1377201632,
      quality,
    },
  ];
  const state = {
    episodes,
    files,
    history: [] as Array<{
      id: number;
      seriesId: number;
      episodeId: number;
      eventType: string;
      date: string;
      sourceTitle: string;
      downloadId: string;
      data: Record<string, string>;
    }>,
    releases: [source('one', [1, 2]), source('two', [3, 4])],
    calls: [] as Array<{ guid: string; episodeIds: number[] }>,
    deletes: [] as number[],
    queue: [] as Array<Record<string, unknown>>,
    removals: [] as Array<{ id: number; options: Record<string, string> }>,
    mode: 'normal' as 'normal' | '503' | 'unknown',
    failGuid: 'two',
    foreign: false,
    removeUnknown: false,
    candidates: [] as Array<Record<string, unknown>>,
  };
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const series = JSON.parse(
    readFileSync(
      new URL('../../arr/__fixtures__/sonarr.series-byid.json', import.meta.url),
      'utf8',
    ),
  );
  const fetchImpl = async (input: unknown, init: RequestInit = {}) => {
    const u = new URL(String(input)),
      method = init.method ?? 'GET',
      body = init.body ? JSON.parse(String(init.body)) : null;
    if (method === 'GET' && u.pathname.endsWith('/manualimport')) return json(state.candidates);
    if (method === 'GET' && u.pathname.endsWith('/command')) return json([]);
    if (method === 'GET' && u.pathname.endsWith('/episode')) return json(state.episodes);
    if (method === 'GET' && u.pathname.endsWith('/episodefile')) return json(state.files);
    if (method === 'GET' && u.pathname.endsWith('/series/439'))
      return json({ ...series, id: 439, title: 'Show', path: '/data/tv/Show', year: 2020 });
    if (method === 'GET' && u.pathname.endsWith('/queue'))
      return json({
        page: 1,
        pageSize: 200,
        totalRecords: state.queue.length,
        records: state.queue,
      });
    if (method === 'GET' && u.pathname.endsWith('/history'))
      return json({
        page: 1,
        pageSize: 200,
        totalRecords: state.history.length,
        records: state.history.slice(-200),
      });
    if (method === 'GET' && u.pathname.endsWith('/history/series')) return json(state.history);
    if (method === 'GET' && u.pathname.endsWith('/release')) return json(state.releases);
    if (method === 'DELETE' && u.pathname.includes('/episodefile/')) {
      const id = Number(u.pathname.split('/').at(-1));
      state.deletes.push(id);
      state.files.splice(
        state.files.findIndex((f) => f.id === id),
        1,
      );
      for (const e of state.episodes)
        if (e.episodeFileId === id) {
          e.hasFile = false;
          e.episodeFileId = 0;
        }
      return new Response(null, { status: 200 });
    }
    if (method === 'DELETE' && u.pathname.includes('/queue/')) {
      state.removals.push({
        id: Number(u.pathname.split('/').at(-1)),
        options: Object.fromEntries(u.searchParams),
      });
      state.queue = [];
      return state.removeUnknown
        ? json({ message: 'unknown removal' }, 503)
        : new Response(null, { status: 200 });
    }
    if (method === 'POST' && u.pathname.endsWith('/release')) {
      state.calls.push(body);
      const offer = state.releases.find((r) => r.guid === body.guid)!;
      if (state.mode !== 'unknown' || body.guid !== state.failGuid)
        for (const id of body.episodeIds)
          state.history.push({
            id: 1000 + state.history.length,
            seriesId: 439,
            episodeId: id,
            eventType: 'grabbed',
            date: new Date().toISOString(),
            sourceTitle: offer.title,
            downloadId: `dl-${body.guid}-${state.calls.length}`,
            data: {},
          });
      return json(body, state.mode !== 'normal' && body.guid === state.failGuid ? 503 : 200);
    }
    return json({ message: 'unhandled stub' }, 404);
  };
  const options = { apiKey: 'test', fetchImpl: fetchImpl as typeof fetch, retryDelayMs: 0 };
  const arr = buildArrClientBundle({
    sonarr: { ...options, baseUrl: 'http://sonarr.test' },
    radarr: { ...options, baseUrl: 'http://radarr.test' },
    lidarr: { ...options, baseUrl: 'http://lidarr.test' },
    bazarr: { ...options, baseUrl: 'http://bazarr.test' },
  });
  const plex = fakePlex({
    accounts: ['9000'],
    files: () =>
      state.files.map((f) => ({
        id: f.id,
        name: f.relativePath,
        size: f.size,
        season: 1,
        episodes: state.episodes
          .filter((e) => e.episodeFileId === f.id)
          .map((e) => e.episodeNumber),
      })),
  });
  const importPair = (downloadId: string, numbers: number[], fileId: number) => {
    const grab = state.history.find((h) => h.downloadId === downloadId)!;
    state.files.push({
      id: fileId,
      seriesId: 439,
      seasonNumber: 1,
      relativePath: `Season 1/part-${fileId}.mkv`,
      sceneName: grab.sourceTitle,
      size: 600000000,
      quality,
    });
    for (const n of numbers) {
      const e = state.episodes[n - 1]!;
      e.episodeFileId = fileId;
      e.hasFile = true;
      state.history.push({
        id: 1000 + state.history.length,
        seriesId: 439,
        episodeId: e.id,
        eventType: 'downloadFolderImported',
        date: new Date().toISOString(),
        sourceTitle: grab.sourceTitle,
        downloadId,
        data: { fileId: String(fileId) },
      });
    }
  };
  const fail = (downloadId: string) => {
    const grabs = state.history.filter(
      (h) => h.downloadId === downloadId && h.eventType === 'grabbed',
    );
    for (const grab of grabs)
      state.history.push({
        ...grab,
        id: 1000 + state.history.length,
        eventType: 'downloadFailed',
        date: new Date().toISOString(),
        data: { message: 'Duplicate NZB' },
      });
  };
  return { state, arr, plex: plex.plex, importPair, fail };
}
describe('multipart original-parent recovery', () => {
  let t: TestDb, itemId: string;
  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [
        {
          arrItemId: 439,
          tvdbId: 100,
          title: 'Show',
          sortTitle: 'show',
          year: 2020,
          monitored: true,
          qualityProfileId: 1,
          qualityProfileName: 'test',
          rootFolder: '/data/tv',
        },
      ],
    });
    const [item] = await t.db.select().from(mediaItems).where(eq(mediaItems.arrItemId, 439));
    itemId = item!.id;
    const [lib] = await t.db
      .insert(plexLibraries)
      .values({
        serverId: SEEDED_PLEX_SERVER_IDS.haynestower,
        sectionKey: '4',
        name: 'test TV',
        mediaType: 'show',
        available: true,
      })
      .returning();
    await t.db.insert(mediaPlexMatches).values({
      mediaItemId: itemId,
      plexLibraryId: lib!.id,
      ratingKey: 'show-1',
      matchedVia: 'tvdb',
    });
  }, 240000);
  afterAll(async () => t.stop());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  beforeEach(async () => {
    resetReleaseSearchState();
    await t.db.delete(watchCarries);
    await t.db.delete(ledgerEvents);
    await t.db.delete(fixRequests);
    await setRepairGuideRemedies({
      db: t.db,
      actorId: null,
      remedies: { release_pick: true, episode_remap: true },
    });
  });
  async function start(w: ReturnType<typeof world>) {
    const input = { db: t.db, arr: w.arr, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 1 };
    const plan = await planWrongContentReplace(input);
    return runWrongContentReplace({
      ...input,
      planDigest: plan.digest,
      keys: plan.candidates.filter((p) => !p.whole).map((p) => p.key),
      evidence: 'Physical title cards prove the original is another story.',
      watchCarry: w.plex,
      carryPauseMs: 0,
    });
  }
  async function ingest(w: ReturnType<typeof world>) {
    const events = w.state.history
      .filter((h) => h.eventType === 'downloadFolderImported')
      .map((h) =>
        historyRecordToLedgerEvent(h as Parameters<typeof historyRecordToLedgerEvent>[0], {
          arrKind: 'sonarr',
          arrInstanceId: 'main',
          mediaItemId: itemId,
        }),
      );
    await ingestLedgerEvents({
      db: t.db,
      source: 'sonarr',
      events: events.filter((e): e is NonNullable<typeof e> => e !== null),
    });
    return completeFixRequests({ db: t.db });
  }
  const staff = { kind: 'staff' as const },
    evidence = 'Actual title cards and English were independently verified.';
  it('refuses multiple offers without a Watch Carry adapter before creating or deleting anything', async () => {
    const w = world();
    const input = { db: t.db, arr: w.arr, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 1 };
    const plan = await planWrongContentReplace(input);
    await expect(
      runWrongContentReplace({
        ...input,
        planDigest: plan.digest,
        keys: plan.candidates.filter((p) => !p.whole).map((p) => p.key),
        evidence,
      }),
    ).rejects.toThrow('No Plex adapter is available');
    expect(w.state.deletes).toEqual([]);
    expect(w.state.calls).toEqual([]);
    expect(await t.db.select().from(fixRequests)).toEqual([]);
    expect(await t.db.select().from(watchCarries)).toEqual([]);
  });
  it('deletes one shared original once, claims both pairs, and normally completes only after all four actual imports', async () => {
    const w = world(),
      r = await start(w);
    expect(w.state.deletes).toEqual([123]);
    expect(w.state.calls.map((c) => c.episodeIds)).toEqual([
      [401, 402],
      [403, 404],
    ]);
    const [carry] = await t.db.select().from(watchCarries);
    const selection = readWrongContentPartSelection(carry!.detail)!;
    expect(selection.parts).toHaveLength(2);
    w.importPair('dl-one-1', [1, 2], 801);
    expect((await ingest(w)).completed).toEqual([]);
    w.importPair('dl-two-2', [3, 4], 802);
    expect((await ingest(w)).completed[0]?.fixRequestId).toBe(r.fixRequestId);
  });
  it('leaves a failed pre-call target lookup unclaimed and resumes the original part without another deletion', async () => {
    const w = world();
    const original = releasePicks.readReleasePickTarget;
    const lookup = vi
      .spyOn(releasePicks, 'readReleasePickTarget')
      .mockImplementation(async (input) => {
        if (w.state.deletes.length) throw new Error('target lookup unavailable');
        return original(input);
      });
    await expect(start(w)).rejects.toThrow('target lookup unavailable');
    const [fix] = await t.db.select().from(fixRequests);
    expect(fix!.status).toBe('actioned');
    expect(fix!.actionsTaken.some((a) => a.step === 'wrong_content_part_grab_intent')).toBe(false);
    expect(w.state.calls).toEqual([]);
    expect(w.state.deletes).toEqual([123]);
    lookup.mockRestore();
    const [carry] = await t.db.select().from(watchCarries);
    const part = readWrongContentPartSelection(carry!.detail)!.parts[0]!;
    const input = { db: t.db, arr: w.arr, actor: staff, fixRequestId: fix!.id, partId: part.id };
    const p = await planWrongContentPartResume(input);
    expect(p.state).toBe('ready');
    await runWrongContentPartResume({ ...input, digest: p.digest, evidence });
    expect(w.state.calls).toHaveLength(1);
    expect(w.state.deletes).toEqual([123]);
  });
  it('holds only the exact owned multipart GUID, series and title before enforced queue removal', async () => {
    const w = world();
    await start(w);
    const title = w.state.history.find((h) => h.downloadId === 'dl-two-2')!.sourceTitle;
    const owned: QueueCleanupQueueItem = {
      queueItemId: 991,
      downloadId: 'dl-two-2',
      parentId: 439,
      title,
      targetId: 403,
      addedAt: null,
      status: 'failed',
      trackedDownloadStatus: 'error',
      trackedDownloadState: 'failed',
      errorMessage: 'Unpacking failed',
      statusMessages: null,
    };
    const items = [
      owned,
      { ...owned, queueItemId: 992, title: 'another release' },
      { ...owned, queueItemId: 993, parentId: 440 },
      { ...owned, queueItemId: 994, downloadId: 'foreign' },
    ];
    const deleted: number[] = [];
    const client = (records: QueueCleanupQueueItem[]): QueueCleanupInstanceClient => ({
      async getQueueAll() {
        return records;
      },
      async deleteQueueItem(item) {
        deleted.push(item.queueItemId);
      },
      async processMonitoredDownloads() {
        throw new Error('no retry');
      },
      async monitoredTargets() {
        return [];
      },
      async searchTargets() {
        throw new Error('no search');
      },
    });
    const config = structuredClone(ARR_QUEUE_CLEANUP_CONFIG_DEFAULT);
    config.minItemAgeHours = 0;
    config.modes.sonarr.bad_release = 'enforce';
    // GUID grouping keeps foreign identity records in separate runs, mirroring one real native download per GUID.
    for (const item of items)
      await evaluateQueueCleanup({
        db: t.db,
        clients: { sonarr: client([item]), radarr: client([]), lidarr: client([]) },
        config,
      });
    expect(deleted).toEqual([992, 993, 994]);
    expect(w.state.deletes).toEqual([123]);
    expect(w.state.calls).toHaveLength(2);
  });
  it.each(['503', 'unknown'] as const)(
    'keeps a post-delete %s call open and never replays its claimed original part',
    async (mode) => {
      const w = world();
      w.state.mode = mode;
      const r = await start(w);
      expect(r.waiting).toBe(true);
      const [fix] = await t.db.select().from(fixRequests);
      expect(fix!.status).toBe('search_triggered');
      const [carry] = await t.db.select().from(watchCarries);
      const part = readWrongContentPartSelection(carry!.detail)!.parts[1]!;
      const input = {
        db: t.db,
        arr: w.arr,
        actor: staff,
        fixRequestId: r.fixRequestId,
        partId: part.id,
      };
      const p = await planWrongContentPartResume(input);
      expect(p.state).toBe('observe');
      await runWrongContentPartResume({ ...input, digest: p.digest, evidence });
      expect(w.state.calls).toHaveLength(2);
      expect(w.state.deletes).toEqual([123]);
    },
  );
  it('adopts a genuine first-pair native import, retries only the failed later pair, and preserves the original full obligation', async () => {
    const w = world(),
      r = await start(w);
    w.importPair('dl-one-1', [1, 2], 801);
    w.fail('dl-two-2');
    const [carry] = await t.db.select().from(watchCarries),
      parts = readWrongContentPartSelection(carry!.detail)!.parts;
    const adopt = {
      db: t.db,
      arr: w.arr,
      actor: staff,
      fixRequestId: r.fixRequestId,
      partId: parts[0]!.id,
    };
    const ap = await planWrongContentPartResume(adopt);
    expect(ap.state).toBe('adopt');
    await runWrongContentPartResume({ ...adopt, digest: ap.digest, evidence });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 3000));
    w.state.releases = [source('replacement', [3, 4])];
    resetReleaseSearchState();
    const input = {
      db: t.db,
      arr: w.arr,
      actor: staff,
      fixRequestId: r.fixRequestId,
      failedDownloadId: 'dl-two-2',
    };
    const p = await planWrongContentRetry(input);
    expect(p.targetEpisodeIds).toEqual([403, 404]);
    await runWrongContentRetry({ ...input, key: p.candidates[0]!.key, digest: p.digest, evidence });
    expect(w.state.calls.at(-1)?.episodeIds).toEqual([403, 404]);
    expect(w.state.episodes[0]!.episodeFileId).toBe(801);
    expect(w.state.deletes).toEqual([123]);
    w.importPair('dl-replacement-3', [3, 4], 802);
    expect((await ingest(w)).completed[0]?.fixRequestId).toBe(r.fixRequestId);
  });
  it('refuses a foreign occupied other part and a stale imported-file boundary before retry', async () => {
    const w = world(),
      r = await start(w);
    w.fail('dl-two-2');
    w.state.episodes[0]!.episodeFileId = 123;
    w.state.episodes[0]!.hasFile = true;
    await expect(
      planWrongContentRetry({
        db: t.db,
        arr: w.arr,
        actor: staff,
        fixRequestId: r.fixRequestId,
        failedDownloadId: 'dl-two-2',
      }),
    ).rejects.toThrow();
    expect(w.state.calls).toHaveLength(2);
  });
  it('holds only positive owned failures and does not claim a same-title foreign GUID', async () => {
    const w = world(),
      r = await start(w);
    const title = w.state.history.find((h) => h.downloadId === 'dl-two-2')!.sourceTitle;
    const held = await deferredWrongContentFailures({
      db: t.db,
      failures: [
        { downloadId: 'dl-two-2', parentId: 439, title, failedAt: new Date() },
        { downloadId: 'foreign', parentId: 439, title, failedAt: new Date() },
      ],
    });
    expect(held.has('dl-two-2\u0000439')).toBe(true);
    expect(held.has('foreign\u0000439')).toBe(false);
    expect(r.fixRequestId).toBeTruthy();
  });
  it('resumes one positively unclaimed original part once after a bound 503 on the first part', async () => {
    const w = world();
    w.state.mode = '503';
    w.state.failGuid = 'one';
    const r = await start(w);
    const [carry] = await t.db.select().from(watchCarries);
    const part = readWrongContentPartSelection(carry!.detail)!.parts[1]!;
    const input = {
      db: t.db,
      arr: w.arr,
      actor: staff,
      fixRequestId: r.fixRequestId,
      partId: part.id,
    };
    const p = await planWrongContentPartResume(input);
    expect(p.state).toBe('ready');
    const results = await Promise.allSettled([
      runWrongContentPartResume({ ...input, digest: p.digest, evidence }),
      runWrongContentPartResume({ ...input, digest: p.digest, evidence }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(w.state.calls.filter((c) => c.guid === 'two')).toHaveLength(1);
    expect(w.state.deletes).toEqual([123]);
  });
  it('an unknown first transport blocks even a disjoint never-claimed second part', async () => {
    const w = world();
    w.state.mode = 'unknown';
    w.state.failGuid = 'one';
    const r = await start(w);
    const [carry] = await t.db.select().from(watchCarries);
    const part = readWrongContentPartSelection(carry!.detail)!.parts[1]!;
    await expect(
      planWrongContentPartResume({
        db: t.db,
        arr: w.arr,
        actor: staff,
        fixRequestId: r.fixRequestId,
        partId: part.id,
      }),
    ).rejects.toThrow();
    expect(w.state.calls).toHaveLength(1);
  });
  it('lost actual call facts leave the durable claim observe-only despite native history', async () => {
    const w = world(),
      real = fixWriters.appendFixActions;
    vi.spyOn(fixWriters, 'appendFixActions').mockImplementation(async (input) => {
      if (input.actions.some((a) => a.step === 'wrong_content_part_call_result'))
        throw new Error('test call-fact outage');
      return real(input);
    });
    await expect(start(w)).rejects.toThrow('test call-fact outage');
    vi.restoreAllMocks();
    const [fix] = await t.db.select().from(fixRequests),
      [carry] = await t.db.select().from(watchCarries),
      part = readWrongContentPartSelection(carry!.detail)!.parts[0]!;
    const input = { db: t.db, arr: w.arr, actor: staff, fixRequestId: fix!.id, partId: part.id },
      p = await planWrongContentPartResume(input);
    expect(p.state).toBe('observe');
    await runWrongContentPartResume({ ...input, digest: p.digest, evidence });
    expect(w.state.calls).toHaveLength(1);
  });
  it('a stale protected empty neighbor refuses before dispatch and never relaxes the original boundary', async () => {
    const w = world();
    w.state.mode = '503';
    w.state.failGuid = 'one';
    w.state.episodes.push({
      id: 900,
      seriesId: 439,
      seasonNumber: 2,
      episodeNumber: 1,
      title: 'Protected',
      monitored: true,
      hasFile: false,
      episodeFileId: 0,
    });
    const r = await start(w);
    const [carry] = await t.db.select().from(watchCarries),
      part = readWrongContentPartSelection(carry!.detail)!.parts[1]!;
    w.state.episodes.at(-1)!.hasFile = true;
    w.state.episodes.at(-1)!.episodeFileId = 999;
    await expect(
      planWrongContentPartResume({
        db: t.db,
        arr: w.arr,
        actor: staff,
        fixRequestId: r.fixRequestId,
        partId: part.id,
      }),
    ).rejects.toThrow();
    expect(w.state.calls).toHaveLength(1);
  });
  it('late older receipts cannot regress a newer part attempt and an unknown GUID cannot identify a failed part', async () => {
    const w = world(),
      r = await start(w);
    w.fail('dl-two-2');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 3000));
    w.state.releases = [source('replacement', [3, 4])];
    const input = {
        db: t.db,
        arr: w.arr,
        actor: staff,
        fixRequestId: r.fixRequestId,
        failedDownloadId: 'dl-two-2',
      },
      p = await planWrongContentRetry(input);
    await runWrongContentRetry({ ...input, key: p.candidates[0]!.key, digest: p.digest, evidence });
    const [fix] = await t.db.select().from(fixRequests),
      [carry] = await t.db.select().from(watchCarries);
    await fixWriters.appendFixActions({
      db: t.db,
      fixRequestId: r.fixRequestId,
      actions: [
        {
          step: 'release_grab',
          ok: true,
          at: new Date().toISOString(),
          release: w.state.history.find((h) => h.downloadId === 'dl-two-2')!.sourceTitle,
        },
      ],
    });
    const [later] = await t.db.select().from(fixRequests);
    const bindings = selectedPartBindings(
      readWrongContentPartSelection(carry!.detail)!,
      later!.actionsTaken,
    );
    expect([...bindings.latest.values()].some((b) => b.downloadId === 'dl-replacement-3')).toBe(
      true,
    );
    expect(fix!.status).toBe('search_triggered');
    await expect(
      planWrongContentRetry({ ...input, failedDownloadId: 'foreign' }),
    ).rejects.toThrow();
  });
  it('an immutable native import audit cannot admit changed current bytes', async () => {
    const w = world(),
      r = await start(w);
    w.importPair('dl-one-1', [1, 2], 801);
    const [carry] = await t.db.select().from(watchCarries),
      part = readWrongContentPartSelection(carry!.detail)!.parts[0]!;
    const input = {
        db: t.db,
        arr: w.arr,
        actor: staff,
        fixRequestId: r.fixRequestId,
        partId: part.id,
      },
      p = await planWrongContentPartResume(input);
    await runWrongContentPartResume({ ...input, digest: p.digest, evidence });
    w.state.files.find((f) => f.id === 801)!.size++;
    w.fail('dl-two-2');
    await expect(
      planWrongContentRetry({
        db: t.db,
        arr: w.arr,
        actor: staff,
        fixRequestId: r.fixRequestId,
        failedDownloadId: 'dl-two-2',
      }),
    ).rejects.toThrow();
  });
  it('a malformed overlapping canonical selection refuses rather than inferring missing legacy intent', async () => {
    const w = world(),
      r = await start(w);
    const [carry] = await t.db.select().from(watchCarries),
      selection = readWrongContentPartSelection(carry!.detail)!;
    selection.parts[1]!.episodeIds = [401, 402];
    const { digest: _, ...base } = selection;
    selection.digest = partHash(base);
    await t.db
      .update(watchCarries)
      .set({ detail: { ...carry!.detail, wrongContentSelection: selection } })
      .where(eq(watchCarries.id, carry!.id));
    await expect(
      planWrongContentPartResume({
        db: t.db,
        arr: w.arr,
        actor: staff,
        fixRequestId: r.fixRequestId,
        partId: selection.parts[0]!.id,
      }),
    ).rejects.toThrow();
    expect(w.state.calls).toHaveLength(2);
  });

  it.each([false, true])(
    'removes only an owned failed queue GUID without client deletion/search and observes uncertainty=%s',
    async (uncertain) => {
      const w = world(),
        r = await start(w);
      w.fail('dl-two-2');
      const title = w.state.history.find((h) => h.downloadId === 'dl-two-2')!.sourceTitle;
      w.state.queue = [
        { id: 991, seriesId: 439, episodeId: 403, title, downloadId: 'dl-two-2', status: 'failed' },
      ];
      w.state.removeUnknown = uncertain;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() + 3000));
      w.state.releases = [source('replacement', [3, 4])];
      const input = {
          db: t.db,
          arr: w.arr,
          actor: staff,
          fixRequestId: r.fixRequestId,
          failedDownloadId: 'dl-two-2',
        },
        p = await planWrongContentRetry(input);
      expect(p.failedQueue).toMatchObject({
        downloadId: 'dl-two-2',
        queueItemIds: [991],
        options: { blocklist: false, removeFromClient: false, skipRedownload: true },
      });
      const result = await runWrongContentRetry({
        ...input,
        digest: p.digest,
        key: p.candidates[0]!.key,
        evidence,
      });
      expect(w.state.removals).toEqual([
        {
          id: 991,
          options: { removeFromClient: 'false', blocklist: 'false', skipRedownload: 'true' },
        },
      ]);
      expect(w.state.deletes).toEqual([123]);
      expect(w.state.calls).toHaveLength(uncertain ? 2 : 3);
      if (uncertain) {
        expect(result.outcome).toBe('observe');
        const again = await planWrongContentRetry(input);
        await runWrongContentRetry({
          ...input,
          digest: again.digest,
          key: p.candidates[0]!.key,
          evidence,
        });
        expect(w.state.removals).toHaveLength(1);
        expect(w.state.calls).toHaveLength(2);
        const [fix] = await t.db.select().from(fixRequests);
        expect(
          fix!.actionsTaken.some(
            (a) =>
              a.step === 'wrong_content_part_remove_read_back' &&
              a.observationOnly === true &&
              a.commandOutcome === 'unknown' &&
              a.queueAbsent === true,
          ),
        ).toBe(true);
      }
    },
  );
  it('excludes a same-title foreign failure outside an uncertain returned call window without holding unrelated failures', async () => {
    const w = world();
    w.state.mode = 'unknown';
    const r = await start(w);
    const [fix] = await t.db.select().from(fixRequests),
      [heldCarry] = await t.db.select().from(watchCarries);
    const call = fix!.actionsTaken.find(
      (a) =>
        a.step === 'wrong_content_part_call_result' &&
        a.partId === readWrongContentPartSelection(heldCarry!.detail)!.parts[1]!.id,
    )!;
    const date = new Date(Date.parse(String(call.finishedAt)) + 1000).toISOString(),
      title = String(call.title);
    const held = await deferredWrongContentFailures({
      db: t.db,
      failures: [
        {
          downloadId: 'later-foreign',
          parentId: 439,
          title,
          failedAt: new Date(Date.parse(date) + 1000),
          grabbedHistory: { id: 999, downloadId: 'later-foreign', title, date },
        },
        { downloadId: 'unrelated', parentId: 123, title: 'Another show', failedAt: new Date() },
      ],
    });
    expect(held.size).toBe(0);
    expect(r.fixRequestId).toBeTruthy();
  });
  it('a missing legacy intent never proves an original part was not dispatched', async () => {
    const w = world(),
      r = await start(w);
    const [carry] = await t.db.select().from(watchCarries),
      selection = readWrongContentPartSelection(carry!.detail)!;
    const detail = { ...carry!.detail };
    delete detail.wrongContentSelection;
    await t.db.update(watchCarries).set({ detail }).where(eq(watchCarries.id, carry!.id));
    await expect(
      planWrongContentPartResume({
        db: t.db,
        arr: w.arr,
        actor: staff,
        fixRequestId: r.fixRequestId,
        partId: selection.parts[1]!.id,
      }),
    ).rejects.toThrow();
    expect(w.state.calls).toHaveLength(2);
  });
  it('owned import derives one exact selected pair and refuses same-title foreign native GUIDs', async () => {
    const w = world(),
      r = await start(w),
      title = w.state.history.find((h) => h.downloadId === 'dl-two-2')!.sourceTitle;
    w.state.queue = [
      {
        id: 992,
        seriesId: 439,
        episodeId: 403,
        title,
        downloadId: 'dl-two-2',
        status: 'completed',
      },
      {
        id: 993,
        seriesId: 439,
        episodeId: 404,
        title,
        downloadId: 'dl-two-2',
        status: 'completed',
      },
    ];
    w.state.candidates = [
      {
        id: 10,
        path: `/downloads/${title}.mkv`,
        relativePath: `${title}.mkv`,
        size: 600000000,
        series: { id: 439, title: 'Show', year: 2020 },
        seasonNumber: 1,
        episodes: w.state.episodes.slice(2),
        quality,
        languages: [{ id: 1, name: 'English' }],
        releaseGroup: 'GRP',
        downloadId: 'dl-two-2',
        indexerFlags: 0,
        releaseType: 'singleEpisode',
        rejections: [],
      },
    ];
    const input = {
        db: t.db,
        arr: w.arr,
        actor: staff,
        parent: { kind: 'fix' as const, id: r.fixRequestId },
        downloadId: 'dl-two-2',
      },
      p = await planOwnedSonarrImport(input);
    expect(p.targetEpisodeIds).toEqual([403, 404]);
    expect(p.state).toBe('import');
    w.state.history.push(
      ...w.state.history
        .filter((h) => h.downloadId === 'dl-two-2')
        .map((h) => ({ ...h, id: h.id + 9000, downloadId: 'foreign' })),
    );
    await expect(planOwnedSonarrImport({ ...input, downloadId: 'foreign' })).rejects.toThrow();
    expect(w.state.deletes).toEqual([123]);
  });
  it('unpack-only failure preserves the selected release while removing only its exact owned failed queue', async () => {
    const w = world(),
      r = await start(w);
    w.fail('dl-two-2');
    for (const h of w.state.history)
      if (h.eventType === 'downloadFailed')
        h.data.message = 'Unpacking failed: Found archive file, might need to be extracted';
    const title = w.state.history.find((h) => h.downloadId === 'dl-two-2')!.sourceTitle;
    w.state.queue = [
      {
        id: 994,
        seriesId: 439,
        episodeId: 403,
        title,
        downloadId: 'dl-two-2',
        status: 'failed',
        statusMessages: [{ messages: ['Found archive file, might need to be extracted'] }],
      },
    ];
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 3000));
    w.state.releases = [source('replacement', [3, 4])];
    const input = {
        db: t.db,
        arr: w.arr,
        actor: staff,
        fixRequestId: r.fixRequestId,
        failedDownloadId: 'dl-two-2',
      },
      p = await planWrongContentRetry(input);
    await runWrongContentRetry({ ...input, digest: p.digest, key: p.candidates[0]!.key, evidence });
    expect(w.state.removals[0]?.options).toMatchObject({
      removeFromClient: 'false',
      blocklist: 'false',
      skipRedownload: 'true',
    });
    expect(w.state.calls).toHaveLength(3);
    expect(w.state.deletes).toEqual([123]);
  });
});
