// DESIGN-018 / PLAN-018 — the Prometheus-derived reads for the Metrics → Apps sub-tab: the
// media-automation apps (*arr + downloaders + indexers) grouped into four curated panel groups. Every
// field fires an instant query and degrades INDEPENDENTLY: a failed/empty query yields null (or an
// empty row set) — never a throw (the overview.ts `readScalar` posture). The exact metric names were
// verified live 2026-07-10 against the cluster `prometheus` datasource (exportarr + first-party
// exporters); see DESIGN-018 D-03 / OPS-008.
//
// ACCESS (ADR-037 C-03): no *arr/downloader series carries user/requester identity (labels are only
// job/indexer/path/download_state/category — the qbittorrent `category` is the *arr client name, not a
// user), so the whole tab is BOTH-levels. The full-only `requesterActivity` seam is kept present-but-
// empty so a future user-aware panel slots in without a refactor (D-05).
import type { PromVectorSample, PrometheusReader } from './client';
import { firstScalar } from './overview';

// ── PromQL (verified live 2026-07-10) ─────────────────────────────────────────────────────────────
/** The three *arr library apps, in wall order (Movies, TV, Music). */
const ARR_LIBRARY_SPECS = [
  {
    key: 'radarr',
    label: 'Movies',
    total: 'radarr_movie_total',
    monitored: 'radarr_movie_monitored_total',
    missing: 'radarr_movie_missing_total',
    cutoffUnmet: 'radarr_movie_cutoff_unmet_total',
  },
  {
    key: 'sonarr',
    label: 'TV episodes',
    total: 'sonarr_episode_total',
    monitored: 'sonarr_series_monitored_total',
    missing: 'sonarr_episode_missing_total',
    cutoffUnmet: 'sonarr_episode_cutoff_unmet_total',
  },
  {
    key: 'lidarr',
    label: 'Albums',
    total: 'lidarr_albums_total',
    monitored: 'lidarr_artists_monitored_total',
    missing: 'lidarr_albums_missing_total',
    // lidarr exposes no *_cutoff_unmet_total series.
    cutoffUnmet: null,
  },
] as const satisfies readonly {
  key: ArrKey;
  label: string;
  total: string;
  monitored: string;
  missing: string;
  cutoffUnmet: string | null;
}[];

/** The three *arr pipeline apps (Radarr/Sonarr/Lidarr) — queue depth, grabs/hr, health issues. */
const ARR_PIPELINE_SPECS = [
  { key: 'radarr', label: 'Radarr', app: 'radarr' },
  { key: 'sonarr', label: 'Sonarr', app: 'sonarr' },
  { key: 'lidarr', label: 'Lidarr', app: 'lidarr' },
] as const satisfies readonly { key: ArrKey; label: string; app: string }[];

/** The two SABnzbd lanes: automation vs the Seerr fast lane. */
const SAB_LANES = [
  { key: 'sabnzbd', label: 'SABnzbd — automation' },
  { key: 'sabnzbd-fast', label: 'SABnzbd — fast lane' },
] as const satisfies readonly { key: SabKey; label: string }[];

export const SAB_SPEED_QUERY = 'sabnzbd_speed_bps';
export const SAB_DOWNLOADED_24H_QUERY = 'sum by (job) (increase(sabnzbd_downloaded_bytes[24h]))';
export const SAB_REMAINING_QUERY = 'sabnzbd_remaining_bytes';
export const SAB_QUEUE_LENGTH_QUERY = 'sabnzbd_queue_length';
export const SAB_UP_QUERY = 'up{job=~"sabnzbd|sabnzbd-fast"}';

export const QBITTORRENT_UP_QUERY = 'up{job="qbittorrent"}';
export const QBITTORRENT_TORRENTS_QUERY = 'sum(qbittorrent_torrents_count)';
export const SLSKD_UP_QUERY = 'up{job="slskd"}';
export const SLSKD_QUEUE_DEPTH_QUERY = 'slskd_enqueue_queue_depth_current';

export const PROWLARR_ENABLED_QUERY = 'sum(prowlarr_indexer_enabled_total)';
export const PROWLARR_UNAVAILABLE_QUERY = 'sum(prowlarr_indexer_unavailable)';
export const PROWLARR_RESPONSE_MS_QUERY = 'prowlarr_indexer_average_response_time_ms';
export const PROWLARR_QUERY_RATE_QUERY =
  'sum by (indexer) (rate(prowlarr_indexer_queries_total[30m]) * 3600)';

// ── shapes ──────────────────────────────────────────────────────────────────────────────────────
export type ArrKey = 'radarr' | 'sonarr' | 'lidarr';
export type SabKey = 'sabnzbd' | 'sabnzbd-fast';
export type ClientKey = 'qbittorrent' | 'slskd';

