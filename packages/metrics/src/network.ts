// ADR-039 / DESIGN-019 (PLAN-020) — the Prometheus-derived reads for the Metrics → Network sub-tab.
//
// THE PRIVACY INVARIANT (ADR-039 C-01, refining ADR-037 C-03/C-04): this module is the SINGLE place any
// unpoller series is named for the Network tab, and it is an ALLOW-LIST BY CONSTRUCTION — it structurally
// NEVER references `unpoller_client_*` (per-client hostname/MAC/RSSI/rate), `unpoller_site_remote_user_*`
// (VPN remote users), or any `*_info` series (which carry identifying names). Every PromQL string this
// module can issue is enumerated in `NETWORK_ALLOWLIST_QUERIES`; `network.test.ts` asserts each one names
// only allow-listed `unpoller_(site|device|wan)_*` series and matches NONE of the deny patterns — so a
// reviewer (and CI) can PROVE "no client identities at any level" without reading the whole file.
//
// UniFi DEVICE names (an AP called "Garage U7 Outdoor", a switch "Switch Pro Max 48 PoE", the gateway
// "Westford DMSE") are INFRASTRUCTURE, not clients (ADR-039 C-02) — allowed at `full`. There are NO
// per-client / per-station rows at ANY level; the only client-adjacent number is the aggregate
// `unpoller_site_stations` COUNT (a scalar, not an identity).
//
// The WAN usage-vs-capacity meters are NOT duplicated here — they REUSE 017's `getNetworkOverview`
// (overview.ts owns that PromQL + the admin-editable capacity denominators). This module adds only the
// `full`-only infrastructure grain + the both-levels WAN history sparkline. Every field degrades
// INDEPENDENTLY to null/[] on a failed/empty query — never a throw (the overview.ts posture). Series
// names verified live 2026-07-10 against the cluster `prometheus` datasource (unpoller v3.3.0); see
// ADR-039 / DESIGN-019 D-03.
import type { PromMatrixSeries, PromVectorSample, PrometheusReader } from './client';
import {
  firstScalar,
  getNetworkOverview,
  mergeWanLinks,
  WAN_DOWNLOAD_BYTES_QUERY,
  WAN_LINK_DOWN_KBPS_QUERY,
  WAN_LINK_UP_KBPS_QUERY,
  WAN_UPLOAD_BYTES_QUERY,
  type NetworkOverview,
} from './overview';

// ── PromQL (allow-listed; live-verified 2026-07-10) ─────────────────────────────────────────────────
// Infra-device performance — each carries `name` (the UniFi device label) + `type` (udm/usw/uap/…).
export const DEVICE_CPU_RATIO_QUERY = 'unpoller_device_cpu_utilization_ratio';
export const DEVICE_MEM_RATIO_QUERY = 'unpoller_device_memory_utilization_ratio';
export const DEVICE_LOAD1_QUERY = 'unpoller_device_load_average_1';
// WAN health — the gateway's periodic speedtest (Mbps / seconds) + the site's internet (www) latency.
export const GATEWAY_SPEEDTEST_DOWN_QUERY = 'max(unpoller_device_speedtest_download)';
export const GATEWAY_SPEEDTEST_UP_QUERY = 'max(unpoller_device_speedtest_upload)';
export const GATEWAY_SPEEDTEST_LATENCY_QUERY = 'max(unpoller_device_speedtest_latency_seconds)';
export const SITE_WWW_LATENCY_QUERY = 'max(unpoller_site_latency_seconds{subsystem="www"})';
export const UPLINK_LATENCY_MAX_QUERY = 'max(unpoller_device_uplink_latency_seconds)';
// Site rollup COUNTS (aggregates — not per-client rows).
export const SITE_APS_QUERY = 'sum(unpoller_site_aps)';
export const SITE_SWITCHES_QUERY = 'sum(unpoller_site_switches)';
export const SITE_GATEWAYS_QUERY = 'sum(unpoller_site_gateways)';
export const SITE_STATIONS_QUERY = 'sum(unpoller_site_stations)';

/**
 * EVERY PromQL string this module (and the WAN meters/links it reuses from overview.ts) can issue. The
 * privacy-invariant unit test iterates this list and proves each query names only allow-listed series
 * and matches none of the deny patterns (ADR-039 C-01). Keep it EXHAUSTIVE — the test also guards drift.
 */
