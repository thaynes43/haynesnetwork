// ADR-093 C-11 / DESIGN-052 D-17 (PLAN-072 S2) — everyone's Seerr watchlist: the enrollment step behind the audited
// `seerr_watchlist_enroll` setting, on embedded PG16 with in-memory Seerr clients (the HTTP echo of the settings body
// is covered by the @hnet/arr client tests). Off does nothing; `onlyUserIds` limits a canary; a user already on is
// recorded `already_on`; a write whose response does not show both flags leaves no row (retried next run); an
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
  failWrite: Set<number>;
  ignoreWrite: Set<number>;
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
    failWrite: new Set(),
    ignoreWrite: new Set(),
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
      setWatchlistSync: async (id: number, f: { movies: boolean; tv: boolean }) => {
        fake.writes.push(id);
        if (fake.failWrite.has(id)) throw new Error('500');
        if (!fake.ignoreWrite.has(id)) flags.set(id, { ...f });
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

  it('a failed or not-applied write leaves no row (retried next run)', async () => {
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
    expect(await t.db.select().from(seerrWatchlistEnrollments)).toEqual([]);
    fake.failWrite.clear();
    fake.ignoreWrite.clear();
    expect(
      (await enrollSeerrWatchlistSync({ db: t.db, seerr: fake.clients, logger })).enrolled,
    ).toBe(2);
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
