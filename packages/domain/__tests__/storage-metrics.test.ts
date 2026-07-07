// ADR-030 / DESIGN-013 (PLAN-013) — the metrics vertical.
//   getUtilization: merges *arr /diskspace with space_targets; resilient to a downed *arr (partial
//     result with `unavailable`, never a throw); dedupes the shared HaynesTower array.
//   getReclaim: exact category × resolution / cumulative-by-day / per-batch attribution math over
//     seeded embedded-PG deletion snapshots, with the window filter and the best-effort expedite series.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledgerEvents, trashBatchItems, trashBatches } from '@hnet/db/schema';
import {
  buildArrClientBundle,
  getReclaim,
  getUtilization,
  reclaimWindowSince,
  setAppSetting,
  type ArrClientBundle,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const GB = 1_000_000_000;
const TB = 1_000_000_000_000;

// --- diskspace stub: per-kind response, or 'fail' to simulate a downed *arr -------------------------
type DiskSpec = { path: string; freeSpace: number; totalSpace: number }[] | 'fail';
function makeArrBundle(cfg: { radarr?: DiskSpec; sonarr?: DiskSpec; lidarr?: DiskSpec }): ArrClientBundle {
  const byHost: Record<string, DiskSpec | undefined> = {
    'radarr.test': cfg.radarr,
    'sonarr.test': cfg.sonarr,
    'lidarr.test': cfg.lidarr,
  };
  const fetchImpl = (async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/diskspace')) {
      const spec = byHost[url.hostname];
      if (spec === 'fail' || spec === undefined) {
        return new Response('{"message":"down"}', { status: 500 });
      }
      return new Response(JSON.stringify(spec), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{"message":"no stub"}', { status: 404 });
  }) as typeof fetch;
  const opts = { apiKey: 'k', retryDelayMs: 0, fetchImpl } as const;
  return buildArrClientBundle({
    sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
    radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
    lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
    bazarr: { baseUrl: 'http://bazarr.test:6767', ...opts },
  });
}

const TOWER: DiskSpec = [{ path: '/data/haynestower', freeSpace: 112.4304 * TB, totalSpace: 529.96 * TB }];
const MUSIC: DiskSpec = [{ path: '/data/cephfs-hdd', freeSpace: 130.45 * TB, totalSpace: 174.84 * TB }];

describe('getUtilization (ADR-030 C-03 — *arr /diskspace source of record)', () => {
  let t: TestDb;
  let adminId: string;
  beforeAll(async () => {
    t = await bootMigratedDb();
    adminId = (await createUser(t.db, { email: 'util-admin@example.com' })).id;
  });
  afterAll(async () => t?.stop());

  it('merges targets, computes ~78.8% HaynesTower, dedupes the shared array, no cephfs target', async () => {
    await setAppSetting({
      db: t.db,
      key: 'space_targets',
      value: { haynestower: 80 },
      actorId: adminId,
    });
    const bundle = makeArrBundle({ radarr: TOWER, sonarr: TOWER, lidarr: MUSIC });
    const rows = await getUtilization({ db: t.db, arr: bundle });

    const tower = rows.find((r) => r.key === 'haynestower')!;
    expect(tower.unavailable).toBe(false);
    expect(tower.path).toBe('/data/haynestower');
    expect(tower.totalSpace).toBe(529.96 * TB);
    expect(tower.usedPct).toBe(78.8); // the owner's cross-check number
    expect(tower.target).toBe(80);

    const music = rows.find((r) => r.key === 'cephfs')!;
    expect(music.usedPct).toBe(25.4);
    expect(music.target).toBeNull(); // no slug→array mapping for music today (documented)
  });

  it('one *arr down → HaynesTower still resolves via the OTHER source (partial, no crash)', async () => {
    // Radarr down, Sonarr up: movies+TV share the array, so the reading survives on Sonarr.
    const bundle = makeArrBundle({ radarr: 'fail', sonarr: TOWER, lidarr: 'fail' });
    const rows = await getUtilization({ db: t.db, arr: bundle });
    expect(rows.find((r) => r.key === 'haynestower')!.unavailable).toBe(false);
    // Lidarr down → the music array is unavailable but still returns a row (never throws).
    const music = rows.find((r) => r.key === 'cephfs')!;
    expect(music.unavailable).toBe(true);
    expect(music.freeSpace).toBeNull();
    expect(music.usedPct).toBeNull();
  });

  it('both HaynesTower sources down → the array is unavailable, the read still returns', async () => {
    const bundle = makeArrBundle({ radarr: 'fail', sonarr: 'fail', lidarr: MUSIC });
    const rows = await getUtilization({ db: t.db, arr: bundle });
    expect(rows.find((r) => r.key === 'haynestower')!.unavailable).toBe(true);
    expect(rows.find((r) => r.key === 'cephfs')!.unavailable).toBe(false);
  });
});

describe('getReclaim (ADR-030 C-01 — reclaim attribution over deletion snapshots)', () => {
  let t: TestDb;
  let adminId: string;
  const day1 = new Date(Date.now() - 5 * 86_400_000); // recent
  const day2 = new Date(Date.now() - 3 * 86_400_000); // recent, distinct UTC day
  const ancient = new Date(Date.now() - 400 * 86_400_000); // outside every finite window

  beforeAll(async () => {
    t = await bootMigratedDb();
    adminId = (await createUser(t.db, { email: 'reclaim-admin@example.com', displayName: 'Reclaim Admin' })).id;

    const [movieBatch] = await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'movie', state: 'deleted', greenlitBy: adminId })
      .returning();
    const [tvBatch] = await t.db
      .insert(trashBatches)
      .values({ mediaKind: 'tv', state: 'deleted', greenlitBy: adminId })
      .returning();

    const del = (
      batchId: string,
      mmId: string,
      resolution: string | null,
      sizeBytes: number,
      deletedAt: Date,
    ) => ({
      batchId,
      maintainerrMediaId: mmId,
      title: `T-${mmId}`,
      state: 'deleted' as const,
      deletedAt,
      deletedSizeBytes: sizeBytes,
      deletedResolution: resolution,
    });

    await t.db.insert(trashBatchItems).values([
      // movie batch: two 4K (40 GB each, day1) + three 720p (2 GB each, day2)
      del(movieBatch!.id, 'm1', '2160p', 40 * GB, day1),
      del(movieBatch!.id, 'm2', '2160p', 40 * GB, day1),
      del(movieBatch!.id, 'm3', '720p', 2 * GB, day2),
      del(movieBatch!.id, 'm4', '720p', 2 * GB, day2),
      del(movieBatch!.id, 'm5', '720p', 2 * GB, day2),
      // tv batch: one 1080p (10 GB, day2)
      del(tvBatch!.id, 't1', '1080p', 10 * GB, day2),
      // an ancient movie delete: excluded by finite windows, included by 'all'
      del(movieBatch!.id, 'mOld', '480p', 1 * GB, ancient),
      // a non-deleted (pending) item must NEVER count
      { batchId: movieBatch!.id, maintainerrMediaId: 'mPending', title: 'pending', state: 'pending' },
    ]);

    // Best-effort expedite series: one WITH frozen sizeBytes (counted), one WITHOUT (the pre-capture
    // historical case — excluded), one 'batch'-scope (the sweep — excluded, already in totals).
    await t.db.insert(ledgerEvents).values([
      { eventType: 'trash_expedited', source: 'maintainerr', occurredAt: day2, payload: { scope: 'item', maintainerrMediaId: 'e1', sizeBytes: 5 * GB } },
      { eventType: 'trash_expedited', source: 'maintainerr', occurredAt: day2, payload: { scope: 'all', maintainerrMediaId: 'e2' } },
      { eventType: 'trash_expedited', source: 'maintainerr', occurredAt: day2, payload: { scope: 'batch', maintainerrMediaId: 'e3', sizeBytes: 99 * GB } },
    ]);
  });
  afterAll(async () => t?.stop());

  it('90d window: totals, category × resolution, cumulative-by-day, per-batch attribution', async () => {
    const r = await getReclaim({ db: t.db, window: '90d' });

    // Totals exclude the ancient delete + the pending row.
    expect(r.totals.items).toBe(6);
    expect(r.totals.reclaimedBytes).toBe(80 * GB + 6 * GB + 10 * GB); // 96 GB

    // Category × resolution — the bang-for-buck view, ordered by bytes desc.
    const cell = (k: string, res: string) =>
      r.byCategoryResolution.find((c) => c.mediaKind === k && c.resolution === res)!;
    expect(cell('movie', '2160p')).toMatchObject({ items: 2, reclaimedBytes: 80 * GB });
    expect(cell('movie', '720p')).toMatchObject({ items: 3, reclaimedBytes: 6 * GB });
    expect(cell('tv', '1080p')).toMatchObject({ items: 1, reclaimedBytes: 10 * GB });
    expect(r.byCategoryResolution[0]!.reclaimedBytes).toBe(80 * GB); // 4K leads the reclaim

    // Cumulative curve: day1 = 80 GB, day2 = +16 GB → 96 GB running.
    expect(r.cumulative).toHaveLength(2);
    expect(r.cumulative[0]!.cumulativeReclaimedBytes).toBe(80 * GB);
    expect(r.cumulative[1]!.reclaimedBytes).toBe(16 * GB);
    expect(r.cumulative[1]!.cumulativeReclaimedBytes).toBe(96 * GB);

    // Per-batch rollup attributed to the green-lighting admin.
    expect(r.batches).toHaveLength(2);
    const movie = r.batches.find((b) => b.mediaKind === 'movie')!;
    expect(movie).toMatchObject({ items: 5, reclaimedBytes: 86 * GB, greenlitByName: 'Reclaim Admin' });
    expect(movie.greenlitBy).toBe(adminId);
    expect(r.batches.find((b) => b.mediaKind === 'tv')!.reclaimedBytes).toBe(10 * GB);

    // Best-effort expedite series: only the payload-with-sizeBytes, direct-scope event counts.
    expect(r.expedited).toEqual({ items: 1, reclaimedBytes: 5 * GB });
  });

  it("'all' window includes the ancient delete; a 30d window excludes both it and nothing recent", async () => {
    const all = await getReclaim({ db: t.db, window: 'all' });
    expect(all.since).toBeNull();
    expect(all.totals.items).toBe(7); // + the 480p ancient delete
    expect(all.totals.reclaimedBytes).toBe(97 * GB);
    expect(all.byCategoryResolution.some((c) => c.resolution === '480p')).toBe(true);

    const w30 = await getReclaim({ db: t.db, window: '30d' });
    expect(w30.totals.items).toBe(6); // ancient (400d) excluded
    expect(w30.since).not.toBeNull();
  });

  it('reclaimWindowSince math: finite windows subtract days, all → null', () => {
    const now = new Date('2026-07-07T00:00:00Z');
    expect(reclaimWindowSince('30d', now)!.toISOString()).toBe('2026-06-07T00:00:00.000Z');
    expect(reclaimWindowSince('all', now)).toBeNull();
  });
});
