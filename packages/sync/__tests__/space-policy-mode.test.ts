// ADR-031 / DESIGN-014 — the `space-policy` sync mode wiring: runSync drives evaluateSpacePolicy
// through the injected Maintainerr + *arr diskspace bundles, returns a `spacePolicy` report (never a
// per-source loop / sync_runs row), and requires both bundles. The propose-only evaluation matrix
// itself is covered by the @hnet/domain suite.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildMaintainerrClientBundle,
  defaultPerKind,
  setAppSetting,
  type MaintainerrClientBundle,
  type UtilizationArrBundle,
} from '@hnet/domain';
import { runSync } from '../src/orchestrator';
import { bootMigratedDb, type TestDb } from './helpers';

const TB = 1_000_000_000_000;

function stubMaintainerr(): MaintainerrClientBundle {
  const fetchImpl = (async () =>
    new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  return buildMaintainerrClientBundle({ baseUrl: 'http://maintainerr.test:6246', apiKey: 'k', retryDelayMs: 0, fetchImpl });
}

/** A plain diskspace bundle (UtilizationArrBundle is structural — no real client needed). */
function diskBundle(usedPctTower: number): UtilizationArrBundle {
  const free = (1 - usedPctTower / 100) * 1000 * TB;
  const tower = [{ path: '/data/haynestower', freeSpace: free, totalSpace: 1000 * TB }];
  const music = [{ path: '/data/cephfs-hdd', freeSpace: 130 * TB, totalSpace: 175 * TB }];
  const reader = (rows: { path: string; freeSpace: number; totalSpace: number }[]) => ({
    getDiskSpace: async () => rows,
  });
  return { read: { radarr: reader(tower), sonarr: reader(tower), lidarr: reader(music) } };
}

describe('runSync — space-policy mode (ADR-031)', () => {
  let t: TestDb;
  beforeAll(async () => (t = await bootMigratedDb()));
  afterAll(async () => t?.stop());

  it('policy OFF (default) ⇒ a no-op report, no per-source rows, no failure', async () => {
    const report = await runSync({
      mode: 'space-policy',
      clients: {},
      maintainerr: stubMaintainerr(),
      arr: diskBundle(90),
      db: t.db,
    });
    expect(report.mode).toBe('space-policy');
    expect(report.sources).toEqual([]);
    expect(report.spacePolicy).toMatchObject({ enabled: false, proposedCount: 0 });
    expect(report.totalFailure).toBe(false);
  });

  it('enabled + UNDER target ⇒ reads utilization, proposes nothing', async () => {
    await setAppSetting({ db: t.db, key: 'space_targets', value: { haynestower: 80 }, actorId: null });
    await setAppSetting({
      db: t.db,
      key: 'space_policy',
      value: {
        enabled: true,
        mode: 'over-target',
        cooldownDays: 7,
        minCandidates: 1,
        perArray: { haynestower: { enabled: true } },
        perKind: defaultPerKind(),
      },
      actorId: null,
    });
    const report = await runSync({
      mode: 'space-policy',
      clients: {},
      maintainerr: stubMaintainerr(),
      arr: diskBundle(70), // under the 80 target
      db: t.db,
    });
    expect(report.spacePolicy!.enabled).toBe(true);
    expect(report.spacePolicy!.proposedCount).toBe(0);
    const tower = report.spacePolicy!.arrays.find((a) => a.key === 'haynestower')!;
    expect(tower.usedPct).toBe(70);
    expect(tower.overTarget).toBe(false);
  });

  it('requires both a maintainerr and an *arr bundle', async () => {
    await expect(runSync({ mode: 'space-policy', clients: {}, arr: diskBundle(90), db: t.db })).rejects.toThrow(/maintainerr/);
    await expect(runSync({ mode: 'space-policy', clients: {}, maintainerr: stubMaintainerr(), db: t.db })).rejects.toThrow(/arr/);
  });
});