export interface ArrLibraryRow {
  key: ArrKey;
  label: string;
  total: number | null;
  monitored: number | null;
  missing: number | null;
  /** null for lidarr (no cutoff-unmet series). */
  cutoffUnmet: number | null;
}
export interface CollectionGroup {
  rows: ArrLibraryRow[];
  /** Every field in the group was unreadable. */
  unavailable: boolean;
}

export interface ArrPipelineRow {
  key: ArrKey;
  label: string;
  queue: number | null;
  grabsPerHour: number | null;
  healthIssues: number | null;
}
export interface PipelineGroup {
  rows: ArrPipelineRow[];
  unavailable: boolean;
}

export interface SabLane {
  key: SabKey;
  label: string;
  speedBps: number | null;
  downloaded24hBytes: number | null;
  remainingBytes: number | null;
  queueLength: number | null;
  up: boolean | null;
}
export interface ClientStatus {
  key: ClientKey;
  label: string;
  up: boolean | null;
  /** A short curated caption (e.g. "12 torrents", "queue depth 0", "unreachable"). */
  detail: string;
}
export interface DownloadsGroup {
  usenet: SabLane[];
  clients: ClientStatus[];
  unavailable: boolean;
}

export interface IndexerRow {
  indexer: string;
  avgResponseMs: number | null;
  queriesPerHour: number | null;
}
export interface IndexersGroup {
  enabled: number | null;
  unavailableCount: number | null;
  rows: IndexerRow[];
  unavailable: boolean;
}

/** A future user-aware requester panel would populate this (D-05). Empty today. */
export interface RequesterActivityRow {
  requester: string;
  count: number;
}

export interface AppsMetrics {
  collection: CollectionGroup;
  pipeline: PipelineGroup;
  downloads: DownloadsGroup;
  indexers: IndexersGroup;
  /**
   * FULL-ONLY seam (ADR-037 C-03). Present (as `[]`) ONLY when `includeUserAware`; OMITTED at
   * `limited`. No *arr/downloader series names a user today, so nothing populates it — the seam keeps
   * a future requester panel a slot-in, not a refactor.
   */
  requesterActivity?: RequesterActivityRow[];
}

// ── helpers (mirror overview.ts's degrade posture) ────────────────────────────────────────────────
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

/** Fold instant samples into label→value, keyed by `labelKey` (e.g. `job`, `indexer`). */
function foldByLabel(samples: PromVectorSample[], labelKey: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) {
    const id = s.metric[labelKey];
    if (id === undefined) continue;
    const v = Number(s.value[1]);
    if (Number.isFinite(v)) out.set(id, v);
  }
  return out;
}

/** true(1)/false(0)/null(unknown) from an `up`-style scalar. */
function upFlag(n: number | null): boolean | null {
  if (n === null) return null;
  return n >= 1;
}

// ── the read ──────────────────────────────────────────────────────────────────────────────────────
export interface GetAppsMetricsInput {
  prometheus: PrometheusReader;
  /** level === 'full' — gates the present-but-empty full-only branch (ADR-037 C-03 / D-05). */
  includeUserAware: boolean;
}

export async function getAppsMetrics(input: GetAppsMetricsInput): Promise<AppsMetrics> {
  const p = input.prometheus;
  const [collection, pipeline, downloads, indexers] = await Promise.all([
    getCollectionGroup(p),
    getPipelineGroup(p),
    getDownloadsGroup(p),
    getIndexersGroup(p),
  ]);

  const metrics: AppsMetrics = { collection, pipeline, downloads, indexers };
  if (input.includeUserAware) {
    // No user-aware *arr/downloader series today — the full-only branch is present-but-empty (D-05).
    metrics.requesterActivity = [];
  }
  return metrics;
}

async function getCollectionGroup(p: PrometheusReader): Promise<CollectionGroup> {
  const rows = await Promise.all(
    ARR_LIBRARY_SPECS.map(async (spec): Promise<ArrLibraryRow> => {
      const [total, monitored, missing, cutoffUnmet] = await Promise.all([
        readScalar(p, spec.total),
        readScalar(p, spec.monitored),
        readScalar(p, spec.missing),
        spec.cutoffUnmet === null ? Promise.resolve(null) : readScalar(p, spec.cutoffUnmet),
      ]);
      return { key: spec.key, label: spec.label, total, monitored, missing, cutoffUnmet };
    }),
  );
  const unavailable = rows.every(
    (r) => r.total === null && r.monitored === null && r.missing === null && r.cutoffUnmet === null,
  );
  return { rows, unavailable };
}

