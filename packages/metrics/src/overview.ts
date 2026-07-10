// ADR-037 / DESIGN-016 D-02 — the Prometheus-derived Overview reads: WAN network (usage-vs-capacity +
// full-only per-uplink breakdown) and cluster hardware (node load + memory). Every read fires its instant
// queries in parallel and degrades EACH field independently: a failed/empty query yields null (or
// `unavailable: true`) — never a throw. The exact metric names were verified live 2026-07-10 against the
// haynes-ops Prometheus (unpoller + node-exporter); see ADR-037.
import type { PromVectorSample, PrometheusReader } from './client';

// ── PromQL (verified live) ──────────────────────────────────────────────────────────────────────
/** Current WAN upstream (upload) byte-rate, gateway aggregate — no client device, no user. */
export const WAN_UPLOAD_BYTES_QUERY = 'sum(unpoller_site_transmit_rate_bytes{subsystem="wan"})';
/** Current WAN downstream (download) byte-rate, gateway aggregate. */
export const WAN_DOWNLOAD_BYTES_QUERY = 'sum(unpoller_site_receive_rate_bytes{subsystem="wan"})';
/** Per-uplink advertised capacity (kbps), keyed by `wan_name` — the finer grain, full only. */
export const WAN_LINK_UP_KBPS_QUERY = 'unpoller_wan_provider_upload_kbps';
export const WAN_LINK_DOWN_KBPS_QUERY = 'unpoller_wan_provider_download_kbps';

export const NODE_LOAD1_SUM_QUERY = 'sum(node_load1)';
export const NODE_COUNT_QUERY = 'count(node_load1)';
export const NODE_CORES_QUERY =
  'count(count by (instance, cpu) (node_cpu_seconds_total{mode="idle"}))';
export const NODE_MEM_TOTAL_QUERY = 'sum(node_memory_MemTotal_bytes)';
export const NODE_MEM_AVAIL_QUERY = 'sum(node_memory_MemAvailable_bytes)';

const BYTES_PER_SEC_TO_MBPS = 8 / 1_000_000;

// ── shapes ──────────────────────────────────────────────────────────────────────────────────────
export interface MetricsMeter {
  /** Current usage in Mbps, or null when the source is unreachable. */
  usageMbps: number | null;
  /** The admin-editable capacity denominator (Mbps). */
  capacityMbps: number;
  /** usage/capacity·100, one decimal, clamped ≥ 0; null when usage is unknown or capacity ≤ 0. */
  pct: number | null;
}

export interface WanLink {
  id: string;
  label: string;
  capacityUpMbps: number | null;
  capacityDownMbps: number | null;
  /** Reserved for a later per-uplink live rate (PLAN-020); null in the foundation. */
  usageUpMbps: number | null;
  usageDownMbps: number | null;
}

export interface NetworkOverview {
  upload: MetricsMeter;
  download: MetricsMeter;
  /** FULL ONLY — present only when `includeWanLinks`; a `limited` caller never receives this key. */
  wanLinks?: WanLink[];
  /** True when BOTH usage meters are unreadable (the gateway is unreachable). */
  unavailable: boolean;
}

