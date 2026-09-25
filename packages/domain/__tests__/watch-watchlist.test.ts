// ADR-092 / DESIGN-051 D-03 / D-04 / D-07 (PLAN-071 S2; PRD AC-30) — Watchlist Changes against embedded Postgres
// 16 and a RECORDING FAKE plex.tv (never the real one — a live add of a title not on Plex downloads it): add on
// Plex, add not on Plex (the Seerr line), remove, already-on and already-off (no row, no write), ambiguous (a
// pool tie and two exact TMDB hits), a remove of a title not on the watchlist, no catalog match, an unconfirmed
// guid, a Plex failure (`failed`; undo closes it without a call), a write that landed despite its error, a
// non-owner (no row, no call), a retried remove, undo of an add and of a remove (exactly the inverse call), the
// undo replay, and the new actions ignored by every reader of the watch statements.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { watchMarks, type Database, type WatchMarkRow } from '@hnet/db';
import {
  computeMovieProgress,
  formatUndoResult,
  formatWatchlistChange,
  indexMarks,
  isOnWatchlist,
  ledgerExclusions,
  movieCounts,
  movieObsFromItem,
  movieProgressFields,
  parsePlexItemIds,
  recommendations,
  selectLiveMarks,
  selectRecommendInputs,
  selectWatchlist,
  titleKeyFor,
  type WatchlistChangeView,
} from '@hnet/watch';
import {
  changeWatchlist,
  replaceRecoSignals,
  undoLastChange,
  upsertWatchOwner,
  upsertWatchTitles,
  type ChangeWatchlistInput,
  type WatchTmdbSearch,
} from '../src/watch';
import { FakePlex, type FakeMovie } from './watch-fake-plex';
import { bootMigratedDb, type TestDb } from './helpers';

const OWNER = 12874060;
const ACTOR = { plexAccountId: OWNER, appUserId: null };
const NOW = new Date('2026-09-25T20:00:00Z');
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const MATRIX = '5d776825880197001ec967c0';
const DUNE3 = '64d2b1d3a8e0f2c1b0e4d3a1';
const SEV = '5d9c086c46115600200aa9b1';
const DARK = '65f1c0a2b3d4e5f601234567';
const GHOST = 'ffffffffffffffffffffffff';

let t: TestDb;
let db: Database;

beforeAll(async () => {
  t = await bootMigratedDb();
  db = t.db;
});

afterAll(async () => {
  await t.stop();
});

/** The Matrix: in history, on Plex (a Title State with `on_plex`), with its plex guid and TMDB/IMDb ids. */
function matrixMovie(): FakeMovie {
  return {
    server: 'haynesops',
    ratingKey: 'mx',
    title: 'The Matrix',
    year: 1999,
    guid: `plex://movie/${MATRIX}`,
    Guid: [{ id: 'tmdb://603' }, { id: 'imdb://tt0133093' }],
    viewCount: 1,
    lastViewedAt: Math.floor(NOW.getTime() / 1000) - 400 * 86_400,
  };
}

function world(): FakePlex {
  const fake = new FakePlex(
    [],
    [
      matrixMovie(),
      { server: 'haynesops', ratingKey: 'd21', title: 'Dune', year: 2021, guid: 'plex://movie/d21', Guid: [{ id: 'tmdb://438631' }] },
      { server: 'haynesops', ratingKey: 'd84', title: 'Dune', year: 1984, guid: 'plex://movie/d84', Guid: [{ id: 'tmdb://841' }] },
    ],
  );
  fake.now = Math.floor(NOW.getTime() / 1000);
  fake.catalog.push(
    { id: MATRIX, kind: 'movie', title: 'The Matrix', year: 1999, guids: ['tmdb://603', 'imdb://tt0133093'] },
    { id: DUNE3, kind: 'movie', title: 'Dune: Part Three', year: 2026, guids: ['tmdb://1170608', 'imdb://tt31378509'] },
    { id: SEV, kind: 'show', title: 'Severance', year: 2022, guids: ['tmdb://95396', 'tvdb://371980'] },
    { id: DARK, kind: 'show', title: 'Dark Matter', year: 2024, guids: ['tmdb://203744'] },
  );
  // plex.tv's live watchlist: Severance and Dark Matter.
  fake.watchlist.set(SEV, fake.now - 86_400);
  fake.watchlist.set(DARK, fake.now - 2 * 86_400);
  return fake;
}

