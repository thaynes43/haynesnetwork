// ADR-083 / DESIGN-046 (PLAN-065 — *arr queue janitor). The classifier (pure, versioned patterns — D-03),
// the single-writer evaluator (census rows ALWAYS; enforce actions only where the class×instance cell is
// switched to `enforce`, behind the safety rails — D-04), the DB-backed audited config (D-05), the confined
// *arr client bundle (built INSIDE this package so @hnet/arr/write stays domain-only — the arr-write import
// guard), the /admin status read + promotion-ladder derivation (D-08), and the nightly digest section (D-07).
//
// The *arrs are the source of truth (hard rule 4, amended by ADR-083 C-04): the janitor only removes FAILED
// TRANSFER STATE (a stuck queue item + a blocklist entry), never library files. Its whole trail is the
// append-only arr_queue_cleanup_actions table (D-06) — no permission_audit / ledger_events coupling (the
// mam_gate_state / smart_drive_state derived-operational-state class). Ships ALL-CENSUS (T-238, observe-only);
// enforcement arrives through the Promotion Ladder (T-240) as audited config flips, not releases.
import {
  ARR_KINDS,
  QUEUE_CLEANUP_MODES,
  appSettings,
  arrQueueCleanupActions,
  permissionAudit,
  type ArrKind,
  type ArrQueueCleanupActionInsert,
  type DbClient,
  type QueueCleanupAction,
  type QueueCleanupActionClass,
  type QueueCleanupMode,
  type QueueCleanupOutcome,
} from '@hnet/db';
import { LidarrClient, RadarrClient, SonarrClient } from '@hnet/arr/read';
import { LidarrWriteClient, RadarrWriteClient, SonarrWriteClient } from '@hnet/arr/write';
import {
  ARR_CLUSTER_URL_DEFAULTS,
  ArrConfigError,
  type LidarrQueueRecord,
  type RadarrQueueRecord,
  type SonarrQueueRecord,
} from '@hnet/arr';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { setAppSetting } from './app-settings';
import { resolveDb } from './db-client';
import { QueueCleanupConfigInvalidError } from './errors';

// ---------------------------------------------------------------------------
// Classifier (D-03) — pure, exhaustively tested; patterns in versioned code.
// ---------------------------------------------------------------------------

/** The minimal queue-record shape the classifier reads (SonarrQueueRecord/… all satisfy it structurally). */
export interface ClassifiableQueueItem {
  status?: string | null;
  trackedDownloadStatus?: string | null;
  trackedDownloadState?: string | null;
  errorMessage?: string | null;
  statusMessages?: Array<{ title?: string | null; messages?: (string | null)[] | null }> | null;
}

export interface QueueCleanupClassification {
  class: QueueCleanupActionClass;
  /** The statusMessage that drove the class (≤500 chars), or the first message for the unknown fallback. */
  reason: string | null;
  confidence: 'high' | 'low';
}

/** The *arr's own already-satisfied rejections (D-03 have_better) — the *arr already compared against the
 *  library; the janitor trusts its verdict rather than re-deriving (the *arrs are the source of truth). */
const HAVE_BETTER_PATTERNS = [
  /not an upgrade for existing/i,
  /not a custom format upgrade/i,
  /cutoff has already been met/i,
  /cutoff.*already.*met/i,
];

/** Release-defect signals (D-03 bad_release). */
const BAD_RELEASE_PATTERNS = [
  /unable to parse/i,
  /\bsample\b/i,
  /\barchive\b/i,
  /password/i,
  /executable/i,
];

/** The empty/transient set the stuck-import class ProcessMonitoredDownloads exists for (D-03 retry_import). */
const RETRY_TRANSIENT_PATTERNS = [/waiting to import/i];

const truncate = (s: string): string => (s.length > 500 ? s.slice(0, 500) : s);

/** Flatten a queue record's errorMessage + every statusMessage title/message into a plain string list. */
function collectMessages(item: ClassifiableQueueItem): string[] {
  const out: string[] = [];
  if (typeof item.errorMessage === 'string' && item.errorMessage.trim() !== '') {
    out.push(item.errorMessage.trim());
  }
  for (const sm of item.statusMessages ?? []) {
    if (sm == null) continue;
    if (typeof sm.title === 'string' && sm.title.trim() !== '') out.push(sm.title.trim());
    for (const m of sm.messages ?? []) {
      if (typeof m === 'string' && m.trim() !== '') out.push(m.trim());
    }
  }
  return out;
}

/**
 * Classify one queue item into exactly one Action Class (D-03, FIRST-MATCH order: have_better → bad_release →
 * retry_import → unknown). Pure. Lidarr's match-ambiguity messages ("…not close enough…", manual-import
 * prompts) deliberately fall to `unknown` initially (Q-01) — census evidence graduates specific patterns later.
 */
