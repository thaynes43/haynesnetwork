// ADR-040 / DESIGN-020 (PLAN-019) — the Prometheus-derived reads for the Metrics → Hardware sub-tab:
// SMART drive health + NVMe endurance (the headline), per-node load/temperature, and the Proxmox
// host→VM showcase. UNGATED (owner ruling — the payload is identical at `full` and `limited`; hardware
// is not user-aware), so there is no level seam here. Every field degrades INDEPENDENTLY to null/[] on
// a failed/empty query — never a throw (the overview.ts / network.ts posture). Series names verified
// live 2026-07-10 against the cluster `prometheus` datasource (smartctl-exporter [in-cluster + NAS],
// node-exporter [+ NAS], prometheus-pve-exporter); see ADR-040 recon.
import type { PromMatrixSeries, PromVectorSample, PrometheusReader } from './client';

// ── PromQL (verified live 2026-07-10) ────────────────────────────────────────────────────────────
// smartctl — the two jobs (in-cluster DaemonSet + the NAS `role=nas` scrape) share these families.
export const SMART_INFO_QUERY = 'smartctl_device';
export const SMART_STATUS_QUERY = 'smartctl_device_smart_status';
export const SMART_WEAR_QUERY = 'smartctl_device_percentage_used';
export const SMART_TEMP_QUERY = 'smartctl_device_temperature';
export const SMART_MEDIA_ERRORS_QUERY = 'smartctl_device_media_errors';
export const SMART_AVAILABLE_SPARE_QUERY = 'smartctl_device_available_spare';
export const SMART_AVAILABLE_SPARE_THRESHOLD_QUERY = 'smartctl_device_available_spare_threshold';
export const SMART_CRITICAL_WARNING_QUERY = 'smartctl_device_critical_warning';
export const SMART_POWER_ON_SECONDS_QUERY = 'smartctl_device_power_on_seconds';
export const SMART_CAPACITY_BYTES_QUERY = 'smartctl_device_capacity_bytes';
// node-exporter (k8s nodes + the NAS job) — folded `by (instance)`.
export const NODE_LOAD1_QUERY = 'node_load1';
export const NODE_CORES_BY_INSTANCE_QUERY =
  'count by (instance) (node_cpu_seconds_total{mode="idle"})';
export const NODE_MEM_TOTAL_BY_INSTANCE_QUERY = 'node_memory_MemTotal_bytes';
export const NODE_MEM_AVAIL_BY_INSTANCE_QUERY = 'node_memory_MemAvailable_bytes';
export const NODE_TEMP_MAX_BY_INSTANCE_QUERY = 'max by (instance) (node_hwmon_temp_celsius)';
// prometheus-pve-exporter — the Proxmox host/VM grain, folded by the `id` label (node/NAME, qemu/100…).
export const PVE_NODE_INFO_QUERY = 'pve_node_info';
export const PVE_GUEST_INFO_QUERY = 'pve_guest_info';
export const PVE_UP_QUERY = 'pve_up';
export const PVE_CPU_RATIO_QUERY = 'pve_cpu_usage_ratio';
export const PVE_MEM_USED_QUERY = 'pve_memory_usage_bytes';
export const PVE_MEM_SIZE_QUERY = 'pve_memory_size_bytes';
export const PVE_UPTIME_QUERY = 'pve_uptime_seconds';

// ── curated NVMe pool topology (owner-normative, ADR-040 D-02) ────────────────────────────────────
export type PoolFraming = 'critical' | 'expendable';
interface PoolMember {
  pool: string;
  framing: PoolFraming;
}
/** The NAS cache NVMe → pool map (device name, `role=nas` only). All four are CT2000P3PSSD8 2 TB. */
export const NVME_POOLS: Record<string, PoolMember> = {
  nvme0: { pool: 'Cache-apps', framing: 'critical' },
  nvme3: { pool: 'Cache-apps', framing: 'critical' },
  nvme1: { pool: 'Cache-staging', framing: 'expendable' },
  nvme2: { pool: 'Cache-staging', framing: 'expendable' },
};
/** The per-pool topology caption (owner-normative). */
export const POOL_TOPOLOGY: Record<string, string> = {
  'Cache-apps': 'nvme0+nvme3 · MIRROR · critical appdata',
  'Cache-staging': 'nvme1+nvme2 · striped · expendable',
};