export const NETWORK_ALLOWLIST_QUERIES: readonly string[] = [
  // reused from the 017 Overview (WAN usage-vs-capacity meters + per-uplink caps)
  WAN_UPLOAD_BYTES_QUERY,
  WAN_DOWNLOAD_BYTES_QUERY,
  WAN_LINK_UP_KBPS_QUERY,
  WAN_LINK_DOWN_KBPS_QUERY,
  // full-only infra grain owned here
  DEVICE_CPU_RATIO_QUERY,
  DEVICE_MEM_RATIO_QUERY,
  DEVICE_LOAD1_QUERY,
  GATEWAY_SPEEDTEST_DOWN_QUERY,
  GATEWAY_SPEEDTEST_UP_QUERY,
  GATEWAY_SPEEDTEST_LATENCY_QUERY,
  SITE_WWW_LATENCY_QUERY,
  UPLINK_LATENCY_MAX_QUERY,
  SITE_APS_QUERY,
  SITE_SWITCHES_QUERY,
  SITE_GATEWAYS_QUERY,
  SITE_STATIONS_QUERY,
] as const;

// ── shapes ──────────────────────────────────────────────────────────────────────────────────────
export type DeviceCategory = 'gateway' | 'switch' | 'ap';

/** One infrastructure device's performance (NO client identity — a UniFi AP/switch/gateway). */
export interface DevicePerfRow {
  /** The UniFi device NAME (infrastructure label, e.g. "Garage U7 Outdoor") — ADR-039 C-02. */
  name: string;
  category: DeviceCategory;
  /** The raw unpoller device type (udm/usw/uap) — infrastructure classifier, not a client attribute. */
  type: string;
  cpuPct: number | null;
  memPct: number | null;
  load1: number | null;
}

export interface WanHealth {
  /** The gateway's last speedtest, in Mbps (down/up) + its latency in ms. */
  speedtestDownMbps: number | null;
  speedtestUpMbps: number | null;
  speedtestLatencyMs: number | null;
  /** The site's internet-path (www) round-trip latency, in ms. */
  siteLatencyMs: number | null;
  /** The worst uplink latency across infra devices, in ms. */
  uplinkLatencyMs: number | null;
  unavailable: boolean;
}

/** Site rollup COUNTS (aggregates, never per-client rows). */
export interface SiteRollup {
  aps: number | null;
  switches: number | null;
  gateways: number | null;
  /** Aggregate connected-station COUNT — a scalar, not an identity (ADR-039 C-02). */
  stations: number | null;
  unavailable: boolean;
}

/** FULL-ONLY: the infrastructure-performance grain. Present ONLY when the caller is `full`. */
export interface NetworkInfra {
  devices: DevicePerfRow[];
  wanHealth: WanHealth;
  site: SiteRollup;
}

/** One WAN-throughput history point (Mbps at a unix-second). */
export interface WanHistoryPoint {
  t: number;
  mbps: number;
}
export interface WanHistory {
  upload: WanHistoryPoint[];
  download: WanHistoryPoint[];
  /** The window length in days (for the caption). */
  rangeDays: number;
  /** True when NEITHER series returned any point. */
  unavailable: boolean;
}

export interface NetworkMetrics {
  /** The disjoint-shape driver — echoed like `metrics.overview` (ADR-039 C-03). */
  level: 'full' | 'limited';
  /** WAN usage-vs-capacity meters (REUSE of 017 getNetworkOverview). `wan.wanLinks` is full-only. */
  wan: NetworkOverview;
  /** Both-levels WAN throughput history (the `limited` value-add over the Overview; ADR-039 C-05). */
  history: WanHistory;
  /**
   * FULL-ONLY (ADR-039 C-03). Present ONLY when `includeInfra`; OMITTED at `limited` — the same
   * never-fetch/never-serialize seam ADR-037 C-03 established. NEVER contains a client series.
   */
  infra?: NetworkInfra;
}

const BYTES_PER_SEC_TO_MBPS = 8 / 1_000_000;
const SEC_TO_MS = 1000;
const DEFAULT_HISTORY_DAYS = 7;
/** 1-hour step over 7 days ⇒ ~168 points — plenty for a sparkline, cheap for one range query. */
const HISTORY_STEP_SEC = 3600;

// ── helpers (mirror overview.ts / apps.ts degrade posture) ──────────────────────────────────────────
/** Run an instant query, returning its first scalar — or null on ANY failure (the degrade path). */
async function readScalar(reader: PrometheusReader, promQL: string): Promise<number | null> {
  try {
    return firstScalar(await reader.query(promQL));
  } catch {
    return null;
  }
}

