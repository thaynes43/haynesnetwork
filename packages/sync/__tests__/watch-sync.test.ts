// ADR-088 / ADR-089 / DESIGN-049 D-09 (PLAN-068 S6) — the `watch` sync mode against embedded Postgres 16,
// fake Plex servers and the REAL TautulliClient over a fetch stub: first-run backfill, the incremental
// window, change-detected allLeaves re-reads (every server that holds a moved show), 404 / 400 / `{}` →
// "gone", the Q-06 show-guid retry, per-source degradation, the watchlist replace, the 20-hour TMDB seed
// cadence, and absent / deleted movies. The sync is read-only against every source.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  mediaItems,
  watchEvents,
  watchRecoSignals,
  watchTitles,
  type Database,
  type WatchTitleRow,
} from '@hnet/db';
import {
  upsertMediaItemsBatch,
  upsertMediaMetadataBatch,
  upsertWatchOwner,
  type PlexClientBundle,
} from '@hnet/domain';
import type { TmdbPagedResults } from '@hnet/arr';
import type { PlexSectionItem } from '@hnet/plex';
import { runSync } from '../src/orchestrator';
import { runWatchSync, type WatchSyncInput, type WatchTmdb } from '../src/watch';
import { bootMigratedDb, type TestDb } from './helpers';
import {
  FakePlexServer,
  episodeRow,
  fakeTautulli,
  movieRow,
  type FakeTautulli,
  type SShow,
} from './watch-fakes';

const OWNER = 12874060;
const FRIEND = 55501234;
const NOW = new Date('2026-09-23T20:00:00Z');
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

let t: TestDb;
let db: Database;

beforeAll(async () => {
  t = await bootMigratedDb();
  db = t.db;
});

afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE watch_marks, watch_titles, watch_events, watch_reco_signals, watch_accounts, media_metadata, media_items CASCADE`,
  );
});

const BP = { title: 'Breaking Prod', ratingKey: 501, year: 2019 };
const TOONS = { title: 'Stub Toons', ratingKey: 502, year: 2020 };
const GONE = { title: 'Deleted Show', ratingKey: 4040, year: 2015 };
const FIXTURE = { title: 'The Fixture', year: 2022, guid: 'plex://movie/fixture' };

function breakingProd(): SShow {
  return {
    ratingKey: '501',
    title: 'Breaking Prod',
    year: 2019,
    guid: 'plex://show/bp',
    Guid: [{ id: 'tvdb://990001' }, { id: 'tmdb://55501' }, { id: 'imdb://tt9900010' }],
    Genre: [{ tag: 'Drama' }, { tag: 'Crime' }],
    contentRating: 'TV-MA',
    episodes: [
      { ratingKey: '50101', season: 0, episode: 1 },
      { ratingKey: '50111', season: 1, episode: 1, viewCount: 1, lastViewedAt: T('2026-01-06T02:45:00Z') },
      { ratingKey: '50112', season: 1, episode: 2, viewCount: 1, lastViewedAt: T('2026-01-07T02:45:00Z') },
      { ratingKey: '50113', season: 1, episode: 3, viewCount: 1, lastViewedAt: T('2026-01-09T02:45:00Z') },
      { ratingKey: '50121', season: 2, episode: 1, viewCount: 1, lastViewedAt: T('2026-08-30T02:45:00Z') },
      { ratingKey: '50122', season: 2, episode: 2 },
    ],
  };
}

interface World {
  ops: FakePlexServer;
  tower: FakePlexServer;
  kube: FakePlexServer;
  tautOps: FakeTautulli;
  tautTower: FakeTautulli;
  tmdbCalls: string[];
  tmdb: WatchTmdb & { failIds: Set<number> };
  input: (extra?: Partial<WatchSyncInput>) => WatchSyncInput;
}

function world(): World {
  const ops = new FakePlexServer(
    'haynesops',
    [],
    [
      { ratingKey: '6001', ...FIXTURE, Guid: [{ id: 'tmdb://880001' }], viewCount: 1, lastViewedAt: T('2026-09-20T03:40:00Z') },
      {
        ratingKey: '6002',
        title: 'Stub Runner',
        year: 2020,
        guid: 'plex://movie/runner',
        Guid: [{ id: 'tmdb://880002' }],
        viewOffset: 1_800_000,
        duration: 6_000_000,
        lastViewedAt: T('2026-09-22T04:10:00Z'),
      },
    ],
  );
  const tower = new FakePlexServer(
    'haynestower',
    [
      breakingProd(),
      {
        ratingKey: '502',
        title: 'Stub Toons',
        year: 2020,
        guid: 'plex://show/toons',
        Guid: [{ id: 'tvdb://990002' }],
        Genre: [{ tag: 'Animation' }, { tag: 'Kids' }],
        contentRating: 'TV-Y7',
        episodes: [
          { ratingKey: '50211', season: 1, episode: 1, viewCount: 1, lastViewedAt: T('2026-03-01T17:45:00Z') },
          { ratingKey: '50212', season: 1, episode: 2 },
        ],
      },
      {
        ratingKey: '503',
        title: 'Finished Show',
        year: 2015,
        guid: 'plex://show/finished',
        Guid: [{ id: 'tvdb://280619' }, { id: 'tmdb://63639' }],
        Genre: [{ tag: 'Science Fiction' }],
        episodes: [
          { ratingKey: '50311', season: 1, episode: 1, viewCount: 1, lastViewedAt: T('2025-03-01T00:00:00Z') },
          { ratingKey: '50312', season: 1, episode: 2, viewCount: 1, lastViewedAt: T('2025-03-02T00:00:00Z') },
        ],
      },
      {
        ratingKey: '504',
        title: 'Taster Show',
        year: 2000,
        guid: 'plex://show/taster',
        Guid: [{ id: 'tmdb://7777' }],
        episodes: Array.from({ length: 20 }, (_, i) => ({
          ratingKey: `504${i}`,
          season: 1,
          episode: i + 1,
          ...(i === 0 ? { viewCount: 1, lastViewedAt: T('2026-06-01T00:00:00Z') } : {}),
        })),
      },
      {
        ratingKey: '505',
        title: 'Unstarted Show',
        year: 2021,
        guid: 'plex://show/unstarted',
        episodes: [{ ratingKey: '50511', season: 1, episode: 1 }],
      },
    ],
    [{ ratingKey: '601', ...FIXTURE, Guid: [{ id: 'tmdb://880001' }], viewCount: 1, lastViewedAt: T('2026-09-20T03:40:00Z') }],
  );
  const kube = new FakePlexServer('hayneskube');
  for (const s of [ops, tower, kube]) s.owner = { id: String(OWNER), username: 'plexowner', email: 'owner@example.test' };
  ops.watchlist = [
    {
      ratingKey: 'd1',
      type: 'show',
      title: 'Stub Severance',
      year: 2022,
      guid: 'plex://show/severance',
      Guid: [{ id: 'tmdb://95396' }, { id: 'tvdb://990020' }],
      Label: [],
    },
    { ratingKey: 'd2', type: 'movie', title: 'Stub Dune', year: 2021, guid: 'plex://movie/dune', Guid: [{ id: 'tmdb://880020' }], Label: [] },
  ] as unknown as PlexSectionItem[];

  const tautTower = fakeTautulli('haynestower', [
    movieRow(OWNER, { ...FIXTURE, ratingKey: 601 }, '2025-03-01T02:00:00Z'),
    episodeRow(OWNER, BP, { ratingKey: 50111, season: 1, episode: 1 }, '2026-01-06T02:00:00Z'),
    episodeRow(OWNER, BP, { ratingKey: 50112, season: 1, episode: 2 }, '2026-01-07T02:00:00Z'),
    episodeRow(FRIEND, BP, { ratingKey: 50111, season: 1, episode: 1 }, '2026-01-08T02:00:00Z'),
    episodeRow(OWNER, BP, { ratingKey: 50113, season: 1, episode: 3 }, '2026-01-09T02:00:00Z'),
    episodeRow(OWNER, GONE, { ratingKey: 40401, season: 1, episode: 1 }, '2026-02-01T02:00:00Z'),
    episodeRow(OWNER, TOONS, { ratingKey: 50211, season: 1, episode: 1 }, '2026-03-01T17:00:00Z'),
    episodeRow(OWNER, BP, { ratingKey: 50121, season: 2, episode: 1 }, '2026-08-30T02:00:00Z'),
    { ...movieRow(OWNER, { title: 'Some Track', ratingKey: 701, year: 2001, guid: 'plex://track/x' }, '2026-09-01T00:00:00Z'), media_type: 'track' },
  ]);
  const tautOps = fakeTautulli('haynesops', [
    movieRow(OWNER, { ...FIXTURE, ratingKey: 6001 }, '2026-09-20T02:00:00Z'),
    movieRow(OWNER, { title: 'Stub Runner', ratingKey: 6002, year: 2020, guid: 'plex://movie/runner' }, '2026-09-22T02:30:00Z', 30),
    // A session playing NOW has no row id; include_activity=0 keeps it out (and the ingest skips it anyway).
    { ...movieRow(OWNER, { title: 'Stub Runner', ratingKey: 6002, year: 2020, guid: 'plex://movie/runner' }, '2026-09-23T19:50:00Z', 35), row_id: null },
  ]);
  tautTower.metadata.set('501', { guid: 'plex://show/bp' });

  const tmdbCalls: string[] = [];
  const failIds = new Set<number>();
  const page = (ids: number[], kind: 'tv' | 'movie'): TmdbPagedResults => ({
    page: 1,
    total_pages: 1,
    total_results: ids.length,
    results: ids.map((id) =>
      kind === 'tv'
        ? { id, media_type: 'tv', name: `Show ${id}`, first_air_date: '2020-01-01' }
        : { id, media_type: 'movie', title: `Movie ${id}`, release_date: '2019-05-05' },
    ),
  });
  const tmdb = {
    failIds,
    getTvRecommendations: async (id: number) => {
      tmdbCalls.push(`tv:${id}`);
      if (failIds.has(id)) throw new Error('tmdb down');
      return page([id * 10 + 1, id * 10 + 2], 'tv');
    },
    getMovieRecommendations: async (id: number) => {
      tmdbCalls.push(`movie:${id}`);
      if (failIds.has(id)) throw new Error('tmdb down');
      return page([id * 10 + 1], 'movie');
    },
  };
  const w: World = {
    ops,
    tower,
    kube,
    tautOps,
    tautTower,
    tmdbCalls,
    tmdb,
    input: (extra = {}) => ({
      db,
      plex: { read: { haynesops: ops.read(), haynestower: tower.read(), hayneskube: kube.read() } },
      tautulli: [tautOps.source, tautTower.source],
      tmdb,
      now: NOW,
      ...extra,
    }),
  };
  return w;
}

async function titles(): Promise<Map<string, WatchTitleRow>> {
  const rows = await db.select().from(watchTitles);
  return new Map(rows.map((r) => [r.title, r]));
}

async function seedLedger() {
  await upsertMediaItemsBatch({
    db,
    arrKind: 'sonarr',
    items: [
      {
        arrItemId: 1,
        tvdbId: 280619,
        title: 'Finished Show',
        sortTitle: 'finished show',
        year: 2015,
        monitored: true,
        qualityProfileId: 1,
        qualityProfileName: 'Any',
        rootFolder: '/tv',
        onDiskFileCount: 2,
        expectedFileCount: 2,
        sizeOnDisk: 1,
        arrAttrs: { status: 'ended', ended: true },
      },
    ],
  });
  const [item] = await db.select({ id: mediaItems.id }).from(mediaItems);
  if (!item) throw new Error('ledger seed failed');
  await upsertMediaMetadataBatch({ db, rows: [{ mediaItemId: item.id, genres: ['Science Fiction', 'Drama'] }] });
}

describe('watch sync — the first run backfills, later runs are incremental (D-09)', () => {
  it('writes the owner, the whole history, the Title States, the watchlist and the seeds', async () => {
    await seedLedger();
    const w = world();
    const r = await runWatchSync(w.input());

    expect(r.totalFailure).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.owner).toEqual({ plexAccountId: OWNER, username: 'plexowner', from: 'plex' });
    // The owner's movies and episodes only: no friend row, no track, no live session.
    expect(r.events).toEqual({ haynesops: 2, haynestower: 7 });
    expect(w.tautTower.requests[0]?.get('after')).toBeNull();
    expect(w.tautTower.requests[0]?.get('include_activity')).toBe('0');
    expect(w.tautTower.requests[0]?.get('grouping')).toBe('0');
    expect(w.tautTower.requests[0]?.get('user_id')).toBe(String(OWNER));

    const byTitle = await titles();
    expect(byTitle.get('Breaking Prod')).toMatchObject({
      kind: 'show',
      titleKey: 'plex:plex://show/bp',
      episodesTotal: 5, // the special is excluded
      episodesWatched: 4,
      nextSeason: 2,
      nextEpisode: 2,
      nextTitle: 'Breaking Prod 2x2',
      nextServer: 'haynestower',
      eventPlays: 4,
      isKids: false,
      onPlex: [{ server: 'haynestower', ratingKey: '501', local: false }],
    });
    expect(byTitle.get('Stub Toons')?.isKids).toBe(true);
    expect(byTitle.get('Finished Show')).toMatchObject({
      showStatus: 'ended',
      genres: ['Science Fiction', 'Drama'], // the ledger's genres first (D-16)
      plexWatched: true,
    });
    expect(byTitle.get('Finished Show')?.mediaItemId).not.toBeNull();
    expect(byTitle.get('Taster Show')).toMatchObject({ episodesWatched: 1, episodesTotal: 20 });
    expect(byTitle.has('Unstarted Show')).toBe(false);
    // The deleted show: Plex 404 on its grandparent key → no guid → an event-only title by name.
    expect(byTitle.get('Deleted Show')).toMatchObject({
      titleKey: 'name:show:deleted show|2015',
      onPlex: [],
      eventWatchedEpisodes: 1,
    });
    expect(byTitle.get('The Fixture')).toMatchObject({ kind: 'movie', plexWatched: true, eventPlays: 2 });
    expect(byTitle.get('The Fixture')?.onPlex.map((e) => e.server)).toEqual(['haynesops', 'haynestower']);
    expect(byTitle.get('Stub Runner')).toMatchObject({
      resumePercent: 30,
      nextServer: 'haynesops',
      nextRatingKey: '6002',
      plexWatched: false,
    });

    expect(r.watchlist).toBe(2);
    // Seeds: Breaking Prod (4/5), Finished Show (finished), The Fixture (watched) — not the kids' show,
    // not the Taster (1 of 20), not the Deleted Show (no TMDB id).
    expect(r.seeds).toEqual({ refreshed: true, seeds: 3, rows: 5 });
    expect(w.tmdbCalls.sort()).toEqual(['movie:880001', 'tv:55501', 'tv:63639']);
    const seedRows = await db.select().from(watchRecoSignals).where(sql`${watchRecoSignals.source} = 'tmdb_seed'`);
    expect(seedRows.every((s) => s.seedTitleKey !== null && s.seedTitle !== null)).toBe(true);
  });

  it('a second run with nothing new re-reads nothing and writes nothing', async () => {
    const w = world();
    await runWatchSync(w.input());
    const leavesBefore = w.tower.calls.filter((c) => c.startsWith('leaves:')).length;
    w.tmdbCalls.length = 0;

    const r = await runWatchSync(w.input({ now: new Date(NOW.getTime() + 15 * 60_000) }));
    expect(r.events).toEqual({ haynesops: 0, haynestower: 0 });
    // The window: the newest stored start minus three days.
    expect(w.tautTower.requests.at(-1)?.get('after')).toBe('2026-08-27');
    expect(r.shows.reread).toBe(0);
    expect(w.tower.calls.filter((c) => c.startsWith('leaves:')).length).toBe(leavesBefore);
    expect(r.titles).toMatchObject({ upserted: 0 });
    expect(r.seeds).toEqual({ refreshed: false, seeds: 0, rows: 0 });
    expect(w.tmdbCalls).toEqual([]);
  });

  it('re-reads allLeaves only for the show whose counters moved, and writes it through', async () => {
    const w = world();
    await runWatchSync(w.input());
    const bp = w.tower.shows.find((s) => s.ratingKey === '501');
    const ep = bp?.episodes.find((e) => e.ratingKey === '50122');
    if (ep) {
      ep.viewCount = 1;
      ep.lastViewedAt = T('2026-09-23T03:00:00Z');
    }
    w.tautTower.rows.push(episodeRow(OWNER, BP, { ratingKey: 50122, season: 2, episode: 2 }, '2026-09-23T02:15:00Z'));
    w.tower.calls.length = 0;

    const r = await runWatchSync(w.input({ now: new Date(NOW.getTime() + 60 * 60_000) }));
    expect(r.events.haynestower).toBe(1);
    expect(w.tower.calls.filter((c) => c.startsWith('leaves:'))).toEqual(['leaves:501']);
    expect((await titles()).get('Breaking Prod')).toMatchObject({
      episodesWatched: 5,
      plexWatched: true,
      nextSeason: null,
    });
  });

  it('re-reads a moved show on EVERY server that holds it', async () => {
    const w = world();
    const shared = (): SShow => ({
      ratingKey: 'x',
      title: 'Shared Show',
      year: 2018,
      guid: 'plex://show/shared',
      episodes: [
        { ratingKey: 'e1', season: 1, episode: 1, viewCount: 1, lastViewedAt: T('2026-09-01T00:00:00Z') },
        { ratingKey: 'e2', season: 1, episode: 2 },
      ],
    });
    w.ops.shows.push({ ...shared(), ratingKey: 'sh-ops' });
    w.tower.shows.push({ ...shared(), ratingKey: 'sh-tower' });
    await runWatchSync(w.input());
    w.ops.calls.length = 0;
    w.tower.calls.length = 0;
    const ep = w.ops.shows.find((s) => s.ratingKey === 'sh-ops')?.episodes[1];
    if (ep) {
      ep.viewCount = 1;
      ep.lastViewedAt = T('2026-09-23T00:00:00Z');
    }
    await runWatchSync(w.input({ now: new Date(NOW.getTime() + 3_600_000) }));
    expect(w.ops.calls.filter((c) => c.startsWith('leaves:'))).toEqual(['leaves:sh-ops']);
    expect(w.tower.calls.filter((c) => c.startsWith('leaves:'))).toEqual(['leaves:sh-tower']);
    expect((await titles()).get('Shared Show')).toMatchObject({ episodesWatched: 2, plexWatched: true });
  });
});

describe('watch sync — Tautulli paging and "gone" (D-09 step 2, Q-06)', () => {
  it('pages get_history 500 at a time on the first run', async () => {
    const w = world();
    w.tautTower.rows.length = 0;
    for (let i = 0; i < 1203; i += 1) {
      w.tautTower.rows.push(
        episodeRow(OWNER, BP, { ratingKey: 50111, season: 1, episode: 1 }, new Date(Date.UTC(2025, 0, 1) + i * 3_600_000).toISOString()),
      );
    }
    const r = await runWatchSync(w.input());
    expect(r.events.haynestower).toBe(1203);
    expect(w.tautTower.requests.map((p) => [p.get('start'), p.get('length'), p.get('order_dir')])).toEqual([
      ['0', '500', 'desc'],
      ['500', '500', 'desc'],
      ['1000', '500', 'desc'],
    ]);
  });

  it('a show Plex cannot answer for (Tautulli 400 or {}) stays guid-less — then a later run fills it (Q-06)', async () => {
    const w = world();
    const outage = { title: 'Outage Show', ratingKey: 777, year: 2012 };
    const older = { title: 'Old Outage', ratingKey: 888, year: 2008 };
    for (const [show, key, day] of [
      [outage, '7771', '2026-09-10'],
      [older, '8881', '2026-03-15'],
    ] as const) {
      w.tower.shows.push({
        ratingKey: String(show.ratingKey),
        title: show.title,
        year: show.year,
        guid: `plex://show/${show.ratingKey}`,
        episodes: [{ ratingKey: key, season: 1, episode: 1, viewCount: 1, lastViewedAt: T(`${day}T01:00:00Z`) }],
      });
      w.tautTower.rows.push(
        episodeRow(OWNER, show, { ratingKey: Number(key), season: 1, episode: 1 }, `${day}T00:00:00Z`),
      );
    }
    // Plex cannot answer for three shows; Tautulli answers "gone" the way current builds do (HTTP 400
    // "Unable to retrieve metadata") and the way older ones did (200 with `{}`).
    for (const k of ['777', '888', '4040']) w.tower.unreachableKeys.add(k);
    w.tautTower.metadata.set('777', 'gone400');
    w.tautTower.metadata.set('888', 'gone400');
    w.tautTower.metadata.set('4040', 'goneEmpty');
    const first = await runWatchSync(w.input());
    expect(first.showGuids.retried).toBe(0); // every pair was just asked at ingest
    const guidless = await db
      .select({ key: watchEvents.grandparentRatingKey, guid: watchEvents.showGuid })
      .from(watchEvents)
      .where(sql`${watchEvents.grandparentRatingKey} in ('777', '888', '4040')`);
    expect(guidless).toHaveLength(3);
    expect(guidless.every((e) => e.guid === null)).toBe(true);
    // Meanwhile the guid-less events link to the Plex show by its title (the Q-06 fallback).
    expect((await titles()).get('Outage Show')?.eventPlays).toBe(1);

    // Plex is back. 777 is inside the new window, so the ingest resolves it and fills the stored event; 888
    // and 4040 are older — the retry asks Plex first: 888 answers, 4040 is a 404 (truly gone).
    w.tower.unreachableKeys.clear();
    const r = await runWatchSync(w.input({ now: new Date(NOW.getTime() + 15 * 60_000) }));
    expect(r.showGuids).toEqual({ resolved: 1, retried: 2, filled: 2 });
    const rows = await db
      .select({ key: watchEvents.grandparentRatingKey, guid: watchEvents.showGuid })
      .from(watchEvents)
      .where(sql`${watchEvents.grandparentRatingKey} in ('777', '888', '4040')`)
      .orderBy(watchEvents.grandparentRatingKey);
    expect(rows).toEqual([
      { key: '4040', guid: null },
      { key: '777', guid: 'plex://show/777' },
      { key: '888', guid: 'plex://show/888' },
    ]);
    const byTitle = await titles();
    expect(byTitle.get('Outage Show')).toMatchObject({ titleKey: 'plex:plex://show/777', eventPlays: 1 });
    expect(byTitle.get('Old Outage')).toMatchObject({ titleKey: 'plex:plex://show/888', eventPlays: 1 });
  });
});

