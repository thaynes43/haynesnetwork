// ADR-088 / DESIGN-049 D-11..D-15 (PLAN-068 S5) — the Watch Mark flows against embedded Postgres 16 and a
// RECORDING FAKE Plex (never a real server — PLAN-068's hard rule): every mark scope, the replay rule, a
// partial Plex failure with an accurate `flipped`, not-on-Plex (and the TMDB fallback), ambiguous titles
// that write nothing, local:// copies, undo reversing EXACTLY `flipped` (collapsed to season keys, never the
// show key), dismissals that never touch Plex, and live revalidation with its budget. PR #563 review:
// truncated listings are failed reads, a failed undo retries the same mark, and only the current owner is served
// (D-03). DESIGN-051 D-15t / D-15u (amending that review's "pending marks are never undone"): undo never walks
// past a pending mark (in progress; ten minutes on, closed and its planned keys unscrobbled), and a revert is never
// stamped before its mark; the undo replay guard (DESIGN-051 D-04) repeats only a retry, so an undo after a new
// mark inside its 30 seconds undoes that mark. Live incident 2026-09-23 (D-26): specials never take part in
// a mark, no write touches an already-watched leaf, and a mark or undo leaves the next read to Plex.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { watchMarks, watchTitles, type Database, type WatchMarkFlip, type WatchTitleRow } from '@hnet/db';
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
  WatchNotReadyError,
  dismissTitle,
  markScopeOf,
  markWatched,
  planReverts,
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

const APRIL = Math.floor(Date.parse('2026-04-02T02:00:00Z') / 1000);

/**
 * The live incident's shape (2026-09-23): The Expanse with every regular episode watched (last in April) and
 * specials never watched. `unwatched` lists regular episodes to leave unwatched.
 */
function expanse(unwatched: readonly string[] = []): FakeShow {
  const regular = [1, 2, 3].flatMap((season) =>
    [1, 2].map((episode) => {
      const ratingKey = `exp-${season}-${episode}`;
      return unwatched.includes(ratingKey)
        ? { ratingKey, season, episode }
        : { ratingKey, season, episode, viewCount: 1, lastViewedAt: APRIL - (6 - (season - 1) * 2 - episode) * DAY };
    }),
  );
  return {
    server: 'haynesops',
    ratingKey: 'exp',
    title: 'The Expanse',
    year: 2015,
    guid: 'plex://show/exp',
    Guid: [{ id: 'tvdb://280619' }, { id: 'tmdb://63639' }],
    episodes: [
      { ratingKey: 'exp-0-10', season: 0, episode: 10 },
      { ratingKey: 'exp-0-28', season: 0, episode: 28 },
      ...regular,
    ],
  };
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

/** Seed ONE Title State over several copies of a show (one per server), as the sync would. */
async function seedCopies(fake: FakePlex, copies: readonly FakeShow[]): Promise<WatchTitleRow> {
  const reads = [];
  for (const copy of copies) {
    const client = fake.clients().read[copy.server];
    const leaves = (await client.listAllLeaves(copy.ratingKey)).items;
    const meta = (await client.getMetadataItem(copy.ratingKey))?.item;
    if (!meta) throw new Error('no meta');
    reads.push({ copy, leaves, meta });
  }
  fake.calls.length = 0;
  const lead = reads[0];
  if (!lead) throw new Error('no copies');
  const ids = parsePlexItemIds(lead.meta);
  const p = computeShowProgress(
    reads.map((r) => ({ server: r.copy.server, episodes: episodeObsFromLeaves(r.leaves) })),
    [],
  );
  const r = await upsertWatchTitles({
    db,
    plexAccountId: OWNER,
    titles: [
      {
        kind: 'show',
        titleKey: titleKeyFor({ kind: 'show', title: lead.copy.title, year: lead.copy.year, ...ids }),
        plexGuid: ids.plexGuid,
        tmdbId: ids.tmdbId,
        tvdbId: ids.tvdbId,
        imdbId: ids.imdbId,
        mediaItemId: null,
        title: lead.copy.title,
        year: lead.copy.year,
        genres: [],
        contentRating: null,
        isKids: false,
        onPlex: reads.map((x) => ({ server: x.copy.server, ratingKey: x.copy.ratingKey, local: false })),
        plexCounts: Object.fromEntries(reads.map((x) => [x.copy.server, showCounts(x.meta)])),
        showStatus: 'ended',
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

/** The recorded Plex writes as `op:key`, in call order. */
function writeKeys(fake: FakePlex): string[] {
  return fake.writes().map((c) => `${c.op}:${c.key}`);
}

type LeafState = { viewCount: number; lastViewedAt: number | null; viewOffset: number | null };

/** Every leaf's watch fields by `server:ratingKey` — to prove a write touched nothing but its flips. */
function leafSnapshot(fake: FakePlex): Map<string, LeafState> {
  const out = new Map<string, LeafState>();
  for (const s of fake.shows) {
    for (const e of s.episodes) {
      out.set(`${s.server}:${e.ratingKey}`, {
        viewCount: e.viewCount ?? 0,
        lastViewedAt: e.lastViewedAt ?? null,
        viewOffset: e.viewOffset ?? null,
      });
    }
  }
  return out;
}

/**
 * Only the `flipped` leaves changed. The fake, like Plex, bumps `viewCount` and re-stamps `lastViewedAt` on
 * EVERY leaf under a scrobbled key — so a show or season key written over an already-watched episode or a
 * special shows up here (D-26, live incident 2026-09-23).
 */
function expectOnlyFlippedChanged(fake: FakePlex, before: Map<string, LeafState>, flipped: readonly string[]) {
  const after = leafSnapshot(fake);
  const changed = [...after.entries()]
    .filter(([key, state]) => JSON.stringify(state) !== JSON.stringify(before.get(key)))
    .map(([key]) => key.slice(key.indexOf(':') + 1))
    .sort();
  expect(changed).toEqual([...flipped].sort());
}

describe('markWatched — whole show, replay, and an exact undo (D-14, D-15)', () => {
  it('writes season by season (never the show key, never a special), records exactly the flipped leaves, writes the Title State through', async () => {
    const show = severance();
    const fake = new FakePlex([show], movies());
    const seeded = await seedShow(fake, show);
    const before = fake.watchedState();
    const leavesBefore = leafSnapshot(fake);

    const out = await mark(fake, 'severance');
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    // Season 1 still has watched episodes, so only its unwatched S1E3 is written; season 2 is wholly
    // unwatched, so its season key flips exactly its leaves. The specials (season 0) are never written.
    expect(writeKeys(fake).sort()).toEqual(['scrobble:sev-1-3', `scrobble:${seasonKeyOf(show, 2)}`].sort());
    expect(out.view).toMatchObject({ scope: 'show', plexResult: 'written', episodes: 5, flipped: 3 });
    expect(formatMarkResult(out.view)).toBe('Marked Severance (2022) as watched in Plex, all 5 episodes.');
    expectOnlyFlippedChanged(fake, leavesBefore, ['sev-1-3', 'sev-2-1', 'sev-2-2']);

    const [row] = await marks();
    expect(row).toMatchObject({
      action: 'watched',
      scope: 'show',
      plexResult: 'written',
      consumer: 'hop',
      query: 'severance',
      titleKey: seeded.titleKey,
    });
    expect(row?.flipped.map((f) => f.ratingKey).sort()).toEqual(['sev-1-3', 'sev-2-1', 'sev-2-2']);
    const title = await titleRow(seeded.id);
    expect(title).toMatchObject({ episodesWatched: 5, episodesTotal: 5, plexWatched: true, nextSeason: null });
    // D-26: the written server's counters are dropped, so the next sync re-reads the show there.
    expect(title.plexCounts.haynesops).toBeUndefined();

    // D-14 step 7: said again within 10 minutes, nothing would flip → the same answer, no second row.
    const again = await mark(fake, 'Severance');
    expect(again).toMatchObject({ status: 'done', replayed: true, markId: row?.id });
    if (again.status === 'done') expect(again.view).toEqual(out.view);
    expect(await marks()).toHaveLength(1);
    expect(fake.writes()).toHaveLength(2);

    // D-15: undo unscrobbles exactly `flipped` — season 2 collapses to its key (all flipped), S1E3 alone
    // (S1E1/S1E2 were already watched and stay watched); never the show key, never season 0.
    fake.calls.length = 0;
    const undo = await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: NOW });
    expect(undo.status).toBe('done');
    if (undo.status !== 'done') return;
    expect(writeKeys(fake).sort()).toEqual(['unscrobble:sev-1-3', `unscrobble:${seasonKeyOf(show, 2)}`].sort());
    expect(fake.watchedState()).toEqual(before);
    expect(undo.view).toMatchObject({ undone: true, action: 'watched', revertResult: 'written', episodes: 3 });
    expect(formatUndoResult(undo.view)).toBe('Undone. Severance (2022) is back to unwatched in Plex, 3 episodes.');
    const [reverted] = await marks();
    expect(reverted?.revertedAt).toEqual(NOW);
    expect(reverted?.revertResult).toBe('written');
    const undone = await titleRow(seeded.id);
    expect(undone).toMatchObject({ episodesWatched: 2, nextSeason: 1, nextEpisode: 3 });
    expect(undone.plexCounts.haynesops).toBeUndefined();

    // The undo replay guard (DESIGN-051 D-04, D-13): a retried undo within 30 seconds (no mark made since) repeats
    // its answer and reverts nothing — no Plex call, no second revert.
    fake.calls.length = 0;
    const retried = await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: new Date(NOW.getTime() + 29_000) });
    expect(retried).toMatchObject({ status: 'done', replayed: true, markId: reverted?.id });
    if (retried.status === 'done') expect(retried.view).toEqual(undo.view);
    expect(fake.calls).toEqual([]);
    expect((await marks())[0]?.revertedAt).toEqual(NOW);

    // Nothing left to undo, once the replay window has passed.
    const none = await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: new Date(NOW.getTime() + 31_000) });
    expect(none).toMatchObject({ status: 'done', view: { undone: false } });
  });

  it('a mark that flips every regular leaf writes and undoes SEASON keys — never the show key', async () => {
    const show = silo();
    show.episodes.push(
      { ratingKey: 'silo-0-1', season: 0, episode: 1 },
      { ratingKey: 'silo-2-1', season: 2, episode: 1 },
    );
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const out = await mark(fake, 'silo');
    expect(out).toMatchObject({ status: 'done', view: { plexResult: 'written', episodes: 3, flipped: 3 } });
    expect(writeKeys(fake).sort()).toEqual(['scrobble:silo-s1', 'scrobble:silo-s2']);
    fake.calls.length = 0;
    await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: NOW });
    expect(writeKeys(fake).sort()).toEqual(['unscrobble:silo-s1', 'unscrobble:silo-s2']);
    expect(fake.watchedState()).toEqual([]);
  });
});