export interface HardwareOverview {
  nodes: {
    count: number;
    coresTotal: number;
    load1Total: number;
    /** sum(load1)/cores·100, one decimal. */
    loadPerCorePct: number;
  } | null;
  memory: { usedBytes: number; totalBytes: number; pct: number } | null;
  /** True when neither the node nor the memory tile could be read. */
  unavailable: boolean;
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
/** The numeric value of the first instant sample, or null (empty/non-finite). */
export function firstScalar(samples: PromVectorSample[]): number | null {
  const raw = samples[0]?.value?.[1];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Run an instant query, returning its first scalar — or null on ANY failure (the degrade path). */
async function readScalar(reader: PrometheusReader, promQL: string): Promise<number | null> {
  try {
    return firstScalar(await reader.query(promQL));
  } catch {
    return null;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** usage/capacity·100, one decimal, clamped ≥ 0; null when usage unknown or capacity ≤ 0. */
export function meterPct(usageMbps: number | null, capacityMbps: number): number | null {
  if (usageMbps === null || capacityMbps <= 0) return null;
  return round1(Math.max(0, (usageMbps / capacityMbps) * 100));
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────
export interface GetNetworkOverviewInput {
  prometheus: PrometheusReader;
  uploadCapacityMbps: number;
  downloadCapacityMbps: number;
  /** level === 'full' — gates whether the per-uplink breakdown is fetched + serialized (ADR-037 C-03). */
  includeWanLinks: boolean;
}

export async function getNetworkOverview(input: GetNetworkOverviewInput): Promise<NetworkOverview> {
  const [upBytes, downBytes, upKbps, downKbps] = await Promise.all([
    readScalar(input.prometheus, WAN_UPLOAD_BYTES_QUERY),
    readScalar(input.prometheus, WAN_DOWNLOAD_BYTES_QUERY),
    // Full-only queries are ONLY issued when includeWanLinks — a limited caller never fetches them.
    input.includeWanLinks
      ? input.prometheus.query(WAN_LINK_UP_KBPS_QUERY).catch(() => null)
      : Promise.resolve(null),
    input.includeWanLinks
      ? input.prometheus.query(WAN_LINK_DOWN_KBPS_QUERY).catch(() => null)
      : Promise.resolve(null),
  ]);

  const upMbps = upBytes === null ? null : round1(upBytes * BYTES_PER_SEC_TO_MBPS);
  const downMbps = downBytes === null ? null : round1(downBytes * BYTES_PER_SEC_TO_MBPS);

  const overview: NetworkOverview = {
    upload: {
      usageMbps: upMbps,
      capacityMbps: input.uploadCapacityMbps,
      pct: meterPct(upMbps, input.uploadCapacityMbps),
    },
    download: {
      usageMbps: downMbps,
      capacityMbps: input.downloadCapacityMbps,
      pct: meterPct(downMbps, input.downloadCapacityMbps),
    },
    unavailable: upMbps === null && downMbps === null,
  };

  if (input.includeWanLinks) {
    overview.wanLinks = mergeWanLinks(upKbps, downKbps);
  }
  return overview;
}

/** Fold the per-`wan_name` up/down capacity vectors into one WanLink list, deduped + sorted by label. */
export function mergeWanLinks(
  upSamples: PromVectorSample[] | null,
  downSamples: PromVectorSample[] | null,
): WanLink[] {
  const byId = new Map<string, WanLink>();
  const ensure = (id: string, label: string): WanLink => {
    let link = byId.get(id);
    if (!link) {
      link = {
        id,
        label,
        capacityUpMbps: null,
        capacityDownMbps: null,
        usageUpMbps: null,
        usageDownMbps: null,
      };
      byId.set(id, link);
    }
    return link;
  };
  for (const s of upSamples ?? []) {
    const label = s.metric.wan_name ?? s.metric.wan_networkgroup ?? 'WAN';
    const id = s.metric.wan_id ?? label;
    const v = Number(s.value[1]);
    if (Number.isFinite(v)) ensure(id, label).capacityUpMbps = round1(v / 1000);
  }
  for (const s of downSamples ?? []) {
    const label = s.metric.wan_name ?? s.metric.wan_networkgroup ?? 'WAN';
    const id = s.metric.wan_id ?? label;
    const v = Number(s.value[1]);
    if (Number.isFinite(v)) ensure(id, label).capacityDownMbps = round1(v / 1000);
  }
  return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export async function getHardwareOverview(input: {
  prometheus: PrometheusReader;
}): Promise<HardwareOverview> {
  const [load1, nodeCount, cores, memTotal, memAvail] = await Promise.all([
    readScalar(input.prometheus, NODE_LOAD1_SUM_QUERY),
    readScalar(input.prometheus, NODE_COUNT_QUERY),
    readScalar(input.prometheus, NODE_CORES_QUERY),
    readScalar(input.prometheus, NODE_MEM_TOTAL_QUERY),
    readScalar(input.prometheus, NODE_MEM_AVAIL_QUERY),
  ]);

  const nodes =
    load1 !== null && nodeCount !== null && cores !== null && cores > 0
      ? {
          count: Math.round(nodeCount),
          coresTotal: Math.round(cores),
          load1Total: round1(load1),
          loadPerCorePct: round1((load1 / cores) * 100),
        }
      : null;

  const memory =
    memTotal !== null && memAvail !== null && memTotal > 0
      ? {
          usedBytes: Math.max(0, memTotal - memAvail),
          totalBytes: memTotal,
          pct: round1((Math.max(0, memTotal - memAvail) / memTotal) * 100),
        }
      : null;

  return { nodes, memory, unavailable: nodes === null && memory === null };
}