/** available_spare must stay this many points above its threshold before we call the spare healthy. */
export const SPARE_MARGIN_PCT = 10;
/** The endurance-panel projection target (percentage_used). */
export const WEAR_PROJECTION_TARGET_PCT = 90;
/** A wear-rate projection needs at least this much history span to be trustworthy (2 days). */
export const MIN_PROJECTION_SPAN_SEC = 2 * 86_400;
const HISTORY_DAYS = 14;
/** ~6-hour step over 14 days ⇒ ~56 points — cheap and plenty for a linear fit. */
const HISTORY_STEP_SEC = 6 * 3600;

// ── shapes ──────────────────────────────────────────────────────────────────────────────────────
export type DriveRole = 'nas' | 'cluster';
export type DriveKind = 'nvme' | 'hdd';
export type SmartStatus = 'pass' | 'fail';
export type DriveHealthPill = 'healthy' | 'warn' | 'fail';

export interface DriveHealth {
  /** `instance/device` — unique across both smartctl jobs. */
  driveKey: string;
  device: string;
  instance: string;
  role: DriveRole;
  kind: DriveKind;
  /** model name + short serial, or the drive key when the info series is absent. */
  label: string;
  model: string | null;
  /** curated pool ('Cache-apps'|'Cache-staging'), or null for non-pool drives (the in-cluster NVMe). */
  pool: string | null;
  smartStatus: SmartStatus;
  wearPct: number | null;
  tempC: number | null;
  powerOnHours: number | null;
  mediaErrors: number | null;
  availableSpare: number | null;
  availableSpareThreshold: number | null;
  criticalWarning: number | null;
  capacityBytes: number | null;
  /** the dashboard pill (dashboard-only — distinct from the R-130 paging bar). */
  health: DriveHealthPill;
}

export interface WearProjection {
  /** true until enough history has accrued to fit a trustworthy wear rate. */
  insufficientHistory: boolean;
  /** wear gained per week (percentage points), when computable. */
  weeklyRatePct?: number;
  /** projected days until the pool's worst member reaches 90 % wear (0 when already past). */
  projectedDaysTo90?: number;
}

export interface NvmePool {
  name: string;
  framing: PoolFraming;
  topology: string;
  members: DriveHealth[];
  worstWearPct: number | null;
  minAvailableSpare: number | null;
  spareThreshold: number | null;
  totalMediaErrors: number;
  criticalWarningActive: boolean;
  /** owner-facing one-liner ("over rated endurance, spare 100 %, 0 media errors — holding"). */
  statusLine: string;
  projection: WearProjection;
}

export interface NodeLoad {
  name: string;
  role: DriveRole;
  load1: number | null;
  cores: number | null;
  loadPerCorePct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  memPct: number | null;
  hottestTempC: number | null;
}

export interface PveVm {
  id: string;
  vmid: string | null;
  name: string;
  type: string;
  up: boolean;
  cpuPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
}

export interface PveHost {
  name: string;
  up: boolean;
  cpuPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  memPct: number | null;
  uptimeSeconds: number | null;
  vms: PveVm[];
}

export interface HardwareMetrics {
  pools: NvmePool[];
  drives: DriveHealth[];
  nodes: NodeLoad[];
  pveHosts: PveHost[];
  /** true only when EVERY group came back empty (Prometheus unreachable). */
  unavailable: boolean;
}

/** The narrow SMART reading the `smart-alerts` evaluator consumes (numbers, no null — safe defaults). */
export interface DriveSmartReading {
  driveKey: string;
  label: string;
  pool: string | null;
  criticalPool: boolean;
  smartStatus: SmartStatus;
  wearPct: number;
  mediaErrors: number;
  availableSpare: number;
  availableSpareThreshold: number;
  criticalWarning: number;
}

