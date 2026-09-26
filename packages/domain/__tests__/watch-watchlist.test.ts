// ADR-092 / DESIGN-051 D-03 / D-04 / D-07 (PLAN-071 S2; PRD AC-30) — Watchlist Changes against embedded Postgres
// 16 and a RECORDING FAKE plex.tv (never the real one — a live add of a title not on Plex downloads it): add on
// Plex, add not on Plex (the Seerr line), remove, already-on and already-off (no row, no write), ambiguous (a
// pool tie, two exact TMDB hits, two watchlist titles of one name), a remove of a title not on the watchlist, no
// catalog match, an unconfirmed guid, a Plex failure (`failed`; its undo removes a failed add anyway and leaves a
// failed remove as it is), a change that could not even be sent (still recorded, so undo closes IT), an outcome
// plex.tv never confirms (`unknown:`), a write that landed despite its error, a non-owner (no row, no call), a
// retried remove, undo of an add and of a remove (exactly the inverse call), the undo replay, two undos at once,
// and the new actions ignored by every reader of the watch statements (DESIGN-051 D-15: the PR #580 rulings).
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
  type WatchPlexClients,
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

/** The one Watch Mark, asserting there is exactly one (PR #580 ruling 11: a stray second row must fail). */
async function onlyMark(): Promise<WatchMarkRow> {
  const rows = await marks();
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error('no watch mark');
  return row;
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
    const all = await marks();
    expect(all).toHaveLength(1);
    const [row] = all;
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
    const all = await marks();
    expect(all).toHaveLength(1);
    const [row] = all;
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
    expect(out).toMatchObject({ status: 'done', result: 'unchanged', markId: null, onPlex: false });
    // Severance is not on Plex here, so the Seerr sentence rides along (D-15j).
    expect(spoken(out)).toBe(
      "Severance (2022 show) is already on your watchlist. It isn't on Plex yet, so Seerr will request it if it hasn't already.",
    );
    // The watchlist row's own title and plex guid: no read-back, just the live state.
    expect(fake.opKeys()).toEqual([`getDiscoverUserState:${SEV}`]);
    expect(await marks()).toEqual([]);
    // A title on Plex: just "already on".
    fake.watchlist.set(MATRIX, fake.now);
    expect(spoken(await change('the matrix', 'add'))).toBe('The Matrix (1999 movie) is already on your watchlist.');
  });

  it('a retried add of a title not on Plex, and one plex.tv never confirmed, still say Seerr will request it (D-15j)', async () => {
    // The first add landed, but its answer was lost (HA's trailing tools/list failed): the retry hears "already on".
    expect(await change('dune: part three', 'add')).toMatchObject({ result: 'written', onPlex: false });
    const retry = await change('dune: part three', 'add', { now: later(5) });
    expect(retry).toMatchObject({ status: 'done', result: 'unchanged', onPlex: false, markId: null });
    expect(spoken(retry)).toBe(
      "Dune: Part Three (2026 movie) is already on your watchlist. It isn't on Plex yet, so Seerr will request it if it hasn't already.",
    );
    expect(fake.watchlistWrites()).toEqual([`addToWatchlist:${DUNE3}`]);
    expect(await marks()).toHaveLength(1);

    // An add plex.tv never confirmed may have landed, and may download.
    await db.execute(sql`TRUNCATE watch_marks`);
    fake.watchlist.delete(DUNE3);
    fake.failWatchlistWrites.add(DUNE3);
    fake.landFailedWatchlistWrites = true;
    const shortRead = { ...fake.clients().read.haynesops, getDiscoverUserState: async () => ({ watchlistedAt: null }) };
    fake.failDiscoverReads.add('getDiscoverUserState'); // the write-budget re-read gets no answer
    const unknown = await change('dune: part three', 'add', { now: later(60), reads: { read: { haynesops: shortRead } } });
    expect(unknown).toMatchObject({ status: 'done', result: 'unknown', onPlex: false });
    expect(spoken(unknown)).toBe(
      "Plex didn't answer in time, so I can't tell whether Dune: Part Three (2026 movie) changed. It isn't on Plex yet, so if it was added, Seerr will request it.",
    );
    expect(fake.watchlist.has(DUNE3)).toBe(true); // it did land
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

  it('a Plex failure records `failed` (nothing overlaid); undo removes the title anyway, a removal being safe (rulings 3, 2)', async () => {
    fake.failWatchlistWrites.add(MATRIX);
    const out = await change('the matrix', 'add');
    expect(out).toMatchObject({ status: 'done', result: 'failed' });
    expect(spoken(out)).toBe("I couldn't reach Plex, so your watchlist didn't change.");
    // The client's retries failed; plex.tv's userState, re-read once, says it did not land.
    expect(fake.opKeys().filter((k) => k.startsWith('getDiscoverUserState'))).toHaveLength(2);
    const rows = await marks();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ action: 'watchlist_add', plexResult: 'failed' });
    expect(row?.plexError).toMatch(/503/);
    expect(row?.plexError).not.toMatch(/token/i);
    expect(await listed()).toEqual(['Severance', 'Dark Matter']);

    // PR #580 ruling 2: a failed add that went out may have landed — its undo sends the (idempotent, never
    // downloading) removal anyway, and the re-read settles it.
    fake.calls.length = 0;
    const u = await undo();
    expect(fake.watchlistWrites()).toEqual([`removeFromWatchlist:${MATRIX}`]);
    expect(u).toMatchObject({
      status: 'done',
      markId: row?.id,
      view: { undone: true, action: 'watchlist_add', revertResult: 'written', watchlistOutcome: 'cleared' },
    });
    if (u.status === 'done') {
      expect(formatUndoResult(u.view)).toBe(
        "Your last change, adding The Matrix (1999 movie) to your watchlist, may not have reached Plex, so I made sure it's off your watchlist.",
      );
    }
    expect(await onlyMark()).toMatchObject({ revertedAt: NOW, revertResult: 'written' });
  });

  it('a change that could not even be sent is still recorded, so "undo that" closes it, not an older change (ruling 1)', async () => {
    const removed = await change('severance', 'remove');
    expect(removed).toMatchObject({ result: 'written' });
    fake.failDiscoverReads.add('matchDiscover');
    const out = await change('dune: part three', 'add', { now: later(60) });
    expect(out).toMatchObject({ status: 'done', result: 'failed' });
    expect(spoken(out)).toBe("I couldn't reach Plex, so your watchlist didn't change.");
    const rows = await marks();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ action: 'watchlist_add', plexResult: 'failed', plexGuid: null, title: 'Dune: Part Three' });
    expect(rows[1]?.plexError).toMatch(/^not sent: /);
    expect(fake.watchlistWrites()).toEqual([`removeFromWatchlist:${SEV}`]);

    fake.calls.length = 0;
    const u = await undo(later(90));
    expect(u).toMatchObject({ markId: rows[1]?.id, view: { action: 'watchlist_add', revertResult: 'none', watchlistOutcome: 'not_sent' } });
    if (u.status === 'done') {
      expect(formatUndoResult(u.view)).toBe(
        'Your last change, adding Dune: Part Three (2026 movie) to your watchlist, never reached Plex, so there was nothing to undo.',
      );
    }
    // No call at all: Severance's remove (the older change) was not reverted.
    expect(fake.calls).toEqual([]);
    expect((await marks()).map((m) => m.revertedAt)).toEqual([null, later(90)]);
    expect(fake.watchlist.has(SEV)).toBe(false);
  });

  it('with no Plex client the change is recorded as not sent, too', async () => {
    const out = await changeWatchlist({ db, plex: { read: {}, write: {} }, tmdb, actor: ACTOR, consumer: 'hop', query: 'the matrix', action: 'add', now: NOW });
    expect(out).toMatchObject({ result: 'failed' });
    const rows = await marks();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.plexError).toBe('not sent: Error: no Plex client for the watchlist');
  });

  it('an outcome plex.tv never confirms (ruling 2): recorded failed/unknown, said as such; the re-read used the WRITE budget', async () => {
    fake.failWatchlistWrites.add(MATRIX);
    // The short-budget readers answer userState only with an error; the write bundle's reader works until told not to.
    const shortCalls: string[] = [];
    const shortRead = {
      ...fake.clients().read.haynesops,
      getDiscoverUserState: (id: string) => {
        shortCalls.push(id);
        return Promise.reject(new Error('short budget timed out'));
      },
    };
    fake.failDiscoverReads.add('getDiscoverUserState'); // the write bundle's re-read fails too
    const out = await change('the matrix', 'add', { reads: { read: { haynesops: shortRead } } });
    expect(out).toMatchObject({ status: 'done', result: 'unknown' });
    expect(spoken(out)).toBe("Plex didn't answer in time, so I can't tell whether The Matrix (1999 movie) changed.");
    // One short-budget read (before the write, the cache then decided); the re-read went to the write bundle.
    expect(shortCalls).toEqual([MATRIX]);
    expect(fake.opKeys().filter((k) => k.startsWith('getDiscoverUserState'))).toEqual([`getDiscoverUserState:${MATRIX}`]);
    const rows = await marks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plexResult: 'failed' });
    expect(rows[0]?.plexError).toMatch(/^unknown: /);

    // Its undo sends the removal; when that cannot be confirmed either, the same words, and the change stays live.
    const u = await undo(later(5));
    if (u.status !== 'done') throw new Error(u.status);
    expect(u.view).toMatchObject({ revertResult: 'failed', watchlistOutcome: 'unknown' });
    expect(formatUndoResult(u.view)).toBe("Plex didn't answer in time, so I can't tell whether The Matrix (1999 movie) changed.");
    expect(await onlyMark()).toMatchObject({ revertedAt: null, revertResult: 'failed' });
  });

  it('a failed add stays in the remove pool for ten minutes, where plex.tv\'s live state decides (ruling 2)', async () => {
    fake.failWatchlistWrites.add(MATRIX);
    fake.landFailedWatchlistWrites = true; // it DID land…
    fake.failDiscoverReads.add('getDiscoverUserState'); // …but the re-read could not tell
    expect(await change('the matrix', 'add')).toMatchObject({ result: 'unknown' });
    expect(fake.watchlist.has(MATRIX)).toBe(true);
    expect(await listed()).toEqual(['Severance', 'Dark Matter']); // a failed change never overlays
    fake.failWatchlistWrites.clear();
    fake.failDiscoverReads.clear();
    const out = await change('the matrix', 'remove', { now: later(120) });
    expect(spoken(out)).toBe('Removed The Matrix (1999 movie) from your watchlist.');
    expect(fake.watchlist.has(MATRIX)).toBe(false);
  });

  it('a write whose last attempt failed but that landed (ruling 4): the re-read finalizes it `written`', async () => {
    fake.failWatchlistWrites.add(MATRIX);
    fake.landFailedWatchlistWrites = true;
    const out = await change('the matrix', 'add');
    expect(out).toMatchObject({ result: 'written' });
    expect(await onlyMark()).toMatchObject({ plexResult: 'written', plexError: null });
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
    expect(await onlyMark()).toMatchObject({ plexResult: 'failed' });
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
  it('one spoken title, two watchlist titles with different discover ids: ambiguous, nothing written (ruling 6)', async () => {
    const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    fake.catalog.push({ id: OTHER, kind: 'show', title: 'Dark Matter', year: 2024, guids: ['tmdb://999001'] });
    fake.watchlist.set(OTHER, fake.now);
    await replaceRecoSignals({
      db,
      plexAccountId: OWNER,
      source: 'watchlist',
      rows: [
        { kind: 'show', title: 'Dark Matter', year: 2024, tmdbId: 203744, tvdbId: null, imdbId: null, plexGuid: `plex://show/${DARK}`, rank: 0 },
        { kind: 'show', title: 'Dark Matter', year: 2024, tmdbId: 999001, tvdbId: null, imdbId: null, plexGuid: `plex://show/${OTHER}`, rank: 1 },
      ],
      fetchedAt: later(-600),
    });
    for (const action of ['remove', 'add'] as const) {
      const out = await change('dark matter', action);
      expect(out, action).toMatchObject({ status: 'ambiguous', result: 'ambiguous' });
      if (out.status === 'ambiguous') expect(out.options).toHaveLength(2);
    }
    // Asked before anything else: even with no Plex client, no "not sent" row is written for a guess.
    expect(await change('dark matter', 'remove', { plex: { read: {}, write: {} } })).toMatchObject({ status: 'ambiguous' });
    expect(fake.calls).toEqual([]);
    expect(await marks()).toEqual([]);
  });

  it('removes a watchlist title: its own guid and name (no read-back), one remove call, the next read drops it', async () => {
    const out = await change('severance', 'remove');
    expect(spoken(out)).toBe('Removed Severance (2022 show) from your watchlist.');
    expect(fake.opKeys()).toEqual([`getDiscoverUserState:${SEV}`, `removeFromWatchlist:${SEV}`]);
    expect(await onlyMark()).toMatchObject({ action: 'watchlist_remove', scope: 'show', plexResult: 'written' });
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
    expect(await onlyMark()).toMatchObject({ revertedAt: later(5), revertResult: 'written' });
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

  it('undoing a failed remove makes NO call (its inverse, an add, could download) and leaves the watchlist as it is', async () => {
    fake.failWatchlistWrites.add(DARK);
    expect(await change('dark matter', 'remove')).toMatchObject({ result: 'failed' });
    fake.failWatchlistWrites.clear();
    fake.calls.length = 0;
    const u = await undo(later(5));
    expect(fake.calls).toEqual([]);
    if (u.status !== 'done') throw new Error(u.status);
    expect(u.view).toMatchObject({ revertResult: 'none', watchlistOutcome: 'left_as_is' });
    expect(formatUndoResult(u.view)).toBe(
      'Your last change, removing Dark Matter (2024 show) from your watchlist, never confirmed with Plex, so I left your watchlist as it is.',
    );
    // A retry repeats that answer (the replay guard reconstructs it from the row).
    const again = await undo(later(10));
    expect(again).toMatchObject({ replayed: true });
    if (again.status === 'done') expect(formatUndoResult(again.view)).toBe(formatUndoResult(u.view));
  });

  it('two undos at once (two replicas): one reverts the newest change, the other repeats its answer (ruling 4)', async () => {
    await change('severance', 'remove');
    await change('the matrix', 'add', { now: later(10) });
    const rows = await marks();
    expect(rows).toHaveLength(2);
    // Slow plex.tv, so the two undos overlap.
    const clients = fake.clients();
    const ops = clients.write.haynesops;
    if (!ops) throw new Error('no haynesops writer');
    const slow: WatchPlexClients = {
      read: clients.read,
      write: {
        haynesops: {
          ...ops,
          removeFromWatchlist: async (id: string) => {
            await new Promise((r) => setTimeout(r, 150));
            return ops.removeFromWatchlist(id);
          },
          addToWatchlist: async (id: string) => {
            await new Promise((r) => setTimeout(r, 150));
            return ops.addToWatchlist(id);
          },
        },
      },
    };
    fake.calls.length = 0;
    const at = later(20);
    const [a, b] = await Promise.all([
      undoLastChange({ db, plex: slow, actor: ACTOR, now: at }),
      undoLastChange({ db, plex: slow, actor: ACTOR, now: at }),
    ]);
    expect([a, b].map((x) => (x.status === 'done' ? x.replayed : null)).sort()).toEqual([false, true]);
    expect(fake.watchlistWrites()).toEqual([`removeFromWatchlist:${MATRIX}`]);
    const after = await marks();
    expect(after[1]).toMatchObject({ revertedAt: at, revertResult: 'written' });
    // The older change (Severance's remove) was never touched: no re-add, no download.
    expect(after[0]).toMatchObject({ revertedAt: null });
    expect(fake.watchlist.has(SEV)).toBe(false);
  });

  it('two undos at once where the lock winner read its clock LATER: the waiter still repeats its answer (D-15i)', async () => {
    await change('severance', 'remove');
    await change('the matrix', 'add', { now: later(10) });
    // plex.tv holds the winner's inverse call until the second undo is waiting on the lock.
    const clients = fake.clients();
    const ops = clients.write.haynesops;
    if (!ops) throw new Error('no haynesops writer');
    let entered!: () => void;
    const inPlex = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const gated: WatchPlexClients = {
      read: clients.read,
      write: {
        haynesops: {
          ...ops,
          removeFromWatchlist: async (id: string) => {
            entered();
            await held;
            return ops.removeFromWatchlist(id);
          },
          addToWatchlist: async (id: string) => {
            entered();
            await held;
            return ops.addToWatchlist(id);
          },
        },
      },
    };
    fake.calls.length = 0;
    // Two copies of one undo, a few ms apart on two replicas: the one that reads its clock 5 ms later takes the lock
    // first, so its revert is stamped after the waiting copy's `now`.
    const late = new Date(later(20).getTime() + 5);
    const first = undoLastChange({ db, plex: gated, actor: ACTOR, now: late });
    await inPlex; // the first copy holds the lock and is inside its Plex call
    const second = undoLastChange({ db, plex: gated, actor: ACTOR, now: later(20) });
    await new Promise((r) => setTimeout(r, 100)); // …and the second is queued on the lock
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a, b].map((x) => (x.status === 'done' ? x.replayed : null))).toEqual([false, true]);
    expect(fake.watchlistWrites()).toEqual([`removeFromWatchlist:${MATRIX}`]);
    if (a.status === 'done' && b.status === 'done') expect(formatUndoResult(b.view)).toBe(formatUndoResult(a.view));
    const after = await marks();
    expect(after[1]).toMatchObject({ revertedAt: late, revertResult: 'written' });
    // Severance's remove is untouched: no re-add, so no Seerr download.
    expect(after[0]).toMatchObject({ revertedAt: null });
    expect(fake.watchlist.has(SEV)).toBe(false);

    // Clock skew alone does it too: a retry on a replica whose clock runs 5 ms behind the stamp still replays.
    fake.calls.length = 0;
    const skewed = await undoLastChange({ db, plex: fake.clients(), actor: ACTOR, now: new Date(late.getTime() - 5) });
    expect(skewed).toMatchObject({ replayed: true, markId: after[1]?.id });
    expect(fake.calls).toEqual([]);
    expect(fake.watchlist.has(SEV)).toBe(false);
  });

  it('an unconfirmed undo of a remove (its inverse is an add) of a title not on Plex says Seerr may request it (D-15j)', async () => {
    expect(await change('dark matter', 'remove')).toMatchObject({ result: 'written' });
    fake.failWatchlistWrites.add(DARK);
    fake.landFailedWatchlistWrites = true;
    fake.failDiscoverReads.add('getDiscoverUserState');
    const u = await undo(later(5));
    if (u.status !== 'done') throw new Error(u.status);
    expect(u.view).toMatchObject({ revertResult: 'failed', watchlistOutcome: 'unknown', onPlex: false });
    expect(formatUndoResult(u.view)).toBe(
      "Plex didn't answer in time, so I can't tell whether Dark Matter (2024 show) changed. It isn't on Plex yet, so if it was put back, Seerr will request it.",
    );
    expect(fake.watchlist.has(DARK)).toBe(true);
    expect(await onlyMark()).toMatchObject({ revertedAt: null, revertResult: 'failed' });
  });

  it('a failed inverse call leaves the change live for the next undo', async () => {
    await change('the matrix', 'add');
    fake.failWatchlistWrites.add(MATRIX);
    const u = await undo(later(5));
    if (u.status !== 'done') throw new Error(u.status);
    expect(formatUndoResult(u.view)).toBe(
      "I couldn't reach Plex, so The Matrix (1999 movie) is still on your watchlist. Say undo again to retry.",
    );
    expect(await onlyMark()).toMatchObject({ revertedAt: null, revertResult: 'failed' });
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
