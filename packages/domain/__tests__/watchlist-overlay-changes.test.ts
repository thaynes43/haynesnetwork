// ADR-093 / DESIGN-052 D-19, D-25ca, D-25cb (PLAN-072, the third review pass of PR #595) — the delete snapshot's
// overlay of the owner's Watchlist Changes, driven through the REAL change and undo paths (DESIGN-051):
//
// - D-25cb: "take X off my watchlist", a registry run that no longer lists X, then "undo that" (an ADD to plex.tv
//   that writes no `watchlist_add` row, only `reverted_at` / `revert_result` on the remove) — X is on the owner's
//   watchlist again, so the gate taken after the undo (Expedite, Expire now) and the late re-read of a snapshot taken
//   before it (a running sweep) both see it, as DESIGN-051's own overlay does;
// - D-25ca: "add X to my watchlist" whose PUT timed out after it went out (`failed`, `unknown:`), then applied by
//   plex.tv — the overlay fails closed and protects X; a change closed as abandoned (`unknown: never finalized`)
//   stays protecting; a change never sent (`not sent:`) and a plain refusal do not.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { watchMarks } from '@hnet/db';
import { selectWatchlist } from '@hnet/watch';
import {
  createStaticWatchlistSources,
  evaluateRegistryGate,
  evaluateWatchlist,
  isOnLateWatchlist,
  refreshWatchlistRegistry,
  silentDomainLogger,
  type DeleteWatchlistSnapshot,
} from '../src';
import {
  changeWatchlist,
  closeAbandonedWatchlistChange,
  replaceRecoSignals,
  undoLastChange,
  upsertWatchOwner,
  type WatchTmdbSearch,
} from '../src/watch';
import { bootMigratedDb, type TestDb } from './helpers';
import { FakePlex } from './watch-fake-plex';

const OWNER = 12874060;
const ACTOR = { plexAccountId: OWNER, appUserId: null };
const T0 = new Date('2026-09-26T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const SEV = '5d9c086c46115600200aa9b1';
const DARK = '65f1c0a2b3d4e5f601234567';
const MATRIX = '5d776825880197001ec967c0';
const sev = { media: 'tv' as const, plexGuid: `plex://show/${SEV}`, tmdbId: 95396, tvdbId: 371980 };
const matrix = { media: 'movie' as const, plexGuid: `plex://movie/${MATRIX}`, tmdbId: 603, tvdbId: null };

const tmdb: WatchTmdbSearch = {
  searchMulti: async (q: string) => {
    const results = /severance/i.test(q)
      ? [{ id: 95396, media_type: 'tv', name: 'Severance', first_air_date: '2022-02-18' }]
      : /matrix/i.test(q)
        ? [{ id: 603, media_type: 'movie', title: 'The Matrix', release_date: '1999-03-31' }]
        : [];
    return { page: 1, total_pages: 1, total_results: results.length, results };
  },
} as never;

let t: TestDb;
let fake: FakePlex;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});

beforeEach(async () => {
  await t.db.execute(
    sql`TRUNCATE watch_marks, watch_titles, watch_events, watch_reco_signals, watch_accounts, watchlist_registry_runs CASCADE`,
  );
  await upsertWatchOwner({ db: t.db, account: { id: String(OWNER), username: 'plexowner', email: null } });
  fake = new FakePlex([], []);
  fake.now = Math.floor(T0.getTime() / 1000);
  fake.catalog.push(
    { id: MATRIX, kind: 'movie', title: 'The Matrix', year: 1999, guids: ['tmdb://603', 'imdb://tt0133093'] },
    { id: SEV, kind: 'show', title: 'Severance', year: 2022, guids: ['tmdb://95396', 'tvdb://371980'] },
    { id: DARK, kind: 'show', title: 'Dark Matter', year: 2024, guids: ['tmdb://203744', 'tvdb://433633'] },
  );
});

