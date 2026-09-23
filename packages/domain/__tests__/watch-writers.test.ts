// ADR-088 / DESIGN-049 D-07..D-09 (PLAN-068 S5) — the Watch Companion single writers against embedded
// Postgres 16: the owner row (and an owner change as an UPDATE), the append-only event log's insert-or-ignore,
// the Q-06 show-guid fill (the one permitted event update), the Title State upsert (changed rows only,
// re-key in place, never delete) and the signal replace.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  watchAccounts,
  watchEvents,
  watchRecoSignals,
  watchTitles,
  type Database,
} from '@hnet/db';
import {
  appendWatchEvents,
  fillShowGuids,
  newestEventStart,
  replaceRecoSignals,
  upsertWatchOwner,
  upsertWatchTitles,
  type WatchEventInput,
  type WatchTitleWrite,
} from '../src/watch';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const OWNER = 12874060;

function event(rowId: number, extra: Partial<WatchEventInput> = {}): WatchEventInput {
  return {
    instance: 'haynestower',
    tautulliRowId: rowId,
    kind: 'episode',
    itemGuid: `plex://episode/${rowId}`,
    showGuid: 'plex://show/aaa',
    title: `Episode ${rowId}`,
    showTitle: 'Breaking Prod',
    season: 1,
    episode: rowId % 10,
    year: 2019,
    ratingKey: String(rowId),
    grandparentRatingKey: '501',
    startedAt: new Date(Date.UTC(2026, 0, 1) + rowId * 60_000),
    stoppedAt: new Date(Date.UTC(2026, 0, 1) + rowId * 60_000 + 2_700_000),
    percentComplete: 100,
    watched: true,
    ...extra,
  };
}

