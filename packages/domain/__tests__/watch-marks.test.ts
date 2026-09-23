// ADR-088 / DESIGN-049 D-11..D-15 (PLAN-068 S5) — the Watch Mark flows against embedded Postgres 16 and a
// RECORDING FAKE Plex (never a real server — PLAN-068's hard rule): every mark scope, the replay rule, a
// partial Plex failure with an accurate `flipped`, not-on-Plex (and the TMDB fallback), ambiguous titles
// that write nothing, local:// copies, undo reversing EXACTLY `flipped` (collapsed to show/season keys),
// dismissals that never touch Plex, and live revalidation with its budget.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { watchMarks, watchTitles, type Database, type WatchTitleRow } from '@hnet/db';
import {
  computeMovieProgress,
  computeShowProgress,
  episodeObsFromLeaves,
  formatDismissResult,
  formatMarkResult,
  formatUndoResult,
  movieCounts,
  movieObsFromItem,
  movieProgressFields,
  parsePlexItemIds,
  plexGenres,
  showCounts,
  showProgressFields,
  titleKeyFor,
} from '@hnet/watch';
import {
  dismissTitle,
  markWatched,
  planShowWrites,
  replaceRecoSignals,
  revalidateTitles,
  undoLastChange,
  upsertWatchOwner,
  upsertWatchTitles,
  type WatchTmdbSearch,
} from '../src/watch';
import { FakePlex, seasonKeyOf, type FakeMovie, type FakeShow } from './watch-fake-plex';
import { bootMigratedDb, type TestDb } from './helpers';

const OWNER = 12874060;
const ACTOR = { plexAccountId: OWNER, appUserId: null };
const NOW = new Date('2026-09-23T20:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;

function severance(): FakeShow {
  return {
    server: 'haynesops',
    ratingKey: 'sev',
    title: 'Severance',
    year: 2022,
    guid: 'plex://show/sev',
    Guid: [{ id: 'tvdb://371980' }, { id: 'tmdb://95396' }, { id: 'imdb://tt11280740' }],
    Genre: [{ tag: 'Drama' }, { tag: 'Science Fiction' }],
    contentRating: 'TV-MA',
    episodes: [
      { ratingKey: 'sev-0-1', season: 0, episode: 1 },
      { ratingKey: 'sev-1-1', season: 1, episode: 1, viewCount: 1, lastViewedAt: NOW_S - 10 * DAY },
      { ratingKey: 'sev-1-2', season: 1, episode: 2, viewCount: 1, lastViewedAt: NOW_S - 9 * DAY },
      { ratingKey: 'sev-1-3', season: 1, episode: 3 },
      { ratingKey: 'sev-2-1', season: 2, episode: 1 },
      { ratingKey: 'sev-2-2', season: 2, episode: 2 },
    ],
  };
}

function silo(): FakeShow {
  return {
    server: 'haynesops',
    ratingKey: 'silo',
    title: 'Silo',
    year: 2023,
    guid: 'plex://show/silo',
    Guid: [{ id: 'tvdb://403245' }],
    episodes: [
      { ratingKey: 'silo-1-1', season: 1, episode: 1 },
      { ratingKey: 'silo-1-2', season: 1, episode: 2 },
    ],
  };
}

function movies(): FakeMovie[] {
  return [
    { server: 'haynesops', ratingKey: 'fix', title: 'The Fixture', year: 2022, guid: 'plex://movie/fix', Guid: [{ id: 'tmdb://880001' }] },
    {
      server: 'haynesops',
      ratingKey: 'run',
      title: 'Stub Runner',
      year: 2020,
      guid: 'plex://movie/run',
      Guid: [{ id: 'tmdb://880002' }],
      viewCount: 1,
      lastViewedAt: NOW_S - 3 * DAY,
    },
  ];
}

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
  await db.execute(sql`TRUNCATE watch_marks, watch_titles, watch_events, watch_reco_signals, watch_accounts CASCADE`);
  await upsertWatchOwner({ db, account: { id: String(OWNER), username: 'plexowner', email: null } });
});