/** Severance and Dark Matter on the owner's watchlist (plex.tv and the cached list the title resolver reads). */
async function listSeveranceAndDarkMatter() {
  fake.watchlist.set(SEV, fake.now - 86_400);
  fake.watchlist.set(DARK, fake.now - 2 * 86_400);
  await replaceRecoSignals({
    db: t.db,
    plexAccountId: OWNER,
    source: 'watchlist',
    rows: [
      { kind: 'show', title: 'Severance', year: 2022, tmdbId: 95396, tvdbId: 371980, imdbId: null, plexGuid: `plex://show/${SEV}`, rank: 0 },
      { kind: 'show', title: 'Dark Matter', year: 2024, tmdbId: 203744, tvdbId: 433633, imdbId: null, plexGuid: `plex://show/${DARK}`, rank: 1 },
    ],
    fetchedAt: at(-10),
  });
}

/** One registry run at `when` whose owner read lists `owner` (no other account). */
async function run(when: Date, owner: Array<{ discoverId: string; kind: 'movie' | 'show'; tvdbId?: number }>) {
  const s = createStaticWatchlistSources({ ownerId: String(OWNER), owner, accounts: [], noSeerr: true } as never);
  const r = await refreshWatchlistRegistry({
    db: t.db,
    sources: s.sources,
    trigger: 'schedule',
    logger: silentDomainLogger,
    now: () => when,
    sleep: async () => {},
  } as never);
  expect(r.status).toBe('ok');
}

const gate = (min: number): Promise<DeleteWatchlistSnapshot> =>
  evaluateRegistryGate({ db: t.db, purpose: 'delete', now: at(min), logger: silentDomainLogger });
const change = (action: 'add' | 'remove', query: string, min: number) =>
  changeWatchlist({ db: t.db, plex: fake.clients(), tmdb, actor: ACTOR, consumer: 'hop', query, action, now: at(min) });

describe('D-25cb — an undone watchlist_remove puts the title back in the delete overlay', () => {
  it('the gate after the undo (Expedite, Expire now) and the late re-read of an earlier snapshot (a sweep) keep it', async () => {
    await listSeveranceAndDarkMatter();
    // 12:00 "take Severance off my watchlist" — written.
    expect(await change('remove', 'severance', 0)).toMatchObject({ status: 'done', result: 'written' });
    // 12:14 the registry run reads the owner's list without it.
    await run(at(14), [{ discoverId: DARK, kind: 'show', tvdbId: 433633 }]);
    const before = await gate(15); // a sweep's delete snapshot, taken before the undo
    expect(evaluateWatchlist(before, sev)).toEqual({ onWatchlist: false, watchlistEvaluable: true });
    // 12:16 "undo that": the real path sends an ADD and writes no watchlist_add row.
    fake.calls.length = 0;
    expect(await undoLastChange({ db: t.db, plex: fake.clients(), actor: ACTOR, now: at(16) })).toMatchObject({
      status: 'done',
    });
    expect(fake.opKeys()).toEqual([`addToWatchlist:${SEV}`]);
    expect(fake.watchlist.has(SEV)).toBe(true);
    const rows = await t.db.select().from(watchMarks);
    expect(rows.map((r) => [r.action, r.revertResult])).toEqual([['watchlist_remove', 'written']]);
    // DESIGN-051's own overlay says it is on the list again; the Trash overlay agrees.
    const listed = (await selectWatchlist(t.db, OWNER, { now: at(16) })).entries.map((e) => e.title);
    expect(listed).toContain('Severance');
    expect(await isOnLateWatchlist({ db: t.db, snapshot: before, item: sev })).toBe(true);
    const after = await gate(18); // Expedite / Expire now, still on the 12:14 run
    expect(evaluateWatchlist(after, sev)).toEqual({ onWatchlist: true, watchlistEvaluable: true });
    expect(after.keys.show.tvdb.has(371980)).toBe(true);
  });

  it('an undo made before the overlay start is the registry read`s business (it is not replayed)', async () => {
    await listSeveranceAndDarkMatter();
    expect(await change('remove', 'severance', 0)).toMatchObject({ result: 'written' });
    expect(await undoLastChange({ db: t.db, plex: fake.clients(), actor: ACTOR, now: at(1) })).toMatchObject({
      status: 'done',
    });
    // The run at 12:14 read the list (overlay from 12:09): the 12:01 undo is before it, and the run's own read
    // governs. Here the run did not list it (a stand-in for "the read already reflects the list").
    await run(at(14), [{ discoverId: DARK, kind: 'show', tvdbId: 433633 }]);
    expect(evaluateWatchlist(await gate(15), sev).onWatchlist).toBe(false);
  });

  it('a remove whose undo failed stays a remove: it adds nothing (and a reverted add never subtracts)', async () => {
    await listSeveranceAndDarkMatter();
    expect(await change('remove', 'severance', 0)).toMatchObject({ result: 'written' });
    await run(at(14), []);
    fake.failWatchlistWrites.add(SEV);
    fake.failWatchlistWritesWith = 503;
    await undoLastChange({ db: t.db, plex: fake.clients(), actor: ACTOR, now: at(16) });
    const [row] = await t.db.select().from(watchMarks);
    expect(row).toMatchObject({ revertResult: 'failed', revertedAt: null });
    expect(evaluateWatchlist(await gate(18), sev).onWatchlist).toBe(false);
  });
});

