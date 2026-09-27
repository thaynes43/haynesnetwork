// ADR-093 C-11 / DESIGN-052 D-17 (PLAN-072 S2) — everyone's Seerr watchlist: the enrollment step behind the audited
// `seerr_watchlist_enroll` setting, on embedded PG16 with in-memory Seerr clients (the HTTP echo of the settings body
// is covered by the @hnet/arr client tests). Off does nothing; `onlyUserIds` limits a canary; a user already on is
// recorded `already_on`; a write whose response does not show both flags leaves only a pending row (retried next run,
// D-25bs), and a write whose answer is lost is confirmed by the next read as the app's own enrollment; an
// enrolled user who later turns sync off is noted once and never turned back on; the anime-tags preflight reads back.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { permissionAudit, seerrWatchlistEnrollments } from '@hnet/db/schema';
import {
  enrollSeerrWatchlistSync,
  getSeerrEnrollSummary,
  getSeerrWatchlistEnroll,
  setSeerrSonarrAnimeTags,
  setSeerrWatchlistEnroll,
  type DomainLogger,
  type SeerrEnrollClients,
} from '../src/index';
import { bootMigratedDb, type TestDb } from './helpers';

interface FakeSeerr {
  clients: SeerrEnrollClients;
  flags: Map<number, { movies: boolean; tv: boolean }>;
  writes: number[];
  /** The write's own GET fails: nothing is sent (D-25cj). */
  failGet: Set<number>;
  failWrite: Set<number>;
  ignoreWrite: Set<number>;
  /** Seerr saves the flags, then the answer is lost (a 10 s client timeout). */
  loseAnswer: Set<number>;
  animeTags: number[];
}

function fakeSeerr(): FakeSeerr {
  const flags = new Map<number, { movies: boolean; tv: boolean }>([
    [1, { movies: true, tv: true }], // the owner (already on)
    [2, { movies: false, tv: false }],
    [3, { movies: false, tv: false }],
    [4, { movies: true, tv: false }],
    [9, { movies: false, tv: false }], // a local user (type 2): never enrolled
  ]);
  const fake: FakeSeerr = {
    flags,
    writes: [],
    failGet: new Set(),
    failWrite: new Set(),
    ignoreWrite: new Set(),
    loseAnswer: new Set(),
    animeTags: [],
    clients: undefined as unknown as SeerrEnrollClients,
  };
  fake.clients = {
    read: {
      listUsers: async () => [
        { id: 1, plexId: '100', userType: 1 },
        { id: 2, plexId: '200', userType: 1 },
        { id: 3, plexId: '300', userType: 1 },
        { id: 4, plexId: '400', userType: 1 },
        { id: 9, plexId: null, userType: 2 },
      ],
      getUserWatchlistSync: async (id: number) => ({ ...flags.get(id)! }),
      listSonarrServers: async () => [
        { id: 0, name: 'Sonarr', tags: [1], animeTags: fake.animeTags },
      ],
    },
    write: {
      // Like SeerrWriteClient: the GET, then the caller's `beforeWrite`, then the POST.
      setWatchlistSync: async (
        id: number,
        f: { movies: boolean; tv: boolean },
        options: { beforeWrite?: () => Promise<void> } = {},
      ) => {
        if (fake.failGet.has(id)) throw new Error('GET 503');
        await options.beforeWrite?.();
        fake.writes.push(id);
        if (fake.failWrite.has(id)) throw new Error('500');
        if (!fake.ignoreWrite.has(id)) flags.set(id, { ...f });
        if (fake.loseAnswer.has(id)) throw new Error('ArrTimeoutError: no answer within 10000 ms');
        return { ...flags.get(id)! };
      },
      setSonarrAnimeTags: async (_id: number, tags: number[]) => {
        fake.animeTags = tags;
        return { id: 0, name: 'Sonarr', tags: [1], animeTags: tags };
      },
    },
  };
  return fake;
}

