// ADR-093 / DESIGN-052 D-01..D-07, D-19 (PLAN-072 S2) — the Watchlist Registry and the Registry Gate.
//
// Pure: the per-source state machine (read, carried at 1 h and 25 h, unreadable at 72 h and back to read,
// never_read, empty_unverified; community empty / not found after titles failed and logged `account_hidden` once;
// the same answers with nothing ever read are empty_unverified / not_applicable; a Seerr ok read with titles turns a
// community transition unreadable at once; a Seerr source failing after the community froze still blocks), the
// derived account status, and the match rule (guid, tmdb, tvdb, the evaluable rule with an unmapped entry, the typed
// snapshot failing closed).
//
// Integration (embedded PG16, in-memory sources — no live API, ADR-010): the refresh writes and carries forward; a
// Seerr source answering 200-empty after a non-empty read and a hidden community friend keep their items; the gate's
// G1..G3 boundaries at 30 min and 24 h; `propose` never refusing; the D-19 overlay adding and never subtracting;
// roster / owner failures; left accounts; the discover-id map; the lock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  plexDiscoverIds,
  watchAccounts,
  watchlistRegistryAccounts,
  watchlistRegistryItems,
  watchlistRegistryRuns,
  watchlistRegistrySources,
  watchMarks,
} from '@hnet/db/schema';
import {
  EMPTY_WATCHLIST_KEYS,
  WatchlistRegistryUnverifiedError,
  createStaticWatchlistSources,
  decideSource,
  deriveAccountStatus,
  evaluateRegistryGate,
  evaluateWatchlist,
  getWatchlistRegistrySummary,
  isOnLateWatchlist,
  seerrReaderFrom,
  readDisplayWatchlistSnapshot,
  refreshWatchlistRegistry,
  type DomainLogger,
  type SourceState,
  type StaticWatchlistFixture,
  type WatchlistKeys,
  type WatchlistSnapshot,
} from '../src/index';
import { SeerrClient } from '@hnet/arr/read';
import { bootMigratedDb, type TestDb } from './helpers';

const HOUR = 3_600_000;
const T0 = new Date('2026-09-26T12:00:00Z');
const at = (h: number) => new Date(T0.getTime() + h * HOUR);

const A = '5d776824151a60001f24a29e';
const B = '608ae6cf5077dd002d3bb8be';
const C = '5f40b53f3ad4a8003ec80fc9';
const D = '5e161c7de9d5a1004086a1f5';
const E = '5d9f35036013b8001f8bdea5';