// ── helpers (mirror overview.ts / network.ts degrade posture) ─────────────────────────────────────
async function readVector(reader: PrometheusReader, promQL: string): Promise<PromVectorSample[]> {
  try {
    return await reader.query(promQL);
  } catch {
    return [];
  }
}

async function readMatrix(
  reader: PrometheusReader,
  promQL: string,
  start: number,
  end: number,
  step: number,
): Promise<PromMatrixSeries[]> {
  try {
    return await reader.queryRange(promQL, start, end, step);
  } catch {
    return [];
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The unique drive key for a smartctl sample — `instance/device`. */
export function driveKeyOf(metric: Record<string, string>): string | null {
  const instance = metric.instance;
  const device = metric.device;
  if (instance === undefined || device === undefined) return null;
  return `${instance}/${device}`;
}

/** Fold a smartctl vector into driveKey→value (first finite sample per key wins). */
function foldByDriveKey(samples: PromVectorSample[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) {
    const key = driveKeyOf(s.metric);
    if (key === null || out.has(key)) continue;
    const v = num(s.value[1]);
    if (v !== null) out.set(key, v);
  }
  return out;
}

/** Fold an instant vector into label→value keyed by a chosen label. */
function foldByLabel(samples: PromVectorSample[], label: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) {
    const key = s.metric[label];
    if (key === undefined || out.has(key)) continue;
    const v = num(s.value[1]);
    if (v !== null) out.set(key, v);
  }
  return out;
}

/** The dashboard health pill (dashboard-only; distinct from the R-130 paging bar). */
export function drivePill(d: {
  smartStatus: SmartStatus;
  wearPct: number | null;
  tempC: number | null;
  mediaErrors: number | null;
  availableSpare: number | null;
  availableSpareThreshold: number | null;
  criticalWarning: number | null;
}): DriveHealthPill {
  const spareBad =
    d.availableSpare !== null &&
    d.availableSpareThreshold !== null &&
    d.availableSpare <= d.availableSpareThreshold;
  if (d.smartStatus === 'fail' || (d.mediaErrors ?? 0) > 0 || spareBad) return 'fail';
  const spareLow =
    d.availableSpare !== null &&
    d.availableSpareThreshold !== null &&
    d.availableSpare <= d.availableSpareThreshold + SPARE_MARGIN_PCT;
  if (
    (d.criticalWarning ?? 0) > 0 ||
    (d.wearPct ?? 0) >= WEAR_PROJECTION_TARGET_PCT ||
    (d.tempC ?? 0) >= 65 ||
    spareLow
  ) {
    return 'warn';
  }
  return 'healthy';
}

/**
 * Fit `percentage_used` history to a weekly wear rate and project the days to the target. Pure +
 * unit-tested. Returns `insufficientHistory` when there are < 2 samples, the span is < the minimum,
 * or wear did not measurably increase (a flat/declining series is not a trustworthy projection —
 * scraping only started 2026-07-10). Least-squares slope over (t seconds, wear pct).
 */
export function projectWear(points: Array<[number, number]>, targetPct: number): WearProjection {
  const finite = points.filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v));
  if (finite.length < 2) return { insufficientHistory: true };
  const first = finite[0]!;
  const last = finite[finite.length - 1]!;
  const spanSec = last[0] - first[0];
  if (spanSec < MIN_PROJECTION_SPAN_SEC) return { insufficientHistory: true };

  const n = finite.length;
  let sumT = 0;
  let sumV = 0;
  let sumTT = 0;
  let sumTV = 0;
  for (const [t, v] of finite) {
    sumT += t;
    sumV += v;
    sumTT += t * t;
    sumTV += t * v;
  }
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return { insufficientHistory: true };
  const slopePerSec = (n * sumTV - sumT * sumV) / denom; // wear pct per second
  const weeklyRatePct = round1(slopePerSec * 604_800);
  if (weeklyRatePct <= 0) return { insufficientHistory: true };

  const currentWear = last[1];
  const remaining = targetPct - currentWear;
  const projectedDaysTo90 = remaining <= 0 ? 0 : Math.round((remaining / weeklyRatePct) * 7);
  return { insufficientHistory: false, weeklyRatePct, projectedDaysTo90 };
}

