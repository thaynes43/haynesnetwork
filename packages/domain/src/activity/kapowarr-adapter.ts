// ADR-059 / DESIGN-030 D-08 (PLAN-048 — Activity / In-Flight) — the KAPOWARR (comics) adapter. The PURE
// normalizer `buildKapowarrActivity` folds Kapowarr's live download `queue`, its running search `tasks`, and
// its completed-download `history` into ActivityItem[], filling the SAME contract as the books + *arr
// adapters with NO change to the card/tab/chips/detail. Comics ride the BOOKS section gate today (DESIGN-030
// D-01 — the comic wall sits under the books section), so every item is `section: 'books'` (NOT a new union
// value) with `kind: 'comic'` / `wall: 'comics'`. The client wiring (constructing the read client) lives in
// the API / sync; this file is I/O-free so it is exhaustively unit-tested against fixtures (incl. a failed
// download). Kapowarr acquires from ITS OWN sources (GetComics DDL) — this adapter NEVER touches MAM/qB/
// Prowlarr/the governor; it is READ-ONLY (the force-search action reuses the PLAN-046 confined write surface).
import { KAPOWARR_CLUSTER_URL_DEFAULT } from '@hnet/kapowarr';
import type {
  KapowarrHistoryEntry,
  KapowarrQueueEntry,
  KapowarrTask,
  KapowarrVolume,
} from '@hnet/kapowarr/read';
import type { ActivityFailureKind, ActivityItem, ActivitySourceAdapter, ActivityStage } from './contract';

/** The Kapowarr adapter's family name (the failure ledger `source` column). */
export const KAPOWARR_ACTIVITY_SOURCE = 'kapowarr';

/** How recently a Kapowarr download must have landed to still read as `completed` ("Just added"). */
export const DEFAULT_KAPOWARR_COMPLETED_HORIZON_MS = 15 * 60 * 1000; // 15 min (mirrors the *arr horizon)

/** The four Kapowarr reads the adapter folds (queue live; tasks for `searching`; history for `completed`). */
export interface KapowarrActivitySources {
  /** `GET /api/activity/queue` — the live downloads. */
  queue: KapowarrQueueEntry[];
  /** `GET /api/system/tasks` — the running/planned background tasks (search-shaped ones ⇒ `searching`). */
  tasks: KapowarrTask[];
  /** `GET /api/activity/history` — the completed-download log (recent ones ⇒ `completed`). */
  history: KapowarrHistoryEntry[];
  /** `GET /api/volumes` — the added volumes; only monitored+wanted ones with an active search task search. */
  volumes: KapowarrVolume[];
}

export interface KapowarrActivityOptions {
  now: Date;
  /** Completed-recent horizon override (tests pin it; default DEFAULT_KAPOWARR_COMPLETED_HORIZON_MS). */
  completedHorizonMs?: number;
  /** Kapowarr base URL for the Admin-only downstream deep link (null ⇒ no link). */
  baseUrl?: string | null;
}

interface Classified {
  stage: ActivityStage;
  progress: number | null;
  failureKind: ActivityFailureKind | null;
  failureReason: string | null;
}

/** Higher wins when two queue entries share a volume (a failed issue must surface over a downloading one). */
const STAGE_SEVERITY: Record<ActivityStage, number> = {
  failed: 4,
  importing: 3,
  downloading: 2,
  searching: 1,
  completed: 0,
};

/** True when a task is a search-shaped one (Kapowarr's `auto_search` / `search_all` both match). */
function isSearchTask(t: KapowarrTask): boolean {
  return (t.action ?? '').toLowerCase().includes('search');
}