/** Seed a show's Title State the way the `watch` sync would (from the fake's current state). */
async function seedShow(fake: FakePlex, show: FakeShow, opts: { local?: boolean } = {}): Promise<WatchTitleRow> {
  const client = fake.clients().read[show.server];
  const leaves = (await client.listAllLeaves(show.ratingKey)).items;
  const meta = (await client.getMetadataItem(show.ratingKey))?.item;
  fake.calls.length = 0;
  if (!meta) throw new Error('no meta');
  const ids = parsePlexItemIds(meta);
  const p = computeShowProgress([{ server: show.server, episodes: episodeObsFromLeaves(leaves) }], []);
  const r = await upsertWatchTitles({
    db,
    plexAccountId: OWNER,
    titles: [
      {
        kind: 'show',
        titleKey: titleKeyFor({ kind: 'show', title: show.title, year: show.year, ...ids }),
        plexGuid: ids.plexGuid,
        tmdbId: ids.tmdbId,
        tvdbId: ids.tvdbId,
        imdbId: ids.imdbId,
        mediaItemId: null,
        title: show.title,
        year: show.year,
        genres: plexGenres(meta),
        contentRating: meta.contentRating ?? null,
        isKids: false,
        onPlex: [{ server: show.server, ratingKey: show.ratingKey, local: opts.local ?? false }],
        plexCounts: { [show.server]: showCounts(meta) },
        showStatus: 'continuing',
        ...showProgressFields(p),
      },
    ],
  });
  const row = r.rows[0];
  if (!row) throw new Error('seed failed');
  return row;
}

async function seedMovie(fake: FakePlex, movie: FakeMovie): Promise<WatchTitleRow> {
  const client = fake.clients().read[movie.server];
  const meta = (await client.getMetadataItem(movie.ratingKey))?.item;
  fake.calls.length = 0;
  if (!meta) throw new Error('no meta');
  const ids = parsePlexItemIds(meta);
  const obs = movieObsFromItem(movie.server, meta);
  const r = await upsertWatchTitles({
    db,
    plexAccountId: OWNER,
    titles: [
      {
        kind: 'movie',
        titleKey: titleKeyFor({ kind: 'movie', title: movie.title, year: movie.year, ...ids }),
        plexGuid: ids.plexGuid,
        tmdbId: ids.tmdbId,
        tvdbId: null,
        imdbId: ids.imdbId,
        mediaItemId: null,
        title: movie.title,
        year: movie.year,
        genres: [],
        contentRating: null,
        isKids: false,
        onPlex: [{ server: movie.server, ratingKey: movie.ratingKey, local: false }],
        plexCounts: { [movie.server]: movieCounts(obs) },
        showStatus: null,
        ...movieProgressFields(computeMovieProgress([obs], []), [obs]),
      },
    ],
  });
  const row = r.rows[0];
  if (!row) throw new Error('seed failed');
  return row;
}

async function marks() {
  return db.select().from(watchMarks).orderBy(watchMarks.id);
}

async function titleRow(id: number): Promise<WatchTitleRow> {
  const [row] = await db.select().from(watchTitles).where(sql`${watchTitles.id} = ${id}`);
  if (!row) throw new Error(`no title ${id}`);
  return row;
}

function mark(fake: FakePlex, query: string, extra: Record<string, unknown> = {}) {
  return markWatched({ db, plex: fake.clients(), actor: ACTOR, consumer: 'hop', query, now: NOW, ...extra });
}