describe('the undo replay guard is only for a retry (DESIGN-051 D-04; PR #580 eighth pass)', () => {
  it('a second undo after a new mark within 30 seconds undoes that mark; only a third, with nothing new, is a replay', async () => {
    const sev = severance();
    const s = silo();
    const fake = new FakePlex([sev, s]);
    await seedShow(fake, sev);
    await seedShow(fake, s);
    const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
    const before = fake.watchedState();

    expect(await mark(fake, 'severance', { season: 2 })).toMatchObject({ status: 'done', view: { plexResult: 'written' } });
    const first = await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: at(5) });
    expect(first).toMatchObject({ status: 'done', replayed: false, view: { title: 'Severance', revertResult: 'written' } });
    // A new mark inside the replay window: the next undo is the owner's, never a retry of the first.
    expect(await mark(fake, 'silo', { season: 1, now: at(10) })).toMatchObject({ status: 'done', view: { plexResult: 'written' } });
    fake.calls.length = 0;
    const second = await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: at(15) });
    expect(second).toMatchObject({ status: 'done', replayed: false, view: { title: 'Silo', revertResult: 'written' } });
    if (second.status !== 'done') throw new Error(second.status);
    expect(formatUndoResult(second.view)).toBe('Undone. Season 1 of Silo (2023) is back to unwatched in Plex, 2 episodes.');
    expect(writeKeys(fake)).toEqual([`unscrobble:${seasonKeyOf(s, 1)}`]);
    expect(fake.watchedState()).toEqual(before);
    // Said again with nothing new: the replay of the second undo, not a third revert.
    fake.calls.length = 0;
    const third = await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: at(20) });
    expect(third).toMatchObject({ status: 'done', replayed: true });
    if (third.status === 'done') expect(third.view).toEqual(second.view);
    expect(fake.calls).toEqual([]);
  });
});