async function seedMovie(fake: FakePlex, movie: FakeMovie): Promise<void> {
  const client = fake.clients().read[movie.server];
  const meta = (await client.getMetadataItem(movie.ratingKey))?.item;
  if (!meta) throw new Error('no meta');
  const ids = parsePlexItemIds(meta);
  const obs = movieObsFromItem(movie.server, meta);
  await upsertWatchTitles({
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
        genres: ['Science Fiction'],
        contentRating: null,
        isKids: false,
        onPlex: [{ server: movie.server, ratingKey: movie.ratingKey, local: false }],
        plexCounts: { [movie.server]: movieCounts(obs) },
        showStatus: null,
        ...movieProgressFields(computeMovieProgress([obs], []), [obs]),
      },
    ],
    now: NOW,
  });
}

let fake: FakePlex;
const tmdbCalls: string[] = [];

/** TMDB's `search/multi`: Dune: Part Three (a movie nothing else knows) and two exact "Shōgun" shows. */
const tmdb: WatchTmdbSearch = {
  searchMulti: async (q: string) => {
    tmdbCalls.push(q);
    const results = /dune/i.test(q)
      ? [{ id: 1170608, media_type: 'movie', title: 'Dune: Part Three', release_date: '2026-12-18' }]
      : /sh.gun/i.test(q)
        ? [
            { id: 126308, media_type: 'tv', name: 'Shōgun', first_air_date: '2024-02-27' },
            { id: 1, media_type: 'tv', name: 'Shōgun', first_air_date: '1980-09-15' },
            { id: 2, media_type: 'movie', title: 'Shogun Assassin', release_date: '1980-11-11' },
          ]
        : [];
    return { page: 1, total_pages: 1, total_results: results.length, results };
  },
};

beforeEach(async () => {
  await db.execute(sql`TRUNCATE watch_marks, watch_titles, watch_events, watch_reco_signals, watch_accounts CASCADE`);
  await upsertWatchOwner({ db, account: { id: String(OWNER), username: 'plexowner', email: null } });
  fake = world();
  for (const m of fake.movies) await seedMovie(fake, m);
  // The 15-minute cache, read ten minutes ago: Severance and Dark Matter, newest first.
  await replaceRecoSignals({
    db,
    plexAccountId: OWNER,
    source: 'watchlist',
    rows: [
      { kind: 'show', title: 'Severance', year: 2022, tmdbId: 95396, tvdbId: 371980, imdbId: null, plexGuid: `plex://show/${SEV}`, rank: 0 },
      { kind: 'show', title: 'Dark Matter', year: 2024, tmdbId: 203744, tvdbId: null, imdbId: null, plexGuid: `plex://show/${DARK}`, rank: 1 },
    ],
    fetchedAt: later(-600),
  });
  fake.calls.length = 0;
  tmdbCalls.length = 0;
});

function change(query: string, action: 'add' | 'remove', extra: Partial<ChangeWatchlistInput> = {}) {
  return changeWatchlist({ db, plex: fake.clients(), tmdb, actor: ACTOR, consumer: 'hop', query, action, now: NOW, ...extra });
}

function undo(now = NOW) {
  return undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now });
}

async function marks(): Promise<WatchMarkRow[]> {
  return db.select().from(watchMarks).orderBy(watchMarks.id);
}

async function listed(now = NOW): Promise<string[]> {
  return (await selectWatchlist(db, OWNER, { now })).entries.map((e) => e.title);
}

function spoken(out: Awaited<ReturnType<typeof change>>): string {
  if (out.status !== 'done') throw new Error(out.status);
  return formatWatchlistChange(out.view as WatchlistChangeView);
}