describe('markWatched — whole show, replay, and an exact undo (D-14, D-15)', () => {
  it('scrobbles the show key once, records exactly the flipped leaves, writes the Title State through', async () => {
    const show = severance();
    const fake = new FakePlex([show], movies());
    const seeded = await seedShow(fake, show);
    const before = fake.watchedState();

    const out = await mark(fake, 'severance');
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    expect(fake.writes()).toEqual([{ server: 'haynesops', op: 'scrobble', key: 'sev' }]);
    expect(out.view).toMatchObject({ scope: 'show', plexResult: 'written', episodes: 5, flipped: 4 });
    expect(formatMarkResult(out.view)).toBe('Marked Severance (2022) as watched in Plex, all 5 episodes.');

    const [row] = await marks();
    expect(row).toMatchObject({
      action: 'watched',
      scope: 'show',
      plexResult: 'written',
      consumer: 'hop',
      query: 'severance',
      titleKey: seeded.titleKey,
    });
    expect(row?.flipped.map((f) => f.ratingKey).sort()).toEqual(['sev-0-1', 'sev-1-3', 'sev-2-1', 'sev-2-2']);
    const title = await titleRow(seeded.id);
    expect(title).toMatchObject({ episodesWatched: 5, episodesTotal: 5, plexWatched: true, nextSeason: null });

    // D-14 step 7: said again within 10 minutes, nothing would flip → the same answer, no second row.
    const again = await mark(fake, 'Severance');
    expect(again).toMatchObject({ status: 'done', replayed: true, markId: row?.id });
    if (again.status === 'done') expect(again.view).toEqual(out.view);
    expect(await marks()).toHaveLength(1);
    expect(fake.writes()).toHaveLength(1);

    // D-15: undo unscrobbles exactly `flipped` — season 0 and season 2 collapse to their keys (all
    // flipped), S1E3 alone (S1E1/S1E2 were already watched and stay watched).
    fake.calls.length = 0;
    const undo = await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: NOW });
    expect(undo.status).toBe('done');
    if (undo.status !== 'done') return;
    expect(fake.writes().map((c) => `${c.op}:${c.key}`).sort()).toEqual(
      ['unscrobble:sev-1-3', `unscrobble:${seasonKeyOf(show, 0)}`, `unscrobble:${seasonKeyOf(show, 2)}`].sort(),
    );
    expect(fake.watchedState()).toEqual(before);
    expect(undo.view).toMatchObject({ undone: true, action: 'watched', revertResult: 'written', episodes: 4 });
    expect(formatUndoResult(undo.view)).toBe('Undone. Severance (2022) is back to unwatched in Plex, 4 episodes.');
    const [reverted] = await marks();
    expect(reverted?.revertedAt).toEqual(NOW);
    expect(reverted?.revertResult).toBe('written');
    expect(await titleRow(seeded.id)).toMatchObject({ episodesWatched: 2, nextSeason: 1, nextEpisode: 3 });

    // Nothing left to undo.
    const none = await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: NOW });
    expect(none).toMatchObject({ status: 'done', view: { undone: false } });
  });

  it('undo collapses to the SHOW key when the mark flipped every leaf', async () => {
    const show = silo();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    await mark(fake, 'silo');
    fake.calls.length = 0;
    await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: NOW });
    expect(fake.writes()).toEqual([{ server: 'haynesops', op: 'unscrobble', key: 'silo' }]);
    expect(fake.watchedState()).toEqual([]);
  });
});

describe('markWatched — season, episode and through scopes (D-14 step 5)', () => {
  it.each([
    [{ season: 2 }, ['scrobble:sev-s2'], ['sev-2-1', 'sev-2-2'], 'season', 2],
    [{ season: 1, episode: 3 }, ['scrobble:sev-1-3'], ['sev-1-3'], 'episode', 1],
    // through S2E1: season 1's key (it has an unwatched episode) + S2E1; specials untouched.
    [{ season: 2, episode: 1, through: true }, ['scrobble:sev-s1', 'scrobble:sev-2-1'], ['sev-1-3', 'sev-2-1'], 'through', 4],
  ] as const)('%o', async (params, writes, flipped, scope, covered) => {
    const show = severance();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const out = await mark(fake, 'severance', params);
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    expect(fake.writes().map((c) => `${c.op}:${c.key}`)).toEqual(writes);
    expect(out.view).toMatchObject({ scope, plexResult: 'written', flipped: flipped.length, episodes: covered });
    const [row] = await marks();
    expect(row?.flipped.map((f) => f.ratingKey)).toEqual(flipped);
    expect(show.episodes.find((e) => e.season === 0)?.viewCount ?? 0).toBe(0);
  });

  it('plans only writes that flip something', () => {
    const show = severance();
    show.episodes.forEach((e) => (e.viewCount = 1));
    const leaves = show.episodes.map((e) => ({
      ratingKey: e.ratingKey,
      title: 'x',
      index: e.episode,
      parentIndex: e.season,
      parentRatingKey: seasonKeyOf(show, e.season),
      viewCount: 1,
    }));
    expect(planShowWrites('haynesops', 'sev', leaves, { scope: 'show', season: null, episode: null }).writes).toEqual([]);
    expect(planShowWrites('haynesops', 'sev', leaves, { scope: 'season', season: 9, episode: null })).toMatchObject({
      hasScope: false,
    });
  });

  it('a season Plex does not have is recorded as not on Plex, with no write', async () => {
    const show = severance();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const out = await mark(fake, 'severance', { season: 9 });
    expect(out).toMatchObject({ status: 'done', view: { plexResult: 'not_on_plex', scope: 'season', season: 9 } });
    expect(fake.writes()).toEqual([]);
  });

  it('an episode without its season asks for the season and writes nothing', async () => {
    const show = severance();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    expect(await mark(fake, 'severance', { episode: 3 })).toEqual({ status: 'need_season' });
    expect(await marks()).toEqual([]);
    expect(fake.writes()).toEqual([]);
  });
});