export function classifyQueueItem(item: ClassifiableQueueItem): QueueCleanupClassification {
  const messages = collectMessages(item);
  const state = (item.trackedDownloadState ?? '').toLowerCase();
  const status = (item.status ?? '').toLowerCase();
  const trackedStatus = (item.trackedDownloadStatus ?? '').toLowerCase();
  const isImportStuck = state === 'importblocked' || state === 'importpending';
  const firstMessage = messages[0] ?? null;
  const matchIn = (patterns: RegExp[]): string | null =>
    messages.find((m) => patterns.some((p) => p.test(m))) ?? null;

  // 1. have_better — import blocked/pending + an already-satisfied rejection.
  if (isImportStuck) {
    const hb = matchIn(HAVE_BETTER_PATTERNS);
    if (hb) return { class: 'have_better', reason: truncate(hb), confidence: 'high' };
  }

  // 2. bad_release — errored transfer, a failed download, or a release-defect message.
  const badMsg = matchIn(BAD_RELEASE_PATTERNS);
  if (trackedStatus === 'error' || status === 'failed' || state === 'failed' || badMsg) {
    const r = badMsg ?? firstMessage;
    return { class: 'bad_release', reason: r ? truncate(r) : null, confidence: 'high' };
  }

  // 3. retry_import — a stuck import with an empty/transient message set.
  if (isImportStuck) {
    const transient = matchIn(RETRY_TRANSIENT_PATTERNS);
    if (transient || messages.length === 0) {
      return { class: 'retry_import', reason: transient ? truncate(transient) : null, confidence: 'high' };
    }
  }

  // 4. unknown — everything else (incl. Lidarr match-ambiguity, Q-01). Reported, never acted on.
  return { class: 'unknown', reason: firstMessage ? truncate(firstMessage) : null, confidence: 'low' };
}

// ---------------------------------------------------------------------------
// Config (D-05) — the audited app_settings key `arr_queue_cleanup_config`.
// ---------------------------------------------------------------------------

/** The classes that HAVE an enforce cell (unknown never does — ADR-083 normative). */
export const QUEUE_CLEANUP_ENFORCEABLE_CLASSES = ['have_better', 'retry_import', 'bad_release'] as const;
export type QueueCleanupEnforceableClass = (typeof QUEUE_CLEANUP_ENFORCEABLE_CLASSES)[number];

/** The 3 mode cells for one instance (class → 'census'|'enforce'). */
export type QueueCleanupModeCells = Record<QueueCleanupEnforceableClass, QueueCleanupMode>;

export interface ArrQueueCleanupConfig {
  /** T-240 cells: per instance × enforceable class. */
  modes: Record<ArrKind, QueueCleanupModeCells>;
  /** Per-instance per-run mutation cap (1..100). */
  maxActionsPerRun: number;
  /** Minimum item age before any action (0..168 hours) — the organic-import window. */
  minItemAgeHours: number;
  /** Consecutive retry_import runs before an item escalates to bad_release handling (1..48). */
  retryEscalateRuns: number;
}

function allCensusCells(): QueueCleanupModeCells {
  return { have_better: 'census', retry_import: 'census', bad_release: 'census' };
}

/** The code default — ALL-CENSUS (observe-only), caps 10 / 2h / 6-run (DESIGN-046 D-05). */
export const ARR_QUEUE_CLEANUP_CONFIG_DEFAULT: ArrQueueCleanupConfig = {
  modes: { sonarr: allCensusCells(), radarr: allCensusCells(), lidarr: allCensusCells() },
  maxActionsPerRun: 10,
  minItemAgeHours: 2,
  retryEscalateRuns: 6,
};

/**
 * ADR-083 C-04 analog — validate a janitor config. Returns a human-readable message for the FIRST violated
 * invariant, or null when valid. Enforced at BOTH the API zod edge and the domain writer (defense in depth):
 * unknown instance/class keys, a non-'census'/'enforce' mode, or a knob out of range (caps 1..100, age 0..168,
 * escalate 1..48) can never be stored.
 */