describe('D-25ca — a watchlist_add whose outcome plex.tv never confirmed protects (fail closed)', () => {
  it('a PUT that timed out after it went out: the gate and the late re-read keep the title', async () => {
    await run(at(0), []);
    const before = await gate(10);
    fake.failWatchlistWrites.add(MATRIX);
    fake.failWatchlistWritesWith = 'timeout';
    expect(await change('add', 'the matrix', 12)).toMatchObject({ result: 'unknown' });
    const [row] = await t.db.select().from(watchMarks);
    expect(row).toMatchObject({ action: 'watchlist_add', plexResult: 'failed' });
    expect(row?.plexError?.startsWith('unknown: ')).toBe(true);
    expect(await isOnLateWatchlist({ db: t.db, snapshot: before, item: matrix })).toBe(true);
    expect(evaluateWatchlist(await gate(13), matrix)).toEqual({ onWatchlist: true, watchlistEvaluable: true });
  });

  it('a pending add closed as abandoned (`unknown: never finalized`) keeps protecting', async () => {
    await run(at(0), []);
    const before = await gate(10);
    const [row] = await t.db
      .insert(watchMarks)
      .values({
        plexAccountId: OWNER,
        action: 'watchlist_add',
        scope: 'movie',
        titleKey: `plex:plex://movie/${MATRIX}`,
        kind: 'movie',
        title: 'The Matrix',
        plexGuid: `plex://movie/${MATRIX}`,
        tmdbId: 603,
        query: 'q',
        consumer: 'hop',
        plexResult: 'pending',
        createdAt: at(12),
      })
      .returning();
    expect(await isOnLateWatchlist({ db: t.db, snapshot: before, item: matrix })).toBe(true);
    const closed = await closeAbandonedWatchlistChange(t.db, row!);
    expect(closed).toMatchObject({ plexResult: 'failed' });
    expect(await isOnLateWatchlist({ db: t.db, snapshot: before, item: matrix })).toBe(true);
    expect(evaluateWatchlist(await gate(14), matrix).onWatchlist).toBe(true);
  });

  it('an add never sent (`not sent:`) or refused outright does not protect; an undone unknown add does not either', async () => {
    await run(at(0), []);
    const insert = (plexError: string | null, createdAt: Date) =>
      t.db.insert(watchMarks).values({
        plexAccountId: OWNER,
        action: 'watchlist_add',
        scope: 'movie',
        titleKey: `plex:plex://movie/${MATRIX}`,
        kind: 'movie',
        title: 'The Matrix',
        plexGuid: `plex://movie/${MATRIX}`,
        tmdbId: 603,
        query: 'q',
        consumer: 'hop',
        plexResult: 'failed',
        plexError,
        createdAt,
      });
    await insert('not sent: discover lookup failed', at(11));
    await insert('http_400', at(11));
    expect(evaluateWatchlist(await gate(12), matrix).onWatchlist).toBe(false);
    await t.db.insert(watchMarks).values({
      plexAccountId: OWNER,
      action: 'watchlist_add',
      scope: 'movie',
      titleKey: `plex:plex://movie/${MATRIX}`,
      kind: 'movie',
      title: 'The Matrix',
      plexGuid: `plex://movie/${MATRIX}`,
      tmdbId: 603,
      query: 'q',
      consumer: 'hop',
      plexResult: 'failed',
      plexError: 'unknown: timeout',
      createdAt: at(11),
      revertedAt: at(11.5),
      revertResult: 'written',
    });
    expect(evaluateWatchlist(await gate(12), matrix).onWatchlist).toBe(false);
  });
});
