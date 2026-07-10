import { describe, expect, it, vi } from 'vitest';
import type { PromMatrixSeries, PromVectorSample, PrometheusReader } from '../src/client';
import {
  getNetworkMetrics,
  mergeDevicePerf,
  matrixToMbps,
  ratioToPct,
  deviceCategory,
  NETWORK_ALLOWLIST_QUERIES,
  DEVICE_CPU_RATIO_QUERY,
  DEVICE_MEM_RATIO_QUERY,
  DEVICE_LOAD1_QUERY,
} from '../src/network';

function sample(value: number, metric: Record<string, string> = {}): PromVectorSample {
  return { metric, value: [1_700_000_000, String(value)] };
}
function matrix(name: string, pts: [number, number][]): PromMatrixSeries {
  return { metric: { __name__: name }, values: pts.map(([t, v]) => [t, String(v)]) };
}

/** A stub reader answering the Network series from a map (instant) + WAN throughput history (range). */
function stubReader(
  instant: Record<string, PromVectorSample[]>,
  rangeAnswers: Record<string, PromMatrixSeries[]> = {},
): { reader: PrometheusReader; queries: string[]; rangeQueries: string[] } {
  const queries: string[] = [];
  const rangeQueries: string[] = [];
  return {
    queries,
    rangeQueries,
    reader: {
      query: vi.fn(async (promQL: string) => {
        queries.push(promQL);
        if (promQL in instant) return instant[promQL]!;
        throw new Error(`no stub for ${promQL}`);
      }),
      queryRange: vi.fn(async (promQL: string) => {
        rangeQueries.push(promQL);
        return rangeAnswers[promQL] ?? [];
      }),
    },
  };
}

/** The full happy-path instant answers (mirror the live 2026-07-10 magnitudes). */
const LIVE_INSTANT: Record<string, PromVectorSample[]> = {
  // WAN meters (reused from overview.ts)
  'sum(unpoller_site_transmit_rate_bytes{subsystem="wan"})': [sample(1_454_880, { subsystem: 'wan' })],
  'sum(unpoller_site_receive_rate_bytes{subsystem="wan"})': [sample(844_568, { subsystem: 'wan' })],
  unpoller_wan_provider_upload_kbps: [
    sample(316_000, { wan_name: 'Internet 1', wan_id: 'a' }),
    sample(350_000, { wan_name: 'Internet 2', wan_id: 'b' }),
  ],
  unpoller_wan_provider_download_kbps: [
    sample(2_256_000, { wan_name: 'Internet 1', wan_id: 'a' }),
    sample(2_300_000, { wan_name: 'Internet 2', wan_id: 'b' }),
  ],
  // Infra device perf — gateway (udm), a switch (usw), an AP (uap), and a NON-network pdu (dropped).
  [DEVICE_CPU_RATIO_QUERY]: [
    sample(0.454, { name: 'Westford DMSE', type: 'udm' }),
    sample(0.213, { name: 'Switch Pro Max 48 PoE', type: 'usw' }),
    sample(0.032, { name: 'Garage U7-Pro-Wall', type: 'uap' }),
    sample(0.025, { name: 'Power Distribution Hi-Density', type: 'pdu' }),
  ],
  [DEVICE_MEM_RATIO_QUERY]: [
    sample(0.818, { name: 'Westford DMSE', type: 'udm' }),
    sample(0.4, { name: 'Switch Pro Max 48 PoE', type: 'usw' }),
  ],
  [DEVICE_LOAD1_QUERY]: [sample(1.2, { name: 'Westford DMSE', type: 'udm' })],
  // WAN health + site rollups
  'max(unpoller_device_speedtest_download)': [sample(1526)],
  'max(unpoller_device_speedtest_upload)': [sample(312)],
  'max(unpoller_device_speedtest_latency_seconds)': [sample(0.012)],
  'max(unpoller_site_latency_seconds{subsystem="www"})': [sample(0.008)],
  'max(unpoller_device_uplink_latency_seconds)': [sample(0)],
  'sum(unpoller_site_aps)': [sample(7)],
  'sum(unpoller_site_switches)': [sample(15)],
  'sum(unpoller_site_gateways)': [sample(1)],
  'sum(unpoller_site_stations)': [sample(181)],
};

const LIVE_RANGE: Record<string, PromMatrixSeries[]> = {
  'sum(unpoller_site_transmit_rate_bytes{subsystem="wan"})': [
    matrix('up', [
      [1_700_000_000, 1_250_000],
      [1_700_003_600, 2_500_000],
    ]),
  ],
  'sum(unpoller_site_receive_rate_bytes{subsystem="wan"})': [
    matrix('down', [
      [1_700_000_000, 12_500_000],
      [1_700_003_600, 25_000_000],
    ]),
  ],
};