describe('markWatched — season, episode and through scopes (D-14 step 5)', () => {
  it.each([
    // Season 2 is wholly unwatched: its key flips exactly its leaves.
    [{ season: 2 }, ['scrobble:sev-s2'], ['sev-2-1', 'sev-2-2'], 'season', 2],
    // Season 1 has watched episodes: its key would re-stamp them, so only the unwatched S1E3 is written.
    [{ season: 1 }, ['scrobble:sev-1-3'], ['sev-1-3'], 'season', 3],
    [{ season: 1, episode: 3 }, ['scrobble:sev-1-3'], ['sev-1-3'], 'episode', 1],
    // through S2E1: season 1's unwatched S1E3 (not its key — S1E1/S1E2 are watched) + S2E1; specials untouched.
    [{ season: 2, episode: 1, through: true }, ['scrobble:sev-1-3', 'scrobble:sev-2-1'], ['sev-1-3', 'sev-2-1'], 'through', 4],
  ] as const)('%o', async (params, writes, flipped, scope, covered) => {
    const show = severance();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const before = leafSnapshot(fake);
    const out = await mark(fake, 'severance', params);
    expect(out.status).toBe('done');
    if (out.status !== 'done') return;
    expect(writeKeys(fake)).toEqual(writes);
    expect(out.view).toMatchObject({ scope, plexResult: 'written', flipped: flipped.length, episodes: covered });
    const [row] = await marks();
    expect(row?.flipped.map((f) => f.ratingKey)).toEqual(flipped);
    expectOnlyFlippedChanged(fake, before, flipped);
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
    expect(planShowWrites('haynesops', leaves, { scope: 'show', season: null, episode: null }).writes).toEqual([]);
    expect(planShowWrites('haynesops', leaves, { scope: 'season', season: 9, episode: null })).toMatchObject({
      hasScope: false,
    });
  });

  describe('planShowWrites writes a season key only when it provably covers just the flipped leaves', () => {
    const leaf = (key: string, parentIndex: number, index: number, parentRatingKey?: string, viewCount = 0) => ({
      ratingKey: key,
      title: 'x',
      parentIndex,
      index,
      ...(parentRatingKey ? { parentRatingKey } : {}),
      ...(viewCount > 0 ? { viewCount } : {}),
    });
    const plannedKeys = (leaves: Parameters<typeof planShowWrites>[1], scope: 'show' | 'season' = 'show') => {
      const spec = { scope, season: scope === 'season' ? 1 : null, episode: null };
      return planShowWrites('haynesops', leaves, spec).writes.map((w) => w.ratingKey);
    };

    it('with every leaf keyed, a wholly unwatched season goes by its key', () => {
      const leaves = [leaf('a1', 1, 1, 's1'), leaf('a2', 1, 2, 's1'), leaf('b1', 2, 1, 's2')];
      expect(plannedKeys(leaves)).toEqual(['s1', 's2']);
    });

    it('a watched leaf without parentRatingKey ⇒ episode keys only (no season key can be proven)', () => {
      // a0 may sit under s1: scrobbling s1 would re-stamp it.
      const leaves = [
        leaf('a0', 1, 1, undefined, 1),
        leaf('a1', 1, 2, 's1'),
        leaf('a2', 1, 3, 's1'),
        leaf('b1', 2, 1, 's2'),
      ];
      expect(plannedKeys(leaves)).toEqual(['a1', 'a2', 'b1']);
      expect(plannedKeys(leaves, 'season')).toEqual(['a1', 'a2']);
      // The same for a special without its key: season 2 is not written by its key either.
      expect(plannedKeys([leaf('sp', 0, 1), leaf('b1', 2, 1, 's2'), leaf('b2', 2, 2, 's2')])).toEqual(['b1', 'b2']);
    });

    it('two leaves of one season with different parentRatingKey values ⇒ episode keys only', () => {
      const leaves = [leaf('a1', 1, 1, 's1'), leaf('a2', 1, 2, 's1-other')];
      expect(plannedKeys(leaves)).toEqual(['a1', 'a2']);
      expect(plannedKeys(leaves, 'season')).toEqual(['a1', 'a2']);
    });

    it('a leaf of another season under the same key (a special) ⇒ episode keys only', () => {
      const leaves = [leaf('sp', 0, 1, 's1', 1), leaf('a1', 1, 1, 's1'), leaf('a2', 1, 2, 's1')];
      expect(plannedKeys(leaves)).toEqual(['a1', 'a2']);
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

describe('specials never take part in a mark (D-26, live incident 2026-09-23)', () => {
  it('a fully watched show with unwatched specials makes no write and answers with its regular episodes', async () => {
    const show = expanse();
    const fake = new FakePlex([show]);
    const seeded = await seedShow(fake, show);
    const out = await mark(fake, 'the expanse');
    expect(out).toMatchObject({ status: 'done', replayed: false });
    if (out.status !== 'done') return;
    expect(fake.writes()).toEqual([]);
    expect(out.view).toMatchObject({ scope: 'show', plexResult: 'written', episodes: 6, flipped: 0 });
    expect(formatMarkResult(out.view)).toBe('The Expanse (2015) was already watched in Plex, all 6 episodes.');
    const [row] = await marks();
    expect(row).toMatchObject({ plexResult: 'written', flipped: [] });
    expect(show.episodes.filter((e) => e.season === 0).map((e) => e.viewCount ?? 0)).toEqual([0, 0]);
    // Nothing was written, so nothing needs a re-read: the counters and the April dates stand.
    const title = await titleRow(seeded.id);
    expect(title.plexCounts).toEqual(seeded.plexCounts);
    expect(title.lastWatchedAt).toEqual(seeded.lastWatchedAt);
    expect(title.lastWatchedAt?.toISOString()).toBe('2026-04-02T02:00:00.000Z');
    // D-14 step 7 still applies: the repeat is a replay, not a second row.
    expect(await mark(fake, 'The Expanse')).toMatchObject({ status: 'done', replayed: true, markId: row?.id });
    expect(await marks()).toHaveLength(1);
  });

  it('a show Plex lists with specials only is noted as `none` — never "not on Plex" — and writes nothing', async () => {
    const show: FakeShow = { ...expanse(), episodes: expanse().episodes.filter((e) => e.season === 0) };
    const fake = new FakePlex([show]);
    const seeded = await seedShow(fake, show);
    const out = await mark(fake, 'the expanse');
    expect(out).toMatchObject({
      status: 'done',
      replayed: false,
      view: { scope: 'show', plexResult: 'none', flipped: 0 },
    });
    if (out.status !== 'done') return;
    expect(formatMarkResult(out.view)).toBe(
      'Noted The Expanse (2015) as watched. Plex only lists specials for it, so nothing changed there.',
    );
    expect(fake.writes()).toEqual([]);
    const [row] = await marks();
    expect(row).toMatchObject({ action: 'watched', scope: 'show', plexResult: 'none', flipped: [] });
    expect((await titleRow(seeded.id)).plexCounts).toEqual(seeded.plexCounts);
    // A repeat is a replay with the same answer; the undo has nothing to put back in Plex.
    const again = await mark(fake, 'The Expanse');
    expect(again).toMatchObject({ status: 'done', replayed: true, markId: row?.id });
    if (again.status === 'done') expect(again.view).toEqual(out.view);
    expect(await undo(fake)).toMatchObject({ view: { undone: true, revertResult: 'none', episodes: 0 } });
    expect(fake.writes()).toEqual([]);
  });

  it('two unwatched episodes that are all of season 3 → one scrobble of the season-3 key; its undo collapses to it', async () => {
    const show = expanse(['exp-3-1', 'exp-3-2']);
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const before = fake.watchedState();
    const leaves = leafSnapshot(fake);
    const out = await mark(fake, 'the expanse');
    expect(out).toMatchObject({ status: 'done', view: { plexResult: 'written', episodes: 6, flipped: 2 } });
    expect(writeKeys(fake)).toEqual([`scrobble:${seasonKeyOf(show, 3)}`]);
    const [row] = await marks();
    expect(row?.flipped).toEqual([
      { server: 'haynesops', ratingKey: 'exp-3-1' },
      { server: 'haynesops', ratingKey: 'exp-3-2' },
    ]);
    expectOnlyFlippedChanged(fake, leaves, ['exp-3-1', 'exp-3-2']);

    fake.calls.length = 0;
    const out2 = await undo(fake);
    expect(out2).toMatchObject({ view: { undone: true, revertResult: 'written', episodes: 2 } });
    expect(writeKeys(fake)).toEqual([`unscrobble:${seasonKeyOf(show, 3)}`]);
    expect(fake.watchedState()).toEqual(before);
    expectOnlyFlippedChanged(fake, leaves, []);
  });

  it('a season with a watched episode is written episode by episode — its key would re-stamp the watched one', async () => {
    const show = expanse(['exp-3-2']);
    show.episodes.push({ ratingKey: 'exp-3-3', season: 3, episode: 3 });
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const leaves = leafSnapshot(fake);
    const out = await mark(fake, 'the expanse');
    expect(out).toMatchObject({ status: 'done', view: { plexResult: 'written', episodes: 7, flipped: 2 } });
    expect(writeKeys(fake)).toEqual(['scrobble:exp-3-2', 'scrobble:exp-3-3']);
    // S3E1 keeps its one play and its April date.
    expectOnlyFlippedChanged(fake, leaves, ['exp-3-2', 'exp-3-3']);

    fake.calls.length = 0;
    await undo(fake);
    expect(writeKeys(fake)).toEqual(['unscrobble:exp-3-2', 'unscrobble:exp-3-3']);
    expectOnlyFlippedChanged(fake, leaves, []);
  });

  it('through and season scopes ignore specials; a season below 1 asks for a season and writes nothing', async () => {
    const show = expanse(['exp-3-1', 'exp-3-2']);
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const leaves = leafSnapshot(fake);
    const through = await mark(fake, 'the expanse', { season: 3, episode: 1, through: true });
    expect(through).toMatchObject({ status: 'done', view: { scope: 'through', flipped: 1, episodes: 5 } });
    expect(writeKeys(fake)).toEqual(['scrobble:exp-3-1']);
    expectOnlyFlippedChanged(fake, leaves, ['exp-3-1']);

    fake.calls.length = 0;
    expect(await mark(fake, 'the expanse', { season: 0 })).toEqual({ status: 'need_season' });
    expect(await mark(fake, 'the expanse', { season: 0, episode: 10 })).toEqual({ status: 'need_season' });
    expect(await mark(fake, 'the expanse', { season: 0, episode: 10, through: true })).toEqual({
      status: 'need_season',
    });
    expect(fake.calls).toEqual([]);
    expect(await marks()).toHaveLength(1);
    expect(markScopeOf('show', { season: 0 })).toBe('need_season');
    expect(markScopeOf('show', { season: 1 })).toEqual({ scope: 'season', season: 1, episode: null });
  });

  it('the undo of a mark made before D-26 (specials in `flipped`) puts them back by their own keys — never the show key', async () => {
    const show = expanse(['exp-3-1', 'exp-3-2']);
    const fake = new FakePlex([show]);
    const seeded = await seedShow(fake, show);
    const before = fake.watchedState();
    // What the old show-key scrobble did: every unwatched leaf, specials included, flipped.
    const legacy = ['exp-0-10', 'exp-0-28', 'exp-3-1', 'exp-3-2'];
    for (const e of show.episodes) {
      if (legacy.includes(e.ratingKey)) Object.assign(e, { viewCount: 1, lastViewedAt: NOW_S - 60 });
    }
    await db.insert(watchMarks).values({
      plexAccountId: OWNER,
      action: 'watched',
      scope: 'show',
      titleKey: seeded.titleKey,
      kind: 'show',
      title: 'The Expanse',
      year: 2015,
      plexGuid: seeded.plexGuid,
      tmdbId: seeded.tmdbId,
      tvdbId: seeded.tvdbId,
      imdbId: seeded.imdbId,
      season: null,
      episode: null,
      query: 'the expanse',
      consumer: 'hop',
      actorUserId: null,
      flipped: legacy.map((ratingKey) => ({ server: 'haynesops' as const, ratingKey })),
      plexResult: 'written',
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    const out = await undo(fake);
    expect(out).toMatchObject({ view: { undone: true, revertResult: 'written', episodes: 4 } });
    expect(writeKeys(fake).sort()).toEqual(
      ['unscrobble:exp-0-10', 'unscrobble:exp-0-28', `unscrobble:${seasonKeyOf(show, 3)}`].sort(),
    );
    expect(fake.watchedState()).toEqual(before);
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
    fake.failWrites.add(`haynesops:${seasonKeyOf(show, 1)}`);
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
    const localItem = (await fake.clients().read.haynesops.getMetadataItem('hh-ops'))?.item;
    if (!localItem) throw new Error('no local item');
    fake.calls.length = 0;
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
          plexCounts: { ...row.plexCounts, haynesops: showCounts(localItem) },
          episodeMap: row.episodeMap,
        },
      ],
    });
    expect(Object.keys((await titleRow(row.id)).plexCounts).sort()).toEqual(['haynesops', 'haynestower']);
    const out = await mark(fake, 'hazbin hotel');
    expect(out).toMatchObject({ status: 'done', view: { plexResult: 'written', flipped: 2 } });
    expect(fake.writes().map((c) => `${c.server}:${c.key}`).sort()).toEqual([
      'haynesops:hh-ops-s1',
      'haynestower:hh-tower-s1',
    ]);
    // D-26: both written servers' counters are dropped, so the next sync re-reads the show on each.
    expect((await titleRow(row.id)).plexCounts).toEqual({});
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

// ---------------------------------------------------------------------------------------------------
// PR #563 review fixes

function undo(fake: FakePlex, now = NOW) {
  return undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now });
}

describe('truncated allLeaves listings are failed reads (D-14, D-15, D-11)', () => {
  it('a truncated before-state fails the mark: no write, nothing flipped', async () => {
    const show = severance();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const before = fake.watchedState();
    // Only S0E1 is listed: planning from it would see none of the show's five regular episodes.
    fake.truncateLeavesAt = 1;

    const out = await mark(fake, 'severance');
    expect(out).toMatchObject({ status: 'done', view: { plexResult: 'failed', flipped: 0 } });
    expect(fake.writes()).toEqual([]);
    expect(fake.watchedState()).toEqual(before);
    const [row] = await marks();
    expect(row).toMatchObject({ plexResult: 'failed', flipped: [] });
    expect(row?.plexError).toMatch(/truncated/);
  });

  it('a truncated undo listing unscrobbles each flipped key and never collapses', async () => {
    const show = silo();
    show.episodes.push({ ratingKey: 'silo-1-3', season: 1, episode: 3, viewCount: 1, lastViewedAt: NOW_S - DAY });
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const before = fake.watchedState();
    await mark(fake, 'silo');
    // S1E3 was already watched, so the mark wrote S1E1 and S1E2 by their own keys.
    expect(writeKeys(fake).sort()).toEqual(['scrobble:silo-1-1', 'scrobble:silo-1-2']);
    fake.calls.length = 0;
    // The listing stops after S1E2: season 1 would look wholly flipped, and collapsing to its key would
    // unscrobble S1E3, watched before the mark.
    fake.truncateLeavesAt = 2;

    const out = await undo(fake);
    expect(out).toMatchObject({ status: 'done', view: { undone: true, revertResult: 'written', episodes: 2 } });
    expect(writeKeys(fake).sort()).toEqual(['unscrobble:silo-1-1', 'unscrobble:silo-1-2']);
    expect(fake.watchedState()).toEqual(before);
  });

  it('a truncated revalidation keeps the snapshot (the sync re-reads it)', async () => {
    const show = severance();
    const fake = new FakePlex([show]);
    const row = await seedShow(fake, show);
    const ep = show.episodes.find((e) => e.ratingKey === 'sev-1-3');
    if (ep) {
      ep.viewCount = 1;
      ep.lastViewedAt = NOW_S - 60;
    }
    fake.truncateLeavesAt = 3;
    const r = await revalidateTitles({ db, plex: fake.clients(), plexAccountId: OWNER, rows: [row], now: NOW });
    expect(r).toMatchObject({ changed: 0, failed: 1, timedOut: false });
    expect(r.rows[0]).toBe(row);
    const stored = await titleRow(row.id);
    expect(stored.plexCounts).toEqual(row.plexCounts);
    expect(stored.episodeMap).toEqual(row.episodeMap);
    expect(stored.refreshedAt).toEqual(row.refreshedAt);
  });
});

describe('a failed or partial undo is retried on the SAME mark (D-15)', () => {
  it('an unscrobble failure leaves the mark live; the next undo retries it, not the older mark', async () => {
    const show = severance();
    const fake = new FakePlex([show], movies());
    await seedShow(fake, show);
    await seedMovie(fake, fake.movies[0] as FakeMovie);
    const before = fake.watchedState();
    // An older change (the movie), then the one to undo (season 2).
    await mark(fake, 'the fixture', { now: new Date(NOW.getTime() - 3_600_000) });
    await mark(fake, 'severance', { season: 2 });
    const [older, season2] = await marks();
    fake.calls.length = 0;
    fake.failWrites.add(`haynesops:${seasonKeyOf(show, 2)}`);

    const failed = await undo(fake);
    expect(failed).toMatchObject({ markId: season2?.id, view: { undone: true, revertResult: 'failed', episodes: 0 } });
    const afterFail = await marks();
    expect(afterFail[1]).toMatchObject({ id: season2?.id, revertedAt: null, revertResult: 'failed' });
    expect(afterFail[0]).toMatchObject({ id: older?.id, revertedAt: null, revertResult: null });
    // Plex still has season 2 watched (and the movie).
    expect(fake.watchedState()).toContain('haynesops:sev-2-1');

    // "Undo" again with Plex back: the SAME mark, never the older movie.
    fake.failWrites.clear();
    fake.calls.length = 0;
    const retried = await undo(fake);
    expect(retried).toMatchObject({ markId: season2?.id, view: { undone: true, revertResult: 'written', episodes: 2 } });
    expect(fake.writes().map((c) => `${c.op}:${c.key}`)).toEqual([`unscrobble:${seasonKeyOf(show, 2)}`]);
    const afterRetry = await marks();
    expect(afterRetry[1]).toMatchObject({ revertedAt: NOW, revertResult: 'written' });
    expect(afterRetry[0]?.revertedAt).toBeNull();
    expect(fake.watchedState()).toEqual([...before, 'haynesops:fix'].sort());

    // Only now does undo reach the older change (past the 30-second replay of the retry, DESIGN-051 D-04).
    const third = await undo(fake, new Date(NOW.getTime() + 31_000));
    expect(third).toMatchObject({ markId: older?.id, view: { undone: true, revertResult: 'written' } });
    expect(fake.watchedState()).toEqual(before);
  });

  it('a partial undo records `partial`, stays live, and the retry re-issues the idempotent unscrobbles', async () => {
    const show = severance();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const before = fake.watchedState();
    await mark(fake, 'severance', { season: 2, episode: 1, through: true });
    fake.calls.length = 0;
    fake.failWrites.add('haynesops:sev-2-1');

    const partial = await undo(fake);
    expect(partial).toMatchObject({ view: { revertResult: 'partial', episodes: 1 } });
    const [row] = await marks();
    expect(row).toMatchObject({ revertedAt: null, revertResult: 'partial' });
    expect(fake.watchedState()).toEqual([...before, 'haynesops:sev-2-1'].sort());

    fake.failWrites.clear();
    fake.calls.length = 0;
    const retried = await undo(fake);
    expect(retried).toMatchObject({ markId: row?.id, view: { revertResult: 'written', episodes: 2 } });
    expect(fake.writes().map((c) => `${c.op}:${c.key}`).sort()).toEqual(['unscrobble:sev-1-3', 'unscrobble:sev-2-1']);
    expect(fake.watchedState()).toEqual(before);
    expect((await marks())[0]).toMatchObject({ revertedAt: NOW, revertResult: 'written' });
  });
});

describe('undo never walks past a pending mark (DESIGN-051 D-15t, amending D-15)', () => {
  async function insertPending(flipped: WatchMarkFlip[], createdAt: Date) {
    await db.insert(watchMarks).values({
      plexAccountId: OWNER,
      action: 'watched',
      scope: 'show',
      titleKey: 'plex:plex://show/silo',
      kind: 'show',
      title: 'Silo',
      year: 2023,
      plexGuid: 'plex://show/silo',
      tmdbId: null,
      tvdbId: 403245,
      imdbId: null,
      season: null,
      episode: null,
      query: 'silo',
      consumer: 'hop',
      actorUserId: null,
      flipped,
      plexResult: 'pending',
      createdAt,
    });
  }

  it('a lone pending mark still in flight is said to be going through: no Plex call, nothing reverted', async () => {
    const show = silo();
    show.episodes.forEach((e) => (e.viewCount = 1));
    const fake = new FakePlex([show]);
    await insertPending(
      show.episodes.map((e) => ({ server: 'haynesops', ratingKey: e.ratingKey })),
      new Date(NOW.getTime() - 1000),
    );
    const out = await undo(fake);
    if (out.status !== 'done') throw new Error(out.status);
    expect(out.view).toMatchObject({ undone: true, action: 'watched', title: 'Silo', inProgress: true });
    expect(formatUndoResult(out.view)).toBe(
      'Plex is still working on your last change, marking Silo (2023) as watched. Say undo again in a moment.',
    );
    expect(fake.calls).toEqual([]);
    expect(fake.watchedState()).toEqual(['haynesops:silo-1-1', 'haynesops:silo-1-2']);
    expect((await marks())[0]).toMatchObject({ plexResult: 'pending', revertedAt: null, revertResult: null });
  });

  it('a newer pending mark is never walked past: the older COMPLETED change is left alone', async () => {
    const show = silo();
    const fake = new FakePlex([show], movies());
    await seedMovie(fake, fake.movies[0] as FakeMovie);
    await mark(fake, 'the fixture', { now: new Date(NOW.getTime() - 3_600_000) });
    await insertPending([{ server: 'haynesops', ratingKey: 'silo-1-1' }], new Date(NOW.getTime() - 1000));
    fake.calls.length = 0;
    const out = await undo(fake);
    expect(out).toMatchObject({ view: { undone: true, title: 'Silo', inProgress: true } });
    expect(fake.calls).toEqual([]);
    const rows = await marks();
    expect(rows.map((m) => [m.title, m.plexResult, m.revertedAt])).toEqual([
      ['The Fixture', 'written', null],
      ['Silo', 'pending', null],
    ]);
    expect(fake.watchedState()).toContain('haynesops:fix');
  });

  it('an abandoned pending mark (ten minutes on) is closed and undone: its planned keys go back to unwatched', async () => {
    const show = silo();
    // Its scrobbles landed, then its replica died before the finalize.
    show.episodes.forEach((e) => (e.viewCount = 1));
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    await insertPending(
      show.episodes.map((e) => ({ server: 'haynesops', ratingKey: e.ratingKey })),
      new Date(NOW.getTime() - 10 * 60 * 1000 - 1000),
    );
    fake.calls.length = 0;
    const out = await undo(fake);
    expect(out).toMatchObject({ view: { undone: true, title: 'Silo', revertResult: 'written', episodes: 2 } });
    expect(fake.writes().map((c) => `${c.op}:${c.key}`)).toEqual(['unscrobble:silo-s1']);
    expect(fake.watchedState()).toEqual([]);
    expect((await marks())[0]).toMatchObject({
      plexResult: 'failed',
      plexError: 'unknown: never finalized',
      revertedAt: NOW,
      revertResult: 'written',
    });
  });

  it('a mark an undo closed as abandoned is left alone by its own finalize, should it ever run', async () => {
    const show = silo();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const clients = fake.clients();
    const ops = clients.write.haynesops;
    if (!ops) throw new Error('no haynesops writer');
    let entered!: () => void;
    const inWrite = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const stuck = {
      read: clients.read,
      write: {
        haynesops: {
          ...ops,
          scrobble: async (key: string) => {
            entered();
            await held;
            return ops.scrobble(key);
          },
        },
      },
    };
    const stalled = markWatched({ db, plex: stuck, actor: ACTOR, consumer: 'hop', query: 'silo', now: NOW });
    await inWrite;
    expect((await marks())[0]).toMatchObject({ plexResult: 'pending' });
    const late = new Date(NOW.getTime() + 11 * 60 * 1000);
    expect(await undo(fake, late)).toMatchObject({ view: { title: 'Silo', revertResult: 'written' } });
    release();
    await stalled;
    const [row] = await marks();
    expect(row).toMatchObject({ plexResult: 'failed', plexError: 'unknown: never finalized', revertedAt: late });
    // The Title State is not written through as watched after the undo put the keys back.
    const [title] = await db.select().from(watchTitles);
    expect(title?.episodesWatched ?? 0).toBe(0);
  });
});

describe('a revert is never stamped before its change (DESIGN-051 D-15u)', () => {
  it('an undo whose clock reads before the mark it picks stamps the mark\'s own time, so a retry is a replay', async () => {
    const fake = new FakePlex([], movies());
    await seedMovie(fake, fake.movies[0] as FakeMovie);
    // The undo read its clock at +11 s, then waited on the lock while the mark (at +12 s) was made.
    await mark(fake, 'the fixture', { now: new Date(NOW.getTime() + 12_000) });
    fake.calls.length = 0;
    const out = await undo(fake, new Date(NOW.getTime() + 11_000));
    expect(out).toMatchObject({ replayed: false, view: { title: 'The Fixture', revertResult: 'written' } });
    expect((await marks())[0]).toMatchObject({ revertedAt: new Date(NOW.getTime() + 12_000) });
    fake.calls.length = 0;
    expect(await undo(fake, new Date(NOW.getTime() + 13_000))).toMatchObject({ replayed: true });
    expect(fake.calls).toEqual([]);
  });
});

describe('planReverts — season keys only, and only when every leaf names its season (D-15, D-26)', () => {
  const leaf = (ratingKey: string, parentIndex: number, index: number, parentRatingKey?: string) => ({
    ratingKey,
    title: 'x',
    parentIndex,
    index,
    ...(parentRatingKey ? { parentRatingKey } : {}),
  });
  const flips = (...keys: string[]): WatchMarkFlip[] => keys.map((ratingKey) => ({ server: 'haynesops', ratingKey }));

  it('collapses to the season keys whose every leaf flipped — never the show key, never season 0', () => {
    const leaves = [leaf('sp1', 0, 1, 's0'), leaf('a1', 1, 1, 's1'), leaf('a2', 1, 2, 's1'), leaf('b1', 2, 1, 's2')];
    expect(planReverts('haynesops', flips('a1', 'a2', 'b1'), leaves).map((p) => p.ratingKey)).toEqual(['s1', 's2']);
    expect(planReverts('haynesops', flips('a1', 'a2'), leaves).map((p) => p.ratingKey)).toEqual(['s1']);
    // Every leaf flipped (a mark made before D-26 flipped the specials too): the regular seasons collapse,
    // the special goes back by its own key — no call covers the show.
    expect(planReverts('haynesops', flips('sp1', 'a1', 'a2', 'b1'), leaves).map((p) => p.ratingKey)).toEqual([
      's1',
      's2',
      'sp1',
    ]);
  });

  it('unscrobbles per flipped key when any leaf lacks parentRatingKey', () => {
    // b0 has no season key: it may belong to s1, so s1 cannot be proven fully flipped.
    const leaves = [leaf('a1', 1, 1, 's1'), leaf('a2', 1, 2, 's1'), leaf('b0', 1, 3)];
    expect(planReverts('haynesops', flips('a1', 'a2'), leaves).map((p) => p.ratingKey)).toEqual(['a1', 'a2']);
    expect(planReverts('haynesops', flips('a1', 'a2', 'b0'), leaves).map((p) => p.ratingKey)).toEqual([
      'a1',
      'a2',
      'b0',
    ]);
  });
});

describe('undo never touches an episode added after the mark (D-15)', () => {
  it.each([
    ['in the same season', { ratingKey: 'silo-1-3', season: 1, episode: 3 }, ['unscrobble:silo-1-1', 'unscrobble:silo-1-2']],
    ['in a new season', { ratingKey: 'silo-2-1', season: 2, episode: 1 }, ['unscrobble:silo-s1']],
  ] as const)('%s', async (_label, added, writes) => {
    const show = silo();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    await mark(fake, 'silo');
    // After the mark, a new episode arrives and is watched (by the owner or the children).
    show.episodes.push({ ...added, viewCount: 1, lastViewedAt: NOW_S });
    fake.calls.length = 0;
    const out = await undo(fake);
    expect(out).toMatchObject({ view: { revertResult: 'written', episodes: 2 } });
    expect(fake.writes().map((c) => `${c.op}:${c.key}`).sort()).toEqual([...writes].sort());
    expect(fake.watchedState()).toEqual([`haynesops:${added.ratingKey}`]);
  });
});

describe('the write-through leaves the next read to Plex (D-26, live incident 2026-09-23)', () => {
  it("mark then undo: the written server's counters are dropped (the other's kept) and the dates round-trip", async () => {
    const ops = expanse(['exp-3-2']);
    const tower: FakeShow = {
      ...expanse(['exp-3-2']),
      server: 'haynestower',
      ratingKey: 'expt',
      episodes: expanse(['exp-3-2']).episodes.map((e) => ({ ...e, ratingKey: e.ratingKey.replace('exp-', 'expt-') })),
    };
    const fake = new FakePlex([ops, tower]);
    const seeded = await seedCopies(fake, [ops, tower]);
    expect(Object.keys(seeded.plexCounts).sort()).toEqual(['haynesops', 'haynestower']);
    expect(seeded.lastWatchedAt?.toISOString()).toBe('2026-04-01T02:00:00.000Z');

    await mark(fake, 'the expanse');
    // The preferred matched copy only (view-state sync carries it).
    expect(fake.writes().map((c) => `${c.server}:${c.op}:${c.key}`)).toEqual(['haynesops:scrobble:exp-3-2']);
    const marked = await titleRow(seeded.id);
    expect(marked.plexCounts).toEqual({ haynestower: seeded.plexCounts.haynestower });
    // The flipped episode reads as watched now — as Plex stamps it.
    expect(marked).toMatchObject({ episodesWatched: 6, plexWatched: true, lastWatchedAt: NOW });

    fake.calls.length = 0;
    await undo(fake);
    expect(writeKeys(fake)).toEqual(['unscrobble:exp-3-2']);
    const undone = await titleRow(seeded.id);
    expect(undone.plexCounts).toEqual({ haynestower: seeded.plexCounts.haynestower });
    // No container write re-stamped a watched episode, so the undo's live read still carries April.
    expect(undone.lastWatchedAt).toEqual(seeded.lastWatchedAt);
    expect(undone.plexLastViewedAt).toEqual(seeded.plexLastViewedAt);
    expect(undone).toMatchObject({ episodesWatched: 5, plexWatched: false, nextSeason: 3, nextEpisode: 2 });

    // Plex's show counters are back exactly where they were — the change detector alone would never look
    // again. The dropped counters make the next live revalidation (D-11) re-read the leaves (and the next
    // sync too: packages/sync watch-sync.test.ts) and store fresh ones.
    fake.calls.length = 0;
    const r = await revalidateTitles({ db, plex: fake.clients(), plexAccountId: OWNER, rows: [undone], now: NOW });
    expect(fake.calls.map((c) => `${c.op}:${c.key}`)).toEqual(['getMetadataItem:exp', 'listAllLeaves:exp']);
    expect(r.rows[0]?.plexCounts).toEqual(seeded.plexCounts);
  });

  it('an undo whose unscrobbles all fail still drops the counters: one may have landed after its timeout', async () => {
    const show = expanse(['exp-3-1', 'exp-3-2']);
    const fake = new FakePlex([show]);
    const seeded = await seedShow(fake, show);
    await mark(fake, 'the expanse');
    // A revalidation between the mark and the undo stores fresh counters again.
    const rows = [await titleRow(seeded.id)];
    await revalidateTitles({ db, plex: fake.clients(), plexAccountId: OWNER, rows, now: NOW });
    expect((await titleRow(seeded.id)).plexCounts.haynesops).toMatchObject({ viewedLeafCount: 6 });

    fake.failWrites.add(`haynesops:${seasonKeyOf(show, 3)}`);
    expect(await undo(fake)).toMatchObject({ view: { revertResult: 'failed', episodes: 0 } });
    const title = await titleRow(seeded.id);
    expect(title.plexCounts.haynesops).toBeUndefined();
    expect(title).toMatchObject({ episodesWatched: 6, plexWatched: true });
  });

  it("a movie's written server takes the applied state as its counters, so the sync re-checks a disagreeing Plex", async () => {
    const fake = new FakePlex([], movies());
    const fixture = await seedMovie(fake, fake.movies[0] as FakeMovie);
    expect(fixture.plexCounts.haynesops).toEqual({ leafCount: 1, viewedLeafCount: 0, lastViewedAt: null });

    await mark(fake, 'the fixture');
    expect((await titleRow(fixture.id)).plexCounts.haynesops).toEqual({
      leafCount: 1,
      viewedLeafCount: 1,
      lastViewedAt: NOW_S,
    });

    // A failed undo changes nothing: the counters still say watched there (the sync's absent-movie check
    // re-reads a movie that left the watched listing while its counters say watched).
    fake.failWrites.add('haynesops:fix');
    expect(await undo(fake)).toMatchObject({ view: { revertResult: 'failed' } });
    expect(await titleRow(fixture.id)).toMatchObject({
      plexWatched: true,
      plexCounts: { haynesops: { viewedLeafCount: 1 } },
    });

    fake.failWrites.clear();
    expect(await undo(fake)).toMatchObject({ view: { revertResult: 'written' } });
    const undone = await titleRow(fixture.id);
    expect(undone.plexCounts.haynesops).toEqual({ leafCount: 1, viewedLeafCount: 0, lastViewedAt: null });
    expect(undone).toMatchObject({ plexWatched: false, lastWatchedAt: null });
  });
});

describe('the flows serve only the current owner (D-03)', () => {
  it('a demoted account is refused before any Plex call or write — mark, dismiss, undo, revalidate', async () => {
    const show = severance();
    const fake = new FakePlex([show]);
    const row = await seedShow(fake, show);
    await dismissTitle({ db, actor: ACTOR, consumer: 'hop', query: 'severance', now: NOW });
    // A new Server Owner: OWNER becomes a `household` row.
    await upsertWatchOwner({ db, account: { id: '999', username: 'other', email: null } });
    const marksBefore = await marks();
    const titleBefore = await titleRow(row.id);
    const plex = fake.clients();

    const refused: Array<() => Promise<unknown>> = [
      () => markWatched({ db, plex, actor: ACTOR, consumer: 'hop', query: 'severance', now: NOW }),
      () => dismissTitle({ db, actor: ACTOR, consumer: 'hop', query: 'severance', reason: 'not_mine', now: NOW }),
      () => undoLastChange({ db, plex, actor: ACTOR, now: NOW }),
      () => revalidateTitles({ db, plex, plexAccountId: OWNER, rows: [row], now: NOW }),
    ];
    for (const call of refused) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WatchNotReadyError);
      expect((error as Error).message).toBe("Watch history isn't ready yet.");
    }
    expect(fake.calls).toEqual([]);
    expect(await marks()).toEqual(marksBefore);
    expect(await titleRow(row.id)).toEqual(titleBefore);
  });

  it('an account with no row at all is refused too', async () => {
    const fake = new FakePlex([silo()]);
    await expect(
      markWatched({ db, plex: fake.clients(), actor: { plexAccountId: 4242, appUserId: null }, consumer: 'hop', query: 'silo', now: NOW }),
    ).rejects.toBeInstanceOf(WatchNotReadyError);
    expect(await marks()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

// ADR-091 C-04 / DESIGN-050 D-07 (PLAN-069 S4) — the mark flows act for ANY tracked account, and Plex write-back
// stays OWNER-ONLY: a household account reached through its user's connector records `watched` in its history
// only (plex_result `none`, nothing flipped) and never causes a single Plex call — not a read, not a write, not
// an unscrobble on undo. Untracked accounts are still refused; live revalidation stays owner-only.
describe('a tracked non-owner account (ADR-091 C-04): history only, never Plex', () => {
  const HOUSE = 55501;
  const HOUSE_ACTOR = { plexAccountId: HOUSE, appUserId: null };

  async function household(tracked = true): Promise<void> {
    await db.execute(
      sql`INSERT INTO watch_accounts (plex_account_id, username, role, tracked) VALUES (${HOUSE}, 'kid', 'household', ${tracked})`,
    );
  }

  /** The household account's own Title State for Severance (what its history would hold). */
  async function seedHouseholdSeverance(): Promise<void> {
    await upsertWatchTitles({
      db,
      plexAccountId: HOUSE,
      titles: [
        {
          kind: 'show',
          titleKey: titleKeyFor({ kind: 'show', title: 'Severance', year: 2022, plexGuid: 'plex://show/sev', tmdbId: 95396, tvdbId: 371980, imdbId: 'tt11280740' }),
          plexGuid: 'plex://show/sev',
          tmdbId: 95396,
          tvdbId: 371980,
          imdbId: 'tt11280740',
          mediaItemId: null,
          title: 'Severance',
          year: 2022,
          genres: [],
          contentRating: null,
          isKids: false,
          onPlex: [{ server: 'haynesops', ratingKey: 'sev', local: false }],
          plexCounts: {},
          showStatus: 'continuing',
          ...showProgressFields(computeShowProgress([], [])),
        },
      ],
    });
  }

  it('mark_watched records the mark in history with plex_result none and makes ZERO Plex calls', async () => {
    await household();
    await seedHouseholdSeverance();
    const fake = new FakePlex([severance()]);
    const out = await markWatched({ db, plex: fake.clients(), actor: HOUSE_ACTOR, consumer: 'oauth:abc', query: 'severance', now: NOW });
    expect(out).toMatchObject({ status: 'done', replayed: false });
    if (out.status !== 'done') throw new Error(out.status);
    expect(out.view).toMatchObject({ plexResult: 'none', flipped: 0, historyOnly: true, title: 'Severance', year: 2022 });
    expect(formatMarkResult(out.view)).toBe(
      "Noted Severance (2022) as watched in your history. Only the server owner's marks change Plex.",
    );
    expect(fake.calls).toEqual([]);
    const [mark] = await marks();
    expect(mark).toMatchObject({ plexAccountId: HOUSE, action: 'watched', plexResult: 'none', flipped: [], consumer: 'oauth:abc' });
    // The owner's history is untouched.
    expect((await marks()).filter((m) => m.plexAccountId === OWNER)).toEqual([]);
  });

  it('a season / episode mark reads the same way; a repeat within 10 minutes is a replay (no second row)', async () => {
    await household();
    await seedHouseholdSeverance();
    const fake = new FakePlex([severance()]);
    const plex = fake.clients();
    const season = await markWatched({ db, plex, actor: HOUSE_ACTOR, consumer: 'oauth:abc', query: 'severance', season: 2, now: NOW });
    if (season.status !== 'done') throw new Error(season.status);
    expect(formatMarkResult(season.view)).toBe(
      "Noted season 2 of Severance (2022) as watched in your history. Only the server owner's marks change Plex.",
    );
    const again = await markWatched({ db, plex, actor: HOUSE_ACTOR, consumer: 'oauth:abc', query: 'severance', season: 2, now: new Date(NOW.getTime() + 60_000) });
    expect(again).toMatchObject({ status: 'done', replayed: true, markId: season.markId });
    expect(await marks()).toHaveLength(1);
    expect(fake.calls).toEqual([]);
  });

  it('dismiss works for the household account (never Plex, as for the owner)', async () => {
    await household();
    await seedHouseholdSeverance();
    const fake = new FakePlex([severance()]);
    const out = await dismissTitle({ db, actor: HOUSE_ACTOR, consumer: 'oauth:abc', query: 'severance', reason: 'not_mine', now: NOW });
    if (out.status !== 'done') throw new Error(out.status);
    expect(formatDismissResult(out.view)).toContain('Severance (2022)');
    expect((await marks())[0]).toMatchObject({ plexAccountId: HOUSE, action: 'not_mine', plexResult: 'none' });
    expect(fake.calls).toEqual([]);
  });

  it('undo of a history-only mark makes no Plex call and answers as a plain undo', async () => {
    await household();
    await seedHouseholdSeverance();
    const fake = new FakePlex([severance()]);
    const plex = fake.clients();
    await markWatched({ db, plex, actor: HOUSE_ACTOR, consumer: 'oauth:abc', query: 'severance', now: NOW });
    const undo = await undoLastChange({ db, plex, actor: HOUSE_ACTOR, now: new Date(NOW.getTime() + 120_000) });
    if (undo.status !== 'done') throw new Error(undo.status);
    expect(undo.view).toMatchObject({ undone: true, revertResult: 'none', episodes: 0 });
    expect(formatUndoResult(undo.view)).toBe('Undone. Severance (2022) is no longer marked as watched.');
    expect(fake.calls).toEqual([]);
    expect((await marks())[0]!.revertedAt).not.toBeNull();
  });

  it("even a household mark row that claims flips is never unscrobbled with the owner's tokens", async () => {
    await household();
    const fake = new FakePlex([severance()]);
    await db.execute(sql`
      INSERT INTO watch_marks (plex_account_id, action, scope, title_key, kind, title, year, query, consumer, flipped, plex_result, created_at)
      VALUES (${HOUSE}, 'watched', 'show', 'plex:plex://show/sev', 'show', 'Severance', 2022, 'severance', 'oauth:abc',
              ${JSON.stringify([{ server: 'haynesops', ratingKey: 'sev-1-3' }])}::jsonb, 'written', ${NOW})`);
    const undo = await undoLastChange({ db, plex: fake.clients(), actor: HOUSE_ACTOR, now: new Date(NOW.getTime() + 1000) });
    expect(undo).toMatchObject({ status: 'done', view: { undone: true, revertResult: 'none' } });
    expect(fake.calls).toEqual([]);
  });

  it('an UNTRACKED household account is refused before anything — mark, dismiss, undo', async () => {
    await household(false);
    const fake = new FakePlex([severance()]);
    const plex = fake.clients();
    for (const call of [
      () => markWatched({ db, plex, actor: HOUSE_ACTOR, consumer: 'oauth:abc', query: 'severance', now: NOW }),
      () => dismissTitle({ db, actor: HOUSE_ACTOR, consumer: 'oauth:abc', query: 'severance', now: NOW }),
      () => undoLastChange({ db, plex, actor: HOUSE_ACTOR, now: NOW }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(WatchNotReadyError);
    }
    expect(fake.calls).toEqual([]);
    expect(await marks()).toEqual([]);
  });

  it("live revalidation stays owner-only — it reads Plex with the owner's tokens", async () => {
    await household();
    const fake = new FakePlex([severance()]);
    await expect(revalidateTitles({ db, plex: fake.clients(), plexAccountId: HOUSE, rows: [], now: NOW })).rejects.toBeInstanceOf(
      WatchNotReadyError,
    );
    expect(fake.calls).toEqual([]);
  });

  it('the owner still writes Plex exactly as before (the hop path is unchanged)', async () => {
    await household();
    const show = severance();
    const fake = new FakePlex([show]);
    await seedShow(fake, show);
    const out = await markWatched({ db, plex: fake.clients(), actor: ACTOR, consumer: 'hop', query: 'severance', season: 1, now: NOW });
    if (out.status !== 'done') throw new Error(out.status);
    expect(out.view.historyOnly).toBeUndefined();
    expect(out.view.plexResult).toBe('written');
    expect(fake.writes().length).toBeGreaterThan(0);
  });
});
