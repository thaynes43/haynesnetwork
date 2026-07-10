import { describe, expect, it, vi } from 'vitest';
import type { PromMatrixSeries, PromVectorSample, PrometheusReader } from '../src/client';
import {
  buildPools,
  drivePill,
  getDriveSmartReadings,
  getHardwareMetrics,
  projectWear,
  poolStatusLine,
  MIN_PROJECTION_SPAN_SEC,
  SMART_STATUS_QUERY,
  SMART_WEAR_QUERY,
  SMART_TEMP_QUERY,
  SMART_MEDIA_ERRORS_QUERY,
  SMART_AVAILABLE_SPARE_QUERY,
  SMART_AVAILABLE_SPARE_THRESHOLD_QUERY,
  SMART_CRITICAL_WARNING_QUERY,
  SMART_POWER_ON_SECONDS_QUERY,
  SMART_CAPACITY_BYTES_QUERY,
  SMART_INFO_QUERY,
  NODE_LOAD1_QUERY,
  NODE_CORES_BY_INSTANCE_QUERY,
  NODE_MEM_TOTAL_BY_INSTANCE_QUERY,
  NODE_MEM_AVAIL_BY_INSTANCE_QUERY,
  NODE_TEMP_MAX_BY_INSTANCE_QUERY,
  PVE_NODE_INFO_QUERY,
  PVE_GUEST_INFO_QUERY,
  PVE_UP_QUERY,
  PVE_CPU_RATIO_QUERY,
  PVE_MEM_USED_QUERY,
  PVE_MEM_SIZE_QUERY,
  PVE_UPTIME_QUERY,
} from '../src/hardware';

function s(value: number, metric: Record<string, string> = {}): PromVectorSample {
  return { metric, value: [1_700_000_000, String(value)] };
}
const nas = (device: string, extra: Record<string, string> = {}) => ({
  instance: 'haynestower',
  device,
  role: 'nas',
  ...extra,
});
const cl = (device: string) => ({ instance: '10.42.0.244:9633', device, namespace: 'observability' });

function stubReader(
  instant: Record<string, PromVectorSample[]>,
  range: Record<string, PromMatrixSeries[]> = {},
): PrometheusReader {
  return {
    query: vi.fn(async (q: string) => instant[q] ?? []),
    queryRange: vi.fn(async (q: string) => range[q] ?? []),
  };
}

// The live 2026-07-10 NAS cache + one cluster NVMe, plus a node and two PVE hosts.
const LIVE: Record<string, PromVectorSample[]> = {
  [SMART_STATUS_QUERY]: [
    s(1, nas('nvme0')),
    s(0, nas('nvme1')),
    s(0, nas('nvme2')),
    s(1, nas('nvme3')),
    s(1, cl('nvme0n1')),
  ],
  [SMART_WEAR_QUERY]: [
    s(57, nas('nvme0')),
    s(100, nas('nvme1')),
    s(100, nas('nvme2')),
    s(60, nas('nvme3')),
    s(25, cl('nvme0n1')),
  ],
  [SMART_TEMP_QUERY]: [s(55, nas('nvme0')), s(58, nas('nvme1')), s(40, cl('nvme0n1'))],
  [SMART_MEDIA_ERRORS_QUERY]: [
    s(0, nas('nvme0')),
    s(0, nas('nvme1')),
    s(0, nas('nvme2')),
    s(0, nas('nvme3')),
    s(0, cl('nvme0n1')),
  ],
  [SMART_AVAILABLE_SPARE_QUERY]: [
    s(100, nas('nvme0')),
    s(100, nas('nvme1')),
    s(100, nas('nvme2')),
    s(100, nas('nvme3')),
    s(100, cl('nvme0n1')),
  ],
  [SMART_AVAILABLE_SPARE_THRESHOLD_QUERY]: [
    s(5, nas('nvme0')),
    s(5, nas('nvme1')),
    s(5, nas('nvme2')),
    s(5, nas('nvme3')),
    s(5, cl('nvme0n1')),
  ],
  [SMART_CRITICAL_WARNING_QUERY]: [
    s(0, nas('nvme0')),
    s(4, nas('nvme1')),
    s(4, nas('nvme2')),
    s(0, nas('nvme3')),
  ],
  [SMART_POWER_ON_SECONDS_QUERY]: [s(3_600_000, nas('nvme0'))],
  [SMART_CAPACITY_BYTES_QUERY]: [s(2_000_000_000_000, nas('nvme0'))],
  [SMART_INFO_QUERY]: [
    s(1, nas('nvme0', { model_name: 'CT2000P3PSSD8', serial_number: '2331E865B710' })),
    s(1, nas('nvme1', { model_name: 'CT2000P3PSSD8', serial_number: '2331E865B76D' })),
  ],
  [NODE_LOAD1_QUERY]: [s(3.2, { instance: 'haynestower' }), s(1.5, { instance: '192.168.40.10:9100' })],
  [NODE_CORES_BY_INSTANCE_QUERY]: [
    s(24, { instance: 'haynestower' }),
    s(8, { instance: '192.168.40.10:9100' }),
  ],
  [NODE_MEM_TOTAL_BY_INSTANCE_QUERY]: [
    s(128_000_000_000, { instance: 'haynestower' }),
    s(32_000_000_000, { instance: '192.168.40.10:9100' }),
  ],
  [NODE_MEM_AVAIL_BY_INSTANCE_QUERY]: [
    s(64_000_000_000, { instance: 'haynestower' }),
    s(16_000_000_000, { instance: '192.168.40.10:9100' }),
  ],
  [NODE_TEMP_MAX_BY_INSTANCE_QUERY]: [s(48, { instance: 'haynestower' })],
  [PVE_NODE_INFO_QUERY]: [
    s(1, { id: 'node/HaynesIntelligence', name: 'HaynesIntelligence' }),
    s(1, { id: 'node/twin-top', name: 'twin-top' }),
  ],
  [PVE_GUEST_INFO_QUERY]: [
    s(1, { id: 'qemu/100', node: 'HaynesIntelligence', name: 'plex-vm', type: 'qemu', vmid: '100' }),
    s(1, { id: 'lxc/101', node: 'HaynesIntelligence', name: 'a-container', type: 'lxc', vmid: '101' }),
  ],
  [PVE_UP_QUERY]: [
    s(1, { id: 'node/HaynesIntelligence' }),
    s(1, { id: 'node/twin-top' }),
    s(1, { id: 'qemu/100' }),
    s(0, { id: 'lxc/101' }),
  ],
  [PVE_CPU_RATIO_QUERY]: [s(0.35, { id: 'node/HaynesIntelligence' }), s(0.1, { id: 'qemu/100' })],
  [PVE_MEM_USED_QUERY]: [s(64_000_000_000, { id: 'node/HaynesIntelligence' }), s(8_000_000_000, { id: 'qemu/100' })],
  [PVE_MEM_SIZE_QUERY]: [s(256_000_000_000, { id: 'node/HaynesIntelligence' }), s(16_000_000_000, { id: 'qemu/100' })],
  [PVE_UPTIME_QUERY]: [s(1_080_000, { id: 'node/HaynesIntelligence' })],
};