/** Compose the owner-facing pool status line (R-129 acceptance copy). */
export function poolStatusLine(pool: {
  framing: PoolFraming;
  worstWearPct: number | null;
  bestWearPct: number | null;
  minAvailableSpare: number | null;
  totalMediaErrors: number;
  projection: WearProjection;
}): string {
  const spare = pool.minAvailableSpare ?? 0;
  const errs = pool.totalMediaErrors;
  if (pool.framing === 'expendable') {
    const past = (pool.worstWearPct ?? 0) >= 100 ? 'over rated endurance' : `${pool.worstWearPct}% worn`;
    const holding = spare > 5 && errs === 0 ? ' — holding' : ' — watch closely';
    return `${past}, spare ${spare}%, ${errs} media error${errs === 1 ? '' : 's'}${holding}`;
  }
  // critical (appdata mirror)
  const lo = pool.bestWearPct ?? pool.worstWearPct ?? 0;
  const hi = pool.worstWearPct ?? lo;
  const wornRange = lo === hi ? `${hi}% worn` : `${lo}–${hi}% worn`;
  if (pool.projection.insufficientHistory) {
    return `${wornRange}, projection pending — insufficient history yet`;
  }
  const days = pool.projection.projectedDaysTo90 ?? 0;
  if (days <= 0) return `${wornRange}, already at the 90% mark`;
  const months = Math.max(1, Math.round(days / 30));
  return `${wornRange}, projected ~${months} month${months === 1 ? '' : 's'} to 90%`;
}

// ── the drive read (shared by getHardwareMetrics + getDriveSmartReadings) ──────────────────────────
async function readDrives(reader: PrometheusReader): Promise<DriveHealth[]> {
  const [status, wear, temp, media, spare, spareThresh, critWarn, powerOn, capacity, info] =
    await Promise.all([
      readVector(reader, SMART_STATUS_QUERY),
      readVector(reader, SMART_WEAR_QUERY),
      readVector(reader, SMART_TEMP_QUERY),
      readVector(reader, SMART_MEDIA_ERRORS_QUERY),
      readVector(reader, SMART_AVAILABLE_SPARE_QUERY),
      readVector(reader, SMART_AVAILABLE_SPARE_THRESHOLD_QUERY),
      readVector(reader, SMART_CRITICAL_WARNING_QUERY),
      readVector(reader, SMART_POWER_ON_SECONDS_QUERY),
      readVector(reader, SMART_CAPACITY_BYTES_QUERY),
      readVector(reader, SMART_INFO_QUERY),
    ]);

  // smart_status is the CORE signal — a device without it can't be evaluated, so it defines the set.
  const statusMap = foldByDriveKey(status);
  const wearMap = foldByDriveKey(wear);
  const tempMap = foldByDriveKey(temp);
  const mediaMap = foldByDriveKey(media);
  const spareMap = foldByDriveKey(spare);
  const spareThreshMap = foldByDriveKey(spareThresh);
  const critWarnMap = foldByDriveKey(critWarn);
  const powerOnMap = foldByDriveKey(powerOn);
  const capacityMap = foldByDriveKey(capacity);

  // Per-key meta (instance, device, role) captured from the status vector; model/serial from info.
  const meta = new Map<string, { instance: string; device: string; role: DriveRole }>();
  for (const s of status) {
    const key = driveKeyOf(s.metric);
    if (key === null || meta.has(key)) continue;
    meta.set(key, {
      instance: s.metric.instance!,
      device: s.metric.device!,
      role: s.metric.role === 'nas' ? 'nas' : 'cluster',
    });
  }
  const modelByKey = new Map<string, { model: string; serial: string | undefined }>();
  for (const s of info) {
    const key = driveKeyOf(s.metric);
    if (key === null || modelByKey.has(key)) continue;
    if (s.metric.model_name) {
      modelByKey.set(key, { model: s.metric.model_name, serial: s.metric.serial_number });
    }
  }

  const drives: DriveHealth[] = [];
  for (const [key, statusVal] of statusMap) {
    const m = meta.get(key);
    if (!m) continue;
    const info0 = modelByKey.get(key);
    const model = info0?.model ?? null;
    const shortSerial = info0?.serial ? info0.serial.slice(-6) : null;
    const label = model
      ? `${model}${shortSerial ? ` · …${shortSerial}` : ''} (${m.device})`
      : key;
    const smartStatus: SmartStatus = statusVal === 1 ? 'pass' : 'fail';
    const pool = m.role === 'nas' ? (NVME_POOLS[m.device]?.pool ?? null) : null;
    const wearPct = wearMap.get(key) ?? null;
    const tempC = tempMap.get(key) ?? null;
    const mediaErrors = mediaMap.get(key) ?? null;
    const availableSpare = spareMap.get(key) ?? null;
    const availableSpareThreshold = spareThreshMap.get(key) ?? null;
    const criticalWarning = critWarnMap.get(key) ?? null;
    const powerOnSeconds = powerOnMap.get(key) ?? null;
    const capacityBytes = capacityMap.get(key) ?? null;
    drives.push({
      driveKey: key,
      device: m.device,
      instance: m.instance,
      role: m.role,
      kind: m.device.startsWith('nvme') ? 'nvme' : 'hdd',
      label,
      model,
      pool,
      smartStatus,
      wearPct,
      tempC: tempC === null ? null : round1(tempC),
      powerOnHours: powerOnSeconds === null ? null : Math.round(powerOnSeconds / 3600),
      mediaErrors,
      availableSpare,
      availableSpareThreshold,
      criticalWarning,
      capacityBytes,
      health: drivePill({
        smartStatus,
        wearPct,
        tempC,
        mediaErrors,
        availableSpare,
        availableSpareThreshold,
        criticalWarning,
      }),
    });
  }

  // NAS pool members first (the endurance story), then by role, then device name.
  const roleOrder: Record<DriveRole, number> = { nas: 0, cluster: 1 };
  return drives.sort((a, b) => {
    const ap = a.pool ? 0 : 1;
    const bp = b.pool ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.role !== b.role) return roleOrder[a.role] - roleOrder[b.role];
    return a.driveKey.localeCompare(b.driveKey);
  });
}

