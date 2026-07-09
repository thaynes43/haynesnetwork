// ADR-030 amendment (2026-07-09) / DESIGN-013 D-07 — the native free-space trend. Proves:
//   • the thin Prometheus client (URL/query construction, zod matrix validation, HTTP/shape errors);
//   • the window→step math stays inside the ~200-point budget on clean boundaries;
//   • mapTrendSeries groups exportarr rootfolder paths onto the SAME arrays getUtilization uses
//     (haynestower deduped radarr-first with sonarr fallback; music via mount OR rootfolder label),
//     max-merges multi-rootfolder sources, and converts the percent-used target to a free-bytes floor;
//   • the degrade path — Prometheus down ⇒ `unavailable`, never a thrown trend (router-level too);
//   • storage.trend is adminProcedure (a member is FORBIDDEN).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { users } from '@hnet/db';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';
import { stubArrBundle } from './arr-stubs';
import { createPrometheusClient, prometheusClientFromEnv, PROMETHEUS_DEFAULT_URL } from '../src/prometheus';
import type { PromMatrixSeries, PrometheusRangeReader } from '../src/prometheus';
import {
  FREESPACE_TREND_QUERY,
  getStorageTrend,
  mapTrendSeries,
  TREND_WINDOWS,
  TREND_WINDOW_SPECS,
} from '../src/storage-trend';
import type { StorageArrayUtilization } from '@hnet/domain';

const TB = 1_000_000_000_000;

// ---------------------------------------------------------------------------------------------------
// The thin Prometheus client
// ---------------------------------------------------------------------------------------------------