describe('getHardwareMetrics', () => {
  it('folds the live NAS pools, drives, nodes, and PVE hosts', async () => {
    const data = await getHardwareMetrics({ prometheus: stubReader(LIVE) });

    // Two NVMe pools, CRITICAL (Cache-apps) first.
    expect(data.pools.map((p) => p.name)).toEqual(['Cache-apps', 'Cache-staging']);
    const staging = data.pools.find((p) => p.name === 'Cache-staging')!;
    expect(staging.framing).toBe('expendable');
    expect(staging.worstWearPct).toBe(100);
    expect(staging.totalMediaErrors).toBe(0);
    expect(staging.criticalWarningActive).toBe(true);
    expect(staging.statusLine).toContain('holding'); // over rated endurance, spare 100 %, 0 media errors
    const apps = data.pools.find((p) => p.name === 'Cache-apps')!;
    expect(apps.framing).toBe('critical');
    expect(apps.statusLine.toLowerCase()).toContain('worn');

    // Every reporting SMART device is in the drive list; nvme1 (SMART FAILED) reads 'fail'.
    expect(data.drives).toHaveLength(5);
    const nvme1 = data.drives.find((d) => d.driveKey === 'haynestower/nvme1')!;
    expect(nvme1.smartStatus).toBe('fail');
    expect(nvme1.health).toBe('fail');
    expect(nvme1.pool).toBe('Cache-staging');
    const nvme0 = data.drives.find((d) => d.driveKey === 'haynestower/nvme0')!;
    expect(nvme0.model).toBe('CT2000P3PSSD8');

    // Nodes: the NAS is flagged role=nas; cores/mem/load folded per instance.
    const nasNode = data.nodes.find((n) => n.name === 'haynestower')!;
    expect(nasNode.role).toBe('nas');
    expect(nasNode.cores).toBe(24);
    expect(nasNode.memPct).toBe(50);

    // PVE hosts + nested VMs.
    expect(data.pveHosts.map((h) => h.name)).toEqual(['HaynesIntelligence', 'twin-top']);
    const hi = data.pveHosts.find((h) => h.name === 'HaynesIntelligence')!;
    expect(hi.cpuPct).toBe(35);
    expect(hi.vms).toHaveLength(2);
    expect(hi.vms.find((v) => v.id === 'lxc/101')!.up).toBe(false);

    expect(data.unavailable).toBe(false);
  });

  it('degrades to empty + unavailable when Prometheus is unreachable', async () => {
    const reader: PrometheusReader = {
      query: vi.fn(async () => {
        throw new Error('prometheus down');
      }),
      queryRange: vi.fn(async () => {
        throw new Error('prometheus down');
      }),
    };
    const data = await getHardwareMetrics({ prometheus: reader });
    expect(data.pools).toEqual([]);
    expect(data.drives).toEqual([]);
    expect(data.nodes).toEqual([]);
    expect(data.pveHosts).toEqual([]);
    expect(data.unavailable).toBe(true);
  });
});