/** 0..100 rounded download percent from Kapowarr's queue `progress` float, or null when absent. */
function queueProgress(progress: number | null): number | null {
  if (progress == null || !Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

/**
 * The Kapowarr queue stage machine (the Kapowarr leg of ADR-059's stage vocabulary). Kapowarr's own
 * `DownloadState`:
 *   • `failed`                              → failed / download_failed (the ONLY failure class Kapowarr
 *                                             distinguishes — it has no *arr-style manual-import queue, so
 *                                             `import_blocked` is NOT detectable here; documented honestly)
 *   • `importing`                           → importing (post-download move into the library)
 *   • `queued`/`paused`/`downloading`/`seeding` → downloading (progress = queue `progress`)
 *   • `canceled`/`shutdown`                 → SKIPPED (user/app-stopped, not a stuck failure — never fabricate)
 * Never fabricates a failure: a plain downloading/queued item is `downloading`, never `failed`.
 */
function classifyQueue(rec: KapowarrQueueEntry): Classified | null {
  const status = rec.status;
  if (status === 'failed') {
    return {
      stage: 'failed',
      progress: null,
      failureKind: 'download_failed',
      failureReason:
        'The comic download failed at Kapowarr (dead GetComics source) — nothing to import. Re-search for a new source.',
    };
  }
  if (status === 'canceled' || status === 'shutdown') return null; // not a stuck failure — skip
  if (status === 'importing') {
    return { stage: 'importing', progress: null, failureKind: null, failureReason: null };
  }
  if (
    status === 'queued' ||
    status === 'paused' ||
    status === 'downloading' ||
    status === 'seeding'
  ) {
    return { stage: 'downloading', progress: queueProgress(rec.progress), failureKind: null, failureReason: null };
  }
  return null; // unknown/empty state — not an activity item
}

/** A stage/failure → the ADMIN action affordances. Comics only ever fail as `download_failed` (see above),
 *  so the only action is a fresh re-search — Kapowarr exposes no retry-import surface (honest: never faked). */
function actionsFor(stage: ActivityStage, failureKind: ActivityFailureKind | null): ActivityItem['actions'] {
  if (stage !== 'failed') return [];
  return failureKind === 'import_blocked' ? ['retry_import', 'force_research'] : ['force_research'];
}

/** Trim a Kapowarr web/scene title to something presentable (dots/underscores → spaces). */
function cleanKapowarrTitle(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildItem(input: {
  volumeId: number;
  title: string;
  cls: Classified;
  updatedAt: string;
  baseUrl: string | null;
}): ActivityItem {
  return {
    id: `${KAPOWARR_ACTIVITY_SOURCE}:${input.volumeId}`,
    kind: 'comic',
    // Comics ride the BOOKS section gate today (DESIGN-030 D-01 — the comic wall is under books). This is a
    // deliberate reuse of the existing `'books'` section value, NOT a widening of the contract union.
    section: 'books',
    wall: 'comics',
    title: input.title,
    year: null,
    sourceApp: 'kapowarr',
    stage: input.cls.stage,
    progress: input.cls.progress,
    failureReason: input.cls.failureReason,
    failureKind: input.cls.failureKind,
    updatedAt: input.updatedAt,
    posterUrl: null, // the ActivityCard falls back to the KindIcon (no live comic poster proxy on this leg)
    href: null, // the aggregator fills the failure-detail link once the ledger row id is known
    downstreamUrl: input.baseUrl,
    actions: actionsFor(input.cls.stage, input.cls.failureKind),
  };
}

/**
 * Fold Kapowarr's live queue + running search tasks + completed history into normalized ActivityItems, keyed
 * per VOLUME (`kapowarr:<volumeId>` — the same id the comics wall posters carry). Precedence per volume:
 * a live queue entry (failed/importing/downloading; a failed issue wins over a downloading one) beats a
 * `completed`-recent history landing, which beats a `searching` monitored-wanted volume. Pure — no I/O; safe
 * to unit-test exhaustively (incl. the failed-download strand). `href` is left null (the aggregator fills it).
 */
export function buildKapowarrActivity(
  sources: KapowarrActivitySources,
  opts: KapowarrActivityOptions,
): ActivityItem[] {
  const nowIso = opts.now.toISOString();
  const nowMs = opts.now.getTime();
  const horizon = opts.completedHorizonMs ?? DEFAULT_KAPOWARR_COMPLETED_HORIZON_MS;
  const baseUrl = opts.baseUrl ?? null;
  const volumeById = new Map(sources.volumes.map((v) => [v.id, v]));

  const titleFor = (volumeId: number, fallback: string | null): string =>
    cleanKapowarrTitle(volumeById.get(volumeId)?.title ?? fallback) || `Comic ${volumeId}`;

  // ---- queues (live in-flight stage) — most-severe entry wins per volume ----
  const queueByVolume = new Map<number, { cls: Classified; title: string }>();
  for (const rec of sources.queue) {
    if (rec.volumeId == null) continue;
    const cls = classifyQueue(rec);
    if (cls === null) continue;
    const existing = queueByVolume.get(rec.volumeId);
    if (existing && STAGE_SEVERITY[existing.cls.stage] >= STAGE_SEVERITY[cls.stage]) continue;
    queueByVolume.set(rec.volumeId, { cls, title: titleFor(rec.volumeId, rec.title) });
  }

  const items: ActivityItem[] = [];
  const seen = new Set<number>();
  for (const [volumeId, { cls, title }] of queueByVolume) {
    seen.add(volumeId);
    items.push(buildItem({ volumeId, title, cls, updatedAt: nowIso, baseUrl }));
  }

  // ---- history (completed-recent: a download the queue no longer holds, within the horizon) ----
  const completedCls: Classified = { stage: 'completed', progress: null, failureKind: null, failureReason: null };
  for (const rec of sources.history) {
    if (rec.volumeId == null || seen.has(rec.volumeId)) continue;
    if (!rec.success) continue;
    if (rec.downloadedAtMs == null) continue;
    const age = nowMs - rec.downloadedAtMs;
    if (age < 0 || age > horizon) continue;
    seen.add(rec.volumeId);
    items.push(
      buildItem({
        volumeId: rec.volumeId,
        title: titleFor(rec.volumeId, rec.title),
        cls: completedCls,
        updatedAt: new Date(rec.downloadedAtMs).toISOString(),
        baseUrl,
      }),
    );
  }

  // ---- searching (monitored + wanted volumes with an ACTIVE search task — only claim what the API shows) ----
  const searchTaskVolumeIds = new Set<number>();
  let globalSearchActive = false;
  for (const t of sources.tasks) {
    if (!isSearchTask(t)) continue;
    if (t.volumeId == null) globalSearchActive = true;
    else searchTaskVolumeIds.add(t.volumeId);
  }
  if (globalSearchActive || searchTaskVolumeIds.size > 0) {
    const searchingCls: Classified = { stage: 'searching', progress: null, failureKind: null, failureReason: null };
    for (const vol of sources.volumes) {
      if (seen.has(vol.id)) continue;
      const wanted = vol.monitored && vol.issuesDownloaded < vol.issueCount;
      if (!wanted) continue;
      if (!globalSearchActive && !searchTaskVolumeIds.has(vol.id)) continue;
      seen.add(vol.id);
      items.push(
        buildItem({
          volumeId: vol.id,
          title: titleFor(vol.id, vol.title),
          cls: searchingCls,
          updatedAt: nowIso,
          baseUrl,
        }),
      );
    }
  }

  // Newest first (recency) — failures naturally surface via the loud chip default.
  items.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0));
  return items;
}

// ---------------------------------------------------------------------------
// The parsed Kapowarr ref — the wall-badge join key + the force-search dispatch target.
// ---------------------------------------------------------------------------

export interface ParsedKapowarrRef {
  /** The added volume id — the comics-wall join key AND the confined `searchVolume` dispatch target. */
  volumeId: number;
}

/**
 * Parse a Kapowarr activity ref (`kapowarr:<volumeId>`) → the dispatch target. Returns null for a non-Kapowarr
 * ref (an *arr or books ref). The volume id is both the comics-wall poster join key and the exact target the
 * force-search fires the confined `searchVolume` (auto_search) against.
 */
export function parseKapowarrActivityRef(ref: string): ParsedKapowarrRef | null {
  const m = /^kapowarr:(\d+)$/.exec(ref);
  if (!m) return null;
  return { volumeId: Number(m[1]) };
}

// ---------------------------------------------------------------------------
// The live adapter (the fan-out seam) — reads Kapowarr's queue + tasks + (conditionally) volumes/history.
// ---------------------------------------------------------------------------

/** The read surface the Kapowarr adapter needs (tests inject a fetch-stubbed client; the concrete
 *  KapowarrReadClient satisfies it). */
export interface KapowarrActivityReadClient {
  getQueue(): Promise<KapowarrQueueEntry[]>;
  getDownloadHistory(): Promise<KapowarrHistoryEntry[]>;
  getTasks(): Promise<KapowarrTask[]>;
  listVolumes(): Promise<KapowarrVolume[]>;
}

export interface KapowarrActivityAdapterOptions {
  baseUrl?: string | null;
  completedHorizonMs?: number;
  now?: () => Date;
}

/** Resolve the Kapowarr base URL (non-secret config) for the Admin-only downstream deep link. */
export function resolveKapowarrBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.KAPOWARR_URL?.trim() || KAPOWARR_CLUSTER_URL_DEFAULT;
}