function matrixResponse(result: PromMatrixSeries[]): Response {
  return new Response(
    JSON.stringify({ status: 'success', data: { resultType: 'matrix', result } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('createPrometheusClient — GET /api/v1/query_range + zod matrix validation', () => {
  it('builds the query_range URL (query/start/end/step) and returns the validated matrix', async () => {
    const seen: string[] = [];
    const series: PromMatrixSeries[] = [
      {
        metric: { __name__: 'radarr_rootfolder_freespace_bytes', path: '/data/haynestower/Media/Movies' },
        values: [[1_783_000_000, '112505914261504']],
      },
    ];
    const client = createPrometheusClient({
      baseUrl: 'http://prom.test:9090/', // trailing slash must not double up
      fetchImpl: (async (input: unknown) => {
        seen.push(String(input));
        return matrixResponse(series);
      }) as typeof fetch,
    });
    const result = await client.queryRange('up', 1_783_000_000, 1_783_003_600, 3600);
    expect(result).toEqual(series);
    const url = new URL(seen[0]!);
    expect(url.origin + url.pathname).toBe('http://prom.test:9090/api/v1/query_range');
    expect(url.searchParams.get('query')).toBe('up');
    expect(url.searchParams.get('start')).toBe('1783000000');
    expect(url.searchParams.get('end')).toBe('1783003600');
    expect(url.searchParams.get('step')).toBe('3600');
  });

  it('throws on a non-200 and on a misshapen body (the degrade triggers)', async () => {
    const boom = createPrometheusClient({
      baseUrl: 'http://prom.test:9090',
      fetchImpl: (async () => new Response('oops', { status: 503 })) as typeof fetch,
    });
    await expect(boom.queryRange('up', 0, 1, 1)).rejects.toThrow(/HTTP 503/);

    const misshapen = createPrometheusClient({
      baseUrl: 'http://prom.test:9090',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }), {
          status: 200,
        })) as typeof fetch,
    });
    await expect(misshapen.queryRange('up', 0, 1, 1)).rejects.toThrow(/unexpected shape/);
  });

  it('prometheusClientFromEnv defaults to the in-cluster service and honors PROMETHEUS_URL', () => {
    // The default is the documented in-cluster URL (no helmrelease env line required).
    expect(PROMETHEUS_DEFAULT_URL).toBe(
      'http://prometheus-operated.observability.svc.cluster.local:9090',
    );
    // Both build without throwing (the URL is only dialed at query time).
    expect(prometheusClientFromEnv({})).toBeDefined();
    expect(prometheusClientFromEnv({ PROMETHEUS_URL: 'http://127.0.0.1:19090' })).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// Window → step math
// ---------------------------------------------------------------------------------------------------

describe('TREND_WINDOW_SPECS — every window stays inside the ~200-point budget', () => {
  it('carries ≤ 200 points per window (with real resolution) on clean hour boundaries', () => {
    for (const w of TREND_WINDOWS) {
      const { seconds, stepSeconds } = TREND_WINDOW_SPECS[w];
      const points = Math.floor(seconds / stepSeconds) + 1;
      expect(points, `${w} point count`).toBeLessThanOrEqual(200);
      expect(points, `${w} has enough resolution`).toBeGreaterThanOrEqual(150);
      expect(stepSeconds % 3_600, `${w} step is whole hours`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// mapTrendSeries — paths → arrays + the target line math (pure)
// ---------------------------------------------------------------------------------------------------

/** The live-shaped utilization rows (stub numbers = the e2e /diskspace stub). */
const UTILIZATION: StorageArrayUtilization[] = [
  {
    key: 'haynestower',
    label: 'HaynesTower',
    path: '/data/haynestower',
    freeSpace: 112.4304 * TB,
    totalSpace: 529.96 * TB,
    usedPct: 78.8,
    target: 80,
    unavailable: false,
  },
  {
    key: 'cephfs',
    label: 'Music (CephFS)',
    path: '/data/cephfs-hdd',
    freeSpace: 130.45 * TB,
    totalSpace: 174.84 * TB,
    usedPct: 25.4,
    target: null,
    unavailable: false,
  },
];

function promSeries(name: string, path: string, values: [number, string][]): PromMatrixSeries {
  return { metric: { __name__: name, path }, values };
}

describe('mapTrendSeries — exportarr rootfolder paths group to the getUtilization arrays', () => {
  it('maps rootfolders UNDER the mount (live label shape) + the music rootfolder label; radarr wins the shared array', () => {
    const matrix = [
      promSeries('radarr_rootfolder_freespace_bytes', '/data/haynestower/Media/Movies', [
        [1000, `${112 * TB}`],
        [2000, `${111 * TB}`],
      ]),
      // Sonarr reports the SAME array — deduped away (radarr is the first source).
      promSeries('sonarr_rootfolder_freespace_bytes', '/data/haynestower/Media/TV Shows', [
        [1000, `${999 * TB}`],
      ]),
      // Lidarr's path label is the ROOTFOLDER (/data/media/music), not the mount — still matches.
      promSeries('lidarr_rootfolder_freespace_bytes', '/data/media/music', [[1000, `${130 * TB}`]]),
    ];
    const series = mapTrendSeries(matrix, UTILIZATION);
    expect(series.map((s) => s.key)).toEqual(['haynestower', 'cephfs']);

    const tower = series[0]!;
    expect(tower.points).toEqual([
      { t: 1000, freeBytes: 112 * TB },
      { t: 2000, freeBytes: 111 * TB },
    ]);
    // Target line math: 80% used ceiling of 529.96 TB total ⇒ 20% free floor.
    expect(tower.totalBytes).toBe(529.96 * TB);
    expect(tower.targetPct).toBe(80);
    expect(tower.targetFreeBytes).toBe(Math.round(529.96 * TB * 0.2));

    const music = series[1]!;
    expect(music.points).toEqual([{ t: 1000, freeBytes: 130 * TB }]);
    expect(music.targetPct).toBeNull();
    expect(music.targetFreeBytes).toBeNull(); // no target set ⇒ no dashed line
  });

  it('falls back to sonarr history when radarr has no matching series (one exporter down)', () => {
    const matrix = [
      promSeries('sonarr_rootfolder_freespace_bytes', '/data/haynestower/Media/TV Shows', [
        [1000, `${112 * TB}`],
      ]),
    ];
    const tower = mapTrendSeries(matrix, UTILIZATION)[0]!;
    expect(tower.points).toEqual([{ t: 1000, freeBytes: 112 * TB }]);
  });

  it('max-merges several rootfolders of the winning source and drops non-finite samples', () => {
    const matrix = [
      promSeries('radarr_rootfolder_freespace_bytes', '/data/haynestower/Media/Movies', [
        [1000, `${100 * TB}`],
        [2000, 'NaN'],
      ]),
      promSeries('radarr_rootfolder_freespace_bytes', '/data/haynestower/Media/Movies4K', [
        [1000, `${101 * TB}`],
        [3000, `${99 * TB}`],
      ]),
    ];
    const tower = mapTrendSeries(matrix, UTILIZATION)[0]!;
    expect(tower.points).toEqual([
      { t: 1000, freeBytes: 101 * TB }, // max of the two rootfolder readings
      { t: 3000, freeBytes: 99 * TB }, // the NaN sample at t=2000 dropped
    ]);
  });

  it('an array with no matching series keeps its identity + target with EMPTY points (no history yet)', () => {
    const series = mapTrendSeries([], UTILIZATION);
    expect(series[0]).toMatchObject({ key: 'haynestower', points: [], targetPct: 80 });
    expect(series[0]!.targetFreeBytes).toBe(Math.round(529.96 * TB * 0.2));
  });

  it('a null utilization total (that *arr down) yields a null target line, never NaN', () => {
    const degraded: StorageArrayUtilization[] = UTILIZATION.map((u) =>
      u.key === 'haynestower'
        ? { ...u, freeSpace: null, totalSpace: null, usedPct: null, unavailable: true }
        : u,
    );
    const tower = mapTrendSeries([], degraded)[0]!;
    expect(tower.totalBytes).toBeNull();
    expect(tower.targetFreeBytes).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// getStorageTrend + the router (embedded PG; stub *arr + stub Prometheus readers)
// ---------------------------------------------------------------------------------------------------

let testDb: TestDb;
let admin: typeof users.$inferSelect;
let member: typeof users.$inferSelect;

function stubPrometheus(handler: PrometheusRangeReader['queryRange']): PrometheusRangeReader {
  return { queryRange: handler };
}

function diskspaceStub() {
  return stubArrBundle([
    { path: '/api/v3/diskspace', body: [{ path: '/data/haynestower', freeSpace: 112.4304 * TB, totalSpace: 529.96 * TB }] },
    { path: '/api/v1/diskspace', body: [{ path: '/data/cephfs-hdd', freeSpace: 130.45 * TB, totalSpace: 174.84 * TB }] },
  ]);
}

beforeAll(async () => {
  testDb = await bootMigratedDb();
  admin = await createUser(testDb.db, { admin: true, displayName: 'Admin Ada' });
  member = await createUser(testDb.db, { displayName: 'Member Mia' });
});

afterAll(async () => {
  await testDb.stop();
});

function callerWith(user: typeof users.$inferSelect, prom: PrometheusRangeReader): Caller {
  return caller(
    makeCtx(testDb.db, sessionUser(user), diskspaceStub().bundle, undefined, undefined, prom),
  );
}

describe('storage.trend — the router read', () => {
  it('a member is FORBIDDEN (adminProcedure, like the rest of the Storage tab reads)', async () => {
    const memberCaller = callerWith(member, stubPrometheus(async () => []));
    await expect(memberCaller.storage.trend({ window: '30d' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns the mapped per-array series with a step-aligned window and the target floor', async () => {
    await callerWith(admin, stubPrometheus(async () => [])).storage.targets.set({
      targets: { haynestower: 80 },
    });

    let asked: { query: string; start: number; end: number; step: number } | undefined;
    const prom = stubPrometheus(async (query, start, end, step) => {
      asked = { query, start, end, step };
      return [
        promSeries('radarr_rootfolder_freespace_bytes', '/data/haynestower/Media/Movies', [
          [start, `${120 * TB}`],
          [end, `${112 * TB}`],
        ]),
        promSeries('lidarr_rootfolder_freespace_bytes', '/data/media/music', [[end, `${130 * TB}`]]),
      ];
    });

    const report = await callerWith(admin, prom).storage.trend({ window: '30d' });
    expect(report.unavailable).toBe(false);
    expect(report.window).toBe('30d');
    expect(report.stepSeconds).toBe(TREND_WINDOW_SPECS['30d'].stepSeconds);
    // One combined PromQL round-trip, step-aligned end, full window span.
    expect(asked!.query).toBe(FREESPACE_TREND_QUERY);
    expect(asked!.end % asked!.step).toBe(0);
    expect(asked!.end - asked!.start).toBe(TREND_WINDOW_SPECS['30d'].seconds);
    expect(report).toMatchObject({ start: asked!.start, end: asked!.end });

    const tower = report.series.find((s) => s.key === 'haynestower')!;
    expect(tower.points).toHaveLength(2);
    expect(tower.targetPct).toBe(80);
    expect(tower.targetFreeBytes).toBe(Math.round(529.96 * TB * 0.2));
    const music = report.series.find((s) => s.key === 'cephfs')!;
    expect(music.points).toEqual([{ t: asked!.end, freeBytes: 130 * TB }]);
  });

  it('defaults the window to 30d', async () => {
    const report = await callerWith(admin, stubPrometheus(async () => [])).storage.trend({});
    expect(report.window).toBe('30d');
  });

  it('degrades to `unavailable` when Prometheus is down — the tab keeps rendering (never a throw)', async () => {
    const prom = stubPrometheus(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    const report = await callerWith(admin, prom).storage.trend({ window: '7d' });
    expect(report.unavailable).toBe(true);
    expect(report.series).toEqual([]);
    expect(report.stepSeconds).toBe(TREND_WINDOW_SPECS['7d'].stepSeconds);
  });
});

describe('getStorageTrend — direct (no router)', () => {
  it('survives BOTH Prometheus down and an unreachable *arr at once (empty, degraded, well-formed)', async () => {
    const deadArr = stubArrBundle([]); // every /diskspace 404s ⇒ utilization all unavailable
    const report = await getStorageTrend({
      db: testDb.db,
      arr: deadArr.bundle,
      prometheus: stubPrometheus(async () => {
        throw new Error('down');
      }),
      window: '90d',
    });
    expect(report.unavailable).toBe(true);
    expect(report.series).toEqual([]);
  });
});