export function queueCleanupConfigError(cfg: unknown): string | null {
  if (typeof cfg !== 'object' || cfg === null) return 'Config must be an object.';
  const c = cfg as Record<string, unknown>;
  const modes = c.modes;
  if (typeof modes !== 'object' || modes === null) return 'modes must be an object.';
  const m = modes as Record<string, unknown>;
  const allowedInstances = new Set<string>(ARR_KINDS);
  for (const key of Object.keys(m)) {
    if (!allowedInstances.has(key)) return `Unknown instance '${key}' in modes.`;
  }
  const allowedClasses = new Set<string>(QUEUE_CLEANUP_ENFORCEABLE_CLASSES);
  const allowedModes = new Set<string>(QUEUE_CLEANUP_MODES);
  for (const instance of ARR_KINDS) {
    const cell = m[instance];
    if (typeof cell !== 'object' || cell === null) return `modes.${instance} must be an object.`;
    const cc = cell as Record<string, unknown>;
    for (const key of Object.keys(cc)) {
      if (!allowedClasses.has(key)) return `Unknown class '${key}' in modes.${instance}.`;
    }
    for (const klass of QUEUE_CLEANUP_ENFORCEABLE_CLASSES) {
      if (!allowedModes.has(cc[klass] as string)) {
        return `modes.${instance}.${klass} must be 'census' or 'enforce'.`;
      }
    }
  }
  const cap = c.maxActionsPerRun;
  if (!Number.isInteger(cap) || (cap as number) < 1 || (cap as number) > 100) {
    return 'maxActionsPerRun must be a whole number 1..100.';
  }
  const age = c.minItemAgeHours;
  if (!Number.isInteger(age) || (age as number) < 0 || (age as number) > 168) {
    return 'minItemAgeHours must be a whole number 0..168.';
  }
  const esc = c.retryEscalateRuns;
  if (!Number.isInteger(esc) || (esc as number) < 1 || (esc as number) > 48) {
    return 'retryEscalateRuns must be a whole number 1..48.';
  }
  return null;
}

/** Build a canonical, storable value from a validated config (drops any stray keys). */
function toStorable(config: ArrQueueCleanupConfig) {
  const cell = (c: QueueCleanupModeCells) => ({
    have_better: c.have_better,
    retry_import: c.retry_import,
    bad_release: c.bad_release,
  });
  return {
    modes: {
      sonarr: cell(config.modes.sonarr),
      radarr: cell(config.modes.radarr),
      lidarr: cell(config.modes.lidarr),
    },
    maxActionsPerRun: config.maxActionsPerRun,
    minItemAgeHours: config.minItemAgeHours,
    retryEscalateRuns: config.retryEscalateRuns,
  };
}

/**
 * Read the stored janitor config, or null when no row exists OR a stored row fails validation (a hand-edit).
 * A garbage row reads as null so `resolveArrQueueCleanupConfig` falls back to ALL-CENSUS (fail-safe: a
 * malformed cell can never accidentally enforce).
 */
export async function getArrQueueCleanupConfig(db?: DbClient): Promise<ArrQueueCleanupConfig | null> {
  const [row] = await resolveDb(db)
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, 'arr_queue_cleanup_config'));
  if (!row) return null;
  if (queueCleanupConfigError(row.value) !== null) return null;
  return row.value as ArrQueueCleanupConfig;
}

/** Resolution DB row → code default (all-census). The evaluator + status read call this each run. */
export async function resolveArrQueueCleanupConfig(db?: DbClient): Promise<ArrQueueCleanupConfig> {
  return (await getArrQueueCleanupConfig(db)) ?? ARR_QUEUE_CLEANUP_CONFIG_DEFAULT;
}

/**
 * The single writer for the janitor config: VALIDATE the invariants (throwing QueueCleanupConfigInvalidError
 * so a bad config is unstorable), then upsert via the audited setAppSetting single-writer (an
 * `update_app_setting` permission_audit row in the SAME transaction — hard rule 6).
 */
export async function setArrQueueCleanupConfig(input: {
  db?: DbClient;
  config: ArrQueueCleanupConfig;
  actorId: string | null;
}): Promise<{ changed: boolean }> {
  const message = queueCleanupConfigError(input.config);
  if (message !== null) throw new QueueCleanupConfigInvalidError(message);
  const res = await setAppSetting({
    db: input.db,
    key: 'arr_queue_cleanup_config',
    value: toStorable(input.config),
    actorId: input.actorId,
  });
  return { changed: res.changed };
}

// ---------------------------------------------------------------------------
// Client bundle (D-04 write confinement) — built INSIDE @hnet/domain, injected opaque.
// ---------------------------------------------------------------------------

/** The normalized queue item the evaluator + real client operate on. */
export interface QueueCleanupQueueItem {
  queueItemId: number;
  downloadId: string | null;
  title: string | null;
  addedAt: Date | null;
  status: string | null;
  trackedDownloadStatus: string | null;
  trackedDownloadState: string | null;
  errorMessage: string | null;
  statusMessages: Array<{ title?: string | null; messages?: (string | null)[] | null }> | null;
}

/** The per-instance surface the evaluator drives. Tests inject a stub; prod wires the real *arr clients. */
export interface QueueCleanupInstanceClient {
  /** The WHOLE instance queue (paged read; read-only). */
  getQueueAll(): Promise<QueueCleanupQueueItem[]>;
  /** DELETE /queue/{id}?removeFromClient=&blocklist= — remove the stuck grab + blocklist the release. */
  deleteQueueItem(
    item: QueueCleanupQueueItem,
    opts: { removeFromClient: boolean; blocklist: boolean },
  ): Promise<void>;
  /** POST /command ProcessMonitoredDownloads — estate-wide (at most once per instance per run). */
  processMonitoredDownloads(): Promise<void>;
  /** Whether the item's re-search target is still monitored (re-search only where genuinely wanted). */
  isTargetMonitored(item: QueueCleanupQueueItem): Promise<boolean>;
  /** Trigger the owning *arr's search command for the item's target. */
  searchTarget(item: QueueCleanupQueueItem): Promise<void>;
}

