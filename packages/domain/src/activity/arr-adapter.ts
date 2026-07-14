// ADR-059 / DESIGN-030 D-08 (PLAN-048 — Activity / In-Flight) — the *ARR adapter (Radarr + Sonarr +
// Lidarr). The PURE normalizer `buildArrActivity` folds each instance's download `queue` (downloading %,
// import stage) + recent import `history` into ActivityItem[], filling the SAME contract as the books
// adapter with NO change to the card/tab/chips/detail. Universal walls: `section` is always null (movies/
// tv/music are ungated Library walls — D-01), `wall` is set so the wall-badge join works. The client
// wiring (constructing the *arr read clients) lives in the API / sync; this file is I/O-free so it is
// exhaustively unit-tested against fixtures (incl. the import_blocked / manual-import scenario).
import { ARR_CLUSTER_URL_DEFAULTS } from '@hnet/arr';
import type {
  LidarrHistoryRecord,
  LidarrQueueRecord,
  RadarrHistoryRecord,
  RadarrQueueRecord,
  SonarrHistoryRecord,
  SonarrQueueRecord,
} from '@hnet/arr';
import type { ActivityFailureKind, ActivityItem, ActivitySourceAdapter, ActivityStage } from './contract';

/** The *arr adapter's family name (the failure ledger `source` column — one family across all three). */
export const ARR_ACTIVITY_SOURCE = 'arr';

/** How recently an *arr import must have landed to still read as `completed` ("Just added"). */
export const DEFAULT_ARR_COMPLETED_HORIZON_MS = 15 * 60 * 1000; // 15 min

/** The three *arr instances the adapter reads, each a queue + a recent-history page. */
export interface ArrActivitySources {
  radarr: { queue: RadarrQueueRecord[]; history: RadarrHistoryRecord[] };
  sonarr: { queue: SonarrQueueRecord[]; history: SonarrHistoryRecord[] };
  lidarr: { queue: LidarrQueueRecord[]; history: LidarrHistoryRecord[] };
}

export interface ArrActivityOptions {
  now: Date;
  /** Completed-recent horizon override (tests pin it; default DEFAULT_ARR_COMPLETED_HORIZON_MS). */
  completedHorizonMs?: number;
  /** Per-instance base URLs for the Admin-only downstream deep link (null ⇒ no link). */
  baseUrls?: { radarr?: string | null; sonarr?: string | null; lidarr?: string | null };
}

type ArrKindName = 'radarr' | 'sonarr' | 'lidarr';

/** The (kind, wall, sourceApp) triple per *arr instance. */
const ARR_FACET: Record<
  ArrKindName,
  { kind: ActivityItem['kind']; wall: ActivityItem['wall']; sourceApp: ActivityItem['sourceApp'] }
> = {
  radarr: { kind: 'movie', wall: 'movies', sourceApp: 'radarr' },
  sonarr: { kind: 'tv', wall: 'tv', sourceApp: 'sonarr' },
  lidarr: { kind: 'music', wall: 'music', sourceApp: 'lidarr' },
};

/** The *arr history event types that mean "landed on disk" (the completed-recent signal). */
const IMPORTED_EVENT_TYPES: Record<ArrKindName, ReadonlySet<string>> = {
  radarr: new Set(['downloadFolderImported', 'movieFolderImported']),
  sonarr: new Set(['downloadFolderImported', 'seriesFolderImported']),
  lidarr: new Set(['trackFileImported', 'downloadImported', 'artistFolderImported']),
};

/** The shared queue-record fields the classifier reads (subset of queueRecordBaseSchema). */
interface ArrQueueLike {
  status: string;
  trackedDownloadStatus?: string | null;
  trackedDownloadState?: string | null;
  size?: number | null;
  sizeleft?: number | null;
  title?: string | null;
  errorMessage?: string | null;
  statusMessages?: ({ title?: string | null; messages?: string[] | null } | null)[] | null;
}

interface Classified {
  stage: ActivityStage;
  progress: number | null;
  failureKind: ActivityFailureKind | null;
  failureReason: string | null;
}