describe('changeWatchlist — add (D-03)', () => {
  it('a title on Plex: confirms the guid against the external-id match, one add call, one written Watch Mark', async () => {
    const out = await change('the matrix', 'add');
    expect(out).toMatchObject({ status: 'done', result: 'written', kind: 'movie', onPlex: true });
    expect(spoken(out)).toBe("Added The Matrix (1999 movie) to your watchlist. It's on Plex.");
    // The guid named the id; the match (tmdb://603) confirmed it, with userState read alongside; then the PUT.
    expect(fake.opKeys().sort()).toEqual(
      [`matchDiscover:movie:tmdb://603`, `getDiscoverUserState:${MATRIX}`, `addToWatchlist:${MATRIX}`].sort(),
    );
    expect(fake.watchlist.has(MATRIX)).toBe(true);
    const [row] = await marks();
    expect(row).toMatchObject({
      action: 'watchlist_add',
      scope: 'movie',
      kind: 'movie',
      title: 'The Matrix',
      year: 1999,
      plexGuid: `plex://movie/${MATRIX}`,
      titleKey: `plex:plex://movie/${MATRIX}`,
      tmdbId: 603,
      imdbId: 'tt0133093',
      query: 'the matrix',
      consumer: 'hop',
      flipped: [],
      plexResult: 'written',
      plexError: null,
      season: null,
      episode: null,
    });
    // D-05: the very next read shows it, although the cache predates it.
    expect(await listed()).toEqual(['The Matrix', 'Severance', 'Dark Matter']);
    // D-02 / AC-30: a watchlist change never changes the watch statements.
    expect(await selectLiveMarks(db, OWNER)).toEqual([]);
  });

  it('a title not on Plex (the TMDB fallback): plex.tv names it, the ids fill in, and the answer says Seerr will request it', async () => {
    const out = await change('Dune: Part Three', 'add');
    expect(spoken(out)).toBe(
      "Added Dune: Part Three (2026 movie) to your watchlist. It isn't on Plex yet, so Seerr will request it.",
    );
    expect(out).toMatchObject({ result: 'written', onPlex: false });
    expect(tmdbCalls).toEqual(['Dune: Part Three']);
    expect(fake.opKeys()).toEqual([
      'matchDiscover:movie:tmdb://1170608',
      `getDiscoverUserState:${DUNE3}`,
      `addToWatchlist:${DUNE3}`,
    ]);
    const [row] = await marks();
    expect(row).toMatchObject({
      action: 'watchlist_add',
      title: 'Dune: Part Three',
      year: 2026,
      tmdbId: 1170608,
      imdbId: 'tt31378509',
      plexGuid: `plex://movie/${DUNE3}`,
      titleKey: `plex:plex://movie/${DUNE3}`,
    });
  });

  it('already on the watchlist (plex.tv says so): no row, no write, and it says so', async () => {
    const out = await change('severance', 'add');
    expect(out).toMatchObject({ status: 'done', result: 'unchanged', markId: null });
    expect(spoken(out)).toBe('Severance (2022 show) is already on your watchlist.');
    // The watchlist row's own title and plex guid: no read-back, just the live state.
    expect(fake.opKeys()).toEqual([`getDiscoverUserState:${SEV}`]);
    expect(await marks()).toEqual([]);
  });

  it('when userState cannot be read, the overlaid cache decides', async () => {
    fake.failDiscoverReads.add('getDiscoverUserState');
    expect(await change('severance', 'add')).toMatchObject({ result: 'unchanged' });
    expect(await marks()).toEqual([]);
    const matrix = await change('the matrix', 'add');
    expect(matrix).toMatchObject({ result: 'written' });
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${MATRIX}`]);
  });

  it('ambiguous in the pool, or two exact TMDB hits (ruling 1): asks, no Plex call, no row', async () => {
    const dune = await change('dune', 'add');
    expect(dune.status).toBe('ambiguous');
    if (dune.status === 'ambiguous') expect(dune.options.map((o) => o.year)).toEqual([2021, 1984]);
    const shogun = await change('shogun', 'add');
    expect(shogun).toMatchObject({ status: 'ambiguous', result: 'ambiguous' });
    if (shogun.status === 'ambiguous') {
      expect(shogun.options.map((o) => [o.title, o.year, o.kind])).toEqual([
        ['Shōgun', 2024, 'show'],
        ['Shōgun', 1980, 'show'],
      ]);
    }
    expect(fake.calls).toEqual([]);
    expect(await marks()).toEqual([]);
    // A year settles it.
    expect(await change('shogun 2024', 'add')).toMatchObject({ status: 'done', result: 'not_in_catalog' });
  });

  it('no match in plex.tv\'s catalog (or no id to ask with): not in the catalog, no row, no write', async () => {
    fake.catalog.splice(fake.catalog.findIndex((x) => x.id === DUNE3), 1);
    const out = await change('dune: part three', 'add');
    expect(out).toMatchObject({ status: 'done', result: 'not_in_catalog' });
    expect(spoken(out)).toBe(
      "I found Dune: Part Three (2026 movie) but not in Plex's catalog, so your watchlist didn't change.",
    );
    expect(fake.watchlistWrites()).toEqual([]);
    expect(await marks()).toEqual([]);
  });

  it('a plex guid the external-id match does not confirm (ruling 6): nothing written', async () => {
    fake.catalog[0] = { ...fake.catalog[0]!, id: GHOST }; // tmdb://603 now names another catalog title
    const out = await change('the matrix', 'add');
    expect(out).toMatchObject({ status: 'done', result: 'unconfirmed' });
    expect(spoken(out)).toBe("I couldn't confirm The Matrix (1999 movie) in Plex's catalog, so your watchlist didn't change.");
    expect(fake.watchlistWrites()).toEqual([]);
    expect(await marks()).toEqual([]);
  });

  it('a Plex failure records `failed` (nothing overlaid); undo closes it without a call (ruling 3)', async () => {
    fake.failWatchlistWrites.add(MATRIX);
    const out = await change('the matrix', 'add');
    expect(out).toMatchObject({ status: 'done', result: 'failed' });
    expect(spoken(out)).toBe("I couldn't reach Plex, so your watchlist didn't change.");
    // The client's retries failed; plex.tv's userState, re-read once, says it did not land.
    expect(fake.opKeys().filter((k) => k.startsWith('getDiscoverUserState'))).toHaveLength(2);
    const [row] = await marks();
    expect(row).toMatchObject({ action: 'watchlist_add', plexResult: 'failed' });
    expect(row?.plexError).toMatch(/503/);
    expect(row?.plexError).not.toMatch(/token/i);
    expect(await listed()).toEqual(['Severance', 'Dark Matter']);

    fake.calls.length = 0;
    const u = await undo();
    expect(fake.calls).toEqual([]);
    expect(u).toMatchObject({ status: 'done', markId: row?.id, view: { undone: true, action: 'watchlist_add', revertResult: 'none' } });
    if (u.status === 'done') {
      expect(formatUndoResult(u.view)).toBe(
        'Your last change, adding The Matrix (1999 movie) to your watchlist, never reached Plex, so there was nothing to undo.',
      );
    }
    expect((await marks())[0]).toMatchObject({ revertedAt: NOW, revertResult: 'none' });
  });

  it('a write whose last attempt failed but that landed (ruling 4): the re-read finalizes it `written`', async () => {
    fake.failWatchlistWrites.add(MATRIX);
    fake.landFailedWatchlistWrites = true;
    const out = await change('the matrix', 'add');
    expect(out).toMatchObject({ result: 'written' });
    expect((await marks())[0]).toMatchObject({ plexResult: 'written', plexError: null });
    expect(await listed()).toContain('The Matrix');
  });

  it('a 404 on the write is "not in Plex\'s catalog": the row is finalized failed', async () => {
    // A title known only by a plex guid plex.tv has never heard of (no external id to confirm it with).
    await replaceRecoSignals({
      db,
      plexAccountId: OWNER,
      source: 'tmdb_seed',
      rows: [{ kind: 'movie', title: 'Phantom Cut', year: 2001, tmdbId: null, tvdbId: null, imdbId: null, plexGuid: `plex://movie/${GHOST}`, rank: 0, seedTitleKey: 'x', seedTitle: 'X' }],
      fetchedAt: NOW,
    });
    const out = await change('phantom cut', 'add');
    expect(out).toMatchObject({ result: 'not_in_catalog' });
    expect((await marks())[0]).toMatchObject({ plexResult: 'failed' });
  });

  it('a non-owner principal: no row and no Plex call (ADR-092 C-04)', async () => {
    await db.execute(sql`INSERT INTO watch_accounts (plex_account_id, username, role, tracked) VALUES (55501, 'kid', 'household', true)`);
    const out = await changeWatchlist({
      db,
      plex: fake.clients(),
      tmdb,
      actor: { plexAccountId: 55501, appUserId: null },
      consumer: 'oauth:abc',
      query: 'the matrix',
      action: 'add',
      now: NOW,
    });
    expect(out).toEqual({ status: 'not_owner', result: 'not_owner' });
    expect(fake.calls).toEqual([]);
    expect(tmdbCalls).toEqual([]);
    expect(await marks()).toEqual([]);
  });
});