describe('network privacy invariant — the allow-listed PromQL module (ADR-039 C-01)', () => {
  // The reviewer-provable invariant: the ONLY metric identifiers this module names are infrastructure
  // series; it can never name a client / remote-user / *_info series at ANY level.
  const ALLOWED_METRICS = new Set([
    'unpoller_site_transmit_rate_bytes',
    'unpoller_site_receive_rate_bytes',
    'unpoller_wan_provider_upload_kbps',
    'unpoller_wan_provider_download_kbps',
    'unpoller_device_cpu_utilization_ratio',
    'unpoller_device_memory_utilization_ratio',
    'unpoller_device_load_average_1',
    'unpoller_device_speedtest_download',
    'unpoller_device_speedtest_upload',
    'unpoller_device_speedtest_latency_seconds',
    'unpoller_device_uplink_latency_seconds',
    'unpoller_site_latency_seconds',
    'unpoller_site_aps',
    'unpoller_site_switches',
    'unpoller_site_gateways',
    'unpoller_site_stations',
  ]);
  // Any of these substrings in a query would leak client/device identity — forbidden by construction.
  const DENY = ['unpoller_client_', '_remote_user_', '_info', 'mac', 'hostname', 'rssi', 'signal'];

  it('every enumerated query names ONLY allow-listed infrastructure series', () => {
    expect(NETWORK_ALLOWLIST_QUERIES.length).toBeGreaterThan(0);
    for (const q of NETWORK_ALLOWLIST_QUERIES) {
      const referenced = q.match(/unpoller_[a-z0-9_]+/g) ?? [];
      expect(referenced.length, `"${q}" references a metric`).toBeGreaterThan(0);
      for (const metric of referenced) {
        expect(ALLOWED_METRICS.has(metric), `"${metric}" (in "${q}") is allow-listed`).toBe(true);
      }
    }
  });

  it('no enumerated query contains a client / remote-user / identity-bearing substring', () => {
    for (const q of NETWORK_ALLOWLIST_QUERIES) {
      for (const bad of DENY) {
        expect(q.includes(bad), `"${q}" must not contain "${bad}"`).toBe(false);
      }
    }
  });

  it('a full end-to-end payload contains NO field that could name a client/device beyond infra labels', async () => {
    const { reader } = stubReader(LIVE_INSTANT, LIVE_RANGE);
    const full = await getNetworkMetrics({
      prometheus: reader,
      uploadCapacityMbps: 300,
      downloadCapacityMbps: 2256,
      includeInfra: true,
      includeGrafanaLinks: false,
      nowSec: 1_700_007_200,
    });
    // Only INFRASTRUCTURE device names appear (UniFi gear); every one maps to an infra category.
    for (const d of full.infra!.devices) {
      expect(['gateway', 'switch', 'ap']).toContain(d.category);
    }
    // The serialized payload never carries a client/mac/hostname key anywhere.
    const json = JSON.stringify(full);
    for (const bad of ['client', 'mac', 'hostname', 'rssi', 'remote_user']) {
      expect(json.toLowerCase().includes(bad)).toBe(false);
    }
  });
});