describe('markWatched — movies (D-14)', () => {
  it('scrobbles an unwatched movie and answers "already watched" (no write) for a watched one', async () => {
    const fake = new FakePlex([], movies());
    const fixture = await seedMovie(fake, fake.movies[0] as FakeMovie);
    await seedMovie(fake, fake.movies[1] as FakeMovie);

    const out = await mark(fake, 'the fixture');
    expect(out).toMatchObject({ status: 'done', view: { scope: 'movie', plexResult: 'written', flipped: 1 } });
    expect(fake.writes()).toEqual([{ server: 'haynesops', op: 'scrobble', key: 'fix' }]);
    expect(await titleRow(fixture.id)).toMatchObject({ plexWatched: true, resumePercent: null });

    fake.calls.length = 0;
    const watched = await mark(fake, 'stub runner');
    expect(fake.writes()).toEqual([]);
    expect(watched.status).toBe('done');
    if (watched.status === 'done') {
      expect(watched.view).toMatchObject({ plexResult: 'written', flipped: 0 });
      expect(formatMarkResult(watched.view)).toBe('Stub Runner (2020) was already watched in Plex.');
    }
  });
});

describe('markWatched — partial and failed Plex writes (D-14 step 6)', () => {
  it('records only what flipped; undo then reverts exactly that', async () => {
    const show = severance();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const before = fake.watchedState();
    fake.failWrites.add('haynesops:sev-2-1');

    const out = await mark(fake, 'severance', { season: 2, episode: 1, through: true });
    expect(out).toMatchObject({ status: 'done', view: { plexResult: 'partial', flipped: 1 } });
    const [row] = await marks();
    expect(row?.plexResult).toBe('partial');
    expect(row?.flipped).toEqual([{ server: 'haynesops', ratingKey: 'sev-1-3' }]);
    expect(row?.plexError).toMatch(/503/);
    if (out.status === 'done') expect(formatMarkResult(out.view)).toMatch(/only part of it reached Plex/);

    fake.calls.length = 0;
    fake.failWrites.clear();
    await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: NOW });
    // Season 1 is NOT collapsed: S1E1/S1E2 were already watched and were not flipped.
    expect(fake.writes().map((c) => `${c.op}:${c.key}`)).toEqual(['unscrobble:sev-1-3']);
    expect(fake.watchedState()).toEqual(before);
  });

  it('every write failing records the mark as failed with nothing flipped', async () => {
    const show = silo();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    fake.failWrites.add('haynesops:silo');
    const out = await mark(fake, 'silo');
    expect(out).toMatchObject({ status: 'done', view: { plexResult: 'failed', flipped: 0 } });
    const [row] = await marks();
    expect(row).toMatchObject({ plexResult: 'failed', flipped: [] });
    expect(fake.watchedState()).toEqual([]);
  });
});