function titleWrite(extra: Partial<WatchTitleWrite> & Pick<WatchTitleWrite, 'titleKey' | 'title'>): WatchTitleWrite {
  return {
    kind: 'show',
    plexGuid: null,
    tmdbId: null,
    tvdbId: null,
    imdbId: null,
    mediaItemId: null,
    year: 2019,
    genres: ['Drama'],
    contentRating: 'TV-MA',
    isKids: false,
    onPlex: [],
    plexCounts: {},
    showStatus: null,
    episodeMap: null,
    episodesTotal: null,
    episodesWatched: null,
    furthestSeason: null,
    furthestEpisode: null,
    nextSeason: null,
    nextEpisode: null,
    nextTitle: null,
    nextServer: null,
    nextRatingKey: null,
    nextResume: false,
    resumePercent: null,
    plexWatched: false,
    plexLastViewedAt: null,
    eventPlays: 0,
    eventWatchedEpisodes: 0,
    firstWatchedAt: null,
    lastWatchedAt: null,
    rewatch: false,
    ...extra,
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

describe('upsertWatchOwner (D-09 step 1)', () => {
  it('writes the one owner row, links the app user by email, and demotes a previous owner (never deletes)', async () => {
    const user = await createUser(db, { email: 'owner@example.test' });
    const first = await upsertWatchOwner({
      db,
      account: { id: String(OWNER), username: 'plexowner', email: 'Owner@Example.test' },
    });
    expect(first).toMatchObject({ plexAccountId: OWNER, role: 'owner', appUserId: user.id, tracked: true });

    const again = await upsertWatchOwner({
      db,
      account: { id: String(OWNER), username: 'renamed', email: null },
    });
    expect(again).toMatchObject({ plexAccountId: OWNER, username: 'renamed', role: 'owner', appUserId: null });

    // A different Server Owner: the old row stays, demoted and untracked; exactly one owner.
    await upsertWatchOwner({ db, account: { id: '999', username: 'other', email: null } });
    const rows = await db.select().from(watchAccounts).orderBy(watchAccounts.plexAccountId);
    expect(rows.map((r) => [r.plexAccountId, r.role, r.tracked])).toEqual([
      [999, 'owner', true],
      [OWNER, 'household', false],
    ]);
    // …and back.
    await upsertWatchOwner({ db, account: { id: String(OWNER), username: 'plexowner', email: null } });
    const owners = await db.select().from(watchAccounts).where(eq(watchAccounts.role, 'owner'));
    expect(owners.map((o) => o.plexAccountId)).toEqual([OWNER]);
  });

  it('refuses an account id that is not a positive integer', async () => {
    await expect(
      upsertWatchOwner({ db, account: { id: 'abc', username: 'x', email: null } }),
    ).rejects.toThrow(/positive integer/);
  });
});

describe('appendWatchEvents / fillShowGuids (D-09 step 2, Q-06)', () => {
  beforeEach(async () => {
    await upsertWatchOwner({ db, account: { id: String(OWNER), username: 'plexowner', email: null } });
  });

  it('inserts-or-ignores on (instance, row id): a re-read window never duplicates', async () => {
    const first = await appendWatchEvents({ db, plexAccountId: OWNER, events: [event(1), event(2), event(3)] });
    expect(first.inserted.map((e) => e.title)).toEqual(['Episode 1', 'Episode 2', 'Episode 3']);
    const second = await appendWatchEvents({
      db,
      plexAccountId: OWNER,
      events: [event(2), event(3), event(4), event(3, { instance: 'haynesops' })],
    });
    // Row 3 on ANOTHER instance is a different event (identity is per instance).
    expect(second.inserted.map((e) => [e.instance, e.title])).toEqual([
      ['haynestower', 'Episode 4'],
      ['haynesops', 'Episode 3'],
    ]);
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from watch_events`)).rows as [{ n: number }];
    expect(n).toBe(5);
    expect(await newestEventStart(db, OWNER, 'haynestower')).toEqual(event(4).startedAt);
    expect(await newestEventStart(db, OWNER, 'hayneskube')).toBeNull();
  });

  it('fills a NULL show_guid for one (instance, grandparent key) only — never overwrites a known guid', async () => {
    await appendWatchEvents({
      db,
      plexAccountId: OWNER,
      events: [
        event(101, { showGuid: null, grandparentRatingKey: '777', showTitle: 'Gone Show' }),
        event(102, { showGuid: null, grandparentRatingKey: '777', showTitle: 'Gone Show' }),
        event(103, { showGuid: null, grandparentRatingKey: '777', instance: 'haynesops' }),
        event(104, { showGuid: 'plex://show/known', grandparentRatingKey: '777' }),
      ],
    });
    const { filled } = await fillShowGuids({
      db,
      plexAccountId: OWNER,
      fills: [
        { instance: 'haynestower', grandparentRatingKey: '777', showGuid: 'plex://show/found' },
        { instance: 'haynestower', grandparentRatingKey: '777', showGuid: 'not-a-show-guid' },
      ],
    });
    expect(filled).toBe(2);
    const rows = await db
      .select({ row: watchEvents.tautulliRowId, instance: watchEvents.instance, guid: watchEvents.showGuid })
      .from(watchEvents)
      .where(sql`${watchEvents.tautulliRowId} between 101 and 104`)
      .orderBy(watchEvents.tautulliRowId);
    expect(rows).toEqual([
      { row: 101, instance: 'haynestower', guid: 'plex://show/found' },
      { row: 102, instance: 'haynestower', guid: 'plex://show/found' },
      { row: 103, instance: 'haynesops', guid: null },
      { row: 104, instance: 'haynestower', guid: 'plex://show/known' },
    ]);
  });
});

describe('upsertWatchTitles (D-08, D-09 step 5)', () => {
  beforeEach(async () => {
    await upsertWatchOwner({ db, account: { id: String(OWNER), username: 'plexowner', email: null } });
  });

  it('inserts, skips an unchanged row (refreshed_at stays), updates a changed one', async () => {
    const at1 = new Date('2026-09-20T00:00:00Z');
    const w = titleWrite({
      titleKey: 'name:show:silo|2023',
      title: 'Silo',
      year: 2023,
      episodeMap: { '1': [[1, 1, 1_700_000_000, { haynesops: '11' }]] },
      plexCounts: { haynesops: { leafCount: 10, viewedLeafCount: 1, lastViewedAt: 1_700_000_000 } },
      onPlex: [{ server: 'haynesops', ratingKey: '10', local: false }],
      lastWatchedAt: new Date(1_700_000_000_000),
    });
    const r1 = await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [w], now: at1 });
    expect(r1).toMatchObject({ inserted: 1, updated: 0, unchanged: 0 });
    const id = r1.rows[0]?.id;

    const at2 = new Date('2026-09-21T00:00:00Z');
    const r2 = await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [{ ...w }], now: at2 });
    expect(r2).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(r2.rows[0]?.refreshedAt).toEqual(at1);

    const r3 = await upsertWatchTitles({
      db,
      plexAccountId: OWNER,
      titles: [{ ...w, episodesWatched: 2 }],
      now: at2,
    });
    expect(r3).toMatchObject({ updated: 1, rekeyed: 0 });
    expect(r3.rows[0]).toMatchObject({ id, episodesWatched: 2, refreshedAt: at2 });
  });

  it('re-keys an event-only row IN PLACE when it learns a stronger key, and never downgrades', async () => {
    const eventOnly = titleWrite({ titleKey: 'name:show:gone show|2015', title: 'Gone Show', year: 2015, eventPlays: 3 });
    const [row] = (await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [eventOnly] })).rows;
    expect(row?.titleKey).toBe('name:show:gone show|2015');

    const back = titleWrite({
      titleKey: 'plex:plex://show/gone',
      title: 'Gone Show',
      year: 2015,
      plexGuid: 'plex://show/gone',
      tvdbId: 4040,
      eventPlays: 3,
      onPlex: [{ server: 'haynestower', ratingKey: '4040', local: false }],
    });
    const r = await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [back] });
    expect(r).toMatchObject({ inserted: 0, updated: 1, rekeyed: 1 });
    expect(r.rows[0]).toMatchObject({ id: row?.id, titleKey: 'plex:plex://show/gone', tvdbId: 4040 });

    // A later input that only knows the name keeps the stronger key (and the ids it is given).
    const weaker = titleWrite({ titleKey: 'name:show:gone show|2015', title: 'Gone Show', year: 2015, eventPlays: 4 });
    const r2 = await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [weaker] });
    expect(r2.rows[0]).toMatchObject({ id: row?.id, titleKey: 'plex:plex://show/gone', eventPlays: 4 });

    // A show and a movie of the same name and year are different titles (the key carries the kind).
    const movie = titleWrite({ kind: 'movie', titleKey: 'name:movie:gone show|2015', title: 'Gone Show', year: 2015 });
    const r3 = await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [movie] });
    expect(r3.inserted).toBe(1);
    expect(r3.rows[0]?.id).not.toBe(row?.id);
  });

  it('never deletes: a title gone from Plex keeps its row with on_plex = []', async () => {
    const w = titleWrite({
      titleKey: 'plex:plex://show/left',
      plexGuid: 'plex://show/left',
      title: 'Left Plex',
      onPlex: [{ server: 'haynesops', ratingKey: '9', local: false }],
      eventWatchedEpisodes: 5,
    });
    await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [w] });
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(watchTitles);
    const r = await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [{ ...w, onPlex: [] }] });
    expect(r.rows[0]).toMatchObject({ onPlex: [], eventWatchedEpisodes: 5 });
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(watchTitles);
    expect(after).toEqual(before);
  });

  it('never re-keys a row to a key an earlier input of the same batch is inserting (no unique violation)', async () => {
    const stored = titleWrite({ titleKey: 'name:show:twin peaks|1990', title: 'Twin Peaks', year: 1990 });
    const [row] = (await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [stored] })).rows;
    // First a NEW title that carries TVDB 1234, then an input that matches the stored row by name and has
    // the same (stronger) TVDB key: the insert claims `tvdb:1234`, so the stored row keeps its key.
    const inserted = titleWrite({ titleKey: 'tvdb:1234', tvdbId: 1234, title: 'Other Show', year: 2001 });
    const rekey = titleWrite({ titleKey: 'tvdb:1234', tvdbId: 1234, title: 'Twin Peaks', year: 1990, eventPlays: 2 });
    const r = await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [inserted, rekey] });
    expect(r).toMatchObject({ inserted: 1, updated: 1, rekeyed: 0, conflicts: 0 });
    expect(r.rows[0]).toMatchObject({ titleKey: 'tvdb:1234', title: 'Other Show' });
    expect(r.rows[1]).toMatchObject({ id: row?.id, titleKey: 'name:show:twin peaks|1990', eventPlays: 2 });
  });

  it('matches by any shared identity key and reports a second input claiming the same row', async () => {
    const a = titleWrite({ titleKey: 'tvdb:555', tvdbId: 555, title: 'Twin', year: 2020 });
    await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [a] });
    const viaImdb = titleWrite({ titleKey: 'tvdb:555', tvdbId: 555, imdbId: 'tt555', title: 'Twin', year: 2020 });
    const viaName = titleWrite({ titleKey: 'name:show:twin|2020', title: 'Twin', year: 2020, eventPlays: 9 });
    const r = await upsertWatchTitles({ db, plexAccountId: OWNER, titles: [viaImdb, viaName] });
    expect(r.conflicts).toBe(1);
    expect(r.rows[0]?.imdbId).toBe('tt555');
    expect(r.rows[1]?.id).toBe(r.rows[0]?.id);
  });
});

describe('replaceRecoSignals (D-09 steps 6–7)', () => {
  beforeEach(async () => {
    await upsertWatchOwner({ db, account: { id: String(OWNER), username: 'plexowner', email: null } });
  });

  it("replaces one source's rows in one transaction and leaves the other source alone", async () => {
    const base = { tvdbId: null, imdbId: null, plexGuid: null };
    await replaceRecoSignals({
      db,
      plexAccountId: OWNER,
      source: 'tmdb_seed',
      rows: [{ ...base, kind: 'show', title: 'Foundation', year: 2021, tmdbId: 93740, seedTitleKey: 'x', seedTitle: 'The Expanse', rank: 0 }],
    });
    await replaceRecoSignals({
      db,
      plexAccountId: OWNER,
      source: 'watchlist',
      rows: [
        { ...base, kind: 'show', title: 'Severance', year: 2022, tmdbId: 95396, rank: 0 },
        { ...base, kind: 'movie', title: 'Dune', year: 2021, tmdbId: 438631, rank: 1 },
      ],
    });
    await replaceRecoSignals({
      db,
      plexAccountId: OWNER,
      source: 'watchlist',
      rows: [{ ...base, kind: 'movie', title: 'Dune', year: 2021, tmdbId: 438631, rank: 0 }],
    });
    const rows = await db
      .select({ source: watchRecoSignals.source, title: watchRecoSignals.title, rank: watchRecoSignals.rank })
      .from(watchRecoSignals)
      .orderBy(watchRecoSignals.source, watchRecoSignals.rank);
    expect(rows).toEqual([
      { source: 'tmdb_seed', title: 'Foundation', rank: 0 },
      { source: 'watchlist', title: 'Dune', rank: 0 },
    ]);
  });
});