describe('getDriveSmartReadings', () => {
  it('flags the critical pool and defaults missing series NO-ALERT-safe', async () => {
    const readings = await getDriveSmartReadings({ prometheus: stubReader(LIVE) });
    const byKey = new Map(readings.map((r) => [r.driveKey, r]));
    expect(byKey.get('haynestower/nvme0')!.criticalPool).toBe(true); // Cache-apps mirror
    expect(byKey.get('haynestower/nvme1')!.criticalPool).toBe(false); // Cache-staging expendable
    expect(byKey.get('10.42.0.244:9633/nvme0n1')!.criticalPool).toBe(false); // non-pool cluster NVMe
    // nvme3 had no media_errors/spare series in the info-only vectors — defaults applied.
    expect(byKey.get('haynestower/nvme3')!.mediaErrors).toBe(0);
    expect(byKey.get('haynestower/nvme3')!.availableSpare).toBe(100);
  });
});

describe('projectWear', () => {
  const day = 86_400;
  it('returns insufficientHistory for too-few / too-short / flat series', () => {
    expect(projectWear([], 90).insufficientHistory).toBe(true);
    expect(projectWear([[0, 57]], 90).insufficientHistory).toBe(true);
    // 1-hour span (< MIN_PROJECTION_SPAN_SEC) with rising wear → still insufficient.
    expect(projectWear([[0, 57], [3600, 58]], 90).insufficientHistory).toBe(true);
    // long but flat → insufficient (no measurable increase).
    expect(projectWear([[0, 57], [10 * day, 57]], 90).insufficientHistory).toBe(true);
  });

  it('projects a rising series once enough history has accrued', () => {
    // 50 % → 55 % over 5 days ⇒ 1 %/day = 7 %/week; from 55 %, 35 % remains → ~35 days.
    const pts: Array<[number, number]> = [
      [0, 50],
      [5 * day, 55],
    ];
    expect(5 * day).toBeGreaterThan(MIN_PROJECTION_SPAN_SEC);
    const r = projectWear(pts, 90);
    expect(r.insufficientHistory).toBe(false);
    expect(r.weeklyRatePct).toBeCloseTo(7, 0);
    expect(r.projectedDaysTo90).toBe(35);
  });
});

describe('drivePill + poolStatusLine', () => {
  it('drivePill flags SMART-failed / high-wear / hot drives', () => {
    expect(drivePill({ smartStatus: 'fail', wearPct: 100, tempC: 40, mediaErrors: 0, availableSpare: 100, availableSpareThreshold: 5, criticalWarning: 4 })).toBe('fail');
    expect(drivePill({ smartStatus: 'pass', wearPct: 95, tempC: 40, mediaErrors: 0, availableSpare: 100, availableSpareThreshold: 5, criticalWarning: 0 })).toBe('warn');
    expect(drivePill({ smartStatus: 'pass', wearPct: 25, tempC: 40, mediaErrors: 0, availableSpare: 100, availableSpareThreshold: 5, criticalWarning: 0 })).toBe('healthy');
  });

  it('buildPools yields the acceptance status lines', () => {
    const drives = [
      { driveKey: 'haynestower/nvme0', device: 'nvme0', instance: 'haynestower', role: 'nas' as const, kind: 'nvme' as const, label: 'nvme0', model: null, pool: 'Cache-apps', smartStatus: 'pass' as const, wearPct: 57, tempC: 55, powerOnHours: 1000, mediaErrors: 0, availableSpare: 100, availableSpareThreshold: 5, criticalWarning: 0, capacityBytes: null, health: 'healthy' as const },
      { driveKey: 'haynestower/nvme1', device: 'nvme1', instance: 'haynestower', role: 'nas' as const, kind: 'nvme' as const, label: 'nvme1', model: null, pool: 'Cache-staging', smartStatus: 'fail' as const, wearPct: 100, tempC: 58, powerOnHours: 1000, mediaErrors: 0, availableSpare: 100, availableSpareThreshold: 5, criticalWarning: 4, capacityBytes: null, health: 'fail' as const },
    ];
    const pools = buildPools(drives, new Map());
    const staging = pools.find((p) => p.name === 'Cache-staging')!;
    expect(staging.statusLine).toBe('over rated endurance, spare 100%, 0 media errors — holding');
  });

  it('poolStatusLine frames the critical pool with an insufficient-history note', () => {
    const line = poolStatusLine({
      framing: 'critical',
      worstWearPct: 60,
      bestWearPct: 57,
      minAvailableSpare: 100,
      totalMediaErrors: 0,
      projection: { insufficientHistory: true },
    });
    expect(line).toContain('57–60% worn');
    expect(line).toContain('insufficient history');
  });
});