describe('changeWatchlist — remove (D-03 step 2: only titles on the watchlist)', () => {
  it('removes a watchlist title: its own guid and name (no read-back), one remove call, the next read drops it', async () => {
    const out = await change('severance', 'remove');
    expect(spoken(out)).toBe('Removed Severance (2022 show) from your watchlist.');
    expect(fake.opKeys()).toEqual([`getDiscoverUserState:${SEV}`, `removeFromWatchlist:${SEV}`]);
    expect((await marks())[0]).toMatchObject({ action: 'watchlist_remove', scope: 'show', plexResult: 'written' });
    expect(await listed()).toEqual(['Dark Matter']);
  });

  it('a title not on the watchlist is not found there — no TMDB, no Plex call, no row', async () => {
    const out = await change('the matrix', 'remove');
    expect(out).toEqual({ status: 'not_found', result: 'not_found', kind: null });
    expect(tmdbCalls).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(await marks()).toEqual([]);
  });

  it('already off plex.tv\'s watchlist (the cache is stale): "isn\'t on", no row, no write', async () => {
    fake.watchlist.delete(DARK);
    const out = await change('dark matter', 'remove');
    expect(spoken(out)).toBe("Dark Matter (2024 show) isn't on your watchlist.");
    expect(fake.watchlistWrites()).toEqual([]);
    expect(await marks()).toEqual([]);
  });

  it('a retried remove (ruling 7) still finds the title and answers "isn\'t on" — no second row', async () => {
    await change('severance', 'remove');
    fake.calls.length = 0;
    const again = await change('severance', 'remove', { now: later(60) });
    expect(spoken(again)).toBe("Severance (2022 show) isn't on your watchlist.");
    expect(fake.watchlistWrites()).toEqual([]);
    expect(await marks()).toHaveLength(1);
    // After ten minutes the removed title is simply not on the watchlist.
    expect(await change('severance', 'remove', { now: later(11 * 60) })).toMatchObject({ status: 'not_found' });
  });
});