describe('Seerr watchlist enrollment (ADR-093 C-11 / DESIGN-052 D-17)', () => {
  let t: TestDb;
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: DomainLogger = {
    info: (msg, fields) => logs.push({ msg, fields }),
    warn: (msg, fields) => logs.push({ msg, fields }),
    error: (msg, fields) => logs.push({ msg, fields }),
  };
  beforeAll(async () => {
    t = await bootMigratedDb();
  });
  afterAll(async () => t?.stop());
  beforeEach(async () => {
    logs.length = 0;
    await t.db.delete(seerrWatchlistEnrollments);
  });

  it('is off out of the box: nothing is read or written', async () => {
    const fake = fakeSeerr();
    expect(await getSeerrWatchlistEnroll({ db: t.db })).toEqual({
      enabled: false,
      onlyUserIds: null,
    });
    expect(await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger })).toMatchObject(
      { status: 'disabled' },
    );
    expect(fake.writes).toEqual([]);
  });

  it('the setting write is audited; a canary enrolls only the named user, then all enroll the rest once', async () => {
    const fake = fakeSeerr();
    await setSeerrWatchlistEnroll({
      db: t.db,
      value: { enabled: true, onlyUserIds: [2] },
      actorId: null,
    });
    const audits = await t.db
      .select()
      .from(permissionAudit)
      .where(eq(permissionAudit.action, 'update_app_setting'));
    expect(
      audits.some((a) => (a.detail as { key?: string }).key === 'seerr_watchlist_enroll'),
    ).toBe(true);

    const canary = await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger });
    expect(canary).toMatchObject({ status: 'ok', enrolled: 1, alreadyOn: 0 });
    expect(fake.writes).toEqual([2]);

    await setSeerrWatchlistEnroll({
      db: t.db,
      value: { enabled: true, onlyUserIds: null },
      actorId: null,
    });
    const all = await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger });
    expect(all).toMatchObject({ enrolled: 2, alreadyOn: 1 }); // 3 and 4 written; the owner already on
    expect(fake.writes).toEqual([2, 3, 4]);
    const rows = await t.db.select().from(seerrWatchlistEnrollments);
    expect(rows.map((r) => [r.seerrUserId, r.alreadyOn, r.plexAccountId]).sort()).toEqual([
      [1, true, '100'],
      [2, false, '200'],
      [3, false, '300'],
      [4, false, '400'],
    ]);
    // Enrolled once: the next run writes nothing.
    await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger });
    expect(fake.writes).toEqual([2, 3, 4]);
    expect(logs.filter((l) => l.msg === '[seerr-enroll] enrolled')).toHaveLength(4);
    expect(JSON.stringify(logs)).not.toMatch(/email|username/i);
  });

  it('a failed or not-applied write leaves only a pending row (never counted, retried next run)', async () => {
    const fake = fakeSeerr();
    fake.failWrite.add(2);
    fake.ignoreWrite.add(3);
    await setSeerrWatchlistEnroll({
      db: t.db,
      value: { enabled: true, onlyUserIds: [2, 3] },
      actorId: null,
    });
    const report = await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger });
    expect(report).toMatchObject({ enrolled: 0, failed: 2 });
    const pending = await t.db.select().from(seerrWatchlistEnrollments);
    expect(pending.map((r) => [r.seerrUserId, r.alreadyOn, r.confirmedAt]).sort()).toEqual([
      [2, false, null],
      [3, false, null],
    ]);
    expect(await getSeerrEnrollSummary({ db: t.db })).toMatchObject({ enrolled: 0, alreadyOn: 0, pending: 2 });
    fake.failWrite.clear();
    fake.ignoreWrite.clear();
    expect(
      (await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger })).enrolled,
    ).toBe(2);
    expect(fake.writes).toEqual([2, 3, 2, 3]);
    expect(await getSeerrEnrollSummary({ db: t.db })).toMatchObject({ enrolled: 2, alreadyOn: 0, pending: 0 });
  });

  it('D-25bs: a write whose answer is lost (Seerr saved both flags) is still the app`s enrollment, never already_on', async () => {
    const fake = fakeSeerr();
    fake.loseAnswer.add(2);
    await setSeerrWatchlistEnroll({ db: t.db, value: { enabled: true, onlyUserIds: [2] }, actorId: null });
    const first = await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger });
    expect(first).toMatchObject({ enrolled: 0, alreadyOn: 0, failed: 1 });
    expect(fake.flags.get(2)).toEqual({ movies: true, tv: true }); // Seerr did save them
    fake.loseAnswer.clear();
    // The next run reads both flags on. The pending row says the app wrote them: confirmed as enrolled, no new write.
    const second = await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger });
    expect(second).toMatchObject({ enrolled: 1, alreadyOn: 0, confirmed: 1, failed: 0 });
    expect(fake.writes).toEqual([2]);
    const [row] = await t.db.select().from(seerrWatchlistEnrollments);
    expect(row).toMatchObject({ seerrUserId: 2, alreadyOn: false, confirmedAt: expect.any(Date) });
    expect(await getSeerrEnrollSummary({ db: t.db })).toMatchObject({ enrolled: 1, alreadyOn: 0, pending: 0 });
    // A rollback that turns off only the app's enrollments (already_on = false) finds this user.
    const appRows = (await t.db.select().from(seerrWatchlistEnrollments)).filter((r) => !r.alreadyOn);
    expect(appRows.map((r) => r.seerrUserId)).toEqual([2]);
  });

  it('D-25cj: each row keeps the user`s own flags before the write, so a rollback restores exactly those', async () => {
    const fake = fakeSeerr();
    await setSeerrWatchlistEnroll({ db: t.db, value: { enabled: true, onlyUserIds: null }, actorId: null });
    await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger });
    const rows = await t.db.select().from(seerrWatchlistEnrollments);
    expect(rows.map((r) => [r.seerrUserId, r.alreadyOn, r.moviesBefore, r.tvBefore]).sort()).toEqual([
      [1, true, true, true],
      [2, false, false, false],
      [3, false, false, false],
      [4, false, true, false], // movie sync was already on: a rollback leaves it on
    ]);
    const line = logs.find((l) => l.msg === '[seerr-enroll] enrolled' && l.fields?.seerrUserId === 4);
    expect(line?.fields).toMatchObject({ alreadyOn: false, moviesBefore: true, tvBefore: false });
  });

  it('D-25cj: a write whose own GET failed sent nothing and records nothing; the user turning sync on later is already_on', async () => {
    const fake = fakeSeerr();
    fake.failGet.add(2);
    await setSeerrWatchlistEnroll({ db: t.db, value: { enabled: true, onlyUserIds: [2] }, actorId: null });
    expect(await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger })).toMatchObject({ failed: 1 });
    expect(await t.db.select().from(seerrWatchlistEnrollments)).toEqual([]);
    // The user turns watchlist sync on in Seerr before the next run: theirs, not the app's.
    fake.flags.set(2, { movies: true, tv: true });
    expect(await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger })).toMatchObject({ alreadyOn: 1 });
    const [row] = await t.db.select().from(seerrWatchlistEnrollments);
    expect(row).toMatchObject({ seerrUserId: 2, alreadyOn: true });
    expect(fake.writes).toEqual([]);
  });

  it('respects a later opt-out: noted once after a day, never turned back on', async () => {
    const fake = fakeSeerr();
    await setSeerrWatchlistEnroll({
      db: t.db,
      value: { enabled: true, onlyUserIds: [2] },
      actorId: null,
    });
    const t0 = new Date('2026-10-01T00:00:00Z');
    await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger, now: t0 });
    fake.flags.set(2, { movies: false, tv: true }); // the user turned movies off in Seerr
    const soon = await enrollSeerrWatchlistSync({
      db: t.db,
      seerr: fake.clients,
      logger,
      now: new Date(t0.getTime() + 3_600_000),
    });
    expect(soon.rechecked).toBe(0); // re-checked once a day
    const day = await enrollSeerrWatchlistSync({
      db: t.db,
      seerr: fake.clients,
      logger,
      now: new Date(t0.getTime() + 25 * 3_600_000),
    });
    expect(day).toMatchObject({ rechecked: 1, optoutsObserved: 1 });
    const later = await enrollSeerrWatchlistSync({
      db: t.db,
      seerr: fake.clients,
      logger,
      now: new Date(t0.getTime() + 50 * 3_600_000),
    });
    expect(later.optoutsObserved).toBe(0);
    expect(fake.writes).toEqual([2]); // never written again
    expect(fake.flags.get(2)).toEqual({ movies: false, tv: true });
    expect(await getSeerrEnrollSummary({ db: t.db })).toMatchObject({ enrolled: 1, optedOut: 1 });
  });

  it('the anime-tags preflight writes and reads back', async () => {
    const fake = fakeSeerr();
    expect(
      await setSeerrSonarrAnimeTags({ seerr: fake.clients, serverId: 0, animeTags: [1], logger }),
    ).toEqual({
      serverId: 0,
      before: [],
      after: [1],
      tags: [1],
    });
    await expect(
      setSeerrSonarrAnimeTags({ seerr: fake.clients, serverId: 5, animeTags: [1] }),
    ).rejects.toThrow(/no Sonarr server/);
  });
});