export type QueueCleanupClients = Record<ArrKind, QueueCleanupInstanceClient>;

interface QueueTargetIds {
  parentId: number | null;
  childId: number | null;
}

/** Map a raw Sonarr/Radarr/Lidarr queue record to the normalized item (parent/child kept internal below). */
function normalizeItem(raw: {
  id: number;
  downloadId?: string | null;
  title?: string | null;
  added?: string | null;
  status?: string | null;
  trackedDownloadStatus?: string | null;
  trackedDownloadState?: string | null;
  errorMessage?: string | null;
  statusMessages?: Array<{ title?: string | null; messages?: (string | null)[] | null }> | null;
}): QueueCleanupQueueItem {
  const added = typeof raw.added === 'string' ? new Date(raw.added) : null;
  return {
    queueItemId: raw.id,
    downloadId: raw.downloadId ?? null,
    title: raw.title ?? null,
    addedAt: added && !Number.isNaN(added.getTime()) ? added : null,
    status: raw.status ?? null,
    trackedDownloadStatus: raw.trackedDownloadStatus ?? null,
    trackedDownloadState: raw.trackedDownloadState ?? null,
    errorMessage: raw.errorMessage ?? null,
    statusMessages: raw.statusMessages ?? null,
  };
}

/**
 * Wire the real *arr read + write clients into the three per-instance surfaces. The monitored-check uses the
 * finest cheap granularity the read client exposes: Radarr the movie; Sonarr the episode (via listEpisodes,
 * else the series); Lidarr the album (via listAlbums, else the artist). Re-search targets the same level.
 */
export function buildQueueCleanupClients(clients: {
  read: { sonarr: SonarrClient; radarr: RadarrClient; lidarr: LidarrClient };
  write: { sonarr: SonarrWriteClient; radarr: RadarrWriteClient; lidarr: LidarrWriteClient };
}): QueueCleanupClients {
  const targetsByItem = new WeakMap<QueueCleanupQueueItem, QueueTargetIds>();
  const remember = (item: QueueCleanupQueueItem, ids: QueueTargetIds): QueueCleanupQueueItem => {
    targetsByItem.set(item, ids);
    return item;
  };

  return {
    sonarr: {
      async getQueueAll() {
        const records = await clients.read.sonarr.getQueueAll();
        return records.map((r: SonarrQueueRecord) =>
          remember(normalizeItem(r), { parentId: r.seriesId ?? null, childId: r.episodeId ?? null }),
        );
      },
      deleteQueueItem: (item, opts) => clients.write.sonarr.deleteQueueItem(item.queueItemId, opts),
      processMonitoredDownloads: async () => {
        await clients.write.sonarr.processMonitoredDownloads();
      },
      async isTargetMonitored(item) {
        const t = targetsByItem.get(item);
        if (t?.childId != null && t.parentId != null) {
          const episodes = await clients.read.sonarr.listEpisodes(t.parentId);
          return episodes.find((e) => e.id === t.childId)?.monitored ?? false;
        }
        if (t?.parentId != null) return (await clients.read.sonarr.getSeriesById(t.parentId)).monitored;
        return false;
      },
      async searchTarget(item) {
        const t = targetsByItem.get(item);
        if (t?.childId != null) await clients.write.sonarr.searchEpisodes([t.childId]);
        else if (t?.parentId != null) await clients.write.sonarr.searchSeries(t.parentId);
      },
    },
    radarr: {
      async getQueueAll() {
        const records = await clients.read.radarr.getQueueAll();
        return records.map((r: RadarrQueueRecord) =>
          remember(normalizeItem(r), { parentId: r.movieId ?? null, childId: r.movieId ?? null }),
        );
      },
      deleteQueueItem: (item, opts) => clients.write.radarr.deleteQueueItem(item.queueItemId, opts),
      processMonitoredDownloads: async () => {
        await clients.write.radarr.processMonitoredDownloads();
      },
      async isTargetMonitored(item) {
        const t = targetsByItem.get(item);
        if (t?.parentId != null) return (await clients.read.radarr.getMovieById(t.parentId)).monitored;
        return false;
      },
      async searchTarget(item) {
        const t = targetsByItem.get(item);
        if (t?.parentId != null) await clients.write.radarr.searchMovies([t.parentId]);
      },
    },
    lidarr: {
      async getQueueAll() {
        const records = await clients.read.lidarr.getQueueAll();
        return records.map((r: LidarrQueueRecord) =>
          remember(normalizeItem(r), { parentId: r.artistId ?? null, childId: r.albumId ?? null }),
        );
      },
      deleteQueueItem: (item, opts) => clients.write.lidarr.deleteQueueItem(item.queueItemId, opts),
      processMonitoredDownloads: async () => {
        await clients.write.lidarr.processMonitoredDownloads();
      },
      async isTargetMonitored(item) {
        const t = targetsByItem.get(item);
        if (t?.childId != null && t.parentId != null) {
          const albums = await clients.read.lidarr.listAlbums(t.parentId);
          return albums.find((a) => a.id === t.childId)?.monitored ?? false;
        }
        if (t?.parentId != null) return (await clients.read.lidarr.getArtistById(t.parentId)).monitored;
        return false;
      },
      async searchTarget(item) {
        const t = targetsByItem.get(item);
        if (t?.childId != null) await clients.write.lidarr.searchAlbums([t.childId]);
        else if (t?.parentId != null) await clients.write.lidarr.searchArtist(t.parentId);
      },
    },
  };
}