describe('undo of a Watchlist Change (D-04)', () => {
  it('undoing an add makes exactly the inverse call; a retried undo repeats its answer (ruling 5)', async () => {
    await change('the matrix', 'add');
    fake.calls.length = 0;
    const u = await undo(later(5));
    expect(fake.opKeys()).toEqual([`removeFromWatchlist:${MATRIX}`]);
    expect(fake.watchlist.has(MATRIX)).toBe(false);
    expect(u).toMatchObject({ status: 'done', replayed: false, view: { undone: true, action: 'watchlist_add', revertResult: 'written', onPlex: true } });
    if (u.status === 'done') expect(formatUndoResult(u.view)).toBe('Removed The Matrix (1999 movie) from your watchlist again.');
    expect((await marks())[0]).toMatchObject({ revertedAt: later(5), revertResult: 'written' });
    expect(await listed(later(5))).toEqual(['Severance', 'Dark Matter']);

    fake.calls.length = 0;
    const retried = await undo(later(20));
    expect(retried).toMatchObject({ replayed: true });
    if (retried.status === 'done' && u.status === 'done') expect(retried.view).toEqual(u.view);
    expect(fake.calls).toEqual([]);
    expect(await undo(later(40))).toMatchObject({ view: { undone: false } });
  });

  it('undoing an add of a title not on Plex says Seerr may already have requested it', async () => {
    await change('dune: part three', 'add');
    const u = await undo(later(5));
    if (u.status !== 'done') throw new Error(u.status);
    expect(formatUndoResult(u.view)).toBe(
      'Removed Dune: Part Three (2026 movie) from your watchlist again. Seerr may already have requested it.',
    );
  });

  it('undoing a remove puts it back (the inverse call); not on Plex ⇒ Seerr will request it', async () => {
    await change('dark matter', 'remove');
    fake.calls.length = 0;
    const u = await undo(later(5));
    expect(fake.opKeys()).toEqual([`addToWatchlist:${DARK}`]);
    if (u.status !== 'done') throw new Error(u.status);
    expect(formatUndoResult(u.view)).toBe('Put Dark Matter (2024 show) back on your watchlist. Seerr will request it.');
    expect(await listed(later(5))).toEqual(['Dark Matter', 'Severance']);
  });

  it('a failed inverse call leaves the change live for the next undo', async () => {
    await change('the matrix', 'add');
    fake.failWatchlistWrites.add(MATRIX);
    const u = await undo(later(5));
    if (u.status !== 'done') throw new Error(u.status);
    expect(formatUndoResult(u.view)).toBe(
      "I couldn't reach Plex, so The Matrix (1999 movie) is still on your watchlist. Say undo again to retry.",
    );
    expect((await marks())[0]).toMatchObject({ revertedAt: null, revertResult: 'failed' });
    fake.failWatchlistWrites.clear();
    expect(await undo(later(10))).toMatchObject({ view: { revertResult: 'written' } });
  });
});