/**
 * Build the Kapowarr ActivitySourceAdapter — its `list()` reads the live queue, the running tasks, and the
 * recent history, and (only when a search task is running) the added-volume list, then folds them through the
 * pure normalizer. A read failure propagates so the aggregator can degrade the Kapowarr source without
 * failing the whole read (a Kapowarr outage never blanks the books or *arr items).
 */
export function buildKapowarrActivityAdapter(
  client: KapowarrActivityReadClient,
  opts: KapowarrActivityAdapterOptions = {},
): ActivitySourceAdapter {
  return {
    source: KAPOWARR_ACTIVITY_SOURCE,
    async list() {
      const [queue, history, tasks] = await Promise.all([
        client.getQueue(),
        client.getDownloadHistory(),
        client.getTasks(),
      ]);
      // Only page the volume list when a search task is actually running — otherwise there is no `searching`
      // stage to compute, and the queue/history titles suffice (bounded: 3 calls, or 4 when searching).
      const volumes = tasks.some(isSearchTask) ? await client.listVolumes() : [];
      return buildKapowarrActivity(
        { queue, history, tasks, volumes },
        {
          now: (opts.now ?? (() => new Date()))(),
          ...(opts.completedHorizonMs !== undefined ? { completedHorizonMs: opts.completedHorizonMs } : {}),
          ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        },
      );
    },
  };
}