describe('markWatched — titles not on Plex (D-13, D-14)', () => {
  it('a watchlist-only title is noted as not on Plex without a write; a repeat is a replay', async () => {
    const fake = new FakePlex([severance()]);
    await replaceRecoSignals({
      db,
      plexAccountId: OWNER,
      source: 'watchlist',
      rows: [{ kind: 'show', title: 'Dark Matter', year: 2024, tmdbId: 1234, tvdbId: null, imdbId: null, plexGuid: 'plex://show/dm', rank: 0 }],
    });
    const out = await mark(fake, 'dark matter');
    expect(out).toMatchObject({ status: 'done', view: { plexResult: 'not_on_plex' } });
    if (out.status === 'done') {
      expect(formatMarkResult(out.view)).toBe(
        "Noted Dark Matter (2024) as watched. It isn't on Plex, so only your history changed.",
      );
    }
    expect(fake.writes()).toEqual([]);
    expect(await mark(fake, 'Dark Matter')).toMatchObject({ status: 'done', replayed: true });
    expect(await marks()).toHaveLength(1);
  });

  it('falls back to ONE TMDB search, accepting only an exact title', async () => {
    const fake = new FakePlex([]);
    const calls: string[] = [];
    const tmdb: WatchTmdbSearch = {
      searchMulti: async (q: string) => {
        calls.push(q);
        return {
          page: 1,
          total_pages: 1,
          total_results: 2,
          results: [
            { id: 9, media_type: 'person', name: 'The Night Agent' },
            { id: 5, media_type: 'tv', name: 'The Night Agent', first_air_date: '2023-03-23' },
          ],
        };
      },
    };
    const out = await mark(fake, 'The Night Agent 2023', { tmdb });
    expect(calls).toEqual(['The Night Agent']);
    expect(out).toMatchObject({ status: 'done', view: { kind: 'show', year: 2023, plexResult: 'not_on_plex' } });
    const [row] = await marks();
    expect(row).toMatchObject({ tmdbId: 5, titleKey: 'tmdb:show:5' });

    expect(await mark(fake, 'night agent returns', { tmdb })).toEqual({ status: 'not_found', kind: null });
  });

  it('an ambiguous title asks and writes nothing — no mark, no Plex call', async () => {
    const fake = new FakePlex(
      [],
      [
        { server: 'haynesops', ratingKey: 'd1', title: 'Dune', year: 2021, guid: 'plex://movie/d21' },
        { server: 'haynesops', ratingKey: 'd2', title: 'Dune', year: 1984, guid: 'plex://movie/d84' },
      ],
    );
    await seedMovie(fake, fake.movies[0] as FakeMovie);
    await seedMovie(fake, fake.movies[1] as FakeMovie);
    const out = await mark(fake, 'dune');
    expect(out.status).toBe('ambiguous');
    if (out.status === 'ambiguous') expect(out.options.map((o) => o.year)).toEqual([2021, 1984]);
    expect(fake.calls).toEqual([]);
    expect(await marks()).toEqual([]);
  });
});

describe('markWatched — unmatched local:// copies (ADR-088)', () => {
  it('writes the matched copy AND every local copy (view-state sync skips local items)', async () => {
    const local: FakeShow = { ...silo(), ratingKey: 'hh-ops', title: 'Hazbin Hotel', guid: 'local://42', Guid: [] };
    local.episodes = [{ ratingKey: 'hh-ops-1', season: 1, episode: 1 }];
    const matched: FakeShow = {
      server: 'haynestower',
      ratingKey: 'hh-tower',
      title: 'Hazbin Hotel',
      year: 2023,
      guid: 'plex://show/hh',
      episodes: [{ ratingKey: 'hh-tower-1', season: 1, episode: 1 }],
    };
    const fake = new FakePlex([local, matched]);
    const row = await seedShow(fake, matched);
    await upsertWatchTitles({
      db,
      plexAccountId: OWNER,
      titles: [
        {
          ...row,
          genres: row.genres,
          onPlex: [
            { server: 'haynesops', ratingKey: 'hh-ops', local: true },
            { server: 'haynestower', ratingKey: 'hh-tower', local: false },
          ],
          episodeMap: row.episodeMap,
        },
      ],
    });
    const out = await mark(fake, 'hazbin hotel');
    expect(out).toMatchObject({ status: 'done', view: { plexResult: 'written', flipped: 2 } });
    expect(fake.writes().map((c) => `${c.server}:${c.key}`).sort()).toEqual([
      'haynesops:hh-ops',
      'haynestower:hh-tower',
    ]);
  });
});