describe('the new actions are not watch statements (D-07, AC-30)', () => {
  it('never reach Ever Watched, exclusions, the Taste Profile, dismissals or recommendations', async () => {
    const before = await selectRecommendInputs(db, OWNER, { now: NOW, kind: 'any' });
    const recsBefore = recommendations(before, before.marks, { kind: 'any', now: Math.floor(NOW.getTime() / 1000) });
    await change('dune: part three', 'add');
    await change('dark matter', 'remove');
    const rows = await marks();
    expect(rows.map((r) => r.action)).toEqual(['watchlist_add', 'watchlist_remove']);

    expect(await selectLiveMarks(db, OWNER)).toEqual([]);
    const index = indexMarks(rows);
    expect([...index.watched, ...index.notInterested, ...index.notMine]).toEqual([]);
    expect(ledgerExclusions([], rows)).toEqual({
      show: { mediaItemIds: [], tvdbIds: [], tmdbIds: [], imdbIds: [] },
      movie: { mediaItemIds: [], tvdbIds: [], tmdbIds: [], imdbIds: [] },
    });
    const after = await selectRecommendInputs(db, OWNER, { now: NOW, kind: 'any' });
    // The same inputs but the watchlist (Dune: Part Three on it, Dark Matter off it)…
    expect(after.marks).toEqual([]);
    const recsWith = recommendations(after, rows, { kind: 'any', now: Math.floor(NOW.getTime() / 1000) });
    const recsWithout = recommendations(after, [], { kind: 'any', now: Math.floor(NOW.getTime() / 1000) });
    // …and the marks themselves change nothing: handed the raw rows, the pipeline ignores them.
    expect(recsWith).toEqual(recsWithout);
    expect(recsBefore.onPlex.map((p) => p.candidate.title)).toEqual(recsWith.onPlex.map((p) => p.candidate.title));
    const watchlisted = (await selectWatchlist(db, OWNER, { now: NOW })).entries;
    expect(isOnWatchlist(watchlisted, { kind: 'movie', title: 'Dune: Part Three', year: 2026, tmdbId: 1170608 })).toBe(true);
    expect(isOnWatchlist(watchlisted, { kind: 'show', title: 'Dark Matter', year: 2024, tmdbId: 203744 })).toBe(false);
  });
});