describe('watch sync — per-source degradation (D-09)', () => {
  it('one Tautulli down and one Plex server down: everything else still lands', async () => {
    const w = world();
    await runWatchSync(w.input());
    w.tautOps.down = true;
    w.tower.failing.add('listSections');
    w.tautTower.rows.push(episodeRow(OWNER, BP, { ratingKey: 50122, season: 2, episode: 2 }, '2026-09-23T02:15:00Z'));
    const r = await runWatchSync(w.input({ now: new Date(NOW.getTime() + 3_600_000) }));
    expect(r.totalFailure).toBe(false);
    expect(r.events).toEqual({ haynestower: 1 });
    expect(r.errors.map((e) => `${e.step}:${e.source}`).sort()).toEqual(['events:haynesops', 'plex:haynestower']);
    // HaynesTower's titles keep their stored state and their place on Plex.
    const bp = (await titles()).get('Breaking Prod');
    expect(bp?.onPlex).toEqual([{ server: 'haynestower', ratingKey: '501', local: false }]);
    expect(bp?.episodesTotal).toBe(5);
  });

  it('plex.tv down: a stored owner carries the run; with none stored the run is a total failure', async () => {
    const w = world();
    for (const s of [w.ops, w.tower]) s.failing.add('getOwnerAccount');
    const none = await runWatchSync(w.input());
    expect(none.totalFailure).toBe(true);
    expect(none.events).toEqual({});

    await upsertWatchOwner({ db, account: { id: String(OWNER), username: 'stored', email: null } });
    const r = await runWatchSync(w.input());
    expect(r.owner).toEqual({ plexAccountId: OWNER, username: 'stored', from: 'stored' });
    expect(r.totalFailure).toBe(false);
    expect(r.events.haynestower).toBe(7);
  });
});

