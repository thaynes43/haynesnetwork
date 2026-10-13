// ADR-114 / DESIGN-055 P4 decisions 26-34 — the Watch Carry: the pure plan (which calls, which targets), and the flow
// over the embedded Postgres harness, a stateful stub Sonarr and an in-memory Plex whose watch state follows the episode
// (guid), not the file. A Season Re-map swaps two files that two friends watched; the Second-Copy Fix removes a copy
// someone watched; an ordering switch re-matches items. Every account's state must end on the content it watched.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as carryWriters from '../src/watch-carry';
import * as fixWriters from '../src/fix-requests';
import {
  fixRequests,
  ledgerEvents,
  mediaPlexMatches,
  plexLibraries,
  repairRequests,
  SEEDED_PLEX_SERVER_IDS,
  watchCarries,
  watchCarryMarks,
  watchCarryStates,
} from '@hnet/db/schema';
import {
  FixRefusedError,
  buildArrClientBundle,
  carryCalls,
  carryWatchState,
  contentStates,
  listWatchCarries,
  planCarryTargets,
  planSeasonRemap,
  planSecondCopyFix,
  planShowOrdering,
  planWrongContentReplace,
  preClearWatchCarry,
  revertWatchCarry,
  runSeasonRemap,
  runSecondCopyFix,
  runShowOrdering,
  runWrongContentReplace,
  finishWrongContentReplaceCarry,
  resetReleaseSearchState,
  setRepairGuideRemedies,
  takeWatchCarrySnapshot,
  upsertMediaItemsBatch,
  type ArrClientBundle,
  type SeasonPlexReader,
} from '../src/index';
import { readFileSync } from 'node:fs';
import { fakePlex, type FakeFile } from './fake-plex-carry';

const arrFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../arr/__fixtures__/${name}.json`, import.meta.url), 'utf8'));

/** One release of Sonarr's season list, as `GET /api/v3/release` sends it (the Lost Tapes recording's shape). */
const release = (guid: string, title: string, episode: number, rejections: string[]) => ({
  guid,
  indexerId: 1,
  indexer: 'Indexer (Prowlarr)',
  title,
  size: 489_693_272,
  quality: { quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 }, revision: { version: 1, real: 0, isRepack: false } },
  releaseGroup: 'GRP',
  approved: rejections.length === 0,
  temporarilyRejected: false,
  rejected: rejections.length > 0,
  rejections,
  customFormatScore: 0,
  languages: [{ id: 1, name: 'English' }],
  protocol: 'usenet',
  ageHours: 12,
  seasonNumber: 1,
  mappedSeasonNumber: 1,
  episodeNumbers: [episode],
  mappedEpisodeNumbers: [episode],
  fullSeason: false,
  downloadAllowed: true,
});
import { bootMigratedDb, type TestDb } from './helpers';

const EMPTY = { viewCount: 0, viewOffset: 0, lastViewedAt: null };

describe('carryCalls (ADR-114 C-04)', () => {
  it('sends nothing when the state already matches, within the resume tolerance', () => {
    expect(carryCalls({ viewCount: 1, viewOffset: 300_000, lastViewedAt: 1 }, { viewCount: 1, viewOffset: 303_000, lastViewedAt: null })).toEqual([]);
    expect(carryCalls(EMPTY, EMPTY)).toEqual([]);
  });
  it('clears, scrobbles once per play, then sets the resume point', () => {
    expect(carryCalls({ viewCount: 1, viewOffset: 0, lastViewedAt: 1 }, { viewCount: 2, viewOffset: 90_000, lastViewedAt: null })).toEqual([
      'unscrobble',
      'scrobble',
      'scrobble',
      'progress',
    ]);
    expect(carryCalls(EMPTY, { viewCount: 1, viewOffset: 0, lastViewedAt: null })).toEqual(['scrobble']);
    expect(carryCalls({ viewCount: 3, viewOffset: 0, lastViewedAt: 1 }, EMPTY)).toEqual(['unscrobble']);
  });
  it('moves only the resume point when the plays already match', () => {
    expect(carryCalls({ viewCount: 0, viewOffset: 100_000, lastViewedAt: 1 }, { viewCount: 0, viewOffset: 400_000, lastViewedAt: null })).toEqual(['progress']);
    expect(carryCalls({ viewCount: 0, viewOffset: 100_000, lastViewedAt: 1 }, EMPTY)).toEqual(['unscrobble']);
  });
});

describe('contentStates and planCarryTargets (ADR-114 C-01, C-04, C-05)', () => {
  const part = (size: number) => ({ name: `f${size}.mkv`, size });

  it('credits each file with the plays of every item that played it; a copy’s plays go to its original', () => {
    const states = [
      { ratingKey: 'a', parts: [part(10)], viewCount: 1, viewOffset: 0, lastViewedAt: 100 },
      { ratingKey: 'copy', parts: [part(99)], viewCount: 2, viewOffset: 0, lastViewedAt: 200 },
      { ratingKey: 'b', parts: [part(20)], viewCount: 0, viewOffset: 400_000, lastViewedAt: 300 },
    ];
    const content = contentStates(states, { moved: [], deleted: [99], sameAs: [[99, 10]] });
    expect(content.get(10)).toEqual({ viewCount: 3, viewOffset: 0, lastViewedAt: 200 });
    expect(content.get(20)).toEqual({ viewCount: 0, viewOffset: 400_000, lastViewedAt: 300 });
    expect(content.has(99)).toBe(false);
    // A two-episode copy of two one-episode originals credits both.
    const both = contentStates([{ ratingKey: 'c', parts: [part(77)], viewCount: 1, viewOffset: 0, lastViewedAt: 5 }], {
      moved: [],
      deleted: [77],
      sameAs: [
        [77, 10],
        [77, 20],
      ],
    });
    expect([...both.keys()].sort()).toEqual([10, 20]);
  });

  it('targets each item by the file it holds now: carried, partial, or stale; untouched items are left out', () => {
    const content = new Map([
      [10, { viewCount: 7, viewOffset: 120_000, lastViewedAt: 1 }],
      [20, { viewCount: 0, viewOffset: 400_000, lastViewedAt: 1 }],
      [40, { viewCount: 0, viewOffset: 30_000, lastViewedAt: 1 }],
    ]);
    const after = [
      { ratingKey: 'x', season: 1, episode: 1, parts: [part(20)] },
      { ratingKey: 'y', season: 1, episode: 2, parts: [part(10)] },
      { ratingKey: 'z', season: 1, episode: 3, parts: [part(30)] },
      { ratingKey: 'w', season: 1, episode: 4, parts: [part(40)] },
      { ratingKey: 'untouched', season: 1, episode: 5, parts: [part(50)] },
      { ratingKey: 'emptied', season: 1, episode: 6, parts: [] },
    ];
    const targets = planCarryTargets({ after, beforeTouched: new Set(['emptied']), content, scope: { moved: [10, 20, 30, 40] } });
    expect(targets.map((t) => [t.ratingKey, t.reason, t.target.viewCount, t.target.viewOffset])).toEqual([
      ['x', 'partial', 0, 400_000],
      // Plays are carried up to five; a watched file keeps its resume point.
      ['y', 'carried', 5, 120_000],
      ['z', 'stale', 0, 0],
      // Plex keeps no resume point of 60 s or less on an unwatched item.
      ['w', 'partial', 0, 0],
      ['emptied', 'stale', 0, 0],
    ]);
  });

  it('marks an item that plays two files watched only when both were watched (P4 decision 30)', () => {
    const content = new Map([
      [10, { viewCount: 1, viewOffset: 0, lastViewedAt: 1 }],
      [20, { viewCount: 0, viewOffset: 200_000, lastViewedAt: 1 }],
    ]);
    const after = [{ ratingKey: 'pair', season: 1, episode: 1, parts: [part(10), part(20)] }];
    const [t] = planCarryTargets({ after, beforeTouched: new Set(), content, scope: { moved: [10, 20] } });
    expect(t).toMatchObject({ reason: 'partial', target: { viewCount: 0, viewOffset: 0 } });
  });
});

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

const SERIES_ID = 9101;
const SERIES_PATH = '/data/tv/Show';
const TITLES = ['Alpha Run', 'Bravo Night', 'Charlie Comes Home', 'Delta Force Five'];
const pad = (n: number) => String(n).padStart(2, '0');
const OWNER = '9000';
const FRIEND_A = '1001';
const FRIEND_B = '1002';
const FRIEND_C = '1003';

interface StubEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  episodeFileId: number;
}
interface StubFile {
  id: number;
  relativePath: string;
  size: number;
  sceneName: string | null;
}

/**
 * Season 1: E1 Alpha (right), E2 holds Charlie (E3's content), E3 holds Bravo (E2's), E4 Delta (right). S00E01 has no
 * file (the parking episode). Follows Sonarr's library-file ManualImport and RenameFiles like the Season Re-map's test.
 * `contentOn` overrides which content sits on which slot.
 */
function stubSonarr(opts: { contentOn?: Array<[number, number]>; copyNames?: Record<number, string>; identicalCopies?: boolean } = {}) {
  const nameFor = (e: StubEpisode) =>
    `${e.seasonNumber === 0 ? 'Specials' : `Season ${e.seasonNumber}`}/Show - S${pad(e.seasonNumber)}E${pad(e.episodeNumber)} - ${e.title}-GRP.mkv`;
  const episodes: StubEpisode[] = TITLES.map((title, i) => ({ id: 400 + i + 1, seasonNumber: 1, episodeNumber: i + 1, title, episodeFileId: 0 }));
  episodes.push({ id: 991, seasonNumber: 0, episodeNumber: 1, title: 'Behind the Scenes', episodeFileId: 0 });
  const files = new Map<number, StubFile>();
  const contentOn = opts.contentOn ?? [
    [1, 1],
    [2, 3],
    [3, 2],
    [4, 4],
  ];
  for (const [slot, content] of contentOn) {
    const id = 7000 + slot;
    const e = episodes.find((x) => x.seasonNumber === 1 && x.episodeNumber === slot)!;
    e.episodeFileId = id;
    files.set(id, {
      id,
      relativePath: nameFor(e),
      size: 50_000 + content * 10 + (slot === content || opts.identicalCopies ? 0 : slot),
      sceneName: opts.copyNames?.[slot] ?? `Show.S01E${pad(slot)}.${(TITLES[content - 1] ?? 'Other Story').replace(/ /g, '.')}.1080p.WEB-DL-GRP`,
    });
  }
  const state = {
    nextFileId: 95_000,
    nextCommandId: 800,
    commands: new Map<number, string>(),
    deleted: [] as number[],
    searched: [] as number[][],
    posts: 0,
    /** Sonarr's season release list (the Wrong-Content Replace's search), and the grabs sent. */
    releases: [] as Array<Record<string, unknown>>,
    grabs: [] as Array<Record<string, unknown>>,
    searches: 0,
    deleteAttempts: [] as number[],
    deleteFailures: new Set<number>(),
    deleteNoOps: new Set<number>(),
    failDeletionReadBack: false,
    missingDeletionEpisodes: new Set<number>(),
    failGrabs: false,
  };
  const json = (body: unknown, status = 200) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const quality = { quality: { id: 3, name: 'WEBDL-1080p', source: 'web', resolution: 1080 }, revision: { version: 1, real: 0 } };
  const seasonOf = (f: StubFile) => episodes.find((e) => e.episodeFileId === f.id)?.seasonNumber ?? 1;
  const expectedName = (f: StubFile) => {
    const on = episodes.filter((e) => e.episodeFileId === f.id).sort((a, b) => a.episodeNumber - b.episodeNumber);
    return on.length === 0 ? f.relativePath : nameFor(on[0]!);
  };
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const p = url.pathname;
    if (method === 'GET' && p === '/api/v3/episode') {
      if (state.deleteAttempts.length > 0 && state.failDeletionReadBack) return json({ message: 'episode read-back unavailable' }, 400);
      return json(
        episodes.filter((e) => state.deleteAttempts.length === 0 || !state.missingDeletionEpisodes.has(e.id)).map((e) => ({
          id: e.id,
          seriesId: SERIES_ID,
          seasonNumber: e.seasonNumber,
          episodeNumber: e.episodeNumber,
          title: e.title,
          hasFile: e.episodeFileId > 0,
          monitored: true,
          ...(e.episodeFileId > 0 ? { episodeFileId: e.episodeFileId } : {}),
        })),
      );
    }
    if (method === 'GET' && p === '/api/v3/episodefile') {
      if (state.deleteAttempts.length > 0 && state.failDeletionReadBack) return json({ message: 'file read-back unavailable' }, 400);
      return json([...files.values()].map((f) => ({ id: f.id, seriesId: SERIES_ID, seasonNumber: seasonOf(f), relativePath: f.relativePath, sceneName: f.sceneName, releaseGroup: 'GRP', size: f.size, quality })));
    }
    if (method === 'GET' && p === '/api/v3/queue') return json({ page: 1, pageSize: 200, totalRecords: 0, records: [] });
    if (method === 'GET' && p === `/api/v3/series/${SERIES_ID}`) {
      return json({ ...(arrFixture('sonarr.series-byid') as Record<string, unknown>), id: SERIES_ID, title: 'Show', year: 2020 });
    }
    if (method === 'GET' && p === '/api/v3/release') {
      state.searches += 1;
      return json(state.releases);
    }
    if (method === 'POST' && p === '/api/v3/release') {
      if (state.failGrabs) return json({ message: 'release grab refused' }, 400);
      state.grabs.push(body as Record<string, unknown>);
      return json(body);
    }
    if (method === 'GET' && p === '/api/v3/manualimport') {
      const season = Number(url.searchParams.get('seasonNumber'));
      return json(
        [...files.values()]
          .filter((f) => seasonOf(f) === season)
          .map((f) => ({
            id: f.id * 10,
            path: `${SERIES_PATH}/${f.relativePath}`,
            relativePath: f.relativePath,
            folderName: 'Show',
            size: f.size,
            series: { id: SERIES_ID, title: 'Show', year: 2020 },
            seasonNumber: season,
            episodes: [],
            episodeFileId: f.id,
            releaseGroup: 'GRP',
            quality,
            languages: [{ id: 1, name: 'English' }],
            indexerFlags: 0,
            releaseType: 'singleEpisode',
            rejections: [],
          })),
      );
    }
    if (method === 'GET' && p === '/api/v3/rename') {
      const season = Number(url.searchParams.get('seasonNumber'));
      return json(
        [...files.values()]
          .filter((f) => seasonOf(f) === season && f.relativePath !== expectedName(f))
          .map((f) => ({ seriesId: SERIES_ID, seasonNumber: season, episodeFileId: f.id, existingPath: f.relativePath, newPath: expectedName(f) })),
      );
    }
    const del = /^\/api\/v3\/episodefile\/(\d+)$/.exec(p);
    if (method === 'DELETE' && del) {
      const id = Number(del[1]);
      state.deleteAttempts.push(id);
      if (state.deleteFailures.has(id)) return json({ message: 'file delete refused' }, 400);
      if (state.deleteNoOps.has(id)) return json({});
      files.delete(id);
      for (const e of episodes) if (e.episodeFileId === id) e.episodeFileId = 0;
      state.deleted.push(id);
      return json({});
    }
    if (method === 'POST' && p === '/api/v3/command') {
      state.posts += 1;
      const id = state.nextCommandId++;
      const name = (body as { name: string }).name;
      if (name === 'ManualImport') {
        for (const f of (body as { files: Array<{ path: string; episodeIds: number[] }> }).files) {
          const rel = f.path.slice(SERIES_PATH.length + 1);
          const old = [...files.values()].find((x) => x.relativePath === rel)!;
          files.delete(old.id);
          for (const e of episodes) if (e.episodeFileId === old.id) e.episodeFileId = 0;
          const fresh: StubFile = { ...old, id: state.nextFileId++, sceneName: null };
          files.set(fresh.id, fresh);
          for (const t of f.episodeIds) episodes.find((x) => x.id === t)!.episodeFileId = fresh.id;
        }
      } else if (name === 'RenameFiles') {
        for (const fid of (body as { files: number[] }).files) {
          const f = files.get(fid);
          if (!f) continue;
          const next = expectedName(f);
          if ([...files.values()].some((x) => x.id !== fid && x.relativePath === next)) continue;
          f.relativePath = next;
        }
      } else if (name === 'EpisodeSearch') {
        state.searched.push((body as { episodeIds: number[] }).episodeIds);
      }
      state.commands.set(id, name);
      return json({ id, name });
    }
    if (method === 'GET' && p === '/api/v3/command') return json([...state.commands.entries()].map(([id, name]) => ({ id, name, status: 'completed' })));
    const cmd = /^\/api\/v3\/command\/(\d+)$/.exec(p);
    if (method === 'GET' && cmd) return json({ id: Number(cmd[1]), name: state.commands.get(Number(cmd[1])) ?? 'x', status: 'completed' });
    return json({ message: `no stub for ${method} ${p}` }, 404);
  }) as typeof fetch;
  const o = { apiKey: 'k', retryDelayMs: 0, fetchImpl } as const;
  const bundle: ArrClientBundle = buildArrClientBundle({
    sonarr: { baseUrl: 'http://sonarr.test:8989', ...o },
    radarr: { baseUrl: 'http://radarr.test:7878', ...o },
    lidarr: { baseUrl: 'http://lidarr.test:8686', ...o },
    bazarr: { baseUrl: 'http://bazarr.test:6767', ...o },
  });
  /** What Plex sees: each file at its season and first episode, named as on disk. */
  const plexFiles = (): FakeFile[] =>
    [...files.values()].flatMap((f) => {
      const on = episodes.filter((e) => e.episodeFileId === f.id);
      if (on.length === 0) return [];
      return [{ size: f.size, name: f.relativePath.split('/').pop()!, season: on[0]!.seasonNumber, episodes: on.map((e) => e.episodeNumber) }];
    });
  const sizeOfContent = (n: number) => [...files.values()].find((f) => Math.floor((f.size - 50_000) / 10) === n)?.size ?? null;
  return { state, bundle, files, episodes, plexFiles, sizeOfContent };
}

const plexFollowingTvdb: SeasonPlexReader = {
  async seasonTitles() {
    return [{ server: 'haynestower', items: TITLES.map((title, i) => ({ episodeNumber: i + 1, title })) }];
  },
};

describe('the Watch Carry flow (ADR-114)', () => {
  let t: TestDb;
  let itemId: string;
  const WAIT = { timeoutMs: 50, intervalMs: 5 };

  beforeAll(async () => {
    t = await bootMigratedDb();
    await upsertMediaItemsBatch({
      db: t.db,
      arrKind: 'sonarr',
      items: [{ arrItemId: SERIES_ID, tvdbId: 9_101_000, title: 'Show', sortTitle: 'show', monitored: true, qualityProfileId: 1, qualityProfileName: 'Any', rootFolder: '/data/tv' }],
    });
    const [row] = await t.db.query.mediaItems.findMany({ where: (m, { eq: e }) => e(m.arrItemId, SERIES_ID) });
    itemId = row!.id;
    const [lib] = await t.db
      .insert(plexLibraries)
      .values({ serverId: SEEDED_PLEX_SERVER_IDS.haynestower, sectionKey: '4', name: 'HNet TV Shows', mediaType: 'show', available: true })
      .returning({ id: plexLibraries.id });
    await t.db.insert(mediaPlexMatches).values({ mediaItemId: itemId, plexLibraryId: lib!.id, ratingKey: 'show-1', matchedVia: 'tvdb' });
  }, 240_000);

  afterAll(async () => {
    await t.stop();
  });
  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    await setRepairGuideRemedies({ db: t.db, remedies: { episode_remap: true }, actorId: null });
    await t.db.delete(watchCarries).where(eq(watchCarries.seriesId, SERIES_ID));
    await t.db.delete(repairRequests).where(eq(repairRequests.mediaItemId, itemId));
    await t.db.delete(ledgerEvents).where(eq(ledgerEvents.mediaItemId, itemId));
    await t.db.delete(fixRequests).where(eq(fixRequests.mediaItemId, itemId));
  });

  /** The swap's season, the fake Plex wired to it, and three friends' history on it. */
  function swapWorld() {
    const arr = stubSonarr();
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A, FRIEND_B, FRIEND_C] });
    // A watched E2 twice (it played Charlie) and stopped part-way into E3 (Bravo).
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 2 });
    plex.seed(FRIEND_A, 'g-1-3', { viewOffset: 300_000 });
    // B watched E1 (right) and E3 (Bravo); never Charlie.
    plex.seed(FRIEND_B, 'g-1-1', { viewCount: 1 });
    plex.seed(FRIEND_B, 'g-1-3', { viewCount: 1 });
    return { arr, plex };
  }

  it('a Season Re-map carries every account’s state onto the item that now plays the file it watched', async () => {
    const { arr, plex } = swapWorld();
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, plex: plexFollowingTvdb };
    const plan = await planSeasonRemap(target);
    expect(plan.refusal).toBeNull();
    const result = await runSeasonRemap({ ...target, planDigest: plan.digest, commandWait: WAIT, stepPauseMs: 0, watchCarry: plex.plex, carryWait: WAIT, carryPauseMs: 0 });
    expect(result.outcome).toBe('moved');
    expect(result.carry).toMatchObject({ status: 'verified', accountsWithState: 2, error: null });

    // Charlie (E3's content) now plays on E3: A's two plays are there; Bravo plays on E2: A's resume point is there.
    expect(plex.view(FRIEND_A, 'g-1-3')).toMatchObject({ viewCount: 2, viewOffset: 0 });
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0, viewOffset: 300_000 });
    // B watched Bravo (now E2), never Charlie (now E3); E1 did not move and was never written.
    expect(plex.view(FRIEND_B, 'g-1-2')).toMatchObject({ viewCount: 1 });
    expect(plex.view(FRIEND_B, 'g-1-3')).toMatchObject({ viewCount: 0, viewOffset: 0 });
    expect(plex.view(FRIEND_B, 'g-1-1')).toMatchObject({ viewCount: 1, lastViewedAt: 1_700_000_000 });
    expect(plex.calls.some((c) => c.ratingKey === 'rk-g-1-1' || c.account === OWNER || c.account === FRIEND_C)).toBe(false);

    const result2 = result.carry!.result!;
    expect(result2.totals).toMatchObject({ accounts: 2, mismatches: 0, failed: 0, watchedCarried: 2, resumesCarried: 1 });
    // The snapshot is stored before anything moved, with no token anywhere.
    const [carry] = await t.db.select().from(watchCarries).where(eq(watchCarries.seriesId, SERIES_ID));
    expect(carry).toMatchObject({ kind: 'season_remap', status: 'verified', seasonNumbers: [1, 0] });
    const states = await t.db.select().from(watchCarryStates).where(eq(watchCarryStates.carryId, carry!.id));
    expect(states).toHaveLength(4);
    expect(JSON.stringify([carry, states])).not.toMatch(/token/i);
    // One audit row per mark: the pre-clears of the two moving items, then the carry.
    const marks = await t.db.select().from(watchCarryMarks).where(eq(watchCarryMarks.carryId, carry!.id));
    expect(marks.filter((m) => m.phase === 'pre_clear').map((m) => [m.plexAccountId, m.ratingKey]).sort()).toEqual([
      [FRIEND_A, 'rk-g-1-2'],
      [FRIEND_A, 'rk-g-1-3'],
      [FRIEND_B, 'rk-g-1-3'],
    ]);
    expect(marks.filter((m) => m.phase === 'carry').map((m) => [m.plexAccountId, m.ratingKey, m.reason, m.calls.join(',')]).sort()).toEqual([
      [FRIEND_A, 'rk-g-1-2', 'partial', 'progress'],
      [FRIEND_A, 'rk-g-1-3', 'carried', 'scrobble,scrobble'],
      [FRIEND_B, 'rk-g-1-2', 'carried', 'scrobble'],
    ]);
    expect(marks.every((m) => m.ok)).toBe(true);
    // The Repair Request names the carry.
    const [rr] = await t.db.select().from(repairRequests).where(eq(repairRequests.mediaItemId, itemId));
    expect((rr!.preview as { watchCarry: { carryId: string } }).watchCarry.carryId).toBe(carry!.id);
    expect((rr!.actionsTaken as Array<{ step: string; ok?: boolean }>).find((a) => a.step === 'season_remap_watch_carry')).toMatchObject({ ok: true, status: 'verified' });
  });

  it('refuses the move, writing nothing, when one account’s state cannot be read', async () => {
    const { arr, plex } = swapWorld();
    plex.failRead.add(FRIEND_C);
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, plex: plexFollowingTvdb };
    const plan = await planSeasonRemap(target);
    await expect(
      runSeasonRemap({ ...target, planDigest: plan.digest, commandWait: WAIT, stepPauseMs: 0, watchCarry: plex.plex, carryPauseMs: 0 }),
    ).rejects.toThrow(/could not be carried.*Nothing moved/);
    expect(arr.state.posts).toBe(0);
    expect(plex.calls).toEqual([]);
    expect(await t.db.select().from(watchCarries).where(eq(watchCarries.seriesId, SERIES_ID))).toEqual([]);
    expect(await t.db.select().from(repairRequests).where(eq(repairRequests.mediaItemId, itemId))).toEqual([]);
  });

  it('puts back every clear and refuses the move when a clear fails', async () => {
    const { arr, plex } = swapWorld();
    plex.failWriteAt.set(FRIEND_B, 1);
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, plex: plexFollowingTvdb };
    const plan = await planSeasonRemap(target);
    await expect(
      runSeasonRemap({ ...target, planDigest: plan.digest, commandWait: WAIT, stepPauseMs: 0, watchCarry: plex.plex, carryPauseMs: 0 }),
    ).rejects.toBeInstanceOf(FixRefusedError);
    expect(arr.state.posts).toBe(0);
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 2 });
    expect(plex.view(FRIEND_A, 'g-1-3')).toMatchObject({ viewOffset: 300_000 });
    expect(plex.view(FRIEND_B, 'g-1-3')).toMatchObject({ viewCount: 1 });
    const [carry] = await t.db.select().from(watchCarries).where(eq(watchCarries.seriesId, SERIES_ID));
    expect(carry!.status).toBe('refused');
  });

  it('a clear that lands but answers with a timeout is put back from the item’s state now, without doubling plays', async () => {
    const { arr, plex } = swapWorld();
    // B's clear of E3 lands, then times out: the move must not run, and B's one play comes back as one play.
    plex.landThenFailAt.set(FRIEND_B, 1);
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, plex: plexFollowingTvdb };
    const plan = await planSeasonRemap(target);
    await expect(
      runSeasonRemap({ ...target, planDigest: plan.digest, commandWait: WAIT, stepPauseMs: 0, watchCarry: plex.plex, carryPauseMs: 0 }),
    ).rejects.toThrow(/put back \(carry [0-9a-f-]{36}\) and nothing moved/);
    expect(arr.state.posts).toBe(0);
    expect(plex.view(FRIEND_B, 'g-1-3')).toMatchObject({ viewCount: 1 });
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 2 });
    expect(plex.view(FRIEND_A, 'g-1-3')).toMatchObject({ viewCount: 0, viewOffset: 300_000 });
    const [carry] = await t.db.select().from(watchCarries).where(eq(watchCarries.seriesId, SERIES_ID));
    expect(carry!.status).toBe('refused');
  });

  it('a carry that stopped part-way blocks a new snapshot of the series until it is finished', async () => {
    const { arr, plex } = swapWorld();
    const snapshot = await takeWatchCarrySnapshot({
      db: t.db,
      plex: plex.plex,
      kind: 'season_remap',
      mediaItemId: itemId,
      seriesId: SERIES_ID,
      seasons: [1],
      scope: { moved: [arr.sizeOfContent(2)!, arr.sizeOfContent(3)!] },
      pauseMs: 0,
    });
    // The run dies after its first clear: the carry is already `cleared`.
    plex.failRead.add(FRIEND_A);
    plex.failWriteAt.set(FRIEND_A, 2);
    await expect(preClearWatchCarry({ db: t.db, plex: plex.plex, snapshot, pauseMs: 0 })).rejects.toThrow(/could not be put back: run carry-revert/);
    const [carry] = await t.db.select().from(watchCarries).where(eq(watchCarries.id, snapshot.carryId));
    expect(carry!.status).toBe('cleared');
    await expect(
      takeWatchCarrySnapshot({ db: t.db, plex: plex.plex, kind: 'season_remap', mediaItemId: itemId, seriesId: SERIES_ID, seasons: [1], scope: { moved: [] }, pauseMs: 0 }),
    ).rejects.toThrow(/not finished/);
    // carry-finish from the stored snapshot puts A's marks back where the files are.
    plex.failRead.delete(FRIEND_A);
    const finished = await carryWatchState({ db: t.db, plex: plex.plex, carryId: snapshot.carryId, pauseMs: 0 });
    expect(finished.status).toBe('verified');
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 2 });
    expect(plex.view(FRIEND_A, 'g-1-3')).toMatchObject({ viewOffset: 300_000 });
  });

  it('leaves a view made after the snapshot alone, and carry-finish runs again from the stored snapshot', async () => {
    const { arr, plex } = swapWorld();
    const snapshot = await takeWatchCarrySnapshot({
      db: t.db,
      plex: plex.plex,
      kind: 'season_remap',
      mediaItemId: itemId,
      seriesId: SERIES_ID,
      seasons: [1],
      scope: { moved: [arr.sizeOfContent(2)!, arr.sizeOfContent(3)!] },
      pauseMs: 0,
    });
    await preClearWatchCarry({ db: t.db, plex: plex.plex, snapshot, pauseMs: 0 });
    // A second snapshot is refused while this carry is open.
    await expect(
      takeWatchCarrySnapshot({ db: t.db, plex: plex.plex, kind: 'season_remap', mediaItemId: itemId, seriesId: SERIES_ID, seasons: [1], scope: { moved: [] }, pauseMs: 0 }),
    ).rejects.toThrow(/not finished/);
    // Nothing moved (say the move stopped at once), and C watches E3 meanwhile.
    plex.watchNow(FRIEND_C, 'g-1-3');
    const result = await carryWatchState({ db: t.db, plex: plex.plex, carryId: snapshot.carryId, pauseMs: 0 });
    expect(result.status).toBe('verified');
    // Everyone is back where they were, and C's new view stands.
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 2 });
    expect(plex.view(FRIEND_A, 'g-1-3')).toMatchObject({ viewCount: 0, viewOffset: 300_000 });
    expect(plex.view(FRIEND_B, 'g-1-3')).toMatchObject({ viewCount: 1 });
    expect(plex.view(FRIEND_C, 'g-1-3')).toMatchObject({ viewCount: 1 });
    expect(result.totals.newViews).toBe(1);
    const again = await carryWatchState({ db: t.db, plex: plex.plex, carryId: snapshot.carryId, pauseMs: 0 });
    expect(again.totals.written).toBe(0);
    expect(again.status).toBe('verified');
  });

  it('carry-revert restores every item the carry wrote, newest first', async () => {
    const { arr, plex } = swapWorld();
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, plex: plexFollowingTvdb };
    const plan = await planSeasonRemap(target);
    const run = await runSeasonRemap({ ...target, planDigest: plan.digest, commandWait: WAIT, stepPauseMs: 0, watchCarry: plex.plex, carryWait: WAIT, carryPauseMs: 0 });
    const reverted = await revertWatchCarry({ db: t.db, plex: plex.plex, carryId: run.carry!.carryId, pauseMs: 0 });
    expect(reverted).toMatchObject({ failed: 0 });
    // Each written item is back to its state before the carry (the files stay moved).
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 2, viewOffset: 0 });
    expect(plex.view(FRIEND_A, 'g-1-3')).toMatchObject({ viewCount: 0, viewOffset: 300_000 });
    expect(plex.view(FRIEND_B, 'g-1-2')).toMatchObject({ viewCount: 0 });
    expect(plex.view(FRIEND_B, 'g-1-3')).toMatchObject({ viewCount: 1 });
    const [view] = await listWatchCarries({ db: t.db, carryId: run.carry!.carryId });
    expect(view).toMatchObject({ status: 'reverted' });
    expect(view!.marks.revert).toBeGreaterThan(0);
  });

  it('the Second-Copy Fix clears the copy’s slot and credits the original with its plays (P4 decision 32)', async () => {
    // E2 holds a second copy of E4 ("Delta Force Five"); E4 has its own file.
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 4], [3, 3], [4, 4]] });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A, FRIEND_B] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 }); // watched the copy only
    plex.seed(FRIEND_B, 'g-1-2', { viewCount: 1 }); // watched the copy and the original
    plex.seed(FRIEND_B, 'g-1-4', { viewCount: 1 });
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 };
    const plan = await planSecondCopyFix(target);
    expect(plan.refusal).toBeNull();
    const result = await runSecondCopyFix({ ...target, planDigest: plan.digest, evidence: 'Subtitles 3:00-5:00 match line for line.', watchCarry: plex.plex, carryPauseMs: 0 });
    expect(arr.state.deleted).toEqual([7002]);
    expect(result.carry).toMatchObject({ status: 'verified', error: null });
    // Nobody keeps a mark on E2 (its real episode comes back unwatched); both saw E4's content.
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0 });
    expect(plex.view(FRIEND_B, 'g-1-2')).toMatchObject({ viewCount: 0 });
    expect(plex.view(FRIEND_A, 'g-1-4')).toMatchObject({ viewCount: 1 });
    expect(plex.view(FRIEND_B, 'g-1-4')).toMatchObject({ viewCount: 2 });
    const [fix] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, result.fixRequestId));
    expect((fix!.actionsTaken as Array<{ step: string }>).map((a) => a.step)).toContain('watch_carry');
  });

  it('a byte-identical copy is told apart by its file name (The Simpsons S38E02)', async () => {
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 4], [3, 3], [4, 4]], identicalCopies: true });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 }); // the copy
    plex.seed(FRIEND_A, 'g-1-4', { viewCount: 1 }); // and the original
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 };
    const plan = await planSecondCopyFix(target);
    expect(plan.copy!.size).toBe(plan.original!.size);
    const result = await runSecondCopyFix({ ...target, planDigest: plan.digest, evidence: 'Same size and length; subtitles at 5:00 match.', watchCarry: plex.plex, carryPauseMs: 0 });
    expect(result.carry).toMatchObject({ status: 'verified' });
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0 });
    expect(plex.view(FRIEND_A, 'g-1-4')).toMatchObject({ viewCount: 2 });
  });

  it('the Wrong-Content Replace finds a correct release first, then deletes, grabs, and drops a mark on content held nowhere else (P4 decision 38)', async () => {
    // E2 holds another show's episode (content 9, which nothing else in the library holds). A watched it on E2.
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 9], [3, 3], [4, 4]], copyNames: { 2: 'Other.Show.S01E01.Some.Story.1080p.WEB-DL-GRP' } });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 });
    const existing = 'Existing file on disk has a equal or higher Custom Format score: 0';
    arr.state.releases = [
      release('wrong-1', 'Show.S01E02.Another.Story.1080p.WEB-DL-GRP', 2, [existing]),
      release('right-1', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, [existing]),
    ];
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 };
    const plan = await planWrongContentReplace(target);
    expect(plan.refusal).toBeNull();
    expect(plan.candidates.map((c) => c.title)).toEqual(['Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP']);
    expect(arr.state.deleted).toEqual([]); // the plan only reads
    const result = await runWrongContentReplace({
      ...target,
      planDigest: plan.digest,
      keys: [plan.candidates[0]!.key],
      evidence: 'The title card names another show.',
      watchCarry: plex.plex,
      carryPauseMs: 0,
    });
    expect(arr.state.deleted).toEqual([7002]);
    expect(arr.state.grabs).toEqual([
      expect.objectContaining({ guid: 'right-1', indexerId: 1, seriesId: SERIES_ID, episodeIds: [402], shouldOverride: true }),
    ]);
    // The mark on the wrong content is cleared and recorded as dropped; it never lands on the slot.
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0 });
    expect(result.carry).toMatchObject({ status: 'verified' });
    expect(result.carry!.result!.totals.lost).toBe(1);
    expect(result.carry!.result!.droppedDetail).toEqual([expect.objectContaining({ server: 'haynestower', state: expect.objectContaining({ viewCount: 1 }) })]);
    const [fix] = await t.db.select().from(fixRequests).where(eq(fixRequests.id, result.fixRequestId));
    expect(fix).toMatchObject({ requesterId: null, reason: 'wrong_content', status: 'search_triggered' });
    expect((fix!.actionsTaken as Array<{ step: string }>).map((a) => a.step)).toEqual(
      expect.arrayContaining(['wrong_content_replace', 'delete_file', 'delete_read_back', 'release_grab', 'watch_carry']),
    );
    const [carry] = await t.db.select().from(watchCarries).where(eq(watchCarries.id, result.carry!.carryId));
    expect(carry!.kind).toBe('wrong_content');
  });

  it('keeps the wrong file when no release names the episode, and credits a mark to the copy elsewhere (P4 decision 38)', async () => {
    // E2 holds E4's story (a copy of content 4 under another size): no release names E2, so nothing moves.
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 4], [3, 3], [4, 4]] });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 });
    arr.state.releases = [release('wrong-1', 'Show.S01E02.Another.Story.1080p.WEB-DL-GRP', 2, ['Existing file on disk is of equal or higher preference'])];
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 };
    expect((await planWrongContentReplace(target)).refusal).toBe('no_release');
    // A correct release turns up: the replace credits A's play to E4, which holds the same story.
    arr.state.releases.push(release('right-2', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, ['Existing file on disk is of equal or higher preference']));
    resetReleaseSearchState();
    const plan = await planWrongContentReplace(target);
    const result = await runWrongContentReplace({
      ...target,
      planDigest: plan.digest,
      keys: [plan.candidates[0]!.key],
      evidence: 'Subtitles match the E04 file.',
      sameAs: [{ seasonNumber: 1, episodeNumber: 4 }],
      watchCarry: plex.plex,
      carryPauseMs: 0,
    });
    expect(result.carry).toMatchObject({ status: 'verified' });
    expect(result.carry!.result!.totals.lost).toBe(0);
    expect(plex.view(FRIEND_A, 'g-1-4')).toMatchObject({ viewCount: 1 });
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0 });
  });

  it('replaces two files at once, judges a renumbered release by its own name, and fills a slot from parts (P4 decision 38)', async () => {
    // E2 and E3 each hold another show's episode. Sonarr files `S01E02E03` (Bravo Night + Charlie Comes Home) on E3
    // and E4 (scene numbering); its name and titles say E2 and E3.
    resetReleaseSearchState();
    const arr = stubSonarr({
      contentOn: [[1, 1], [2, 9], [3, 8], [4, 4]],
      copyNames: { 2: 'Other.Show.S01E01.Some.Story.1080p.WEB-DL-GRP', 3: 'Other.Show.S01E02.More.Story.1080p.WEB-DL-GRP' },
    });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    const existing = 'Existing file on disk has a equal or higher Custom Format score: 0';
    arr.state.releases = [
      { ...release('both', 'Show.S01E02E03.Bravo.Night.Charlie.Comes.Home.1080p.WEB-DL-GRP', 2, [existing]), episodeNumbers: [2, 3], mappedEpisodeNumbers: [3, 4] },
      release('two', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, [existing]),
      release('three', 'Show.S01E03.Charlie.Comes.Home.1080p.WEB-DL-GRP', 3, [existing]),
    ];
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2, alsoEpisodes: [3] };
    const plan = await planWrongContentReplace(target);
    expect(plan.refusal).toBeNull();
    expect(plan.files.map((f) => f.id)).toEqual([7002, 7003]);
    expect(plan.candidates.map((c) => [c.title.split('.')[1], c.whole, c.state])).toEqual([
      ['S01E02E03', true, 'override'],
      ['S01E02', false, 'grab'],
      ['S01E03', false, 'grab'],
    ]);
    expect(plan.candidates[0]!.reasonCodes).toContain('renumbered');
    const [both, two, three] = plan.candidates.map((c) => c.key);
    const run = { ...target, planDigest: plan.digest, evidence: 'The title cards name another show.', watchCarry: plex.plex, carryPauseMs: 0, keepReleaseList: true };
    // Releases that land on an episode twice do not fill the slot: refused before anything is written.
    await expect(runWrongContentReplace({ ...run, keys: [both!, two!] })).rejects.toThrow(/do not fill the slot exactly/);
    expect(arr.state.deleted).toEqual([]);
    const result = await runWrongContentReplace({ ...run, keys: [two!, three!] });
    expect(arr.state.deleted).toEqual([7002, 7003]);
    expect(arr.state.grabs).toEqual([
      expect.objectContaining({ guid: 'two', episodeIds: [402], shouldOverride: true }),
      expect.objectContaining({ guid: 'three', episodeIds: [403], shouldOverride: true }),
    ]);
    expect(result.grabbed.map((g) => g.lands)).toEqual([['S01E02 · Bravo Night'], ['S01E03 · Charlie Comes Home']]);
    expect(result.carry).toMatchObject({ status: 'verified' });
    // The staff run kept its one search: the next slot plans from the same list.
    await planWrongContentReplace({ ...target, episodeNumber: 4, alsoEpisodes: [] });
    expect(arr.state.searches).toBe(1);
  });

  it('plans without Plex but refuses to replace without a Watch Carry adapter before any writes', async () => {
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 9], [3, 3], [4, 4]] });
    arr.state.releases = [release('right', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, ['Existing file on disk is of equal or higher preference'])];
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 };
    const plan = await planWrongContentReplace(target);
    expect(plan.refusal).toBeNull();
    await expect(runWrongContentReplace({ ...target, planDigest: plan.digest, keys: [plan.candidates[0]!.key], evidence: 'The title card names another show.' })).rejects.toThrow(/requires a Watch Carry/);
    expect(arr.state.deleteAttempts).toEqual([]);
    expect(arr.state.grabs).toEqual([]);
    expect(await t.db.select().from(watchCarries)).toEqual([]);
    expect(await t.db.select().from(fixRequests)).toEqual([]);
  });

  it.each(['rejected', 'retained'] as const)('restores the audited pre-clear when a Wrong-Content Replace delete is %s', async (failure) => {
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 9], [3, 3], [4, 4]] });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 2, viewOffset: 240_000 });
    arr.state.releases = [release('right', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, ['Existing file on disk is of equal or higher preference'])];
    (failure === 'rejected' ? arr.state.deleteFailures : arr.state.deleteNoOps).add(7002);
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 };
    const plan = await planWrongContentReplace(target);
    await expect(runWrongContentReplace({ ...target, planDigest: plan.digest, keys: [plan.candidates[0]!.key], evidence: 'The title card names another show.', watchCarry: plex.plex, carryPauseMs: 0 })).rejects.toThrow(/nothing was grabbed/i);
    expect(arr.files.has(7002)).toBe(true);
    expect(arr.state.grabs).toEqual([]);
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 2, viewOffset: 240_000 });
    const [carry] = await t.db.select().from(watchCarries);
    expect(carry!.status).toBe('refused');
    const marks = await t.db.select().from(watchCarryMarks).where(eq(watchCarryMarks.carryId, carry!.id));
    expect(marks.some((m) => m.phase === 'revert' && m.reason === 'restore' && m.ok)).toBe(true);
    expect(marks.some((m) => m.phase === 'carry')).toBe(false);
    const [fix] = await t.db.select().from(fixRequests);
    expect(fix!.status).toBe('failed');
  });

  it('a partial Wrong-Content Replace carries only the removed file and restores retained content without crediting its copy', async () => {
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 9], [3, 4], [4, 4]] });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 });
    plex.seed(FRIEND_A, 'g-1-3', { viewOffset: 240_000 });
    plex.seed(FRIEND_A, 'g-1-4', { viewCount: 1 });
    const rejection = ['Existing file on disk is of equal or higher preference'];
    arr.state.releases = [release('two', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, rejection), release('three', 'Show.S01E03.Charlie.Comes.Home.1080p.WEB-DL-GRP', 3, rejection)];
    arr.state.deleteFailures.add(7003);
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2, alsoEpisodes: [3] };
    const plan = await planWrongContentReplace(target);
    await expect(runWrongContentReplace({ ...target, planDigest: plan.digest, keys: plan.candidates.map((c) => c.key), sameAs: [{ copyOfEpisode: 3, seasonNumber: 1, episodeNumber: 4 }], evidence: 'E02 is another show and E03 matches E04.', watchCarry: plex.plex, carryPauseMs: 0 })).rejects.toThrow(/Missing now: S01E02.*release-list or Fix/);
    expect(arr.state.deleted).toEqual([7002]);
    expect(arr.state.grabs).toEqual([]);
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0 });
    expect(plex.view(FRIEND_A, 'g-1-3')).toMatchObject({ viewCount: 0, viewOffset: 240_000 });
    expect(plex.view(FRIEND_A, 'g-1-4')).toMatchObject({ viewCount: 1, viewOffset: 0 });
    const [carry] = await t.db.select().from(watchCarries);
    expect(carry!.status).toBe('verified');
    expect(carry!.scope).toMatchObject({ deletedNames: [plan.files[0]!.name], sameAs: [], pendingDeletes: [] });
    const verification = carry!.summary.verification as { totals: { lost: number }; dropped: Array<{ size: number }> };
    expect(verification.totals.lost).toBe(1);
    expect(verification.dropped.map((d) => d.size)).toEqual([plan.files[0]!.size]);
    const marks = await t.db.select().from(watchCarryMarks).where(eq(watchCarryMarks.carryId, carry!.id));
    expect(marks.some((m) => m.phase === 'carry' && m.episodeNumber === 3 && m.ok)).toBe(true);
  });

  it('credits each source file only to its own evidenced copies during a multi-file replacement', async () => {
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 1], [3, 4], [4, 4]] });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A, FRIEND_B] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 });
    plex.seed(FRIEND_B, 'g-1-3', { viewOffset: 240_000 });
    const rejection = ['Existing file on disk is of equal or higher preference'];
    arr.state.releases = [release('two', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, rejection), release('three', 'Show.S01E03.Charlie.Comes.Home.1080p.WEB-DL-GRP', 3, rejection)];
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2, alsoEpisodes: [3] };
    const plan = await planWrongContentReplace(target);
    const result = await runWrongContentReplace({ ...target, planDigest: plan.digest, keys: plan.candidates.map((c) => c.key), sameAs: [{ copyOfEpisode: 2, seasonNumber: 1, episodeNumber: 1 }, { copyOfEpisode: 3, seasonNumber: 1, episodeNumber: 4 }], evidence: 'The source files match E01 and E04 respectively.', watchCarry: plex.plex, carryPauseMs: 0 });
    expect(result.carry).toMatchObject({ status: 'verified', result: { totals: { lost: 0 } } });
    expect(plex.view(FRIEND_A, 'g-1-1')).toMatchObject({ viewCount: 1, viewOffset: 0 });
    expect(plex.view(FRIEND_A, 'g-1-4')).toMatchObject({ viewCount: 0, viewOffset: 0 });
    expect(plex.view(FRIEND_B, 'g-1-4')).toMatchObject({ viewCount: 0, viewOffset: 240_000 });
    expect(plex.view(FRIEND_B, 'g-1-1')).toMatchObject({ viewCount: 0, viewOffset: 0 });
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0, viewOffset: 0 });
    expect(plex.view(FRIEND_B, 'g-1-3')).toMatchObject({ viewCount: 0, viewOffset: 0 });
  });

  it('refuses equal-size sources with different copy mappings before clearing or deleting anything', async () => {
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 1], [3, 4], [4, 4]] });
    arr.files.get(7003)!.size = arr.files.get(7002)!.size;
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 });
    const rejection = ['Existing file on disk is of equal or higher preference'];
    arr.state.releases = [release('two', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, rejection), release('three', 'Show.S01E03.Charlie.Comes.Home.1080p.WEB-DL-GRP', 3, rejection)];
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2, alsoEpisodes: [3] };
    const plan = await planWrongContentReplace(target);
    await expect(runWrongContentReplace({ ...target, planDigest: plan.digest, keys: plan.candidates.map((c) => c.key), sameAs: [{ copyOfEpisode: 2, seasonNumber: 1, episodeNumber: 1 }, { copyOfEpisode: 3, seasonNumber: 1, episodeNumber: 4 }], evidence: 'The source files match E01 and E04 respectively.', watchCarry: plex.plex, carryPauseMs: 0 })).rejects.toThrow(/same byte size but different copies/);
    expect(arr.state.deleted).toEqual([]);
    expect(arr.state.grabs).toEqual([]);
    expect(plex.calls).toEqual([]);
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 1 });
    expect(await t.db.select().from(watchCarries)).toEqual([]);
  });

  it.each(['unreadable', 'missing_episode'] as const)('holds an %s deletion outcome open, then recovers without marking a new correct file', async (failure) => {
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 9], [3, 3], [4, 4]] });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 });
    arr.state.releases = [release('right', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, ['Existing file on disk is of equal or higher preference'])];
    if (failure === 'unreadable') arr.state.failDeletionReadBack = true;
    else arr.state.missingDeletionEpisodes.add(402);
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 };
    const plan = await planWrongContentReplace(target);
    await expect(runWrongContentReplace({ ...target, planDigest: plan.digest, keys: [plan.candidates[0]!.key], evidence: 'The title card names another show.', watchCarry: plex.plex, carryPauseMs: 0 })).rejects.toThrow(/nothing was grabbed/i);
    expect(arr.state.grabs).toEqual([]);
    const [carry] = await t.db.select().from(watchCarries);
    expect(carry!.status).toBe('cleared');
    expect((carry!.scope.pendingDeletes as unknown[]).length).toBe(1);
    expect(carry!.summary.verification).toBeUndefined();
    // Another process imports the correct file while Sonarr is unreadable. Neither generic carry command may use
    // the planned deletion scope; after a fresh read-back only the removed wrong content's mark is dropped.
    arr.files.set(9002, { id: 9002, size: 50_020, relativePath: 'Season 1/Show - S01E02 - Bravo Night-GRP.mkv', sceneName: null });
    arr.episodes.find((e) => e.id === 402)!.episodeFileId = 9002;
    await expect(carryWatchState({ db: t.db, plex: plex.plex, carryId: carry!.id, pauseMs: 0 })).rejects.toThrow(/file deletions are not verified/i);
    await expect(revertWatchCarry({ db: t.db, plex: plex.plex, carryId: carry!.id, pauseMs: 0 })).rejects.toThrow(/file deletions are not verified/i);
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0 });
    arr.state.failDeletionReadBack = false;
    arr.state.missingDeletionEpisodes.clear();
    const result = await finishWrongContentReplaceCarry({ db: t.db, arr: arr.bundle, plex: plex.plex, carryId: carry!.id, pauseMs: 0 });
    expect(result).toMatchObject({ status: 'verified', totals: { lost: 1 } });
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0 });
    // Even a later explicit revert refuses to put the removed file's state on that new file.
    expect((await revertWatchCarry({ db: t.db, plex: plex.plex, carryId: carry!.id, pauseMs: 0 })).failed).toBe(1);
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0 });
  });

  it.each(['load', 'settle'] as const)('audits confirmed deletion and fails the Fix without a grab when post-delete carry %s fails', async (failure) => {
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 9], [3, 3], [4, 4]] });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 });
    arr.state.releases = [release('right', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, ['Existing file on disk is of equal or higher preference'])];
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 };
    const plan = await planWrongContentReplace(target);
    if (failure === 'load') vi.spyOn(carryWriters, 'loadWatchCarry').mockRejectedValue(new Error('carry load unavailable'));
    else vi.spyOn(carryWriters, 'reconcileWrongContentWatchCarry').mockRejectedValue(new Error('carry settle unavailable'));
    await expect(runWrongContentReplace({ ...target, planDigest: plan.digest, keys: [plan.candidates[0]!.key], evidence: 'The title card names another show.', watchCarry: plex.plex, carryPauseMs: 0 })).rejects.toThrow(/Nothing was grabbed.*S01E02.*release-list or Fix.*carry-status.*carry-finish/);
    expect(arr.state.deleted).toEqual([7002]);
    expect(arr.state.grabs).toEqual([]);
    const [fix] = await t.db.select().from(fixRequests);
    expect(fix!.status).toBe('failed');
    expect(fix!.actionsTaken).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'delete_file', endpoint: 'DELETE /api/v3/episodefile/7002', ok: true }),
      expect.objectContaining({ step: 'delete_read_back', slotEmpty: true, removedFileIds: [7002], missingEpisodeIds: [402] }),
      expect.objectContaining({ step: 'delete_recovery', ok: false, error: `carry ${failure} unavailable` }),
    ]));
    expect((fix!.actionsTaken as Array<{ step: string }>).filter((action) => action.step === 'delete_file')).toHaveLength(1);
    const [carry] = await t.db.select().from(watchCarries);
    expect(carry!.status).toBe('cleared');
    expect((carry!.scope.pendingDeletes as unknown[]).length).toBe(1);
    expect(carry!.summary.verification).toBeUndefined();
    expect(plex.view(FRIEND_A, 'g-1-2')).toMatchObject({ viewCount: 0 });
  });

  it('reports an unsaved post-delete audit and keeps the stored pending carry without grabbing when its writer is unavailable', async () => {
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 9], [3, 3], [4, 4]] });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 });
    arr.state.releases = [release('right', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, ['Existing file on disk is of equal or higher preference'])];
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 };
    const plan = await planWrongContentReplace(target);
    vi.spyOn(fixWriters, 'recordFixAction').mockRejectedValue(new Error('Fix audit database unavailable'));
    await expect(runWrongContentReplace({ ...target, planDigest: plan.digest, keys: [plan.candidates[0]!.key], evidence: 'The title card names another show.', watchCarry: plex.plex, carryPauseMs: 0 })).rejects.toThrow(/failed Fix audit could not be saved.*stored carry.*carry-status.*carry-finish/);
    expect(arr.state.deleted).toEqual([7002]);
    expect(arr.state.grabs).toEqual([]);
    const [fix] = await t.db.select().from(fixRequests);
    expect(fix!.status).toBe('pending');
    expect((fix!.actionsTaken as Array<{ step: string }>).map((action) => action.step)).toEqual(['created']);
    const [carry] = await t.db.select().from(watchCarries);
    expect(carry!.status).toBe('cleared');
    expect((carry!.scope.pendingDeletes as unknown[]).length).toBe(1);
    expect(carry!.detail.deleteRecovery).toBeUndefined();
    await expect(carryWatchState({ db: t.db, plex: plex.plex, carryId: carry!.id, pauseMs: 0 })).rejects.toThrow(/file deletions are not verified/);
  });

  it('records a failed grab after confirmed deletion and says to choose again without promising a search', async () => {
    resetReleaseSearchState();
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 9], [3, 3], [4, 4]] });
    const plex = fakePlex({ files: arr.plexFiles, accounts: [OWNER, FRIEND_A] });
    plex.seed(FRIEND_A, 'g-1-2', { viewCount: 1 });
    arr.state.releases = [release('right', 'Show.S01E02.Bravo.Night.1080p.WEB-DL-GRP', 2, ['Existing file on disk is of equal or higher preference'])];
    arr.state.failGrabs = true;
    const target = { db: t.db, arr: arr.bundle, mediaItemId: itemId, seasonNumber: 1, episodeNumber: 2 };
    const plan = await planWrongContentReplace(target);
    await expect(runWrongContentReplace({ ...target, planDigest: plan.digest, keys: [plan.candidates[0]!.key], evidence: 'The title card names another show.', watchCarry: plex.plex, carryPauseMs: 0 })).rejects.toThrow(/remain missing; use repair-guide.ts release-list or Fix/);
    expect(arr.state.deleted).toEqual([7002]);
    expect(arr.state.grabs).toEqual([]);
    expect(arr.state.searched).toEqual([]);
    const [fix] = await t.db.select().from(fixRequests);
    expect(fix!.status).toBe('failed');
    expect(fix!.actionsTaken).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'release_grab', ok: false }), expect.objectContaining({ step: 'watch_carry', status: 'verified' })]));
    const [carry] = await t.db.select().from(watchCarries);
    expect((carry!.summary.verification as { totals: { lost: number } }).totals.lost).toBe(1);
  });

  it('an ordering switch re-matches items and the carry puts each account’s state back on its files', async () => {
    // Under TheTVDB the numbers 1/3 and 1/4 are matched to swapped episodes (Plex's guids move).
    const arr = stubSonarr({ contentOn: [[1, 1], [2, 2], [3, 3], [4, 4]] });
    const plex = fakePlex({
      files: arr.plexFiles,
      accounts: [OWNER, FRIEND_A],
      guidOf: (s, e, ordering) => (ordering === 'tvdbAiring' && s === 1 && (e === 3 || e === 4) ? `g-1-${7 - e}` : `g-${s}-${e}`),
    });
    plex.seed(FRIEND_A, 'g-1-3', { viewCount: 1 }); // watched the file on E3
    // Plex titles every item "Title g-…", which Sonarr's titles never match, so every item is expected to re-match.
    const request = { db: t.db, arr: arr.bundle, plex: plex.plex, mediaItemId: itemId, ordering: 'tvdbAiring' };
    const plan = await planShowOrdering(request);
    expect(plan.refusal).toBeNull();
    expect(plan.servers[0]).toMatchObject({ server: 'haynestower', current: '', items: 4 });
    const result = await runShowOrdering({ ...request, planDigest: plan.digest, wait: { timeoutMs: 1_000, intervalMs: 0 }, pauseMs: 0 });
    expect(plex.ordering).toBe('tvdbAiring');
    expect(result.switched).toEqual([{ server: 'haynestower', before: '', after: 'tvdbAiring', ok: true, error: null }]);
    expect(result.status).toBe('verified');
    // The file on E3 is now matched to g-1-4: A's mark is there, and no other item carries one.
    expect(plex.view(FRIEND_A, 'g-1-4')).toMatchObject({ viewCount: 1 });
    expect(plex.view(FRIEND_A, 'g-1-3')).toMatchObject({ viewCount: 0 });
  });
});