async function getPipelineGroup(p: PrometheusReader): Promise<PipelineGroup> {
  const rows = await Promise.all(
    ARR_PIPELINE_SPECS.map(async (spec): Promise<ArrPipelineRow> => {
      const [queue, grabsPerHour, healthIssues] = await Promise.all([
        readScalar(p, `sum(${spec.app}_queue_total)`),
        readScalar(p, `sum(rate(${spec.app}_history_total[1h])) * 3600`),
        readScalar(p, `sum(${spec.app}_system_health_issues)`),
      ]);
      return { key: spec.key, label: spec.label, queue, grabsPerHour, healthIssues };
    }),
  );
  const unavailable = rows.every(
    (r) => r.queue === null && r.grabsPerHour === null && r.healthIssues === null,
  );
  return { rows, unavailable };
}

async function getDownloadsGroup(p: PrometheusReader): Promise<DownloadsGroup> {
  const [
    speedSamples,
    downloadedSamples,
    remainingSamples,
    queueSamples,
    upSamples,
    qbtUp,
    qbtTorrents,
    slskdUp,
    slskdQueue,
  ] = await Promise.all([
    readVector(p, SAB_SPEED_QUERY),
    readVector(p, SAB_DOWNLOADED_24H_QUERY),
    readVector(p, SAB_REMAINING_QUERY),
    readVector(p, SAB_QUEUE_LENGTH_QUERY),
    readVector(p, SAB_UP_QUERY),
    readScalar(p, QBITTORRENT_UP_QUERY),
    readScalar(p, QBITTORRENT_TORRENTS_QUERY),
    readScalar(p, SLSKD_UP_QUERY),
    readScalar(p, SLSKD_QUEUE_DEPTH_QUERY),
  ]);

  const speed = foldByLabel(speedSamples, 'job');
  const downloaded = foldByLabel(downloadedSamples, 'job');
  const remaining = foldByLabel(remainingSamples, 'job');
  const queue = foldByLabel(queueSamples, 'job');
  const up = foldByLabel(upSamples, 'job');

  const scalarOr = (m: Map<string, number>, k: string): number | null => m.get(k) ?? null;

  const usenet: SabLane[] = SAB_LANES.map((lane) => ({
    key: lane.key,
    label: lane.label,
    speedBps: scalarOr(speed, lane.key),
    downloaded24hBytes: scalarOr(downloaded, lane.key),
    remainingBytes: scalarOr(remaining, lane.key),
    queueLength: scalarOr(queue, lane.key),
    up: up.has(lane.key) ? up.get(lane.key)! >= 1 : null,
  }));

  const qbtOnline = upFlag(qbtUp);
  const slskdOnline = upFlag(slskdUp);
  const clients: ClientStatus[] = [
    {
      key: 'qbittorrent',
      label: 'qBittorrent',
      up: qbtOnline,
      detail:
        qbtOnline === false
          ? 'unreachable'
          : qbtTorrents === null
            ? qbtOnline === null
              ? 'unavailable'
              : 'online'
            : `${Math.round(qbtTorrents)} torrent${Math.round(qbtTorrents) === 1 ? '' : 's'}`,
    },
    {
      key: 'slskd',
      label: 'Soulseek (slskd)',
      up: slskdOnline,
      detail:
        slskdOnline === false
          ? 'unreachable'
          : slskdQueue === null
            ? slskdOnline === null
              ? 'unavailable'
              : 'online'
            : `queue depth ${Math.round(slskdQueue)}`,
    },
  ];

  const usenetAllNull = usenet.every(
    (l) =>
      l.speedBps === null &&
      l.downloaded24hBytes === null &&
      l.remainingBytes === null &&
      l.queueLength === null &&
      l.up === null,
  );
  const clientsAllNull = qbtOnline === null && slskdOnline === null;
  return { usenet, clients, unavailable: usenetAllNull && clientsAllNull };
}

async function getIndexersGroup(p: PrometheusReader): Promise<IndexersGroup> {
  const [enabled, unavailableCount, responseSamples, queryRateSamples] = await Promise.all([
    readScalar(p, PROWLARR_ENABLED_QUERY),
    readScalar(p, PROWLARR_UNAVAILABLE_QUERY),
    readVector(p, PROWLARR_RESPONSE_MS_QUERY),
    readVector(p, PROWLARR_QUERY_RATE_QUERY),
  ]);

  const response = foldByLabel(responseSamples, 'indexer');
  const queryRate = foldByLabel(queryRateSamples, 'indexer');
  const names = new Set<string>([...response.keys(), ...queryRate.keys()]);
  const rows: IndexerRow[] = Array.from(names)
    .sort((a, b) => a.localeCompare(b))
    .map((indexer) => ({
      indexer,
      avgResponseMs: response.get(indexer) ?? null,
      queriesPerHour: queryRate.get(indexer) ?? null,
    }));

  const unavailable = enabled === null && unavailableCount === null && rows.length === 0;
  return { enabled, unavailableCount, rows, unavailable };
}