describe('dismissTitle (D-15) — never touches Plex', () => {
  it('records not_interested / not_mine with no Plex call; undo of a dismissal makes none either', async () => {
    const show = severance();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const out = await dismissTitle({ db, actor: ACTOR, consumer: 'hop', query: 'severance', now: NOW });
    expect(out).toMatchObject({ status: 'done', view: { reason: 'not_interested', title: 'Severance' } });
    if (out.status === 'done') {
      expect(formatDismissResult(out.view)).toBe("Got it. I won't suggest Severance (2022) again.");
    }
    expect(await dismissTitle({ db, actor: ACTOR, consumer: 'hop', query: 'severance', now: NOW })).toMatchObject({
      replayed: true,
    });
    const rows = await marks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'not_interested', plexResult: 'none', flipped: [] });

    const mine = await dismissTitle({
      db,
      actor: ACTOR,
      consumer: 'hop',
      query: 'severance',
      reason: 'not_mine',
      now: NOW,
    });
    expect(mine).toMatchObject({ status: 'done', replayed: false, view: { reason: 'not_mine' } });

    const undo = await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: NOW });
    expect(undo).toMatchObject({ status: 'done', view: { undone: true, action: 'not_mine', revertResult: null } });
    if (undo.status === 'done') {
      expect(formatUndoResult(undo.view)).toBe('Undone. Severance (2022) counts as your viewing again.');
    }
    expect(fake.calls).toEqual([]);
  });

  it('undo reaches back 24 hours only', async () => {
    const fake = new FakePlex([severance()]);
    await seedShow(fake, fake.shows[0] as FakeShow);
    await dismissTitle({
      db,
      actor: ACTOR,
      consumer: 'hop',
      query: 'severance',
      now: new Date(NOW.getTime() - 25 * 3_600_000),
    });
    expect(await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: NOW })).toMatchObject({
      view: { undone: false },
    });
  });
});

describe('revalidateTitles (D-11)', () => {
  it('re-reads a show whose counters moved and writes it through; an unchanged show is left alone', async () => {
    const show = severance();
    const fake = new FakePlex([show]);
    const row = await seedShow(fake, show);
    const plex = fake.clients();

    const same = await revalidateTitles({ db, plex, plexAccountId: OWNER, rows: [row], now: NOW });
    expect(same).toMatchObject({ changed: 0, timedOut: false });
    expect(fake.calls.map((c) => c.op)).toEqual(['getMetadataItem']);

    const ep = show.episodes.find((e) => e.ratingKey === 'sev-1-3');
    if (ep) {
      ep.viewCount = 1;
      ep.lastViewedAt = NOW_S - 60;
    }
    const moved = await revalidateTitles({ db, plex, plexAccountId: OWNER, rows: [row], now: NOW });
    expect(moved.changed).toBe(1);
    expect(moved.rows[0]).toMatchObject({
      id: row.id,
      episodesWatched: 3,
      nextSeason: 2,
      nextEpisode: 1,
      nextTitle: 'Severance 2x1',
    });
    expect(moved.rows[0]?.plexCounts.haynesops).toMatchObject({ viewedLeafCount: 3 });
  });

  it('answers from the snapshot when the budget runs out', async () => {
    const show = severance();
    const fake = new FakePlex([show]);
    const row = await seedShow(fake, show);
    fake.readDelayMs = 200;
    const r = await revalidateTitles({
      db,
      plex: fake.clients(),
      plexAccountId: OWNER,
      rows: [row],
      budgetMs: 30,
      now: NOW,
    });
    expect(r).toMatchObject({ changed: 0, timedOut: true });
    expect(r.rows[0]).toBe(row);
  });

  it('recomputes a movie from its resume server', async () => {
    const movie: FakeMovie = {
      server: 'haynestower',
      ratingKey: 'm1',
      title: 'Halfway',
      year: 2019,
      guid: 'plex://movie/half',
      duration: 6_000_000,
      viewOffset: 1_800_000,
      lastViewedAt: NOW_S - DAY,
    };
    const fake = new FakePlex([], [movie]);
    const row = await seedMovie(fake, movie);
    expect(row).toMatchObject({ resumePercent: 30, nextServer: 'haynestower', nextRatingKey: 'm1' });
    movie.viewCount = 1;
    delete movie.viewOffset;
    movie.lastViewedAt = NOW_S - 60;
    const r = await revalidateTitles({ db, plex: fake.clients(), plexAccountId: OWNER, rows: [row], now: NOW });
    expect(r.changed).toBe(1);
    expect(r.rows[0]).toMatchObject({ plexWatched: true, resumePercent: null, nextServer: null });
  });
});