const prev = (over: Partial<SourceState> = {}): SourceState => ({
  status: 'read',
  lastOkAt: T0,
  failingSince: null,
  lastOkCount: 3,
  emptyUnverified: false,
  hiddenLoggedAt: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Pure: the D-04 state machine
// ---------------------------------------------------------------------------

describe('decideSource (D-04 outcome rules)', () => {
  const items = [
    { discoverId: A, kind: 'movie' as const, tmdbId: null, tvdbId: null, imdbId: null },
  ];

  it('titles ⇒ ok/read, items replaced, clocks cleared', () => {
    const d = decideSource({
      source: 'community',
      prev: prev({ status: 'carried', failingSince: at(-5), hiddenLoggedAt: at(-5) }),
      answer: { kind: 'titles', items },
      now: at(1),
      seerrOkWithTitles: false,
    });
    expect(d).toMatchObject({
      outcome: 'ok',
      status: 'read',
      lastOkCount: 1,
      failingSince: null,
      hiddenLoggedAt: null,
    });
    expect(d.replaceItems).toEqual(items);
  });

  it('empty with nothing ever read ⇒ ok, empty_unverified, removes nothing', () => {
    const d = decideSource({
      source: 'community',
      prev: null,
      answer: { kind: 'empty', unverified: true },
      now: T0,
      seerrOkWithTitles: false,
    });
    expect(d).toMatchObject({
      outcome: 'ok',
      status: 'read',
      emptyUnverified: true,
      lastOkCount: 0,
    });
    expect(d.replaceItems).toBeNull();
  });

  it('not found with nothing ever read ⇒ not_applicable (a managed user, a private list)', () => {
    const d = decideSource({
      source: 'community',
      prev: null,
      answer: { kind: 'not_found' },
      now: T0,
      seerrOkWithTitles: false,
    });
    expect(d).toMatchObject({ outcome: 'not_applicable', status: 'not_applicable' });
  });

  it('community empty after titles ⇒ failed, carried, account_hidden logged once', () => {
    const first = decideSource({
      source: 'community',
      prev: prev(),
      answer: { kind: 'empty', unverified: true },
      now: at(1),
      seerrOkWithTitles: false,
    });
    expect(first).toMatchObject({
      outcome: 'failed',
      status: 'carried',
      errorClass: 'empty_after_titles',
      hiddenTransition: true,
      logHidden: true,
      failingSince: at(1),
    });
    expect(first.replaceItems).toBeNull();
    const second = decideSource({
      source: 'community',
      prev: {
        ...prev(),
        status: first.status,
        failingSince: first.failingSince,
        hiddenLoggedAt: first.hiddenLoggedAt,
      },
      answer: { kind: 'not_found' },
      now: at(2),
      seerrOkWithTitles: false,
    });
    expect(second).toMatchObject({
      status: 'carried',
      errorClass: 'not_found_after_titles',
      logHidden: false,
    });
    expect(second.failingSince).toEqual(at(1));
  });

  it('Seerr 200-empty after a non-empty read ⇒ failed (empty_after_titles), carried', () => {
    const d = decideSource({
      source: 'seerr',
      prev: prev(),
      answer: { kind: 'empty', unverified: true },
      now: at(1),
      seerrOkWithTitles: false,
    });
    expect(d).toMatchObject({
      outcome: 'failed',
      status: 'carried',
      errorClass: 'empty_after_titles',
    });
  });

  it('failed with no ok read ever ⇒ never_read; with one ⇒ carried (at 1 h and at 25 h)', () => {
    expect(
      decideSource({
        source: 'community',
        prev: null,
        answer: { kind: 'failed', errorClass: 'http_500' },
        now: T0,
        seerrOkWithTitles: false,
      }).status,
    ).toBe('never_read');
    for (const h of [1, 25]) {
      const d = decideSource({
        source: 'community',
        prev: prev({ status: 'carried', failingSince: T0 }),
        answer: { kind: 'failed', errorClass: 'timeout' },
        now: at(h),
        seerrOkWithTitles: false,
      });
      expect(d.status).toBe('carried');
      expect(d.failingSince).toEqual(T0);
    }
  });

  it('failing for 72 h ⇒ unreadable once (keeps items); unreadable stays until an ok read', () => {
    const d = decideSource({
      source: 'seerr',
      prev: prev({ status: 'carried', failingSince: T0 }),
      answer: { kind: 'failed', errorClass: 'inconsistent' },
      now: at(72),
      seerrOkWithTitles: false,
    });
    expect(d).toMatchObject({ status: 'unreadable', becameUnreadable: true });
    expect(d.replaceItems).toBeNull();
    const again = decideSource({
      source: 'seerr',
      prev: prev({ status: 'unreadable', failingSince: T0 }),
      answer: { kind: 'failed', errorClass: 'inconsistent' },
      now: at(80),
      seerrOkWithTitles: false,
    });
    expect(again).toMatchObject({ status: 'unreadable', becameUnreadable: false });
    const back = decideSource({
      source: 'seerr',
      prev: prev({ status: 'unreadable', failingSince: T0 }),
      answer: { kind: 'titles', items },
      now: at(81),
      seerrOkWithTitles: false,
    });
    expect(back.status).toBe('read');
  });

  it('never_read failing 72 h ⇒ unreadable', () => {
    const d = decideSource({
      source: 'community',
      prev: prev({ status: 'never_read', lastOkAt: null, lastOkCount: null, failingSince: T0 }),
      answer: { kind: 'failed', errorClass: 'http_502' },
      now: at(72),
      seerrOkWithTitles: false,
    });
    expect(d.status).toBe('unreadable');
  });

  it('the community exception: Seerr ok with titles this run ⇒ the community transition is unreadable at once', () => {
    const d = decideSource({
      source: 'community',
      prev: prev(),
      answer: { kind: 'empty', unverified: true },
      now: at(1),
      seerrOkWithTitles: true,
    });
    expect(d).toMatchObject({ outcome: 'failed', status: 'unreadable', becameUnreadable: true });
  });

  it('a community read never settles a Seerr transition; a plain community failure is not settled by Seerr', () => {
    expect(
      decideSource({
        source: 'seerr',
        prev: prev(),
        answer: { kind: 'empty', unverified: true },
        now: at(1),
        seerrOkWithTitles: true,
      }).status,
    ).toBe('carried');
    expect(
      decideSource({
        source: 'community',
        prev: prev(),
        answer: { kind: 'failed', errorClass: 'http_500' },
        now: at(1),
        seerrOkWithTitles: true,
      }).status,
    ).toBe('carried');
  });

  it('not_applicable keeps stored items and never blocks', () => {
    const d = decideSource({
      source: 'switch',
      prev: prev(),
      answer: { kind: 'not_applicable', errorClass: 'switch_disabled' },
      now: T0,
      seerrOkWithTitles: false,
    });
    expect(d).toMatchObject({ status: 'not_applicable', replaceItems: null });
  });
});

describe('deriveAccountStatus', () => {
  it('never_read > carried > unreadable > unresolvable > read', () => {
    expect(deriveAccountStatus(['read', 'never_read', 'carried'])).toBe('never_read');
    expect(deriveAccountStatus(['read', 'carried', 'unreadable'])).toBe('carried');
    expect(deriveAccountStatus(['read', 'unreadable'])).toBe('unreadable');
    expect(deriveAccountStatus(['not_applicable', 'not_applicable'])).toBe('unresolvable');
    expect(deriveAccountStatus([])).toBe('unresolvable');
    expect(deriveAccountStatus(['read', 'not_applicable'])).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// Pure: matching (D-06) and the typed snapshot failing closed
// ---------------------------------------------------------------------------

describe('evaluateWatchlist (D-06)', () => {
  const keys = (
    over: Partial<Record<'movie' | 'show', Partial<WatchlistKeys['movie']>>> = {},
  ): WatchlistKeys => ({
    movie: {
      discover: new Set([A]),
      tmdb: new Set([218]),
      tvdb: new Set(),
      unmapped: 0,
      ...over.movie,
    },
    show: {
      discover: new Set([B]),
      tmdb: new Set([1399]),
      tvdb: new Set([121361]),
      unmapped: 0,
      ...over.show,
    },
  });
  const display = (k: WatchlistKeys): WatchlistSnapshot => ({
    purpose: 'display',
    keys: k,
    runId: 'r',
  });
  const movie = {
    media: 'movie' as const,
    plexGuid: `plex://movie/${C}`,
    tmdbId: 999,
    tvdbId: null,
  };

  it('matches by discover id, by tmdb (movie), by tvdb or tmdb (show)', () => {
    expect(
      evaluateWatchlist(display(keys()), { ...movie, plexGuid: `plex://movie/${A}` }).onWatchlist,
    ).toBe(true);
    expect(evaluateWatchlist(display(keys()), { ...movie, tmdbId: 218 }).onWatchlist).toBe(true);
    expect(evaluateWatchlist(display(keys()), movie)).toEqual({
      onWatchlist: false,
      watchlistEvaluable: true,
    });
    const tv = { media: 'tv' as const, plexGuid: null, tmdbId: null, tvdbId: 121361 };
    expect(evaluateWatchlist(display(keys()), tv).onWatchlist).toBe(true);
    expect(
      evaluateWatchlist(display(keys()), { ...tv, tvdbId: null, tmdbId: 1399 }).onWatchlist,
    ).toBe(true);
    expect(
      evaluateWatchlist(display(keys()), { ...tv, plexGuid: `plex://show/${B}`, tvdbId: 1 })
        .onWatchlist,
    ).toBe(true);
  });

  it('a guid of the other kind is not a discover key', () => {
    expect(
      evaluateWatchlist(display(keys()), { ...movie, plexGuid: `plex://show/${A}` }).onWatchlist,
    ).toBe(false);
  });

  it('the evaluable rule: no guid and an unmapped title of that kind ⇒ not evaluable', () => {
    const k = keys({ movie: { unmapped: 1 } });
    expect(evaluateWatchlist(display(k), { ...movie, plexGuid: null })).toEqual({
      onWatchlist: false,
      watchlistEvaluable: false,
    });
    expect(evaluateWatchlist(display(k), movie).watchlistEvaluable).toBe(true); // it has a guid
    expect(
      evaluateWatchlist(display(keys()), { ...movie, plexGuid: null }).watchlistEvaluable,
    ).toBe(true);
  });

  it('fails closed: no snapshot, an unverified delete snapshot, an unfiltered propose snapshot', () => {
    const blind = { onWatchlist: false, watchlistEvaluable: false };
    const hit = { ...movie, plexGuid: `plex://movie/${A}` };
    expect(evaluateWatchlist(null, hit)).toEqual(blind);
    expect(evaluateWatchlist(undefined, hit)).toEqual(blind);
    const forged = {
      purpose: 'delete',
      verified: false,
      keys: keys(),
      runId: 'r',
    } as unknown as WatchlistSnapshot;
    expect(evaluateWatchlist(forged, hit)).toEqual(blind);
    expect(
      evaluateWatchlist({ purpose: 'propose', filtered: false, keys: keys(), runId: null }, hit),
    ).toEqual(blind);
    expect(
      evaluateWatchlist({ purpose: 'propose', filtered: true, keys: keys(), runId: 'r' }, hit)
        .onWatchlist,
    ).toBe(true);
    expect(
      evaluateWatchlist(
        {
          purpose: 'delete',
          verified: true,
          keys: EMPTY_WATCHLIST_KEYS,
          runId: 'r',
          overlaySince: new Date(0),
        },
        hit,
      ),
    ).toEqual({
      onWatchlist: false,
      watchlistEvaluable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: the refresh, the carry-forward, the gate
// ---------------------------------------------------------------------------

describe('refreshWatchlistRegistry + evaluateRegistryGate (embedded PG16)', () => {
  let t: TestDb;
  const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const logger: DomainLogger = {
    info: (msg, fields) => logs.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => logs.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => logs.push({ level: 'error', msg, fields }),
  };
  const noSleep = async () => {};

  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => {
    await t?.stop();
  });
  beforeEach(async () => {
    logs.length = 0;
    await t.db.delete(watchMarks);
    await t.db.delete(watchAccounts);
    await t.db.delete(watchlistRegistryAccounts);
    await t.db.delete(watchlistRegistryRuns);
    await t.db.delete(plexDiscoverIds);
  });

  const refresh = (
    fixture: StaticWatchlistFixture | ReturnType<typeof createStaticWatchlistSources>,
    now: Date,
  ) => {
    const s = 'sources' in fixture ? fixture : createStaticWatchlistSources(fixture);
    return refreshWatchlistRegistry({
      db: t.db,
      sources: s.sources,
      trigger: 'schedule',
      logger,
      now: () => now,
      sleep: noSleep,
    });
  };
  const sourceRow = async (acct: string, source: string) =>
    (
      await t.db
        .select()
        .from(watchlistRegistrySources)
        .where(eq(watchlistRegistrySources.plexAccountId, acct))
    ).find((r) => r.source === source);
  const itemsOf = async (acct: string) =>
    (
      await t.db
        .select()
        .from(watchlistRegistryItems)
        .where(eq(watchlistRegistryItems.plexAccountId, acct))
    )
      .map((r) => `${r.source}:${r.discoverId}`)
      .sort();
  const gate = (now: Date) => evaluateRegistryGate({ db: t.db, now, purpose: 'delete', logger });

  const baseFixture = (): StaticWatchlistFixture => ({
    ownerId: '1',
    owner: [{ discoverId: A, kind: 'movie', tmdbId: 218 }],
    accounts: [
      {
        plexAccountId: '101',
        cls: 'friend',
        community: { kind: 'answered', nodes: [{ discoverId: B, kind: 'show' }] },
      },
      {
        plexAccountId: '102',
        cls: 'friend',
        community: { kind: 'answered', nodes: [] },
        seerr: {
          userId: 5,
          answer: {
            kind: 'ok',
            totalResults: 1,
            items: [{ discoverId: C, kind: 'movie', tmdbId: 77 }],
          },
        },
      },
      { plexAccountId: '103', cls: 'home_managed', community: { kind: 'not_found' } },
    ],
    discover: { [B]: { kind: 'show', ids: { tmdbId: 1399, tvdbId: 121361, imdbId: null } } },
  });

  it('writes every account and source, maps discover ids, and counts only numbers', async () => {
    const report = await refresh(baseFixture(), T0);
    expect(report.status).toBe('ok');
    const accounts = await t.db.select().from(watchlistRegistryAccounts);
    const byId = Object.fromEntries(accounts.map((a) => [a.plexAccountId, a]));
    expect(byId['1']).toMatchObject({ class: 'owner', status: 'read', itemCount: 1 });
    expect(byId['101']).toMatchObject({ class: 'friend', status: 'read', itemCount: 1 });
    expect(byId['102']).toMatchObject({
      class: 'friend',
      status: 'read',
      seerrUserId: 5,
      itemCount: 1,
    });
    expect(byId['103']).toMatchObject({ class: 'home_managed', status: 'unresolvable' });
    expect(await sourceRow('102', 'community')).toMatchObject({
      status: 'read',
      emptyUnverified: true,
      lastOkCount: 0,
    });
    expect(await sourceRow('103', 'switch')).toMatchObject({
      status: 'not_applicable',
      lastErrorClass: 'switch_disabled',
    });
    const [mapped] = await t.db
      .select()
      .from(plexDiscoverIds)
      .where(eq(plexDiscoverIds.discoverId, B));
    expect(mapped).toMatchObject({ tvdbId: 121361, tmdbId: 1399, attempts: 1 });
    expect(report.counts).toMatchObject({
      roster: 4,
      byClass: { owner: 1, friend: 2, home_managed: 1 },
      accountsRead: 3,
      accountsUnreadable: 1,
      emptyUnverified: 1,
      entries: 3,
      distinctTitles: 3,
      unmapped: 0,
    });
    const done = logs.find((l) => l.msg === '[watchlist-registry] run_complete');
    expect(done?.fields).toMatchObject({ trigger: 'schedule', status: 'ok' });
    // D-21: no uuid, no username, no title in any log line.
    expect(JSON.stringify(logs)).not.toMatch(/0{10}101|friend1|"title"/);

    const snap = await gate(at(0.1));
    expect(snap.verified).toBe(true);
    expect(snap.keys.movie.discover.has(A)).toBe(true);
    expect(snap.keys.show.tvdb.has(121361)).toBe(true); // mapped through plex_discover_ids
    expect(snap.keys.movie.tmdb.has(77)).toBe(true); // Seerr's own tmdb id
  });

  it('a hidden community friend keeps its titles (carried, then blocking after 24 h, then unreadable at 72 h)', async () => {
    const s = createStaticWatchlistSources(baseFixture());
    await refresh(s, T0);
    s.fixture.accounts![0]!.community = { kind: 'answered', nodes: [] }; // friend 101 hides the list
    await refresh(s, at(1));
    expect(await itemsOf('101')).toEqual([`community:${B}`]);
    expect(await sourceRow('101', 'community')).toMatchObject({
      status: 'carried',
      lastOutcome: 'failed',
      lastErrorClass: 'empty_after_titles',
    });
    expect(logs.filter((l) => l.msg === '[watchlist-registry] account_hidden')).toHaveLength(1);
    // G3 at 1 h: carried within 24 h of its last ok read ⇒ verified.
    await expect(gate(at(1.2))).resolves.toMatchObject({ verified: true });
    // A run at 25 h: still carried; its last ok read (T0) is older than 24 h ⇒ the gate refuses.
    await refresh(s, at(25));
    expect(logs.filter((l) => l.msg === '[watchlist-registry] account_hidden')).toHaveLength(1); // once
    await expect(gate(at(25.1))).rejects.toMatchObject({
      reason: 'account_unverified',
      detail: { blocking: 1 },
    });
    // At 73 h it has failed continuously for 72 h ⇒ unreadable: frozen, counted, no longer blocking.
    await refresh(s, at(73));
    expect(await sourceRow('101', 'community')).toMatchObject({ status: 'unreadable' });
    expect(await itemsOf('101')).toEqual([`community:${B}`]);
    expect(logs.filter((l) => l.msg === '[watchlist-registry] account_unreadable')).toHaveLength(1);
    await expect(gate(at(73.1))).resolves.toMatchObject({ verified: true });
    // A later ok read with titles returns it to read and replaces the items.
    s.fixture.accounts![0]!.community = {
      kind: 'answered',
      nodes: [{ discoverId: D, kind: 'movie' }],
    };
    await refresh(s, at(74));
    expect(await sourceRow('101', 'community')).toMatchObject({ status: 'read' });
    expect(await itemsOf('101')).toEqual([`community:${D}`]);
  });

  it('Seerr answering 200-empty after a non-empty read, or an inconsistent read (classified answers), leaves the items unchanged', async () => {
    const s = createStaticWatchlistSources(baseFixture());
    await refresh(s, T0);
    s.fixture.accounts![1]!.seerr!.answer = { kind: 'empty' };
    await refresh(s, at(1));
    expect(await itemsOf('102')).toEqual([`seerr:${C}`]);
    expect(await sourceRow('102', 'seerr')).toMatchObject({
      status: 'carried',
      lastErrorClass: 'empty_after_titles',
    });
    expect(
      logs.some(
        (l) =>
          l.msg === '[watchlist-registry] account_failed' &&
          l.fields?.errorClass === 'empty_after_titles',
      ),
    ).toBe(true);
    s.fixture.accounts![1]!.seerr!.answer = { kind: 'failed', errorClass: 'inconsistent' };
    await refresh(s, at(2));
    expect(await itemsOf('102')).toEqual([`seerr:${C}`]);
    expect(await sourceRow('102', 'seerr')).toMatchObject({
      status: 'carried',
      lastErrorClass: 'inconsistent',
    });
  });

  it('through the real SeerrClient (HTTP stub): a two-page list is read whole, and a page 2 answering the error body leaves the items unchanged', async () => {
    let page2Broken = false;
    const pagesRead: number[] = [];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const seerr = seerrReaderFrom(
      new SeerrClient({
        baseUrl: 'http://seerr.test',
        apiKey: 'k',
        fetchImpl: (async (input: unknown) => {
          const url = new URL(String(input));
          if (url.pathname === '/api/v1/user') {
            return json({
              pageInfo: { pages: 1, pageSize: 100, results: 1, page: 1 },
              results: [{ id: 5, plexId: 102, userType: 1 }],
            });
          }
          expect(url.pathname).toBe('/api/v1/user/5/watchlist');
          const page = Number(url.searchParams.get('page'));
          pagesRead.push(page);
          const row = (ratingKey: string) => ({ id: 1, ratingKey, title: 'x', mediaType: 'movie', tmdbId: 1 });
          if (page === 1) return json({ page: 1, totalPages: 2, totalResults: 2, results: [row(C)] });
          return json(
            page2Broken
              ? { page: 2, totalPages: 0, totalResults: 0, results: [] }
              : { page: 2, totalPages: 2, totalResults: 2, results: [row(D)] },
          );
        }) as typeof fetch,
      }),
    );
    const plex = createStaticWatchlistSources(baseFixture()).sources.plex;
    const run = (now: Date) =>
      refreshWatchlistRegistry({
        db: t.db,
        sources: { plex, seerr },
        trigger: 'schedule',
        logger,
        now: () => now,
        sleep: noSleep,
      });
    expect((await run(T0)).status).toBe('ok');
    expect(pagesRead).toEqual([1, 2]);
    const both = [`seerr:${C}`, `seerr:${D}`].sort();
    expect(await itemsOf('102')).toEqual(both);
    page2Broken = true;
    pagesRead.length = 0;
    expect((await run(at(1))).status).toBe('ok');
    expect(pagesRead).toEqual([1, 2, 1, 2]); // inconsistent, read again once, then failed
    expect(await itemsOf('102')).toEqual(both);
    expect(await sourceRow('102', 'seerr')).toMatchObject({
      status: 'carried',
      lastErrorClass: 'inconsistent',
    });
  });

  it('a Seerr ok read with titles settles a community transition at once (unreadable, not blocking)', async () => {
    const f = baseFixture();
    f.accounts![1]!.community = { kind: 'answered', nodes: [{ discoverId: E, kind: 'movie' }] };
    const s = createStaticWatchlistSources(f);
    await refresh(s, T0);
    s.fixture.accounts![1]!.community = { kind: 'answered', nodes: [] };
    await refresh(s, at(30));
    expect(await sourceRow('102', 'community')).toMatchObject({ status: 'unreadable' });
    expect(await itemsOf('102')).toEqual([`community:${E}`, `seerr:${C}`]);
    await expect(gate(at(30.1))).resolves.toMatchObject({ verified: true });
    // …and a Seerr source failing after the community source froze still blocks (its own carry, past 24 h).
    s.fixture.accounts![1]!.seerr!.answer = { kind: 'failed', errorClass: 'http_500' };
    await refresh(s, at(55));
    expect(await sourceRow('102', 'community')).toMatchObject({ status: 'unreadable' });
    await expect(gate(at(55.1))).rejects.toMatchObject({ reason: 'account_unverified' });
  });

  it('a new account whose first read fails is never_read and blocks the gate at once', async () => {
    const f = baseFixture();
    f.accounts!.push({
      plexAccountId: '104',
      cls: 'friend',
      community: { kind: 'failed', errorClass: 'http_500' },
    });
    await refresh(f, T0);
    expect(await sourceRow('104', 'community')).toMatchObject({ status: 'never_read' });
    await expect(gate(at(0.1))).rejects.toBeInstanceOf(WatchlistRegistryUnverifiedError);
  });

  it('G1: an ok run 29 minutes old verifies, 31 minutes old refuses `stale`; no run refuses `stale`', async () => {
    await expect(gate(T0)).rejects.toMatchObject({ reason: 'stale', detail: { ageMin: null } });
    await refresh(baseFixture(), T0);
    await expect(gate(new Date(T0.getTime() + 29 * 60_000))).resolves.toMatchObject({
      verified: true,
    });
    await expect(gate(new Date(T0.getTime() + 31 * 60_000))).rejects.toMatchObject({
      reason: 'stale',
      detail: { ageMin: 31 },
    });
  });

  it('`propose` never refuses: filtered within 24 h, unfiltered after', async () => {
    await expect(
      evaluateRegistryGate({ db: t.db, now: T0, purpose: 'propose', logger }),
    ).resolves.toMatchObject({
      filtered: false,
    });
    await refresh(baseFixture(), T0);
    await expect(
      evaluateRegistryGate({ db: t.db, now: at(23), purpose: 'propose', logger }),
    ).resolves.toMatchObject({
      filtered: true,
    });
    await expect(
      evaluateRegistryGate({ db: t.db, now: at(25), purpose: 'propose', logger }),
    ).resolves.toMatchObject({
      filtered: false,
    });
  });

  it('roster and owner failures fail the run (and a failed run never verifies the gate)', async () => {
    const f = baseFixture();
    await expect(refresh({ ...f, rosterFails: true }, T0)).resolves.toMatchObject({
      status: 'failed',
      failure: 'roster',
    });
    await expect(refresh({ ...f, ownerFailure: 'throw' }, T0)).resolves.toMatchObject({
      status: 'failed',
      failure: 'owner',
    });
    await expect(refresh({ ...f, ownerFailure: 'truncated' }, T0)).resolves.toMatchObject({
      status: 'failed',
      failure: 'owner_truncated',
    });
    await expect(gate(T0)).rejects.toMatchObject({ reason: 'stale' });
    expect(logs.filter((l) => l.msg === '[watchlist-registry] run_failed')).toHaveLength(3);
  });

  it('an account missing from the roster keeps protecting for 24 h, then is deleted with its items', async () => {
    const s = createStaticWatchlistSources(baseFixture());
    await refresh(s, T0);
    s.fixture.accounts = s.fixture.accounts!.filter((a) => a.plexAccountId !== '101');
    await refresh(s, at(1));
    const [left] = await t.db
      .select()
      .from(watchlistRegistryAccounts)
      .where(eq(watchlistRegistryAccounts.plexAccountId, '101'));
    expect(left?.leftAt).toEqual(at(1));
    expect((await gate(at(1.1))).keys.show.discover.has(B)).toBe(true);
    await refresh(s, at(25.5));
    expect(
      await t.db
        .select()
        .from(watchlistRegistryAccounts)
        .where(eq(watchlistRegistryAccounts.plexAccountId, '101')),
    ).toEqual([]);
    expect(await itemsOf('101')).toEqual([]);
  });

  it('D-19: the owner`s watchlist_add changes since the run started count at once; a remove never subtracts', async () => {
    await refresh(baseFixture(), T0);
    await t.db.insert(watchAccounts).values({ plexAccountId: 1, username: 'owner', role: 'owner' });
    const mark = (
      action: 'watchlist_add' | 'watchlist_remove',
      id: string,
      createdAt: Date,
      plexResult = 'written',
    ) =>
      t.db.insert(watchMarks).values({
        plexAccountId: 1,
        action,
        scope: 'movie',
        titleKey: `plex:plex://movie/${id}`,
        kind: 'movie',
        title: 'x',
        plexGuid: `plex://movie/${id}`,
        query: 'q',
        consumer: 'hop',
        plexResult: plexResult as 'written',
        createdAt,
      });
    await mark('watchlist_add', D, at(0.2));
    await mark('watchlist_add', E, at(0.2), 'failed');
    await mark('watchlist_remove', A, at(0.3));
    await mark('watchlist_add', B, at(-1)); // before the run started: only the registry read counts
    const snap = await gate(at(0.4));
    expect(snap.keys.movie.discover.has(D)).toBe(true);
    expect(snap.keys.movie.discover.has(E)).toBe(false);
    expect(snap.keys.movie.discover.has(A)).toBe(true); // the remove never subtracts
    expect(snap.keys.movie.discover.has(B)).toBe(false);
  });

  it('the discover map: 404 ⇒ not_found_at, a failed lookup ⇒ attempts + 1, both retried later', async () => {
    const f = baseFixture();
    f.accounts![0]!.community = {
      kind: 'answered',
      nodes: [
        { discoverId: D, kind: 'movie' },
        { discoverId: E, kind: 'movie' },
      ],
    };
    f.discover = { [D]: null };
    await refresh(f, T0);
    const rows = Object.fromEntries(
      (await t.db.select().from(plexDiscoverIds)).map((r) => [r.discoverId, r]),
    );
    expect(rows[D]).toMatchObject({ notFoundAt: T0, resolvedAt: null, attempts: 1 });
    expect(rows[E]).toMatchObject({ notFoundAt: null, resolvedAt: null, attempts: 1 });
    const snap = await readDisplayWatchlistSnapshot({ db: t.db });
    expect(snap?.keys.movie.unmapped).toBe(2);
    await refresh(f, at(1)); // E retried at once (not a 404); D not until 7 days
    const again = Object.fromEntries(
      (await t.db.select().from(plexDiscoverIds)).map((r) => [r.discoverId, r]),
    );
    expect(again[E]?.attempts).toBe(2);
    expect(again[D]?.attempts).toBe(1);
  });

  it('the discover map resolves a Seerr show (tmdb only) to its tvdb id, so the show counts as mapped', async () => {
    const f = baseFixture();
    f.accounts![1]!.seerr!.answer = {
      kind: 'ok',
      totalResults: 1,
      items: [{ discoverId: E, kind: 'show', tmdbId: 1399 }],
    };
    f.discover = {
      [B]: { kind: 'show', ids: { tmdbId: 1399, tvdbId: 121361, imdbId: null } },
      [E]: { kind: 'show', ids: { tmdbId: 1399, tvdbId: 121361, imdbId: null } },
    };
    await refresh(f, T0);
    const [row] = await t.db
      .select()
      .from(plexDiscoverIds)
      .where(eq(plexDiscoverIds.discoverId, E));
    expect(row).toMatchObject({ tvdbId: 121361, resolvedAt: T0 });
    const snap = await readDisplayWatchlistSnapshot({ db: t.db });
    expect(snap?.keys.show.unmapped).toBe(0);
    expect(snap?.keys.show.tvdb.has(121361)).toBe(true);
  });

  it('seerr_only accounts; a failed Seerr user list keeps links and fails every Seerr source', async () => {
    const f = baseFixture();
    f.seerrOnly = [
      {
        plexId: '900',
        userId: 9,
        answer: {
          kind: 'ok',
          totalResults: 1,
          items: [{ discoverId: E, kind: 'movie', tmdbId: 5 }],
        },
      },
    ];
    const s = createStaticWatchlistSources(f);
    await refresh(s, T0);
    const [only] = await t.db
      .select()
      .from(watchlistRegistryAccounts)
      .where(eq(watchlistRegistryAccounts.plexAccountId, '900'));
    expect(only).toMatchObject({ class: 'seerr_only', status: 'read', seerrUserId: 9 });
    s.fixture.seerrUsersFail = true;
    await refresh(s, at(1));
    expect(await sourceRow('102', 'seerr')).toMatchObject({
      status: 'carried',
      lastErrorClass: 'seerr_users',
    });
    const [still] = await t.db
      .select()
      .from(watchlistRegistryAccounts)
      .where(eq(watchlistRegistryAccounts.plexAccountId, '900'));
    expect(still?.leftAt).toBeNull();
    expect(await itemsOf('900')).toEqual([`seerr:${E}`]);
  });

  it('D-25ba: while the Seerr user list fails, a seerr_only account is re-decided each run: carried, blocking after 24 h, unreadable at 72 h', async () => {
    const s = createStaticWatchlistSources({
      ownerId: '1',
      owner: [{ discoverId: A, kind: 'movie', tmdbId: 218 }],
      seerrOnly: [
        {
          plexId: '900',
          userId: 9,
          answer: { kind: 'ok', totalResults: 1, items: [{ discoverId: E, kind: 'movie', tmdbId: 5 }] },
        },
      ],
    });
    await refresh(s, T0);
    expect(await sourceRow('900', 'seerr')).toMatchObject({ status: 'read' });
    s.fixture.seerrUsersFail = true;
    await refresh(s, at(1));
    expect(await sourceRow('900', 'seerr')).toMatchObject({
      status: 'carried',
      lastErrorClass: 'seerr_users',
    });
    // Past 24 h the carried source blocks the gate, like any carried Seerr source.
    await refresh(s, at(26));
    await expect(gate(at(26.1))).rejects.toMatchObject({ reason: 'account_unverified' });
    // At 72 h it freezes `unreadable`: its titles still protect, and it no longer blocks.
    await refresh(s, at(74));
    expect(await sourceRow('900', 'seerr')).toMatchObject({ status: 'unreadable' });
    const snap = await gate(at(74.1));
    expect(snap.keys.movie.discover.has(E)).toBe(true);
    const [acct] = await t.db
      .select()
      .from(watchlistRegistryAccounts)
      .where(eq(watchlistRegistryAccounts.plexAccountId, '900'));
    expect(acct).toMatchObject({ class: 'seerr_only', leftAt: null, status: 'unreadable' });
    // Seerr not configured behaves the same (`seerr_unconfigured`): still current, still decided.
    s.fixture.seerrUsersFail = false;
    s.fixture.noSeerr = true;
    await refresh(s, at(74.5));
    expect(await sourceRow('900', 'seerr')).toMatchObject({
      status: 'unreadable',
      lastErrorClass: 'seerr_unconfigured',
    });
    // A successful user list that no longer has it marks it left.
    s.fixture.noSeerr = false;
    s.fixture.seerrOnly = [];
    await refresh(s, at(75));
    const [gone] = await t.db
      .select()
      .from(watchlistRegistryAccounts)
      .where(eq(watchlistRegistryAccounts.plexAccountId, '900'));
    expect(gone?.leftAt).toEqual(at(75));
  });

  it('D-25ay: a change made within 5 minutes before the run started counts; one made after the snapshot is re-read late', async () => {
    await refresh(baseFixture(), T0);
    await t.db.insert(watchAccounts).values({ plexAccountId: 1, username: 'owner', role: 'owner' });
    const mark = (id: string, createdAt: Date, plexResult: 'pending' | 'written' = 'pending') =>
      t.db.insert(watchMarks).values({
        plexAccountId: 1,
        action: 'watchlist_add',
        scope: 'movie',
        titleKey: `plex:plex://movie/${id}`,
        kind: 'movie',
        title: 'x',
        plexGuid: `plex://movie/${id}`,
        query: 'q',
        consumer: 'hop',
        plexResult,
        createdAt,
      });
    // `pending` just before the run: plex.tv had not taken it when the run read the owner's list.
    await mark(D, new Date(T0.getTime() - 2 * 60_000));
    await mark(E, new Date(T0.getTime() - 10 * 60_000), 'written'); // outside the margin: the run's read had it
    const snap = await gate(at(0.1));
    expect(snap.overlaySince).toEqual(new Date(T0.getTime() - 5 * 60_000));
    expect(snap.keys.movie.discover.has(D)).toBe(true);
    expect(snap.keys.movie.discover.has(E)).toBe(false);
    const item = (id: string) => ({ media: 'movie' as const, plexGuid: `plex://movie/${id}`, tmdbId: null, tvdbId: null });
    expect(await isOnLateWatchlist({ db: t.db, snapshot: snap, item: item(C) })).toBe(false);
    await mark(C, at(0.2)); // after the snapshot was taken
    expect(await isOnLateWatchlist({ db: t.db, snapshot: snap, item: item(C) })).toBe(true);
    expect(await isOnLateWatchlist({ db: t.db, snapshot: snap, item: item(E) })).toBe(false);
  });

  it('D-25bg: the card`s "Lists" split counts every current account once, the same way as the headline', async () => {
    const f = baseFixture();
    f.accounts!.push(
      { plexAccountId: '104', cls: 'friend', community: { kind: 'answered', nodes: [] } },
      { plexAccountId: '105', cls: 'friend', community: { kind: 'answered', nodes: [] } },
    );
    const report = await refresh(f, T0);
    const c = report.counts!;
    // 1 owner + 101 (titles) + 102 (a Seerr list) are read; 104/105 answered only empty and unverified; 103 managed.
    expect(c.byList).toEqual({ read: 3, empty: 2, never_read: 0, unreadable: 0, unresolvable: 1 });
    expect(Object.values(c.byList).reduce((a, b) => a + b, 0)).toBe(c.roster);
    expect(c.byList.read).toBe(c.accountsRead);
    expect(c.roster - c.byList.read).toBe(c.accountsUnreadable);
    const summary = await getWatchlistRegistrySummary({ db: t.db });
    expect(summary.byList).toEqual(c.byList);
  });

  it('the lock: a second refresh while one holds it is `busy` (the CronJob skips)', async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>((r) => (release = r));
    const s = createStaticWatchlistSources(baseFixture());
    const slowOwner = s.sources.plex[0]!;
    const slow = {
      ...s.sources,
      plex: [
        {
          ...slowOwner,
          label: 'slow',
          getOwner: async () => (await gateOpen, slowOwner.getOwner()),
        },
      ],
    };
    const first = refreshWatchlistRegistry({
      db: t.db,
      sources: slow,
      trigger: 'schedule',
      logger,
      now: () => T0,
      sleep: noSleep,
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = await refresh(s, T0);
    expect(second.status).toBe('busy');
    release();
    await expect(first).resolves.toMatchObject({ status: 'ok' });
  });

  it('the Watchlists card summary is counts only', async () => {
    await refresh(baseFixture(), T0);
    const summary = await getWatchlistRegistrySummary({ db: t.db });
    expect(summary).toMatchObject({
      checkedAt: expect.any(String),
      accountsRead: 3,
      accountsUnreadable: 1,
      byClass: { owner: 1, friend: 2, home_managed: 1 },
      lastRun: { status: 'ok', failure: null },
    });
  });
});