describe('getNetworkMetrics — the disjoint limited/full shape (ADR-039 C-03)', () => {
  it('limited gets ONLY wan meters + history; full ADDS infra + per-uplink wanLinks', async () => {
    const limitedStub = stubReader(LIVE_INSTANT, LIVE_RANGE);
    const limited = await getNetworkMetrics({
      prometheus: limitedStub.reader,
      uploadCapacityMbps: 300,
      downloadCapacityMbps: 2256,
      includeInfra: false,
      includeGrafanaLinks: false,
      nowSec: 1_700_007_200,
    });
    expect(limited.level).toBe('limited');
    expect(limited.wan.upload.usageMbps).toBe(11.6); // 1_454_880 B/s → 11.6 Mbps
    expect(limited.history.upload.length).toBeGreaterThan(0);
    // The full-only keys are ABSENT and were NEVER fetched (server-authoritative, not client-hidden).
    expect('infra' in limited).toBe(false);
    expect(limited.infra).toBeUndefined();
    expect(limited.wan.wanLinks).toBeUndefined();
    expect(limitedStub.queries.some((q) => q.includes('cpu_utilization_ratio'))).toBe(false);
    expect(limitedStub.queries.some((q) => q.includes('provider_upload_kbps'))).toBe(false);
    expect(limitedStub.queries.some((q) => q.includes('unpoller_site_aps'))).toBe(false);

    const fullStub = stubReader(LIVE_INSTANT, LIVE_RANGE);
    const full = await getNetworkMetrics({
      prometheus: fullStub.reader,
      uploadCapacityMbps: 300,
      downloadCapacityMbps: 2256,
      includeInfra: true,
      includeGrafanaLinks: false,
      nowSec: 1_700_007_200,
    });
    expect(full.level).toBe('full');
    expect('infra' in full).toBe(true);
    expect(full.wan.wanLinks).toHaveLength(2);
    // Device perf: the pdu is dropped; gateway sorts first.
    expect(full.infra!.devices.map((d) => d.name)).toEqual([
      'Westford DMSE',
      'Switch Pro Max 48 PoE',
      'Garage U7-Pro-Wall',
    ]);
    const gw = full.infra!.devices[0]!;
    expect(gw).toMatchObject({ category: 'gateway', type: 'udm', cpuPct: 45.4, memPct: 81.8, load1: 1.2 });
    expect(full.infra!.wanHealth).toMatchObject({
      speedtestDownMbps: 1526,
      speedtestUpMbps: 312,
      speedtestLatencyMs: 12,
      siteLatencyMs: 8,
      uplinkLatencyMs: 0,
    });
    expect(full.infra!.site).toMatchObject({ aps: 7, switches: 15, gateways: 1, stations: 181 });
    // Both levels share the identical WAN meter numbers (same reused helper).
    expect(full.wan.upload.usageMbps).toBe(limited.wan.upload.usageMbps);
  });

  it('degrades infra + history to empty/null when every query fails, never throwing', async () => {
    const { reader } = stubReader({}, {}); // instant throws, range → []
    const out = await getNetworkMetrics({
      prometheus: reader,
      uploadCapacityMbps: 300,
      downloadCapacityMbps: 2256,
      includeInfra: true,
      includeGrafanaLinks: false,
      nowSec: 1_700_007_200,
    });
    expect(out.wan.unavailable).toBe(true);
    expect(out.history.unavailable).toBe(true);
    expect(out.infra!.devices).toEqual([]);
    expect(out.infra!.wanHealth.unavailable).toBe(true);
    expect(out.infra!.site.unavailable).toBe(true);
  });

  // DESIGN-016 D-07 — the LAN-only Grafana board links are attached ONLY when includeGrafanaLinks (admin),
  // and are OMITTED otherwise, independent of the infra (level) seam.
  it('attaches the admin-only Grafana links when includeGrafanaLinks, omits them otherwise', async () => {
    const { reader } = stubReader(LIVE_INSTANT, LIVE_RANGE);
    const admin = await getNetworkMetrics({
      prometheus: reader,
      uploadCapacityMbps: 300,
      downloadCapacityMbps: 2256,
      includeInfra: true,
      includeGrafanaLinks: true,
      nowSec: 1_700_007_200,
    });
    expect(admin.grafana).toEqual({
      sites: 'https://grafana.haynesops.com/d/9WaGWZaZk',
      uap: 'https://grafana.haynesops.com/d/g5wFWqxZk',
      usw: 'https://grafana.haynesops.com/d/FsfxpWaZz',
    });

    // A full (includeInfra) NON-admin caller still gets NO Grafana key.
    const fullMember = await getNetworkMetrics({
      prometheus: reader,
      uploadCapacityMbps: 300,
      downloadCapacityMbps: 2256,
      includeInfra: true,
      includeGrafanaLinks: false,
      nowSec: 1_700_007_200,
    });
    expect('grafana' in fullMember).toBe(false);
    expect(fullMember.grafana).toBeUndefined();
  });
});

describe('pure helpers', () => {
  it('ratioToPct converts a 0..1 ratio to a clamped one-decimal percent', () => {
    expect(ratioToPct(0.454)).toBe(45.4);
    expect(ratioToPct(0)).toBe(0);
    expect(ratioToPct(-0.1)).toBe(0);
    expect(ratioToPct(null)).toBeNull();
    expect(ratioToPct(Number.NaN)).toBeNull();
  });

  it('deviceCategory maps only network gear (udm/usw/uap), dropping pdu/uci', () => {
    expect(deviceCategory('udm')).toBe('gateway');
    expect(deviceCategory('usw')).toBe('switch');
    expect(deviceCategory('uap')).toBe('ap');
    expect(deviceCategory('pdu')).toBeNull();
    expect(deviceCategory('uci')).toBeNull();
    expect(deviceCategory(undefined)).toBeNull();
  });

  it('matrixToMbps folds the first series bytes/sec into Mbps points', () => {
    const pts = matrixToMbps([matrix('up', [[100, 1_250_000], [200, 2_500_000]])]);
    expect(pts).toEqual([
      { t: 100, mbps: 10 },
      { t: 200, mbps: 20 },
    ]);
    expect(matrixToMbps([])).toEqual([]);
  });

  it('mergeDevicePerf drops non-network gear and sorts gateway→switch→ap then by cpu desc', () => {
    const rows = mergeDevicePerf(
      [
        sample(0.2, { name: 'AP-A', type: 'uap' }),
        sample(0.5, { name: 'AP-B', type: 'uap' }),
        sample(0.9, { name: 'GW', type: 'udm' }),
        sample(0.1, { name: 'PDU', type: 'pdu' }),
      ],
      [],
      [],
    );
    expect(rows.map((r) => r.name)).toEqual(['GW', 'AP-B', 'AP-A']);
    expect(rows.every((r) => r.category !== undefined)).toBe(true);
  });
});