/**
 * Build the janitor's confined client bundle from the D-18 env contract (`SONARR_URL`/`SONARR_API_KEY` +
 * RADARR_/LIDARR_; URLs default to the in-cluster service DNS). Missing keys throw one ArrConfigError naming
 * every absent variable (values are never echoed). Bazarr/Seerr are NOT part of the bundle — the janitor only
 * talks to the three *arrs. The write clients are constructed HERE (inside @hnet/domain), so @hnet/sync never
 * imports @hnet/arr/write (the ADR-008 guard).
 */
export function arrQueueCleanupClientsFromEnv(
  env: Record<string, string | undefined> = process.env,
): QueueCleanupClients {
  const missing: string[] = [];
  const opts = {} as Record<ArrKind, { baseUrl: string; apiKey: string }>;
  for (const kind of ARR_KINDS) {
    const prefix = kind.toUpperCase();
    const baseUrl = env[`${prefix}_URL`]?.trim() || ARR_CLUSTER_URL_DEFAULTS[kind];
    const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? '';
    if (!apiKey) missing.push(`${prefix}_API_KEY`);
    opts[kind] = { baseUrl, apiKey };
  }
  if (missing.length > 0) throw new ArrConfigError(missing);
  return buildQueueCleanupClients({
    read: {
      sonarr: new SonarrClient(opts.sonarr),
      radarr: new RadarrClient(opts.radarr),
      lidarr: new LidarrClient(opts.lidarr),
    },
    write: {
      sonarr: new SonarrWriteClient(opts.sonarr),
      radarr: new RadarrWriteClient(opts.radarr),
      lidarr: new LidarrWriteClient(opts.lidarr),
    },
  });
}

// ---------------------------------------------------------------------------
// evaluateQueueCleanup (D-04/D-06) — the single writer.
// ---------------------------------------------------------------------------

export interface QueueCleanupInstanceReport {
  instance: ArrKind;
  /** Whether the instance queue was read this run (false ⇒ a read failure, no rows written). */
  read: boolean;
  /** Census rows written for this instance (= queue size read). */
  itemsObserved: number;
  /** Enforce actions attempted this run (each counts against maxActionsPerRun). */
  actionsTaken: number;
  /** *arr write failures (outcome:'error'). */
  errors: number;
  byClass: Record<QueueCleanupActionClass, { observed: number; enforced: number }>;
  readError?: string;
}

export interface QueueCleanupReport {
  instances: QueueCleanupInstanceReport[];
  rowsWritten: number;
  /** True when EVERY instance failed to read — the CLI's nonzero-exit signal. */
  totalFailure: boolean;
}

interface QueueCleanupLogger {
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
}