/** Fold the NVMe pool endurance panel from the drive list + the wear history. */
export function buildPools(
  drives: DriveHealth[],
  wearHistory: Map<string, Array<[number, number]>>,
): NvmePool[] {
  const byPool = new Map<string, DriveHealth[]>();
  for (const d of drives) {
    if (!d.pool) continue;
    const list = byPool.get(d.pool) ?? [];
    list.push(d);
    byPool.set(d.pool, list);
  }
  const pools: NvmePool[] = [];
  for (const [name, members] of byPool) {
    const framing: PoolFraming = NVME_POOLS[members[0]!.device]?.framing ?? 'critical';
    const wears = members.map((m) => m.wearPct).filter((w): w is number => w !== null);
    const worstWearPct = wears.length ? Math.max(...wears) : null;
    const bestWearPct = wears.length ? Math.min(...wears) : null;
    const spares = members
      .map((m) => m.availableSpare)
      .filter((s): s is number => s !== null);
    const minAvailableSpare = spares.length ? Math.min(...spares) : null;
    const spareThreshold =
      members.find((m) => m.availableSpareThreshold !== null)?.availableSpareThreshold ?? null;
    const totalMediaErrors = members.reduce((n, m) => n + (m.mediaErrors ?? 0), 0);
    const criticalWarningActive = members.some((m) => (m.criticalWarning ?? 0) > 0);

    // Project on the WORST-wear member (nearest 90 %).
    const worst = members
      .slice()
      .sort((a, b) => (b.wearPct ?? -1) - (a.wearPct ?? -1))[0]!;
    const points = wearHistory.get(worst.driveKey) ?? [];
    const projection = projectWear(points, WEAR_PROJECTION_TARGET_PCT);

    pools.push({
      name,
      framing,
      topology: POOL_TOPOLOGY[name] ?? members.map((m) => m.device).join('+'),
      members,
      worstWearPct,
      minAvailableSpare,
      spareThreshold,
      totalMediaErrors,
      criticalWarningActive,
      statusLine: poolStatusLine({
        framing,
        worstWearPct,
        bestWearPct,
        minAvailableSpare,
        totalMediaErrors,
        projection,
      }),
      projection,
    });
  }
  // Critical pool first (the one that matters), then expendable.
  return pools.sort((a, b) => (a.framing === b.framing ? 0 : a.framing === 'critical' ? -1 : 1));
}