describe('watch sync — the TMDB seed cadence (D-17)', () => {
  it('refreshes when older than 20 hours; a failed seed keeps its previous rows', async () => {
    const w = world();
    await runWatchSync(w.input());
    const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
    expect((await runWatchSync(w.input({ now: at(1) }))).seeds).toMatchObject({ refreshed: false });
    w.tmdb.failIds.add(55501);
    w.tmdbCalls.length = 0;
    const r = await runWatchSync(w.input({ now: at(21) }));
    expect(r.seeds).toMatchObject({ refreshed: true, seeds: 3 });
    const rows = await db.select().from(watchRecoSignals).where(sql`${watchRecoSignals.source} = 'tmdb_seed'`);
    const bpRows = rows.filter((s) => s.seedTitle === 'Breaking Prod');
    expect(bpRows).toHaveLength(2);
    expect(bpRows.every((s) => s.fetchedAt.getTime() === NOW.getTime())).toBe(true);
    expect(rows.filter((s) => s.seedTitle !== 'Breaking Prod').every((s) => s.fetchedAt.getTime() === at(21).getTime())).toBe(true);
  });

  it('skips seeds without a TMDB client', async () => {
    const w = world();
    const r = await runWatchSync(w.input({ tmdb: null }));
    expect(r.seeds).toBeNull();
  });
});