/** Run an instant query, returning the raw samples — or [] on ANY failure. */
async function readVector(reader: PrometheusReader, promQL: string): Promise<PromVectorSample[]> {
  try {
    return await reader.query(promQL);
  } catch {
    return [];
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A 0..1 ratio → a one-decimal percent (clamped ≥ 0); null passes through. */
export function ratioToPct(ratio: number | null): number | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  return round1(Math.max(0, ratio) * 100);
}

/** unpoller `type` → the curated category, or null for non-network gear (pdu/uci/…) we don't surface. */
export function deviceCategory(type: string | undefined): DeviceCategory | null {
  switch (type) {
    case 'udm':
    case 'ugw':
    case 'uxg':
      return 'gateway';
    case 'usw':
      return 'switch';
    case 'uap':
      return 'ap';
    default:
      return null;
  }
}

/** Fold instant samples into name→value (keyed by the UniFi device `name` label). */
function foldByName(samples: PromVectorSample[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) {
    const name = s.metric.name;
    if (name === undefined) continue;
    const v = Number(s.value[1]);
    if (Number.isFinite(v)) out.set(name, v);
  }
  return out;
}

// ── the read ──────────────────────────────────────────────────────────────────────────────────────
export interface GetNetworkMetricsInput {
  prometheus: PrometheusReader;
  uploadCapacityMbps: number;
  downloadCapacityMbps: number;
  /** level === 'full' — gates whether the infra grain (device perf + WAN health + rollups) is fetched
   *  AND serialized. A `limited` caller never issues those queries and never receives the `infra` key. */
  includeInfra: boolean;
  /** Test seam — the history window (days). Defaults to 7. */
  historyDays?: number;
  /** Test seam — "now" in unix seconds. Defaults to Date.now(). */
  nowSec?: number;
}

export async function getNetworkMetrics(input: GetNetworkMetricsInput): Promise<NetworkMetrics> {
  const level: 'full' | 'limited' = input.includeInfra ? 'full' : 'limited';
  const historyDays = input.historyDays ?? DEFAULT_HISTORY_DAYS;

  const [wan, history, infra] = await Promise.all([
    // REUSE the 017 Overview meters (+ full-only per-uplink caps) — no duplicated WAN PromQL here.
    getNetworkOverview({
      prometheus: input.prometheus,
      uploadCapacityMbps: input.uploadCapacityMbps,
      downloadCapacityMbps: input.downloadCapacityMbps,
      includeWanLinks: input.includeInfra,
    }),
    getWanHistory(input.prometheus, historyDays, input.nowSec),
    // Full-only: the infra grain is ONLY fetched when includeInfra (never for a limited caller).
    input.includeInfra ? getNetworkInfra(input.prometheus) : Promise.resolve(null),
  ]);

  const metrics: NetworkMetrics = { level, wan, history };
  if (infra !== null) metrics.infra = infra;
  return metrics;
}

/** The both-levels WAN throughput history — one range query per direction, degrading to [] independently. */
async function getWanHistory(
  reader: PrometheusReader,
  rangeDays: number,
  nowSec?: number,
): Promise<WanHistory> {
  const end = Math.floor(nowSec ?? Date.now() / 1000);
  const start = end - rangeDays * 86_400;
  const range = async (promQL: string): Promise<PromMatrixSeries[]> => {
    try {
      return await reader.queryRange(promQL, start, end, HISTORY_STEP_SEC);
    } catch {
      return [];
    }
  };
  const [upSeries, downSeries] = await Promise.all([
    range(WAN_UPLOAD_BYTES_QUERY),
    range(WAN_DOWNLOAD_BYTES_QUERY),
  ]);
  const upload = matrixToMbps(upSeries);
  const download = matrixToMbps(downSeries);
  return {
    upload,
    download,
    rangeDays,
    unavailable: upload.length === 0 && download.length === 0,
  };
}

/** Fold the FIRST matrix series' samples into Mbps history points (bytes/sec → Mbps). */
export function matrixToMbps(series: PromMatrixSeries[]): WanHistoryPoint[] {
  const first = series[0];
  if (!first) return [];
  const points: WanHistoryPoint[] = [];
  for (const [t, raw] of first.values) {
    const bytes = Number(raw);
    if (Number.isFinite(bytes)) points.push({ t, mbps: round1(bytes * BYTES_PER_SEC_TO_MBPS) });
  }
  return points;
}

/** FULL-ONLY: the infrastructure grain — per-device perf, WAN health, site rollup counts. */
async function getNetworkInfra(reader: PrometheusReader): Promise<NetworkInfra> {
  const [
    cpuSamples,
    memSamples,
    loadSamples,
    stDown,
    stUp,
    stLatency,
    siteLatency,
    uplinkLatency,
    aps,
    switches,
    gateways,
    stations,
  ] = await Promise.all([
    readVector(reader, DEVICE_CPU_RATIO_QUERY),
    readVector(reader, DEVICE_MEM_RATIO_QUERY),
    readVector(reader, DEVICE_LOAD1_QUERY),
    readScalar(reader, GATEWAY_SPEEDTEST_DOWN_QUERY),
    readScalar(reader, GATEWAY_SPEEDTEST_UP_QUERY),
    readScalar(reader, GATEWAY_SPEEDTEST_LATENCY_QUERY),
    readScalar(reader, SITE_WWW_LATENCY_QUERY),
    readScalar(reader, UPLINK_LATENCY_MAX_QUERY),
    readScalar(reader, SITE_APS_QUERY),
    readScalar(reader, SITE_SWITCHES_QUERY),
    readScalar(reader, SITE_GATEWAYS_QUERY),
    readScalar(reader, SITE_STATIONS_QUERY),
  ]);

  const devices = mergeDevicePerf(cpuSamples, memSamples, loadSamples);

  const wanHealth: WanHealth = {
    speedtestDownMbps: stDown === null ? null : round1(stDown),
    speedtestUpMbps: stUp === null ? null : round1(stUp),
    speedtestLatencyMs: stLatency === null ? null : round1(stLatency * SEC_TO_MS),
    siteLatencyMs: siteLatency === null ? null : round1(siteLatency * SEC_TO_MS),
    uplinkLatencyMs: uplinkLatency === null ? null : round1(uplinkLatency * SEC_TO_MS),
    unavailable:
      stDown === null &&
      stUp === null &&
      stLatency === null &&
      siteLatency === null &&
      uplinkLatency === null,
  };

  const site: SiteRollup = {
    aps: aps === null ? null : Math.round(aps),
    switches: switches === null ? null : Math.round(switches),
    gateways: gateways === null ? null : Math.round(gateways),
    stations: stations === null ? null : Math.round(stations),
    unavailable: aps === null && switches === null && gateways === null && stations === null,
  };

  return { devices, wanHealth, site };
}

/**
 * Fold the cpu/mem/load vectors into one DevicePerfRow list, keyed by the device `name`, keeping only
 * network gear (gateway/switch/AP — pdu/uci/… are dropped). Sorted by category then CPU desc so the UI
 * shows the busiest gear first. NEVER references a client series — the `name`/`type` labels are infra.
 */
export function mergeDevicePerf(
  cpuSamples: PromVectorSample[],
  memSamples: PromVectorSample[],
  loadSamples: PromVectorSample[],
): DevicePerfRow[] {
  const cpu = foldByName(cpuSamples);
  const mem = foldByName(memSamples);
  const load = foldByName(loadSamples);

  // The type label lives on the cpu/mem/load samples themselves — capture it as we see each device.
  const typeByName = new Map<string, string>();
  for (const s of [...cpuSamples, ...memSamples, ...loadSamples]) {
    const name = s.metric.name;
    const type = s.metric.type;
    if (name !== undefined && type !== undefined && !typeByName.has(name)) typeByName.set(name, type);
  }

  const rows: DevicePerfRow[] = [];
  for (const name of new Set([...cpu.keys(), ...mem.keys(), ...load.keys()])) {
    const type = typeByName.get(name) ?? '';
    const category = deviceCategory(type);
    if (category === null) continue; // drop non-network gear (pdu/uci/…) — keep the view curated
    rows.push({
      name,
      category,
      type,
      cpuPct: ratioToPct(cpu.get(name) ?? null),
      memPct: ratioToPct(mem.get(name) ?? null),
      load1: load.has(name) ? round1(load.get(name)!) : null,
    });
  }

  const order: Record<DeviceCategory, number> = { gateway: 0, switch: 1, ap: 2 };
  return rows.sort((a, b) => {
    if (a.category !== b.category) return order[a.category] - order[b.category];
    return (b.cpuPct ?? -1) - (a.cpuPct ?? -1) || a.name.localeCompare(b.name);
  });
}