/** 0..100 download percent from size/sizeleft, or null when the *arr hasn't sized the release yet. */
function queueProgress(size: number | null | undefined, sizeleft: number | null | undefined): number | null {
  if (size == null || sizeleft == null || size <= 0) return null;
  const pct = ((size - sizeleft) / size) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** The human reason off a queue record: the errorMessage, else the first non-empty statusMessage. */
function queueReason(rec: ArrQueueLike): string | null {
  if (rec.errorMessage && rec.errorMessage.trim() !== '') return rec.errorMessage.trim();
  for (const m of rec.statusMessages ?? []) {
    if (!m) continue;
    const parts = [m.title, ...(m.messages ?? [])].filter(
      (p): p is string => typeof p === 'string' && p.trim() !== '',
    );
    if (parts.length > 0) return parts.join(' — ');
  }
  return null;
}

/**
 * The *arr queue stage machine (DESIGN-030 D-08, the *arr leg of ADR-059's stage vocabulary). Reads the
 * download-client `status` + the *arr `trackedDownloadState`/`trackedDownloadStatus`:
 *   • `importBlocked` / `importFailed`                          → failed / import_blocked (manual import)
 *   • `failed` / `failedPending` (or status `failed`)           → failed / download_failed (dead grab)
 *   • completed download the importer flagged (warning/error)   → failed / import_blocked
 *   • `importing` / `importPending` (or status `completed`)     → importing
 *   • `imported`                                                → completed (about to leave the queue)
 *   • anything else in the queue                                → downloading (progress = size/sizeleft)
 * Never fabricates a failure: a plain downloading/queued item is `downloading`, never `failed`.
 */
function classifyQueue(rec: ArrQueueLike): Classified {
  const state = (rec.trackedDownloadState ?? '').toLowerCase();
  const tstatus = (rec.trackedDownloadStatus ?? '').toLowerCase();
  const status = (rec.status ?? '').toLowerCase();
  const reason = queueReason(rec);

  if (state === 'importblocked' || state === 'importfailed') {
    return {
      stage: 'failed',
      progress: null,
      failureKind: 'import_blocked',
      failureReason:
        reason ?? 'The download completed but the importer could not place it — a manual import is needed.',
    };
  }
  if (state === 'failed' || state === 'failedpending' || status === 'failed') {
    return {
      stage: 'failed',
      progress: null,
      failureKind: 'download_failed',
      failureReason: reason ?? 'The download failed at the download client — there is nothing to import.',
    };
  }
  if (status === 'completed' && (tstatus === 'warning' || tstatus === 'error')) {
    return {
      stage: 'failed',
      progress: null,
      failureKind: 'import_blocked',
      failureReason: reason ?? 'The download completed but the importer reported a problem.',
    };
  }
  if (state === 'importing' || state === 'importpending' || status === 'completed') {
    return { stage: 'importing', progress: null, failureKind: null, failureReason: null };
  }
  if (state === 'imported') {
    return { stage: 'completed', progress: null, failureKind: null, failureReason: null };
  }
  return { stage: 'downloading', progress: queueProgress(rec.size, rec.sizeleft), failureKind: null, failureReason: null };
}

/** A stage/failure → the ADMIN action affordances (same rule as the books adapter). */
function actionsFor(stage: ActivityStage, failureKind: ActivityFailureKind | null): ActivityItem['actions'] {
  if (stage !== 'failed') return [];
  // A dead download can only be re-searched; a blocked import can be retried OR re-searched.
  return failureKind === 'download_failed' ? ['force_research'] : ['retry_import', 'force_research'];
}

function buildItem(input: {
  id: string;
  arrKind: ArrKindName;
  title: string;
  cls: Classified;
  updatedAt: string;
  baseUrl: string | null;
}): ActivityItem {
  const facet = ARR_FACET[input.arrKind];
  return {
    id: input.id,
    kind: facet.kind,
    section: null, // universal *arr walls — no section gate (D-01 / DESIGN-030 D-08)
    wall: facet.wall,
    title: input.title,
    year: null,
    sourceApp: facet.sourceApp,
    stage: input.cls.stage,
    progress: input.cls.progress,
    failureReason: input.cls.failureReason,
    failureKind: input.cls.failureKind,
    updatedAt: input.updatedAt,
    posterUrl: null, // the ActivityCard falls back to the KindIcon (no live poster proxy on the *arr leg)
    href: null, // the aggregator fills the failure-detail link once the ledger row id is known
    downstreamUrl: input.baseUrl,
    actions: actionsFor(input.cls.stage, input.cls.failureKind),
  };
}

/** Trim an *arr scene release name to something presentable (dots/underscores → spaces). */
function cleanArrTitle(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fold the three *arr queues + recent-history pages into normalized ActivityItems. Queue items carry the
 * live stage (downloading %, importing, or a failed/import_blocked strand); recent imports the queue no
 * longer holds surface as `completed` from history (deduped against the queue's parents). `id` encodes the
 * *arr kind + the wall parent and the search target (`arr:radarr:<movieId>`, `arr:sonarr:<seriesId>:<episodeId>`,
 * `arr:lidarr:<artistId>:<albumId>`) so the failure ledger, the wall-badge join, and the force-search
 * dispatch all read from the same stable ref. Pure — no I/O; safe to unit-test exhaustively.
 */
export function buildArrActivity(sources: ArrActivitySources, opts: ArrActivityOptions): ActivityItem[] {
  const nowIso = opts.now.toISOString();
  const nowMs = opts.now.getTime();
  const horizon = opts.completedHorizonMs ?? DEFAULT_ARR_COMPLETED_HORIZON_MS;
  const items: ActivityItem[] = [];
  const seenIds = new Set<string>();

  const push = (item: ActivityItem) => {
    if (seenIds.has(item.id)) return;
    seenIds.add(item.id);
    items.push(item);
  };

  // ---- queues (live in-flight stage) ----
  for (const rec of sources.radarr.queue) {
    if ((rec.trackedDownloadState ?? '').toLowerCase() === 'ignored') continue;
    if (rec.movieId == null) continue;
    push(
      buildItem({
        id: `${ARR_ACTIVITY_SOURCE}:radarr:${rec.movieId}`,
        arrKind: 'radarr',
        title: cleanArrTitle(rec.title) || `Movie ${rec.movieId}`,
        cls: classifyQueue(rec),
        updatedAt: nowIso,
        baseUrl: opts.baseUrls?.radarr ?? null,
      }),
    );
  }
  for (const rec of sources.sonarr.queue) {
    if ((rec.trackedDownloadState ?? '').toLowerCase() === 'ignored') continue;
    if (rec.seriesId == null) continue;
    const episode = rec.episodeId ?? 'x';
    push(
      buildItem({
        id: `${ARR_ACTIVITY_SOURCE}:sonarr:${rec.seriesId}:${episode}`,
        arrKind: 'sonarr',
        title: cleanArrTitle(rec.title) || `Series ${rec.seriesId}`,
        cls: classifyQueue(rec),
        updatedAt: nowIso,
        baseUrl: opts.baseUrls?.sonarr ?? null,
      }),
    );
  }
  for (const rec of sources.lidarr.queue) {
    if ((rec.trackedDownloadState ?? '').toLowerCase() === 'ignored') continue;
    if (rec.artistId == null) continue;
    const album = rec.albumId ?? 'x';
    push(
      buildItem({
        id: `${ARR_ACTIVITY_SOURCE}:lidarr:${rec.artistId}:${album}`,
        arrKind: 'lidarr',
        title: cleanArrTitle(rec.title) || `Artist ${rec.artistId}`,
        cls: classifyQueue(rec),
        updatedAt: nowIso,
        baseUrl: opts.baseUrls?.lidarr ?? null,
      }),
    );
  }

  // ---- history (completed-recent: an import the queue no longer holds, within the horizon) ----
  const completedCls: Classified = { stage: 'completed', progress: null, failureKind: null, failureReason: null };
  const isFresh = (date: string): boolean => {
    const t = Date.parse(date);
    return Number.isFinite(t) && nowMs - t <= horizon && nowMs - t >= 0;
  };
  for (const rec of sources.radarr.history) {
    if (!IMPORTED_EVENT_TYPES.radarr.has(rec.eventType) || !isFresh(rec.date)) continue;
    push(
      buildItem({
        id: `${ARR_ACTIVITY_SOURCE}:radarr:${rec.movieId}`,
        arrKind: 'radarr',
        title: cleanArrTitle(rec.sourceTitle) || `Movie ${rec.movieId}`,
        cls: completedCls,
        updatedAt: rec.date,
        baseUrl: opts.baseUrls?.radarr ?? null,
      }),
    );
  }
  for (const rec of sources.sonarr.history) {
    if (!IMPORTED_EVENT_TYPES.sonarr.has(rec.eventType) || !isFresh(rec.date)) continue;
    push(
      buildItem({
        id: `${ARR_ACTIVITY_SOURCE}:sonarr:${rec.seriesId}:${rec.episodeId}`,
        arrKind: 'sonarr',
        title: cleanArrTitle(rec.sourceTitle) || `Series ${rec.seriesId}`,
        cls: completedCls,
        updatedAt: rec.date,
        baseUrl: opts.baseUrls?.sonarr ?? null,
      }),
    );
  }
  for (const rec of sources.lidarr.history) {
    if (!IMPORTED_EVENT_TYPES.lidarr.has(rec.eventType) || !isFresh(rec.date)) continue;
    push(
      buildItem({
        id: `${ARR_ACTIVITY_SOURCE}:lidarr:${rec.artistId}:${rec.albumId}`,
        arrKind: 'lidarr',
        title: cleanArrTitle(rec.sourceTitle) || `Artist ${rec.artistId}`,
        cls: completedCls,
        updatedAt: rec.date,
        baseUrl: opts.baseUrls?.lidarr ?? null,
      }),
    );
  }

  // Newest first (recency) — failures naturally surface via the loud chip default.
  items.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0));
  return items;
}

// ---------------------------------------------------------------------------
// The parsed *arr ref — the wall-badge join key + the retry/force-search dispatch target.
// ---------------------------------------------------------------------------

export interface ParsedArrRef {
  arrKind: ArrKindName;
  /** The wall parent (movieId / seriesId / artistId) — the wall-badge join key. */
  parentId: number;
  /** The search target child (episodeId / albumId); null for radarr (the movie IS the target). */
  targetId: number | null;
}

/**
 * Parse an *arr activity ref (`arr:<kind>:<parentId>[:<targetId|x>]`) → the dispatch target. Radarr refs
 * carry only the movie (`arr:radarr:601`); Sonarr/Lidarr add the episode/album target
 * (`arr:sonarr:501:50110` / `arr:lidarr:701:7011`, or `:x` when the queue item had no child). Returns null
 * for a non-*arr ref (e.g. a books ref).
 */
export function parseArrActivityRef(ref: string): ParsedArrRef | null {
  const m = /^arr:(radarr|sonarr|lidarr):(\d+)(?::(\d+|x))?$/.exec(ref);
  if (!m) return null;
  const target = m[3];
  return {
    arrKind: m[1] as ArrKindName,
    parentId: Number(m[2]),
    targetId: target && target !== 'x' ? Number(target) : null,
  };
}

// ---------------------------------------------------------------------------
// The live adapter (the fan-out seam) — reads each *arr's queue + recent history and folds them.
// ---------------------------------------------------------------------------

/** The read surface the *arr adapter needs (tests inject fetch-stubbed clients). */
export interface ArrActivityReadClients {
  radarr: {
    getQueue(movieId?: number): Promise<RadarrQueueRecord[]>;
    getHistory(params?: { pageSize?: number }): Promise<{ records: RadarrHistoryRecord[] }>;
  };
  sonarr: {
    getQueue(seriesId?: number): Promise<SonarrQueueRecord[]>;
    getHistory(params?: { pageSize?: number }): Promise<{ records: SonarrHistoryRecord[] }>;
  };
  lidarr: {
    getQueue(artistId?: number): Promise<LidarrQueueRecord[]>;
    getHistory(params?: { pageSize?: number }): Promise<{ records: LidarrHistoryRecord[] }>;
  };
}

export interface ArrActivityAdapterOptions {
  baseUrls?: { radarr?: string | null; sonarr?: string | null; lidarr?: string | null };
  completedHorizonMs?: number;
  /** Recent-history page size (bounded — one small page per *arr; default 30). */
  historyPageSize?: number;
  now?: () => Date;
}

/** Resolve the per-instance base URLs (non-secret config) for the Admin-only downstream deep link. */
export function resolveArrBaseUrls(env: Record<string, string | undefined> = process.env): {
  radarr: string;
  sonarr: string;
  lidarr: string;
} {
  return {
    radarr: env.RADARR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.radarr,
    sonarr: env.SONARR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.sonarr,
    lidarr: env.LIDARR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.lidarr,
  };
}

/**
 * Build the *arr ActivitySourceAdapter — its `list()` reads each instance's whole download queue + a small
 * recent-history page LIVE (six bounded calls) and folds them through the pure normalizer. A read failure
 * propagates so the aggregator can degrade the *arr source without failing the whole read (a Radarr outage
 * never blanks the books items).
 */
export function buildArrActivityAdapter(
  clients: ArrActivityReadClients,
  opts: ArrActivityAdapterOptions = {},
): ActivitySourceAdapter {
  const historyPageSize = opts.historyPageSize ?? 30;
  return {
    source: ARR_ACTIVITY_SOURCE,
    async list() {
      const [radarrQueue, radarrHistory, sonarrQueue, sonarrHistory, lidarrQueue, lidarrHistory] =
        await Promise.all([
          clients.radarr.getQueue(),
          clients.radarr.getHistory({ pageSize: historyPageSize }),
          clients.sonarr.getQueue(),
          clients.sonarr.getHistory({ pageSize: historyPageSize }),
          clients.lidarr.getQueue(),
          clients.lidarr.getHistory({ pageSize: historyPageSize }),
        ]);
      return buildArrActivity(
        {
          radarr: { queue: radarrQueue, history: radarrHistory.records },
          sonarr: { queue: sonarrQueue, history: sonarrHistory.records },
          lidarr: { queue: lidarrQueue, history: lidarrHistory.records },
        },
        {
          now: (opts.now ?? (() => new Date()))(),
          ...(opts.completedHorizonMs !== undefined ? { completedHorizonMs: opts.completedHorizonMs } : {}),
          ...(opts.baseUrls ? { baseUrls: opts.baseUrls } : {}),
        },
      );
    },
  };
}