describe('watch sync — movies that left the listings', () => {
  it('a reset movie reads unwatched; a deleted one leaves that server', async () => {
    const w = world();
    w.tower.movies.push({ ratingKey: '611', title: 'Solo Movie', year: 2011, guid: 'plex://movie/solo', viewCount: 1, lastViewedAt: T('2026-05-01T00:00:00Z') });
    w.tower.movies.push({ ratingKey: '612', title: 'Doomed Movie', year: 2012, guid: 'plex://movie/doomed', viewCount: 1, lastViewedAt: T('2026-05-02T00:00:00Z') });
    await runWatchSync(w.input());
    const solo = w.tower.movies.find((m) => m.ratingKey === '611');
    if (solo) solo.viewCount = 0;
    w.tower.movies.splice(
      w.tower.movies.findIndex((m) => m.ratingKey === '612'),
      1,
    );
    await runWatchSync(w.input({ now: new Date(NOW.getTime() + 3_600_000) }));
    const byTitle = await titles();
    expect(byTitle.get('Solo Movie')).toMatchObject({ plexWatched: false, onPlex: [{ server: 'haynestower', ratingKey: '611', local: false }] });
    expect(byTitle.get('Doomed Movie')).toMatchObject({ onPlex: [] });
  });
});

describe("runSync({ mode: 'watch' }) — the orchestrator block", () => {
  it('runs the mode and returns its report; a run without an owner is a total failure', async () => {
    const w = world();
    const report = await runSync({
      mode: 'watch',
      db,
      clients: {} as never,
      plex: { read: w.input().plex.read, write: {} } as unknown as PlexClientBundle,
      watchTautulli: [w.tautTower.source],
      watchTmdb: null,
      now: NOW,
    });
    expect(report.totalFailure).toBe(false);
    expect(report.sources).toEqual([]);
    expect(report.watch?.events).toEqual({ haynestower: 7 });

    await db.execute(sql`TRUNCATE watch_marks, watch_titles, watch_events, watch_reco_signals, watch_accounts CASCADE`);
    for (const s of [w.ops, w.tower]) s.failing.add('getOwnerAccount');
    const failed = await runSync({
      mode: 'watch',
      db,
      clients: {} as never,
      plex: { read: w.input().plex.read, write: {} } as unknown as PlexClientBundle,
      now: NOW,
    });
    expect(failed.totalFailure).toBe(true);
    expect(failed.watchError).toMatch(/no Server Owner/);
  });

  it('refuses to run without a Plex bundle', async () => {
    await expect(runSync({ mode: 'watch', db, clients: {} as never })).rejects.toThrow(/Plex client bundle/);
  });
});