async function readNodes(reader: PrometheusReader): Promise<NodeLoad[]> {
  const [load1, cores, memTotal, memAvail, temp] = await Promise.all([
    readVector(reader, NODE_LOAD1_QUERY),
    readVector(reader, NODE_CORES_BY_INSTANCE_QUERY),
    readVector(reader, NODE_MEM_TOTAL_BY_INSTANCE_QUERY),
    readVector(reader, NODE_MEM_AVAIL_BY_INSTANCE_QUERY),
    readVector(reader, NODE_TEMP_MAX_BY_INSTANCE_QUERY),
  ]);
  const coresMap = foldByLabel(cores, 'instance'); // real nodes = those reporting CPU cores
  const load1Map = foldByLabel(load1, 'instance');
  const memTotalMap = foldByLabel(memTotal, 'instance');
  const memAvailMap = foldByLabel(memAvail, 'instance');
  const tempMap = foldByLabel(temp, 'instance');

  const nodes: NodeLoad[] = [];
  for (const [instance, coreCount] of coresMap) {
    const l1 = load1Map.get(instance) ?? null;
    const total = memTotalMap.get(instance) ?? null;
    const avail = memAvailMap.get(instance) ?? null;
    const used = total !== null && avail !== null ? Math.max(0, total - avail) : null;
    nodes.push({
      name: instance,
      role: instance === 'haynestower' ? 'nas' : 'cluster',
      load1: l1 === null ? null : round1(l1),
      cores: Math.round(coreCount),
      loadPerCorePct: l1 !== null && coreCount > 0 ? round1((l1 / coreCount) * 100) : null,
      memUsedBytes: used,
      memTotalBytes: total,
      memPct: used !== null && total !== null && total > 0 ? round1((used / total) * 100) : null,
      hottestTempC: tempMap.has(instance) ? round1(tempMap.get(instance)!) : null,
    });
  }
  return nodes.sort((a, b) => {
    if (a.role !== b.role) return a.role === 'nas' ? -1 : 1;
    return (b.loadPerCorePct ?? -1) - (a.loadPerCorePct ?? -1) || a.name.localeCompare(b.name);
  });
}

async function readPve(reader: PrometheusReader): Promise<PveHost[]> {
  const [nodeInfo, guestInfo, up, cpu, memUsed, memSize, uptime] = await Promise.all([
    readVector(reader, PVE_NODE_INFO_QUERY),
    readVector(reader, PVE_GUEST_INFO_QUERY),
    readVector(reader, PVE_UP_QUERY),
    readVector(reader, PVE_CPU_RATIO_QUERY),
    readVector(reader, PVE_MEM_USED_QUERY),
    readVector(reader, PVE_MEM_SIZE_QUERY),
    readVector(reader, PVE_UPTIME_QUERY),
  ]);
  const upMap = foldByLabel(up, 'id');
  const cpuMap = foldByLabel(cpu, 'id');
  const memUsedMap = foldByLabel(memUsed, 'id');
  const memSizeMap = foldByLabel(memSize, 'id');
  const uptimeMap = foldByLabel(uptime, 'id');

  const cpuPct = (id: string): number | null => {
    const r = cpuMap.get(id);
    return r === undefined ? null : round1(Math.max(0, r) * 100);
  };

  // Guests grouped by their PVE node.
  const guestsByNode = new Map<string, PveVm[]>();
  for (const s of guestInfo) {
    const node = s.metric.node;
    const id = s.metric.id;
    if (node === undefined || id === undefined) continue;
    const used = memUsedMap.get(id) ?? null;
    const size = memSizeMap.get(id) ?? null;
    const vm: PveVm = {
      id,
      vmid: s.metric.vmid ?? null,
      name: s.metric.name ?? id,
      type: s.metric.type ?? id.split('/')[0] ?? 'guest',
      up: (upMap.get(id) ?? 0) === 1,
      cpuPct: cpuPct(id),
      memUsedBytes: used,
      memTotalBytes: size,
    };
    const list = guestsByNode.get(node) ?? [];
    list.push(vm);
    guestsByNode.set(node, list);
  }

  const hosts: PveHost[] = [];
  for (const s of nodeInfo) {
    const name = s.metric.name;
    if (name === undefined) continue;
    const id = s.metric.id ?? `node/${name}`;
    const used = memUsedMap.get(id) ?? null;
    const size = memSizeMap.get(id) ?? null;
    const vms = (guestsByNode.get(name) ?? []).sort(
      (a, b) => Number(b.up) - Number(a.up) || (b.cpuPct ?? -1) - (a.cpuPct ?? -1) || a.name.localeCompare(b.name),
    );
    hosts.push({
      name,
      up: (upMap.get(id) ?? 1) === 1,
      cpuPct: cpuPct(id),
      memUsedBytes: used,
      memTotalBytes: size,
      memPct: used !== null && size !== null && size > 0 ? round1((used / size) * 100) : null,
      uptimeSeconds: uptimeMap.get(id) ?? null,
      vms,
    });
  }
  return hosts.sort((a, b) => a.name.localeCompare(b.name));
}

