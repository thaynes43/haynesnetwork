import { describe, expect, it, vi } from 'vitest';
import type { PromVectorSample, PrometheusReader } from '../src/client';
import {
  getHardwareOverview,
  getNetworkOverview,
  mergeWanLinks,
  meterPct,
  WAN_LINK_UP_KBPS_QUERY,
  WAN_UPLOAD_BYTES_QUERY,
  WAN_DOWNLOAD_BYTES_QUERY,
  NODE_LOAD1_SUM_QUERY,
  NODE_COUNT_QUERY,
  NODE_CORES_QUERY,
  NODE_MEM_TOTAL_QUERY,
  NODE_MEM_AVAIL_QUERY,
} from '../src/overview';

function sample(value: number, metric: Record<string, string> = {}): PromVectorSample {
  return { metric, value: [1_700_000_000, String(value)] };
}

/** A stub reader that answers instant queries from a map (missing ⇒ throw, to exercise the degrade). */
function stubReader(answers: Record<string, PromVectorSample[]>): {
  reader: PrometheusReader;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (promQL: string) => {
    if (promQL in answers) return answers[promQL]!;
    throw new Error(`no stub for ${promQL}`);
  });
  return {
    reader: { query, queryRange: async () => [] },
    query,
  };
}

describe('meterPct', () => {
  it('computes usage/capacity·100 (one decimal), clamps, and guards capacity ≤ 0 / null usage', () => {
    expect(meterPct(150, 300)).toBe(50);
    expect(meterPct(11.6, 300)).toBe(3.9);
    expect(meterPct(null, 300)).toBeNull();
    expect(meterPct(50, 0)).toBeNull();
    expect(meterPct(-5, 300)).toBe(0);
  });
});

describe('getNetworkOverview', () => {
  const CAPS = { uploadCapacityMbps: 300, downloadCapacityMbps: 2256 };

  it('maps byte-rates to Mbps + pct and includes wanLinks ONLY when full', async () => {
    const { reader, query } = stubReader({
      [WAN_UPLOAD_BYTES_QUERY]: [sample(1_454_880)], // ~11.6 Mbps
      [WAN_DOWNLOAD_BYTES_QUERY]: [sample(844_568)], // ~6.8 Mbps
      [WAN_LINK_UP_KBPS_QUERY]: [sample(316_000, { wan_name: 'Internet 1', wan_id: 'a' })],
      unpoller_wan_provider_download_kbps: [
        sample(2_256_000, { wan_name: 'Internet 1', wan_id: 'a' }),
      ],
    });

    const full = await getNetworkOverview({ prometheus: reader, ...CAPS, includeWanLinks: true });
    expect(full.upload.usageMbps).toBe(11.6);
    expect(full.upload.pct).toBe(3.9);
    expect(full.download.usageMbps).toBe(6.8);
    expect(full.unavailable).toBe(false);
    expect(full.wanLinks).toHaveLength(1);
    expect(full.wanLinks?.[0]).toMatchObject({ label: 'Internet 1', capacityUpMbps: 316, capacityDownMbps: 2256 });

    query.mockClear();
    const limited = await getNetworkOverview({
      prometheus: reader,
      ...CAPS,
      includeWanLinks: false,
    });
    // The full-only key is absent AND the full-only queries were never issued (ADR-037 C-03).
    expect(limited.wanLinks).toBeUndefined();
    expect('wanLinks' in limited).toBe(false);
    const issued = query.mock.calls.map((c) => c[0]);
    expect(issued).not.toContain(WAN_LINK_UP_KBPS_QUERY);
    expect(issued).toContain(WAN_UPLOAD_BYTES_QUERY);
  });

  it('degrades to unavailable when both usage queries fail, never throwing', async () => {
    const { reader } = stubReader({}); // every query throws
    const out = await getNetworkOverview({ prometheus: reader, ...CAPS, includeWanLinks: true });
    expect(out.unavailable).toBe(true);
    expect(out.upload.usageMbps).toBeNull();
    expect(out.upload.pct).toBeNull();
    expect(out.wanLinks).toEqual([]);
  });
});

describe('getHardwareOverview', () => {
  it('computes node + memory tiles from the cluster queries', async () => {
    const { reader } = stubReader({
      [NODE_LOAD1_SUM_QUERY]: [sample(18.5)],
      [NODE_COUNT_QUERY]: [sample(6)],
      [NODE_CORES_QUERY]: [sample(132)],
      [NODE_MEM_TOTAL_QUERY]: [sample(529_642_733_568)],
      [NODE_MEM_AVAIL_QUERY]: [sample(384_401_444_864)],
    });
    const out = await getHardwareOverview({ prometheus: reader });
    expect(out.nodes).toMatchObject({ count: 6, coresTotal: 132, load1Total: 18.5 });
    expect(out.nodes?.loadPerCorePct).toBe(14); // 18.5/132*100 = 14.0
    expect(out.memory?.totalBytes).toBe(529_642_733_568);
    expect(out.memory?.usedBytes).toBe(145_241_288_704);
    expect(out.memory?.pct).toBe(27.4);
    expect(out.unavailable).toBe(false);
  });

  it('degrades each tile independently and marks unavailable when all fail', async () => {
    const memOnly = stubReader({
      [NODE_MEM_TOTAL_QUERY]: [sample(100)],
      [NODE_MEM_AVAIL_QUERY]: [sample(40)],
    });
    const partial = await getHardwareOverview({ prometheus: memOnly.reader });
    expect(partial.nodes).toBeNull();
    expect(partial.memory).toMatchObject({ usedBytes: 60, totalBytes: 100, pct: 60 });
    expect(partial.unavailable).toBe(false);

    const none = stubReader({});
    const empty = await getHardwareOverview({ prometheus: none.reader });
    expect(empty.unavailable).toBe(true);
  });
});

describe('mergeWanLinks', () => {
  it('folds up/down capacity vectors into deduped links sorted by label', () => {
    const links = mergeWanLinks(
      [
        sample(316_000, { wan_name: 'Internet 1', wan_id: 'a' }),
        sample(350_000, { wan_name: 'Internet 2', wan_id: 'b' }),
      ],
      [
        sample(2_256_000, { wan_name: 'Internet 1', wan_id: 'a' }),
        sample(2_300_000, { wan_name: 'Internet 2', wan_id: 'b' }),
      ],
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ label: 'Internet 1', capacityUpMbps: 316, capacityDownMbps: 2256 });
    expect(links[1]).toMatchObject({ label: 'Internet 2', capacityUpMbps: 350, capacityDownMbps: 2300 });
  });
});