function emptyByClass(): Record<QueueCleanupActionClass, { observed: number; enforced: number }> {
  return {
    have_better: { observed: 0, enforced: 0 },
    retry_import: { observed: 0, enforced: 0 },
    bad_release: { observed: 0, enforced: 0 },
    unknown: { observed: 0, enforced: 0 },
  };
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Count the item's prior retry_import rows (the escalation lookback via the (instance, downloadId) index). */
async function priorRetryImportRuns(
  db: ReturnType<typeof resolveDb>,
  instance: ArrKind,
  downloadId: string | null,
): Promise<number> {
  if (!downloadId) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(arrQueueCleanupActions)
    .where(
      and(
        eq(arrQueueCleanupActions.instance, instance),
        eq(arrQueueCleanupActions.downloadId, downloadId),
        eq(arrQueueCleanupActions.actionClass, 'retry_import'),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * Run one janitor pass over Sonarr/Radarr/Lidarr. Census rows are written ALWAYS (one per queue item — the
 * observation of record); enforce actions fire ONLY where the class×instance cell is `enforce`, behind the
 * rails (D-04): per-instance per-run cap `maxActionsPerRun`; `minItemAgeHours` before any action; a monitored
 * target check before a bad_release re-search; retry escalation via the persisted action-row lookback;
 * ProcessMonitoredDownloads at most once per instance per run; a failed *arr write → outcome 'error' (logged,
 * counts against the cap) + continue. `unknown` is NEVER acted on. The table is the single writer's whole
 * audit trail — no permission_audit / ledger coupling (append-only). Never throws for a per-instance failure.
 */
export async function evaluateQueueCleanup(input: {
  db?: DbClient;
  clients: QueueCleanupClients;
  config: ArrQueueCleanupConfig;
  now?: Date;
  logger?: QueueCleanupLogger;
}): Promise<QueueCleanupReport> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const { config } = input;
  const minAgeMs = config.minItemAgeHours * 60 * 60 * 1000;
  const rows: ArrQueueCleanupActionInsert[] = [];
  const instances: QueueCleanupInstanceReport[] = [];
  let anyRead = false;

  for (const instance of ARR_KINDS) {
    const client = input.clients[instance];
    const cells = config.modes[instance];
    const report: QueueCleanupInstanceReport = {
      instance,
      read: false,
      itemsObserved: 0,
      actionsTaken: 0,
      errors: 0,
      byClass: emptyByClass(),
    };

    let items: QueueCleanupQueueItem[];
    try {
      items = await client.getQueueAll();
    } catch (err) {
      report.readError = errMsg(err);
      input.logger?.warn?.('queue-cleanup: queue read failed', { instance, error: report.readError });
      instances.push(report);
      continue;
    }
    report.read = true;
    anyRead = true;

    let actionsTaken = 0;
    let retryCommandRan = false;

    for (const item of items) {
      const classified = classifyQueueItem(item);
      let actionClass: QueueCleanupActionClass = classified.class;

      // Escalation: an item still retry_import after `retryEscalateRuns` prior runs → bad_release handling.
      if (actionClass === 'retry_import') {
        const prior = await priorRetryImportRuns(db, instance, item.downloadId);
        if (prior >= config.retryEscalateRuns) actionClass = 'bad_release';
      }

      // unknown has no config cell (never enforced); every other class reads its instance cell.
      const mode: QueueCleanupMode = actionClass === 'unknown' ? 'census' : cells[actionClass];
      // Conservative age rail: unknown age (no `added`) is treated as YOUNG so a possibly-fresh item is never
      // acted on. minItemAgeHours=0 disables the rail entirely. Real *arr records always carry `added`.
      const young =
        config.minItemAgeHours > 0 &&
        (item.addedAt === null || now.getTime() - item.addedAt.getTime() < minAgeMs);

      let action: QueueCleanupAction = 'none';
      let outcome: QueueCleanupOutcome = 'observed';
      let error: string | null = null;

      if (young) {
        action = 'skipped_young';
      } else if (mode === 'enforce' && actionClass !== 'unknown') {
        if (actionClass === 'retry_import') {
          if (retryCommandRan) {
            // The estate-wide command already ran this instance — this item is covered, no cap cost.
            action = 'retried_import';
            outcome = 'done';
          } else if (actionsTaken >= config.maxActionsPerRun) {
            action = 'skipped_cap';
          } else {
            try {
              await client.processMonitoredDownloads();
              retryCommandRan = true;
              action = 'retried_import';
              outcome = 'done';
            } catch (err) {
              error = errMsg(err);
              outcome = 'error';
              report.errors += 1;
            }
            actionsTaken += 1;
          }
        } else if (actionsTaken >= config.maxActionsPerRun) {
          action = 'skipped_cap';
        } else {
          try {
            if (actionClass === 'have_better') {
              await client.deleteQueueItem(item, { removeFromClient: true, blocklist: true });
              action = 'removed_blocklisted';
              outcome = 'done';
            } else {
              // bad_release — blocklist, then re-search ONLY if the target is still monitored.
              await client.deleteQueueItem(item, { removeFromClient: true, blocklist: true });
              const monitored = await client.isTargetMonitored(item);
              if (monitored) {
                await client.searchTarget(item);
                action = 'blocklisted_searched';
              } else {
                action = 'removed_blocklisted';
              }
              outcome = 'done';
            }
          } catch (err) {
            error = errMsg(err);
            outcome = 'error';
            report.errors += 1;
          }
          actionsTaken += 1;
        }
      }

      rows.push({
        instance,
        queueItemId: item.queueItemId,
        downloadId: item.downloadId,
        title: item.title,
        actionClass,
        mode,
        action,
        outcome,
        reason: classified.reason,
        error,
        createdAt: now,
      });
      report.itemsObserved += 1;
      report.byClass[actionClass].observed += 1;
      if (outcome === 'done') report.byClass[actionClass].enforced += 1;
    }

    report.actionsTaken = actionsTaken;
    input.logger?.info?.('queue-cleanup evaluated', {
      instance,
      observed: report.itemsObserved,
      actionsTaken,
      errors: report.errors,
      byClass: report.byClass,
    });
    instances.push(report);
  }

  // Append the census + action rows — the single writer's whole trail (append-only, no audit coupling).
  if (rows.length > 0) await db.insert(arrQueueCleanupActions).values(rows);

  const totalFailure = instances.length > 0 && !anyRead;
  return { instances, rowsWritten: rows.length, totalFailure };
}

// ---------------------------------------------------------------------------
// Promotion ladder (D-05/D-07) + /admin status read (D-08) + digest section (D-07).
// ---------------------------------------------------------------------------

/**
 * Derive the ladder level from the modes matrix (D-05). L0 = all census; L2 = every enforceable cell enforced
 * (L3 is human-only, set via the plan — never derived above L2); L1 = any partial enforcement (the modes
 * matrix, exposed alongside, shows exactly which cells). Kept deliberately simple + documented.
 */
export function deriveQueueCleanupLadderLevel(config: ArrQueueCleanupConfig): number {
  let anyEnforce = false;
  let allEnforce = true;
  for (const instance of ARR_KINDS) {
    for (const klass of QUEUE_CLEANUP_ENFORCEABLE_CLASSES) {
      if (config.modes[instance][klass] === 'enforce') anyEnforce = true;
      else allEnforce = false;
    }
  }
  if (!anyEnforce) return 0;
  if (allEnforce) return 2;
  return 1;
}

const LADDER_NEXT_CRITERIA: Record<number, string> = {
  0: 'L0→L1: enforce have_better on Sonarr + Radarr after ≥3 digests of census data and a spot-check (≥90% correct, zero false deletions).',
  1: 'L1→L2: enforce everywhere after ≥7 days at L1 with zero bad deletions and the Q-01 Lidarr classification decision recorded.',
  2: 'L2→L3 (steady state): ≥14 days at L2 with the queues near zero and the unknown residue characterized — humans set L3 via the plan.',
};

export interface QueueCleanupLadder {
  level: number;
  /** Days since the config was last written (the latest update_app_setting audit for the key), or null. */
  ageDays: number | null;
  nextCriteria: string;
  /** The stagnation nag: age > 14 days, OR (at L0) census data spanning ≥3 distinct days (the ≥3-digests proxy). */
  promotionDue: boolean;
}

/** Days since the config key was last audited-written, or null when it has never been written. */
async function queueCleanupConfigAgeDays(
  db: ReturnType<typeof resolveDb>,
  now: Date,
): Promise<number | null> {
  const [row] = await db
    .select({ at: permissionAudit.createdAt })
    .from(permissionAudit)
    .where(
      and(
        eq(permissionAudit.action, 'update_app_setting'),
        sql`(${permissionAudit.detail} ->> 'key') = 'arr_queue_cleanup_config'`,
      ),
    )
    .orderBy(desc(permissionAudit.createdAt))
    .limit(1);
  if (!row?.at) return null;
  return Math.max(0, Math.floor((now.getTime() - row.at.getTime()) / (24 * 60 * 60 * 1000)));
}

/** Count distinct calendar days that carry census rows (the "≥3 digests of census data" proxy for L0→L1). */
async function distinctCensusDays(db: ReturnType<typeof resolveDb>): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct (${arrQueueCleanupActions.createdAt})::date)` })
    .from(arrQueueCleanupActions);
  return Number(row?.n ?? 0);
}

/** Resolve the promotion ladder (level + age + next criteria + the stagnation nag). */
export async function getQueueCleanupLadder(input: {
  db?: DbClient;
  config: ArrQueueCleanupConfig;
  now?: Date;
}): Promise<QueueCleanupLadder> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const level = deriveQueueCleanupLadderLevel(input.config);
  const ageDays = await queueCleanupConfigAgeDays(db, now);
  const days = level === 0 ? await distinctCensusDays(db) : 0;
  const promotionDue = (ageDays !== null && ageDays > 14) || (level === 0 && days >= 3);
  return { level, ageDays, nextCriteria: LADDER_NEXT_CRITERIA[level] ?? '', promotionDue };
}

export interface QueueCleanupSummaryCell {
  instance: ArrKind;
  actionClass: QueueCleanupActionClass;
  /** Rows observed (any outcome) in the window. */
  observed: number;
  /** Rows the janitor actually enforced (outcome 'done'). */
  enforced: number;
}

export interface ArrQueueCleanupStatus {
  config: ArrQueueCleanupConfig;
  /** Where the resolved config came from (a stored row vs the all-census default). */
  source: 'db' | 'default';
  ladder: QueueCleanupLadder;
  /** The last-7-days census/action summary (D-08 table). */
  summary: QueueCleanupSummaryCell[];
}

/** The /admin/janitor read (D-08): resolved config + ladder readout + a last-7-days census/action summary. */
export async function getArrQueueCleanupStatus(input?: {
  db?: DbClient;
  now?: Date;
}): Promise<ArrQueueCleanupStatus> {
  const db = resolveDb(input?.db);
  const now = input?.now ?? new Date();
  const stored = await getArrQueueCleanupConfig(db);
  const config = stored ?? ARR_QUEUE_CLEANUP_CONFIG_DEFAULT;
  const ladder = await getQueueCleanupLadder({ db, config, now });

  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recent = await db
    .select({
      instance: arrQueueCleanupActions.instance,
      actionClass: arrQueueCleanupActions.actionClass,
      outcome: arrQueueCleanupActions.outcome,
    })
    .from(arrQueueCleanupActions)
    .where(gte(arrQueueCleanupActions.createdAt, since));

  const byCell = new Map<string, QueueCleanupSummaryCell>();
  for (const r of recent) {
    const key = `${r.instance}:${r.actionClass}`;
    let cell = byCell.get(key);
    if (!cell) {
      cell = { instance: r.instance, actionClass: r.actionClass, observed: 0, enforced: 0 };
      byCell.set(key, cell);
    }
    cell.observed += 1;
    if (r.outcome === 'done') cell.enforced += 1;
  }

  return {
    config,
    source: stored ? 'db' : 'default',
    ladder,
    summary: [...byCell.values()],
  };
}

// ---------------------------------------------------------------------------
// Digest section (D-07) — the nightly failure-digest janitor rollup.
// ---------------------------------------------------------------------------

export interface QueueCleanupDigestClass {
  actionClass: QueueCleanupActionClass;
  /** Rows observed in census mode. */
  census: number;
  /** Rows the janitor enforced (outcome 'done'). */
  enforced: number;
  /** The top-3 distinct reasons with counts. */
  topReasons: Array<{ reason: string; count: number }>;
}

export interface QueueCleanupDigestInstance {
  instance: ArrKind;
  classes: QueueCleanupDigestClass[];
}

export interface QueueCleanupDigestSection {
  /** Total rows observed in the last 24h. */
  observed: number;
  /** Total rows the janitor enforced (outcome 'done') in the last 24h. */
  actions: number;
  instances: QueueCleanupDigestInstance[];
  ladder: { level: number; ageDays: number | null; nextCriteria: string };
  promotionDue: boolean;
}

/**
 * Build the nightly digest's janitor rollup (D-07) from the last-24h arr_queue_cleanup_actions rows: per
 * instance × class counts (census vs enforced), the top-3 distinct reasons per class with counts, and the
 * ladder line (level + age + next criteria) with the stagnation nag. Returns null when the janitor observed
 * NOTHING in 24h (so a run that saw no queue items adds no section and does not force a digest).
 */
export async function buildQueueCleanupDigestSection(input: {
  db?: DbClient;
  now?: Date;
}): Promise<QueueCleanupDigestSection | null> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const recent = await db
    .select({
      instance: arrQueueCleanupActions.instance,
      actionClass: arrQueueCleanupActions.actionClass,
      mode: arrQueueCleanupActions.mode,
      outcome: arrQueueCleanupActions.outcome,
      reason: arrQueueCleanupActions.reason,
    })
    .from(arrQueueCleanupActions)
    .where(gte(arrQueueCleanupActions.createdAt, since));

  if (recent.length === 0) return null;

  interface Acc {
    census: number;
    enforced: number;
    reasons: Map<string, number>;
  }
  const byCell = new Map<string, Acc>();
  let actions = 0;
  for (const r of recent) {
    if (r.outcome === 'done') actions += 1;
    const key = `${r.instance}:${r.actionClass}`;
    let acc = byCell.get(key);
    if (!acc) {
      acc = { census: 0, enforced: 0, reasons: new Map() };
      byCell.set(key, acc);
    }
    if (r.mode === 'census') acc.census += 1;
    if (r.outcome === 'done') acc.enforced += 1;
    if (r.reason && r.reason.trim() !== '') acc.reasons.set(r.reason, (acc.reasons.get(r.reason) ?? 0) + 1);
  }

  const instances: QueueCleanupDigestInstance[] = [];
  for (const instance of ARR_KINDS) {
    const classes: QueueCleanupDigestClass[] = [];
    for (const key of Object.keys(emptyByClass()) as QueueCleanupActionClass[]) {
      const acc = byCell.get(`${instance}:${key}`);
      if (!acc) continue;
      const topReasons = [...acc.reasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([reason, cnt]) => ({ reason, count: cnt }));
      classes.push({ actionClass: key, census: acc.census, enforced: acc.enforced, topReasons });
    }
    if (classes.length > 0) instances.push({ instance, classes });
  }

  const config = await resolveArrQueueCleanupConfig(db);
  const ladder = await getQueueCleanupLadder({ db, config, now });

  return {
    observed: recent.length,
    actions,
    instances,
    ladder: { level: ladder.level, ageDays: ladder.ageDays, nextCriteria: ladder.nextCriteria },
    promotionDue: ladder.promotionDue,
  };
}