// ── the reads ─────────────────────────────────────────────────────────────────────────────────────
export async function getHardwareMetrics(input: {
  prometheus: PrometheusReader;
  /** Test seam — the wear-history window (days). Defaults to 14. */
  historyDays?: number;
  /** Test seam — "now" in unix seconds. Defaults to Date.now(). */
  nowSec?: number;
}): Promise<HardwareMetrics> {
  const end = Math.floor(input.nowSec ?? Date.now() / 1000);
  const start = end - (input.historyDays ?? HISTORY_DAYS) * 86_400;

  const [drives, wearMatrix, nodes, pveHosts] = await Promise.all([
    readDrives(input.prometheus),
    readMatrix(input.prometheus, SMART_WEAR_QUERY, start, end, HISTORY_STEP_SEC),
    readNodes(input.prometheus),
    readPve(input.prometheus),
  ]);

  // Fold the wear matrix into driveKey → [t, wear] points.
  const wearHistory = new Map<string, Array<[number, number]>>();
  for (const series of wearMatrix) {
    const key = driveKeyOf(series.metric);
    if (key === null) continue;
    const points: Array<[number, number]> = [];
    for (const [t, raw] of series.values) {
      const v = num(raw);
      if (v !== null) points.push([t, v]);
    }
    if (points.length) wearHistory.set(key, points);
  }

  const pools = buildPools(drives, wearHistory);
  return {
    pools,
    drives,
    nodes,
    pveHosts,
    unavailable: drives.length === 0 && nodes.length === 0 && pveHosts.length === 0,
  };
}

/**
 * The narrow SMART reading the `smart-alerts` sync mode diffs against stored state. Only drives with a
 * definite `smart_status` are returned; the numeric fields default to a NO-ALERT-safe value when their
 * series is absent (so a missing metric can never false-trigger a page). `criticalPool` is resolved
 * here from the curated pool map, keeping the domain evaluator generic.
 */
export async function getDriveSmartReadings(input: {
  prometheus: PrometheusReader;
}): Promise<DriveSmartReading[]> {
  const drives = await readDrives(input.prometheus);
  return drives.map((d) => ({
    driveKey: d.driveKey,
    label: d.label,
    pool: d.pool,
    criticalPool: d.pool !== null && (NVME_POOLS[d.device]?.framing ?? null) === 'critical',
    smartStatus: d.smartStatus,
    wearPct: d.wearPct ?? 0,
    mediaErrors: d.mediaErrors ?? 0,
    availableSpare: d.availableSpare ?? 100,
    availableSpareThreshold: d.availableSpareThreshold ?? 0,
    criticalWarning: d.criticalWarning ?? 0,
  }));
}
