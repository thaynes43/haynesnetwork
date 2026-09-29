// ADR-083 / DESIGN-046 (PLAN-065 — *arr queue janitor). The classifier (pure, versioned patterns — D-03),
// the single-writer evaluator (census rows ALWAYS; enforce actions only where the class×instance cell is
// switched to `enforce`, behind the safety rails — D-04), the DB-backed audited config (D-05), the confined
// *arr client bundle (built INSIDE this package so @hnet/arr/write stays domain-only — the arr-write import
// guard), the /admin status read + promotion-ladder derivation (D-08), and the nightly digest section (D-07).
// D-13 gives Lidarr's `manual_match` an enforce cell, with a loop guard and a loop signal in the log and digest.
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
  ArrHttpError,
  type LidarrQueueRecord,
  type RadarrQueueRecord,
  type SonarrQueueRecord,
} from '@hnet/arr';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { setAppSetting } from './app-settings';
import { resolveDb } from './db-client';
import { QueueCleanupConfigInvalidError } from './errors';
import {
  JANITOR_BLOCK_KINDS,
  deriveJanitorBlockTerm,
  janitorBlockDigest,
  reconcileJanitorReleaseBlock,
  reconcileJanitorReleaseBlockIfDue,
  type JanitorBlockTerm,
  type JanitorReleaseProfileClient,
} from './janitor-release-block';

// ---------------------------------------------------------------------------
// Classifier (D-03) — pure, exhaustively tested; patterns in versioned code.
// ---------------------------------------------------------------------------

/** The minimal queue-record shape the classifier reads (SonarrQueueRecord/… all satisfy it structurally). */
export interface ClassifiableQueueItem {
  /** The queue record's own title — the download's release name. The *arr titles a release-level statusMessage
   *  with it, which tells that entry apart from per-file ones (D-10). Optional: absent ⇒ a file-name check. */
  title?: string | null;
  status?: string | null;
  trackedDownloadStatus?: string | null;
  trackedDownloadState?: string | null;
  errorMessage?: string | null;
  statusMessages?: Array<{ title?: string | null; messages?: (string | null)[] | null }> | null;
}

export interface QueueCleanupClassification {
  class: QueueCleanupActionClass;
  /** The MESSAGE that drove the class (≤500 chars), or the most informative message for the unknown fallback.
   *  Never a statusMessage title that only names the release or a file (D-10). */
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

/**
 * Identity-mismatch signals (D-10): the *arr is not sure this grab IS the item it was grabbed for, so an
 * "already have it" verdict in the same item may be about the wrong target. A have_better match that also
 * carries one of these goes to `unknown` (report only). Upstream strings at the running tags (Sonarr
 * v4.0.20.3014 / Radarr v6.4.4.10685 / Lidarr v3.1.6.5078): MatchesGrabSpecification "Episode(s) … was/were
 * not found in the grabbed release: …"; CompletedDownloadService "Found matching series|movie via grab
 * history, but release was matched to series|movie by ID. …"; MatchesFolderSpecification "Episode(s) … was/
 * were unexpected considering the … folder name"; and, defensively, CompletedDownloadService's "Series title
 * mismatch" / "Movie title mismatch" / "Artist name mismatch".
 */
const IDENTITY_MISMATCH_PATTERNS = [
  /not found in the grabbed release/i,
  /matched to (?:series|movie|artist|album) by id/i,
  /unexpected considering the\b.*\bfolder name/i,
  /\b(?:series|movie) title mismatch\b/i,
  /\bartist name mismatch\b/i,
];

/**
 * Release-defect signals (D-03 bad_release), matched against RELEASE-LEVEL messages only (D-10): never a
 * release or file name, and never a per-file rejection among real files (a `-sample.mkv` or an unparseable
 * featurette beside the episodes condemns that file, not the release). "Sample" is the upstream
 * NotSampleSpecification rejection verbatim; "Unable to determine if file is a sample" (SampleIndeterminate) is
 * not a verdict and does not match. "archive" is the upstream import rejection verbatim ("Found archive file,
 * might need to be extracted"): a bare \barchive\b also hit release names and paths that upstream embeds in
 * other messages ("Archive 81", "…not found in the grabbed release: <release>", "…eligible for import in
 * <path>").
 */
const BAD_RELEASE_PATTERNS = [
  /unable to parse/i,
  /found archive file/i,
  /password/i,
  /executable/i,
  /^sample\.?$/i,
];

/** The header the *arrs put first in a multi-file statusMessage set ("One or more episodes|movies|tracks
 *  expected in this release were not imported or missing…"); every titled entry after it names a FILE. */
const MULTI_FILE_HEADER = /^one or more \w+ expected in this release were not imported or missing/i;

/** A statusMessage title that is a file name (per-file entries are titled with the file's name). */
const MEDIA_FILE_NAME =
  /\.(?:mkv|mp4|m4v|avi|wmv|mov|mpe?g|ts|m2ts|webm|iso|img|vob|flac|mp3|m4a|m4b|aac|ogg|opus|wav|wv|ape|alac)$/i;

/** The empty/transient set the stuck-import class ProcessMonitoredDownloads exists for (D-03 retry_import). */
const RETRY_TRANSIENT_PATTERNS = [/waiting to import/i];

/**
 * Lidarr's match rejections (D-12, Q-01): the downloaded files could not be matched to an album with confidence.
 * D-12 left the choice to a person; D-13 (owner ruling 2026-09-29) lets the janitor remove, blocklist and search the
 * album again where Lidarr's cell is enforced, behind a loop guard. Upstream strings at the
 * running tag (Lidarr v3.1.6.5078): CloseAlbumMatchSpecification "Album match is not close enough: …", "Worst
 * track match: …", "No tracks matched"; CloseTrackMatchSpecification "Track match is not close enough: …";
 * NoMissingOrUnmatchedTracksSpecification "Has missing tracks" / "Has unmatched tracks"; ImportDecisionMaker
 * "Couldn't find similar album for …"; TrackedDownloadService "Unable to import automatically, found multiple
 * artists: …". Ordered by how much each says, so the stored reason is the most informative one (a release's
 * files usually carry an album-match message AND "Has missing tracks").
 */
const MANUAL_MATCH_PATTERNS = [
  /\balbum match is not close enough\b/i,
  /\bworst track match:/i,
  /\btrack match is not close enough\b/i,
  /\bcouldn['\u2019]t find similar album\b/i,
  /\bunable to import automatically, found multiple artists\b/i,
  /^no tracks matched\.?$/i,
  /^has missing tracks\.?$/i,
  /^has unmatched tracks\.?$/i,
];

const truncate = (s: string): string => (s.length > 500 ? s.slice(0, 500) : s);

const nonEmpty = (s: unknown): string | null => (typeof s === 'string' && s.trim() !== '' ? s.trim() : null);

interface QueueItemMessages {
  /** Reason-bearing texts, most informative first: `errorMessage`, every statusMessage `messages[]` entry,
   *  then titles that ARE the message (an entry with no messages, e.g. Lidarr's single-result shape), the
   *  generic multi-file header last. A title with messages under it only NAMES the release or a file and is
   *  left out (the release name is already the row's `title` column). */
  messages: string[];
  /** The subset that speaks for the WHOLE release: `errorMessage`, the messages of a release-level entry, and
   *  title-borne messages outside a multi-file set. Never a per-file entry's rejections. */
  releaseLevel: string[];
}

/**
 * Split a queue record's texts into reasons vs. names (D-10). The upstream shapes (Sonarr/Radarr/Lidarr
 * `TrackedDownload.Warn` + `CompletedDownloadService`): a single-result or plain warning is ONE entry titled
 * with the download's own title, its messages the reasons; a multi-file result is the header entry (no
 * messages) followed by one entry per unimported file, titled with the FILE name, its messages that file's
 * rejections. So a title with messages under it is a name, never a reason.
 */
function collectMessages(item: ClassifiableQueueItem): QueueItemMessages {
  const itemTitle = nonEmpty(item.title);
  const entries = (item.statusMessages ?? []).filter((sm) => sm != null);
  const multiFile = entries.some((sm) => MULTI_FILE_HEADER.test(nonEmpty(sm.title) ?? ''));
  // A per-file entry: anything in a multi-file set, or a title that is a file name other than the download's.
  const isPerFile = (title: string | null): boolean =>
    multiFile || (title !== null && title !== itemTitle && MEDIA_FILE_NAME.test(title));

  const primary: string[] = [];
  const titleBorne: string[] = [];
  const headers: string[] = [];
  const releaseLevel: string[] = [];

  const error = nonEmpty(item.errorMessage);
  if (error) {
    primary.push(error);
    releaseLevel.push(error);
  }
  for (const sm of entries) {
    const title = nonEmpty(sm.title);
    const messages = (sm.messages ?? []).map(nonEmpty).filter((m): m is string => m !== null);
    if (messages.length === 0) {
      if (title === null) continue;
      if (MULTI_FILE_HEADER.test(title)) {
        headers.push(title);
      } else {
        titleBorne.push(title);
        if (!multiFile) releaseLevel.push(title);
      }
      continue;
    }
    primary.push(...messages);
    if (!isPerFile(title)) releaseLevel.push(...messages);
  }
  return { messages: [...primary, ...titleBorne, ...headers], releaseLevel };
}

/**
 * Classify one queue item into exactly one Action Class (D-03, FIRST-MATCH order: have_better → bad_release →
 * retry_import → manual_match → unknown). Pure. Patterns read MESSAGES, never a statusMessage title that names
 * the release or a file; release-defect patterns read only the release-level ones; a have_better match that
 * also carries an identity mismatch goes to `unknown` (all D-10). Lidarr's match rejections ("Album match is not
 * close enough…", "Has missing tracks", "Couldn't find similar album…") are `manual_match` (D-12, Q-01), which
 * acts only where Lidarr's manual_match cell is enforced (D-13). A have_better match that also carries one goes to
 * `manual_match` too,
 * because its "already have it" may be about a different album. Lidarr's `importFailed` is deliberately NOT a
 * stuck import here: Lidarr sets it when any file of the release was rejected and never retries it, and its
 * "Not an upgrade for existing track file(s)" has been seen about another album's files (D-12).
 */
export function classifyQueueItem(item: ClassifiableQueueItem): QueueCleanupClassification {
  const { messages, releaseLevel } = collectMessages(item);
  const state = (item.trackedDownloadState ?? '').toLowerCase();
  const status = (item.status ?? '').toLowerCase();
  const trackedStatus = (item.trackedDownloadStatus ?? '').toLowerCase();
  const isImportStuck = state === 'importblocked' || state === 'importpending';
  const bestMessage = messages[0] ?? null;
  const matchIn = (patterns: RegExp[], texts: string[] = messages): string | null =>
    texts.find((m) => patterns.some((p) => p.test(m))) ?? null;

  // Lidarr's match rejections, the most informative first (D-12). Report only.
  let manualMatch: string | null = null;
  for (const p of MANUAL_MATCH_PATTERNS) {
    manualMatch = messages.find((m) => p.test(m)) ?? null;
    if (manualMatch) break;
  }

  // 1. have_better — import blocked/pending + an already-satisfied rejection, UNLESS the *arr also doubts the
  //    grab's identity (D-10) or could not match it to the album (D-12): then its "have better" may be about the
  //    wrong target, so report only.
  if (isImportStuck) {
    const hb = matchIn(HAVE_BETTER_PATTERNS);
    if (hb) {
      const mismatch = matchIn(IDENTITY_MISMATCH_PATTERNS);
      if (mismatch) return { class: 'unknown', reason: truncate(mismatch), confidence: 'low' };
      if (manualMatch) return { class: 'manual_match', reason: truncate(manualMatch), confidence: 'high' };
      return { class: 'have_better', reason: truncate(hb), confidence: 'high' };
    }
  }

  // 2. bad_release — errored transfer, a failed download, or a release-level release-defect message.
  const badMsg = matchIn(BAD_RELEASE_PATTERNS, releaseLevel);
  if (trackedStatus === 'error' || status === 'failed' || state === 'failed' || badMsg) {
    const r = badMsg ?? bestMessage;
    return { class: 'bad_release', reason: r ? truncate(r) : null, confidence: 'high' };
  }

  // 3. retry_import — a stuck import with an empty/transient message set.
  if (isImportStuck) {
    const transient = matchIn(RETRY_TRANSIENT_PATTERNS);
    if (transient || messages.length === 0) {
      return { class: 'retry_import', reason: transient ? truncate(transient) : null, confidence: 'high' };
    }
  }

  // 4. manual_match — Lidarr could not match the files to an album with confidence (D-12). Acted on only where
  //    Lidarr's manual_match cell is enforced (D-13).
  if (manualMatch) return { class: 'manual_match', reason: truncate(manualMatch), confidence: 'high' };

  // 5. unknown — everything else. Reported, never acted on.
  return { class: 'unknown', reason: bestMessage ? truncate(bestMessage) : null, confidence: 'low' };
}

// ---------------------------------------------------------------------------
// Config (D-05) — the audited app_settings key `arr_queue_cleanup_config`.
// ---------------------------------------------------------------------------

/** The classes every instance has an enforce cell for (D-05). */
export const QUEUE_CLEANUP_SHARED_CLASSES = ['have_better', 'retry_import', 'bad_release'] as const;
export type QueueCleanupSharedClass = (typeof QUEUE_CLEANUP_SHARED_CLASSES)[number];

/** The classes that have an enforce cell on SOME instance. `unknown` never does (ADR-083 normative). `manual_match`
 *  was report only (D-12) and since D-13 has one cell, on Lidarr only. */
export const QUEUE_CLEANUP_ENFORCEABLE_CLASSES = [...QUEUE_CLEANUP_SHARED_CLASSES, 'manual_match'] as const;
export type QueueCleanupEnforceableClass = (typeof QUEUE_CLEANUP_ENFORCEABLE_CLASSES)[number];

/**
 * The cells each instance has (D-05, D-13): the shared three everywhere, plus `manual_match` on Lidarr. Lidarr's
 * match rejections are the only source of the class, and its action ends in an album search, so Sonarr and
 * Radarr have no such cell (a stored `modes.sonarr.manual_match` is an unknown class).
 */
export const QUEUE_CLEANUP_INSTANCE_CLASSES: { readonly [K in ArrKind]: readonly QueueCleanupEnforceableClass[] } = {
  sonarr: QUEUE_CLEANUP_SHARED_CLASSES,
  radarr: QUEUE_CLEANUP_SHARED_CLASSES,
  lidarr: QUEUE_CLEANUP_ENFORCEABLE_CLASSES,
};

const ENFORCEABLE_CLASS_SET: ReadonlySet<string> = new Set(QUEUE_CLEANUP_ENFORCEABLE_CLASSES);

/** True for a class that has an enforce cell on some instance; false for the report-only class `unknown`. Which
 *  instance has the cell is `QUEUE_CLEANUP_INSTANCE_CLASSES`. */
export function isEnforceableQueueCleanupClass(
  actionClass: QueueCleanupActionClass,
): actionClass is QueueCleanupEnforceableClass {
  return ENFORCEABLE_CLASS_SET.has(actionClass);
}

/** The 3 shared mode cells for one instance (class → 'census'|'enforce'). */
export type QueueCleanupModeCells = Record<QueueCleanupSharedClass, QueueCleanupMode>;

/** Lidarr's cells: the shared three plus `manual_match` (D-13). */
export type LidarrQueueCleanupModeCells = QueueCleanupModeCells & { manual_match: QueueCleanupMode };

export interface ArrQueueCleanupConfig {
  /** T-240 cells: per instance × the classes that instance has a cell for (QUEUE_CLEANUP_INSTANCE_CLASSES). */
  modes: {
    sonarr: QueueCleanupModeCells;
    radarr: QueueCleanupModeCells;
    lidarr: LidarrQueueCleanupModeCells;
  };
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

/** The code default — ALL-CENSUS (observe-only), caps 10 / 2h / 6-run (DESIGN-046 D-05). Lidarr's `manual_match`
 *  cell is census too (D-13), so the deploy that adds it is inert until the cell is flipped. */
export const ARR_QUEUE_CLEANUP_CONFIG_DEFAULT: ArrQueueCleanupConfig = {
  modes: {
    sonarr: allCensusCells(),
    radarr: allCensusCells(),
    lidarr: { ...allCensusCells(), manual_match: 'census' },
  },
  maxActionsPerRun: 10,
  minItemAgeHours: 2,
  retryEscalateRuns: 6,
};

/**
 * The mode of one class×instance cell. `census` for a class the instance has no cell for (`unknown` anywhere,
 * `manual_match` off Lidarr) and for a cell a config lacks: a config stored before D-13 has no `manual_match`
 * cell, and it reads as census (fail safe, never enforce by omission).
 */
export function queueCleanupCellMode(
  config: ArrQueueCleanupConfig,
  instance: ArrKind,
  actionClass: QueueCleanupActionClass,
): QueueCleanupMode {
  if (!isEnforceableQueueCleanupClass(actionClass)) return 'census';
  if (!QUEUE_CLEANUP_INSTANCE_CLASSES[instance].includes(actionClass)) return 'census';
  const cells = config.modes[instance] as Partial<Record<QueueCleanupEnforceableClass, unknown>> | undefined;
  return cells?.[actionClass] === 'enforce' ? 'enforce' : 'census';
}

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
  const allowedModes = new Set<string>(QUEUE_CLEANUP_MODES);
  for (const instance of ARR_KINDS) {
    const cell = m[instance];
    if (typeof cell !== 'object' || cell === null) return `modes.${instance} must be an object.`;
    const cc = cell as Record<string, unknown>;
    const allowedClasses = new Set<string>(QUEUE_CLEANUP_INSTANCE_CLASSES[instance]);
    for (const key of Object.keys(cc)) {
      if (!allowedClasses.has(key)) return `Unknown class '${key}' in modes.${instance}.`;
    }
    for (const klass of QUEUE_CLEANUP_INSTANCE_CLASSES[instance]) {
      // D-13: a config stored before Lidarr's manual_match cell existed lacks it; absent reads as census.
      if (klass === 'manual_match' && cc[klass] === undefined) continue;
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

/** The canonical shape of a validated config: every cell present (Lidarr's `manual_match` filled as census
 *  when a pre-D-13 config lacks it), stray keys dropped. Used for storing AND for reading back. */
function canonicalConfig(config: ArrQueueCleanupConfig): ArrQueueCleanupConfig {
  const cell = (c: QueueCleanupModeCells): QueueCleanupModeCells => ({
    have_better: c.have_better,
    retry_import: c.retry_import,
    bad_release: c.bad_release,
  });
  return {
    modes: {
      sonarr: cell(config.modes.sonarr),
      radarr: cell(config.modes.radarr),
      lidarr: {
        ...cell(config.modes.lidarr),
        manual_match: queueCleanupCellMode(config, 'lidarr', 'manual_match'),
      },
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
  return canonicalConfig(row.value as ArrQueueCleanupConfig);
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
    value: canonicalConfig(input.config),
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
  /** The record's search target (D-13): Sonarr the episodeId, Radarr the movieId, Lidarr the albumId. Null or
   *  absent when the record carries none (an unknown-artist Lidarr record). Persisted as the row's `targetId`;
   *  keys the manual_match loop guard and the digest's repeat-search list. */
  targetId?: number | null;
}

/** The per-instance surface the evaluator drives. Tests inject a stub; prod wires the real *arr clients. */
export interface QueueCleanupInstanceClient {
  /** The WHOLE instance queue (paged read; read-only). */
  getQueueAll(): Promise<QueueCleanupQueueItem[]>;
  /** DELETE /queue/{id}?removeFromClient=&blocklist=&skipRedownload= — remove the stuck grab + blocklist the
   *  release. The janitor always passes `skipRedownload: true` (D-10): the *arr must not re-search on its own. */
  deleteQueueItem(
    item: QueueCleanupQueueItem,
    opts: { removeFromClient: boolean; blocklist: boolean; skipRedownload: boolean },
  ): Promise<void>;
  /** POST /command ProcessMonitoredDownloads — estate-wide (at most once per instance per run). */
  processMonitoredDownloads(): Promise<void>;
  /** The given records (one download's) whose re-search target is still monitored, so a re-search goes only
   *  where it is genuinely wanted. Batched (D-11): a season pack reads its series' episode list once. */
  monitoredTargets(items: QueueCleanupQueueItem[]): Promise<QueueCleanupQueueItem[]>;
  /** Trigger the owning *arr's search for the given records' targets, one command per download where the *arr
   *  takes an id list (EpisodeSearch / MoviesSearch / AlbumSearch — D-11). */
  searchTargets(items: QueueCleanupQueueItem[]): Promise<void>;
  /**
   * D-13 (manual_match): the given records whose album is monitored AND still missing tracks, so an album search
   * can only go where it is wanted and not yet satisfied. A record with no album, an album the read cannot find,
   * and an album whose track counts Lidarr does not report are left out (no search). Lidarr only: an instance
   * without it never searches for manual_match.
   */
  missingMonitoredTargets?(items: QueueCleanupQueueItem[]): Promise<QueueCleanupQueueItem[]>;
  /**
   * D-14 (ADR-094): what the janitor release block needs to name a download's release: the grab's raw indexer title
   * (Lidarr: the newest grab of the download in its history, else the queue title) and the artist's name. Lidarr only.
   */
  releaseIdentity?(
    item: QueueCleanupQueueItem,
  ): Promise<{ releaseTitle: string | null; artistName: string | null }>;
  /** D-14 (ADR-094): the *arr's release-profile surface for the janitor release block. Lidarr only. */
  releaseProfiles?: JanitorReleaseProfileClient;
}

/**
 * D-13: true only when Lidarr's own counts say the album still lacks files: fewer track files than tracks in
 * its selected release. An album without statistics, or with no tracks, cannot be told apart from a complete one,
 * so it is not "missing" (fail safe: no search). Pure.
 */
export function isLidarrAlbumMissing(album: {
  statistics?: { trackFileCount: number; trackCount: number } | null;
}): boolean {
  const stats = album.statistics;
  if (!stats) return false;
  return stats.trackCount > 0 && stats.trackFileCount < stats.trackCount;
}

export type QueueCleanupClients = Record<ArrKind, QueueCleanupInstanceClient>;

interface QueueTargetIds {
  parentId: number | null;
  childId: number | null;
}

/** Memoize an async lookup for the length of one call, so a download's records share one read per parent. */
function memoized<K, V>(load: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (key) => {
    let hit = cache.get(key);
    if (!hit) {
      hit = load(key);
      cache.set(key, hit);
    }
    return hit;
  };
}

/** The distinct non-null ids, in first-seen order. */
const distinctIds = (ids: Array<number | null | undefined>): number[] => [
  ...new Set(ids.filter((id): id is number => id != null)),
];

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
}, targetId: number | null): QueueCleanupQueueItem {
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
    targetId,
  };
}

/**
 * Wire the real *arr read + write clients into the three per-instance surfaces. The monitored-check uses the
 * finest cheap granularity the read client exposes: Radarr the movie; Sonarr the episode (via listEpisodes,
 * else the series); Lidarr the album (via listAlbums, else the artist). Re-search targets the same level. Both
 * take a download's records together (D-11): one list read per parent, and one search command for every
 * monitored episode / movie / album (the series / artist search only for a record with no child id). Lidarr also
 * answers which albums are monitored and still missing tracks (D-13, manual_match), from the same album list.
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
          remember(normalizeItem(r, r.episodeId ?? null), {
            parentId: r.seriesId ?? null,
            childId: r.episodeId ?? null,
          }),
        );
      },
      deleteQueueItem: (item, opts) => clients.write.sonarr.deleteQueueItem(item.queueItemId, opts),
      processMonitoredDownloads: async () => {
        await clients.write.sonarr.processMonitoredDownloads();
      },
      async monitoredTargets(items) {
        const episodesOf = memoized((seriesId: number) =>
          clients.read.sonarr.listEpisodes(seriesId),
        );
        const seriesOf = memoized((seriesId: number) =>
          clients.read.sonarr.getSeriesById(seriesId),
        );
        const monitored: QueueCleanupQueueItem[] = [];
        for (const item of items) {
          const t = targetsByItem.get(item);
          let isMonitored = false;
          if (t?.childId != null && t.parentId != null) {
            const childId = t.childId;
            isMonitored =
              (await episodesOf(t.parentId)).find((e) => e.id === childId)?.monitored ?? false;
          } else if (t?.parentId != null) {
            isMonitored = (await seriesOf(t.parentId)).monitored;
          }
          if (isMonitored) monitored.push(item);
        }
        return monitored;
      },
      async searchTargets(items) {
        const targets = items.map((item) => targetsByItem.get(item));
        const episodeIds = distinctIds(targets.map((t) => t?.childId));
        if (episodeIds.length > 0) await clients.write.sonarr.searchEpisodes(episodeIds);
        for (const seriesId of distinctIds(
          targets.filter((t) => t?.childId == null).map((t) => t?.parentId),
        )) {
          await clients.write.sonarr.searchSeries(seriesId);
        }
      },
    },
    radarr: {
      async getQueueAll() {
        const records = await clients.read.radarr.getQueueAll();
        return records.map((r: RadarrQueueRecord) =>
          remember(normalizeItem(r, r.movieId ?? null), {
            parentId: r.movieId ?? null,
            childId: r.movieId ?? null,
          }),
        );
      },
      deleteQueueItem: (item, opts) => clients.write.radarr.deleteQueueItem(item.queueItemId, opts),
      processMonitoredDownloads: async () => {
        await clients.write.radarr.processMonitoredDownloads();
      },
      async monitoredTargets(items) {
        const movieOf = memoized((movieId: number) => clients.read.radarr.getMovieById(movieId));
        const monitored: QueueCleanupQueueItem[] = [];
        for (const item of items) {
          const t = targetsByItem.get(item);
          if (t?.parentId != null && (await movieOf(t.parentId)).monitored) monitored.push(item);
        }
        return monitored;
      },
      async searchTargets(items) {
        const movieIds = distinctIds(items.map((item) => targetsByItem.get(item)?.parentId));
        if (movieIds.length > 0) await clients.write.radarr.searchMovies(movieIds);
      },
    },
    lidarr: {
      async getQueueAll() {
        const records = await clients.read.lidarr.getQueueAll();
        return records.map((r: LidarrQueueRecord) =>
          remember(normalizeItem(r, r.albumId ?? null), {
            parentId: r.artistId ?? null,
            childId: r.albumId ?? null,
          }),
        );
      },
      deleteQueueItem: (item, opts) => clients.write.lidarr.deleteQueueItem(item.queueItemId, opts),
      processMonitoredDownloads: async () => {
        await clients.write.lidarr.processMonitoredDownloads();
      },
      async monitoredTargets(items) {
        const albumsOf = memoized((artistId: number) => clients.read.lidarr.listAlbums(artistId));
        const artistOf = memoized((artistId: number) =>
          clients.read.lidarr.getArtistById(artistId),
        );
        const monitored: QueueCleanupQueueItem[] = [];
        for (const item of items) {
          const t = targetsByItem.get(item);
          let isMonitored = false;
          if (t?.childId != null && t.parentId != null) {
            const childId = t.childId;
            isMonitored =
              (await albumsOf(t.parentId)).find((a) => a.id === childId)?.monitored ?? false;
          } else if (t?.parentId != null) {
            isMonitored = (await artistOf(t.parentId)).monitored;
          }
          if (isMonitored) monitored.push(item);
        }
        return monitored;
      },
      async searchTargets(items) {
        const targets = items.map((item) => targetsByItem.get(item));
        const albumIds = distinctIds(targets.map((t) => t?.childId));
        if (albumIds.length > 0) await clients.write.lidarr.searchAlbums(albumIds);
        for (const artistId of distinctIds(
          targets.filter((t) => t?.childId == null).map((t) => t?.parentId),
        )) {
          await clients.write.lidarr.searchArtist(artistId);
        }
      },
      // D-14: the grab's own title (what a release-profile term is tested against), else the queue title; and the
      // artist's name, which the term must contain so it never blocks another artist's release.
      async releaseIdentity(item) {
        const t = targetsByItem.get(item);
        const downloadId = nonEmpty(item.downloadId);
        let releaseTitle: string | null = null;
        if (downloadId !== null) {
          const grabs = await clients.read.lidarr.getDownloadGrabs(downloadId);
          releaseTitle = grabs.records.map((r) => nonEmpty(r.sourceTitle)).find((x) => x !== null) ?? null;
        }
        releaseTitle ??= nonEmpty(item.title);
        const artistName =
          t?.parentId != null
            ? nonEmpty((await clients.read.lidarr.getArtistById(t.parentId)).artistName)
            : null;
        return { releaseTitle, artistName };
      },
      releaseProfiles: {
        listReleaseProfiles: () => clients.write.lidarr.listReleaseProfiles(),
        createReleaseProfile: (body) => clients.write.lidarr.createReleaseProfile(body),
        updateReleaseProfile: (body) => clients.write.lidarr.updateReleaseProfile(body),
      },
      // D-13: only records WITH an album qualify, so the searchTargets call that follows never falls back to an
      // artist-wide search for manual_match.
      async missingMonitoredTargets(items) {
        const albumsOf = memoized((artistId: number) => clients.read.lidarr.listAlbums(artistId));
        const missing: QueueCleanupQueueItem[] = [];
        for (const item of items) {
          const t = targetsByItem.get(item);
          if (t?.childId == null || t.parentId == null) continue;
          const albumId = t.childId;
          const album = (await albumsOf(t.parentId)).find((a) => a.id === albumId);
          if (album?.monitored && isLidarrAlbumMissing(album)) missing.push(item);
        }
        return missing;
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
  /** Enforce actions attempted this run (each counts against maxActionsPerRun). One per download (D-11). */
  actionsTaken: number;
  /** Records handled by a call made for another record: the rest of a download's records (D-11), and
   *  retry_import records covered by the run's one ProcessMonitoredDownloads. */
  covered: number;
  /** *arr write failures (outcome:'error'), one per failed call, not per record. */
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
    manual_match: { observed: 0, enforced: 0 },
    unknown: { observed: 0, enforced: 0 },
  };
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The one removal shape the janitor sends (D-04 / D-10): out of the download client, blocklisted, and NO
 *  automatic re-search by the *arr. */
const JANITOR_REMOVAL = { removeFromClient: true, blocklist: true, skipRedownload: true } as const;

/**
 * Group one instance's queue records by download (DESIGN-046 D-11). Records that share a non-empty `downloadId`
 * form one group, in first-seen queue order (Sonarr lists a season pack as one record per episode; Lidarr a
 * multi-album download as one per album). A record with a null, empty or blank `downloadId` is never grouped:
 * it stands alone. Pure.
 */
export function groupQueueRecordsByDownload<T extends { downloadId: string | null }>(
  items: readonly T[],
): T[][] {
  const groups: T[][] = [];
  const byDownload = new Map<string, T[]>();
  for (const item of items) {
    const key = nonEmpty(item.downloadId);
    if (key === null) {
      groups.push([item]);
      continue;
    }
    let group = byDownload.get(key);
    if (!group) {
      group = [];
      byDownload.set(key, group);
      groups.push(group);
    }
    group.push(item);
  }
  return groups;
}

/**
 * Count the download's prior retry_import RUNS (the escalation lookback via the (instance, downloadId) index).
 * Every row of one run carries that run's `createdAt`, so distinct timestamps are runs; counting rows would let a
 * season pack (one row per episode per run) escalate after a single run (D-11).
 */
async function priorRetryImportRuns(
  db: ReturnType<typeof resolveDb>,
  instance: ArrKind,
  downloadId: string | null,
): Promise<number> {
  if (!downloadId) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${arrQueueCleanupActions.createdAt})` })
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
 * D-13 — the loop guard's K: a Lidarr `manual_match` record whose album the janitor has already removed as
 * `manual_match` on this many EARLIER downloads is `skipped_loop`. Each of those removals was followed by another
 * match failure for the album (the next removed download, and for the last one this record), so the janitor's
 * remove-and-search has failed K times in a row and a person should decide. Versioned code, not config: the
 * owner approved the action with this bound.
 */
export const MANUAL_MATCH_LOOP_LIMIT = 2;

/** D-13 — the window of the repeat-search signal: a target the janitor searched on 2+ runs within it is reported
 *  (the digest) and logged (`[queue-cleanup] loop_detected`). */
const REPEAT_SEARCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The stable message of the loop log line (D-13). One JSON line per event; alert on it in Loki. */
export const QUEUE_CLEANUP_LOOP_LOG = '[queue-cleanup] loop_detected';

/**
 * D-13 — for each album, the earlier downloads the janitor removed as `manual_match` (removals that landed, so
 * `outcome: 'done'`). Keyed by download; a row with no downloadId counts once per run.
 */
async function priorManualMatchRemovals(
  db: ReturnType<typeof resolveDb>,
  instance: ArrKind,
  targetIds: number[],
): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>();
  if (targetIds.length === 0) return out;
  const rows = await db
    .select({
      targetId: arrQueueCleanupActions.targetId,
      downloadId: arrQueueCleanupActions.downloadId,
      createdAt: arrQueueCleanupActions.createdAt,
    })
    .from(arrQueueCleanupActions)
    .where(
      and(
        eq(arrQueueCleanupActions.instance, instance),
        eq(arrQueueCleanupActions.actionClass, 'manual_match'),
        eq(arrQueueCleanupActions.outcome, 'done'),
        inArray(arrQueueCleanupActions.action, ['removed_blocklisted', 'blocklisted_searched']),
        inArray(arrQueueCleanupActions.targetId, targetIds),
      ),
    );
  for (const r of rows) {
    if (r.targetId == null) continue;
    let downloads = out.get(r.targetId);
    if (!downloads) {
      downloads = new Set();
      out.set(r.targetId, downloads);
    }
    downloads.add(nonEmpty(r.downloadId) ?? `run:${r.createdAt.toISOString()}`);
  }
  return out;
}

/** D-13 — the runs on which the janitor searched each target within the repeat-search window, before this run. */
async function priorSearchRuns(
  db: ReturnType<typeof resolveDb>,
  instance: ArrKind,
  targetIds: number[],
  since: Date,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (targetIds.length === 0) return out;
  const rows = await db
    .select({
      targetId: arrQueueCleanupActions.targetId,
      runs: sql<number>`count(distinct ${arrQueueCleanupActions.createdAt})`,
    })
    .from(arrQueueCleanupActions)
    .where(
      and(
        eq(arrQueueCleanupActions.instance, instance),
        eq(arrQueueCleanupActions.action, 'blocklisted_searched'),
        eq(arrQueueCleanupActions.outcome, 'done'),
        inArray(arrQueueCleanupActions.targetId, targetIds),
        gte(arrQueueCleanupActions.createdAt, since),
      ),
    )
    .groupBy(arrQueueCleanupActions.targetId);
  for (const r of rows) if (r.targetId != null) out.set(r.targetId, Number(r.runs));
  return out;
}

/** One record's own verdict, before its download is considered (D-11). */
interface RecordVerdict {
  item: QueueCleanupQueueItem;
  actionClass: QueueCleanupActionClass;
  mode: QueueCleanupMode;
  reason: string | null;
  young: boolean;
  /** The class this record would enforce if it stood alone; null when it would only be observed (census cell,
   *  a report-only class, too young, or held by the loop guard). */
  wants: QueueCleanupEnforceableClass | null;
  /** D-13: the loop guard holds this record (`skipped_loop`); `priorRemovals` is how many earlier downloads of
   *  its album the janitor removed as manual_match. */
  loop: boolean;
  priorRemovals: number;
}

/** What one record's row says happened (action + outcome + the *arr error, if any). */
interface RecordResult {
  action: QueueCleanupAction;
  outcome: QueueCleanupOutcome;
  error: string | null;
}

const result = (
  action: QueueCleanupAction,
  outcome: QueueCleanupOutcome = 'observed',
  error: string | null = null,
): RecordResult => ({ action, outcome, error });

/**
 * D-13 — the records of a removed manual_match download to search again: those with an album (a record without
 * one is removed and blocklisted only) whose album the *arr reports monitored and still missing tracks. An
 * instance without the check never searches.
 */
async function manualMatchSearchTargets(
  client: QueueCleanupInstanceClient,
  items: QueueCleanupQueueItem[],
): Promise<QueueCleanupQueueItem[]> {
  const withAlbum = items.filter((i) => i.targetId != null);
  if (withAlbum.length === 0 || !client.missingMonitoredTargets) return [];
  return (await client.missingMonitoredTargets(withAlbum)).filter((i) => i.targetId != null);
}

/** A removal the *arr answered with 404: it no longer tracks the download (D-11 rule 5). */
const isGone = (err: unknown): boolean => err instanceof ArrHttpError && err.status === 404;

/**
 * Run one janitor pass over Sonarr/Radarr/Lidarr. Census rows are written ALWAYS (one per queue record — the
 * observation of record); enforce actions fire ONLY where the class×instance cell is `enforce`, behind the
 * rails (D-04): per-instance per-run cap `maxActionsPerRun`; `minItemAgeHours` before any action; a monitored
 * target check before a bad_release re-search; retry escalation via the persisted action-row lookback (counted
 * in runs); ProcessMonitoredDownloads at most once per instance per run; a failed *arr write → outcome 'error'
 * (logged, counts against the cap) + continue. `unknown` is NEVER acted on. `manual_match` acts only on Lidarr,
 * where its cell is enforced (D-13): remove + blocklist, then an album search only for a monitored album still
 * missing tracks; the loop guard holds an album already removed on MANUAL_MATCH_LOOP_LIMIT earlier downloads
 * (`skipped_loop`), and every loop event is one `[queue-cleanup] loop_detected` log line.
 *
 * The janitor acts once per DOWNLOAD, not once per record (D-11): records sharing a downloadId (a season pack's
 * episodes) get one call, which costs the cap once, and every one of them records that call's result; a
 * download whose records do not all qualify for the same action is left alone (`skipped_mixed`); a removal
 * the *arr answers with 404 is `skipped_gone`, not an error. The table is the single writer's whole audit
 * trail — no permission_audit / ledger coupling (append-only). Never throws for a per-instance failure.
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
    const report: QueueCleanupInstanceReport = {
      instance,
      read: false,
      itemsObserved: 0,
      actionsTaken: 0,
      covered: 0,
      errors: 0,
      byClass: emptyByClass(),
    };

    // D-14 — the janitor release block's upkeep (drift, expiry), whatever the cells say; never fails the run.
    if (JANITOR_BLOCK_KINDS.includes(instance) && client.releaseProfiles) {
      await reconcileJanitorReleaseBlockIfDue({
        db: input.db,
        instance,
        profiles: client.releaseProfiles,
        now,
        logger: input.logger,
      });
    }

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

    // 1. Each record's own verdict: class (with escalation), the mode in effect, the age rail, and what it wants.
    const verdicts = new Map<QueueCleanupQueueItem, RecordVerdict>();
    const priorRuns = new Map<string, Promise<number>>();
    for (const item of items) {
      const classified = classifyQueueItem(item);
      let actionClass: QueueCleanupActionClass = classified.class;

      // Escalation: a download still retry_import after `retryEscalateRuns` prior runs → bad_release handling.
      if (actionClass === 'retry_import' && item.downloadId) {
        let prior = priorRuns.get(item.downloadId);
        if (!prior) {
          prior = priorRetryImportRuns(db, instance, item.downloadId);
          priorRuns.set(item.downloadId, prior);
        }
        if ((await prior) >= config.retryEscalateRuns) actionClass = 'bad_release';
      }

      // `unknown` has no config cell and is never enforced; `manual_match` has a cell on Lidarr only (D-13); every
      // other class reads its instance cell. A missing cell reads as census.
      const mode = queueCleanupCellMode(config, instance, actionClass);
      const cellClass = mode === 'enforce' && isEnforceableQueueCleanupClass(actionClass) ? actionClass : null;
      // Conservative age rail: unknown age (no `added`) is treated as YOUNG so a possibly-fresh item is never
      // acted on. minItemAgeHours=0 disables the rail entirely. Real *arr records always carry `added`.
      const young =
        config.minItemAgeHours > 0 &&
        (item.addedAt === null || now.getTime() - item.addedAt.getTime() < minAgeMs);
      const wants = !young ? cellClass : null;
      verdicts.set(item, {
        item,
        actionClass,
        mode,
        reason: classified.reason,
        young,
        wants,
        loop: false,
        priorRemovals: 0,
      });
    }

    // 1b. The manual_match loop guard (D-13): an album the janitor already removed as manual_match on
    //     MANUAL_MATCH_LOOP_LIMIT earlier downloads is held (`skipped_loop`), never removed or searched again, while it
    //     is still monitored and missing tracks. Only then would the janitor search it again, so only then can it
    //     loop: an album that imported since (a later upgrade grab failing) or was unmonitored gets the removal and
    //     the block, and no search. A record with no album cannot loop through the janitor: it is never searched.
    const loopCandidates = [...verdicts.values()].filter(
      (v) => v.wants === 'manual_match' && v.item.targetId != null,
    );
    if (loopCandidates.length > 0) {
      try {
        const prior = await priorManualMatchRemovals(
          db,
          instance,
          distinctIds(loopCandidates.map((v) => v.item.targetId)),
        );
        const over = loopCandidates
          .map((v) => {
            const own = nonEmpty(v.item.downloadId);
            const earlier = [...(prior.get(v.item.targetId!) ?? [])].filter((d) => d !== own).length;
            return { v, earlier };
          })
          .filter((x) => x.earlier >= MANUAL_MATCH_LOOP_LIMIT);
        if (over.length > 0) {
          // Which of these albums would be searched again (monitored, still missing tracks)? No check ⇒ hold all.
          const searchable = client.missingMonitoredTargets
            ? new Set(await client.missingMonitoredTargets(over.map((x) => x.v.item)))
            : null;
          for (const { v, earlier } of over) {
            if (searchable !== null && !searchable.has(v.item)) continue;
            v.loop = true;
            v.priorRemovals = earlier;
            v.wants = null;
          }
        }
      } catch (err) {
        // The guard cannot tell which albums loop (a failed history or album read), so no manual_match download
        // is acted on this run (fail safe); the census rows are still written.
        for (const v of loopCandidates) v.wants = null;
        input.logger?.warn?.('queue-cleanup: loop-guard read failed, manual_match not acted on this run', {
          instance,
          error: errMsg(err),
        });
      }
    }

    // 2. One decision per download (D-11), in first-seen queue order — the cap is spent per download.
    const results = new Map<QueueCleanupQueueItem, RecordResult>();
    let actionsTaken = 0;
    let retryCommandRan = false;
    /** The records each search command covered this run, per download (the repeat-search check, D-13). */
    const searchedDownloads: QueueCleanupQueueItem[][] = [];

    for (const group of groupQueueRecordsByDownload(items)) {
      const members = group.map((item) => verdicts.get(item)!);
      const wanted = members[0]!.wants;
      const setAll = (r: RecordResult) => {
        for (const m of members) results.set(m.item, r);
      };

      // Nothing to enforce, or a mixed download: no call. A record that would have acted on its own records
      // `skipped_mixed`; the rest keep their own verdict (rule 3). A record held by the loop guard is
      // `skipped_loop`, and it holds the whole download like any other record the janitor would not touch (D-13).
      if (wanted === null || members.some((m) => m.wants !== wanted)) {
        const mixed = members.some((m) => m.wants !== null);
        for (const m of members) {
          results.set(
            m.item,
            m.young
              ? result('skipped_young')
              : m.loop
                ? result('skipped_loop')
                : m.wants
                  ? result('skipped_mixed')
                  : result('none'),
          );
        }
        const looping = members.filter((m) => m.loop);
        if (looping.length > 0) {
          input.logger?.warn?.(QUEUE_CLEANUP_LOOP_LOG, {
            kind: 'skipped_loop',
            instance,
            downloadId: members[0]!.item.downloadId,
            title: members[0]!.item.title,
            targetIds: distinctIds(looping.map((m) => m.item.targetId)),
            priorRemovals: Math.max(...looping.map((m) => m.priorRemovals)),
          });
        }
        if (mixed) {
          input.logger?.warn?.('queue-cleanup: mixed download left alone', {
            instance,
            downloadId: members[0]!.item.downloadId,
            records: members.length,
            classes: [...new Set(members.map((m) => m.actionClass))],
          });
        }
        continue;
      }

      const primary = members[0]!.item;
      if (wanted === 'retry_import') {
        if (retryCommandRan) {
          // The estate-wide command already ran this instance — the whole download is covered, no cap cost.
          setAll(result('retried_import', 'done'));
          report.covered += members.length;
        } else if (actionsTaken >= config.maxActionsPerRun) {
          setAll(result('skipped_cap'));
        } else {
          actionsTaken += 1;
          try {
            await client.processMonitoredDownloads();
            retryCommandRan = true;
            setAll(result('retried_import', 'done'));
          } catch (err) {
            setAll(result('none', 'error', errMsg(err)));
            report.errors += 1;
          }
          report.covered += members.length - 1;
        }
        continue;
      }

      if (actionsTaken >= config.maxActionsPerRun) {
        setAll(result('skipped_cap'));
        continue;
      }

      // manual_match (D-14, ADR-094) — the release NAME is blocked first: a whole-name term in the janitor's release
      // profile, written and read back. A name that cannot be blocked safely leaves the download alone.
      if (wanted === 'manual_match') {
        let term: JanitorBlockTerm;
        let releaseTitle: string | null = null;
        try {
          if (!client.releaseIdentity || !client.releaseProfiles) {
            throw new Error(`no janitor release block on ${instance}`);
          }
          const identity = await client.releaseIdentity(primary);
          releaseTitle = identity.releaseTitle;
          term = deriveJanitorBlockTerm(identity);
        } catch (err) {
          // A read failed: nothing was written, so it costs no cap slot; the next run tries again.
          setAll(result('none', 'error', `release identity: ${errMsg(err)}`));
          report.errors += 1;
          continue;
        }
        if ('refused' in term) {
          setAll(result('skipped_unblockable'));
          input.logger?.warn?.('queue-cleanup: release name cannot be blocked, download left alone', {
            instance,
            downloadId: primary.downloadId,
            reason: term.refused,
          });
          continue;
        }
        actionsTaken += 1;
        try {
          await reconcileJanitorReleaseBlock({
            db: input.db,
            instance,
            profiles: client.releaseProfiles,
            add: [
              {
                term: term.term,
                releaseTitle,
                downloadId: primary.downloadId,
                targetId: primary.targetId ?? null,
              },
            ],
            now,
            logger: input.logger,
          });
        } catch (err) {
          // Not blocked, so not removed (ADR-094): the next run tries again.
          setAll(result('none', 'error', errMsg(err)));
          report.errors += 1;
          report.covered += members.length - 1;
          continue;
        }
      } else {
        actionsTaken += 1;
      }

      // have_better / bad_release / manual_match: ONE removal for the whole download, through its first record —
      // the *arr removes and blocklists the download, so a second DELETE could only answer 404 (rule 2). Every
      // janitor removal passes skipRedownload (D-10): with the *arr's "Redownload Failed" on, a blocklisting
      // removal would otherwise re-search by itself — have_better must never re-search, and bad_release and
      // manual_match re-search only through their own checked search below.
      report.covered += members.length - 1;
      try {
        await client.deleteQueueItem(primary, JANITOR_REMOVAL);
      } catch (err) {
        if (isGone(err)) {
          // Rule 5: the *arr no longer tracks the download — nothing removed or blocklisted, and not an error.
          setAll(result('skipped_gone'));
          input.logger?.warn?.('queue-cleanup: removal answered 404, download already gone', {
            instance,
            queueItemId: primary.queueItemId,
            downloadId: primary.downloadId,
          });
        } else {
          setAll(result('none', 'error', errMsg(err)));
          report.errors += 1;
        }
        continue;
      }

      if (wanted === 'have_better') {
        setAll(result('removed_blocklisted', 'done'));
        continue;
      }

      // bad_release — re-search every record whose target is still monitored, in one command (rule 4).
      // manual_match (D-13) — search only the albums that are monitored AND still missing tracks, in one
      // AlbumSearch; a record with no album is removed and blocklisted, never searched (no artist-wide search).
      try {
        const searchable = new Set(
          wanted === 'manual_match'
            ? await manualMatchSearchTargets(client, members.map((m) => m.item))
            : await client.monitoredTargets(members.map((m) => m.item)),
        );
        if (searchable.size > 0) {
          const toSearch = members.filter((m) => searchable.has(m.item)).map((m) => m.item);
          await client.searchTargets(toSearch);
          searchedDownloads.push(toSearch);
        }
        for (const m of members) {
          results.set(
            m.item,
            result(searchable.has(m.item) ? 'blocklisted_searched' : 'removed_blocklisted', 'done'),
          );
        }
      } catch (err) {
        // The removal landed; only the check or the search failed — the row must not hide the removal.
        setAll(result('removed_blocklisted', 'error', errMsg(err)));
        report.errors += 1;
      }
    }

    // 2b. The repeat-search signal (D-13): a target this run searched that the janitor also searched on an earlier
    //     run within 7 days is logged, whatever the class. Read-only; a failed read never fails the run.
    if (searchedDownloads.length > 0) {
      try {
        const prior = await priorSearchRuns(
          db,
          instance,
          distinctIds(searchedDownloads.flat().map((i) => i.targetId)),
          new Date(now.getTime() - REPEAT_SEARCH_WINDOW_MS),
        );
        for (const searched of searchedDownloads) {
          const repeats = distinctIds(searched.map((i) => i.targetId))
            .filter((id) => (prior.get(id) ?? 0) >= 1)
            .map((targetId) => ({ targetId, searches7d: (prior.get(targetId) ?? 0) + 1 }));
          if (repeats.length === 0) continue;
          input.logger?.warn?.(QUEUE_CLEANUP_LOOP_LOG, {
            kind: 'repeat_search',
            instance,
            downloadId: searched[0]!.downloadId,
            title: searched[0]!.title,
            actionClass: verdicts.get(searched[0]!)!.actionClass,
            targets: repeats,
          });
        }
      } catch (err) {
        input.logger?.warn?.('queue-cleanup: repeat-search read failed', { instance, error: errMsg(err) });
      }
    }

    // 3. One row per record, in queue order.
    for (const item of items) {
      const v = verdicts.get(item)!;
      const r = results.get(item)!;
      rows.push({
        instance,
        queueItemId: item.queueItemId,
        downloadId: item.downloadId,
        title: item.title,
        targetId: item.targetId ?? null,
        actionClass: v.actionClass,
        mode: v.mode,
        action: r.action,
        outcome: r.outcome,
        reason: v.reason,
        error: r.error,
        createdAt: now,
      });
      report.itemsObserved += 1;
      report.byClass[v.actionClass].observed += 1;
      if (r.outcome === 'done') report.byClass[v.actionClass].enforced += 1;
    }

    report.actionsTaken = actionsTaken;
    input.logger?.info?.('queue-cleanup evaluated', {
      instance,
      observed: report.itemsObserved,
      actionsTaken,
      covered: report.covered,
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
 * Derive the ladder level from the modes matrix (D-05). L0 = all census; L2 = every cell enforced, Lidarr's
 * `manual_match` included since D-13 (L3 is human-only, set via the plan — never derived above L2); L1 = any
 * partial enforcement (the modes matrix, exposed alongside, shows exactly which cells). Kept deliberately
 * simple + documented.
 */
export function deriveQueueCleanupLadderLevel(config: ArrQueueCleanupConfig): number {
  let anyEnforce = false;
  let allEnforce = true;
  for (const instance of ARR_KINDS) {
    for (const klass of QUEUE_CLEANUP_INSTANCE_CLASSES[instance]) {
      if (queueCleanupCellMode(config, instance, klass) === 'enforce') anyEnforce = true;
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

/** One loop the digest names (D-13): a download the loop guard held, or a target searched again and again. */
export interface QueueCleanupDigestLoop {
  instance: ArrKind;
  /** The search target (Lidarr album id, Sonarr episode id, Radarr movie id), or null when the record had none. */
  targetId: number | null;
  downloadId: string | null;
  /** The release name of the latest row. */
  title: string | null;
  /** `skipped`: the runs in 24h the guard held it on. `repeatSearches`: the runs in 7 days it was searched on. */
  runs: number;
}

export interface QueueCleanupDigestLoops {
  /** Every download the loop guard held (`skipped_loop`) in the last 24h. */
  skipped: QueueCleanupDigestLoop[];
  /** Every target the janitor searched on 2+ runs in the last 7 days, any class (downloadId: the latest). */
  repeatSearches: QueueCleanupDigestLoop[];
}

export interface QueueCleanupDigestSection {
  /** Total rows observed in the last 24h. */
  observed: number;
  /** Total rows the janitor enforced (outcome 'done') in the last 24h. */
  actions: number;
  instances: QueueCleanupDigestInstance[];
  ladder: { level: number; ageDays: number | null; nextCriteria: string };
  promotionDue: boolean;
  /** D-13 loop visibility: the subject gains `[janitor: loop detected]` when either list is non-empty. */
  loops: QueueCleanupDigestLoops;
  loopDetected: boolean;
  /** D-14: per *arr with a janitor release block, the names blocked in 24h and the live terms (empty: none). */
  releaseBlock: Array<{ instance: ArrKind; blocked24h: number; live: number }>;
}

/**
 * D-13 — the digest's loop lists: every download the loop guard held in the last 24h (one entry per instance,
 * target and download, with the runs it was held on), and every target the janitor searched on 2+ distinct runs
 * in the last 7 days (whatever the class).
 */
async function buildQueueCleanupDigestLoops(
  db: ReturnType<typeof resolveDb>,
  now: Date,
): Promise<QueueCleanupDigestLoops> {
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const heldRows = await db
    .select({
      instance: arrQueueCleanupActions.instance,
      targetId: arrQueueCleanupActions.targetId,
      downloadId: arrQueueCleanupActions.downloadId,
      title: arrQueueCleanupActions.title,
      createdAt: arrQueueCleanupActions.createdAt,
    })
    .from(arrQueueCleanupActions)
    .where(
      and(
        eq(arrQueueCleanupActions.action, 'skipped_loop'),
        gte(arrQueueCleanupActions.createdAt, since24h),
      ),
    )
    .orderBy(desc(arrQueueCleanupActions.createdAt));
  const held = new Map<string, { loop: QueueCleanupDigestLoop; runs: Set<number> }>();
  for (const r of heldRows) {
    const key = `${r.instance}:${r.targetId ?? ''}:${r.downloadId ?? ''}`;
    let acc = held.get(key);
    if (!acc) {
      // Rows come newest first, so the first one seen carries the latest title.
      acc = {
        loop: { instance: r.instance, targetId: r.targetId, downloadId: r.downloadId, title: r.title, runs: 0 },
        runs: new Set(),
      };
      held.set(key, acc);
    }
    acc.runs.add(r.createdAt.getTime());
  }
  const skipped = [...held.values()].map(({ loop, runs }) => ({ ...loop, runs: runs.size }));

  const since7d = new Date(now.getTime() - REPEAT_SEARCH_WINDOW_MS);
  const runs = sql<number>`count(distinct ${arrQueueCleanupActions.createdAt})`;
  const repeatRows = await db
    .select({
      instance: arrQueueCleanupActions.instance,
      targetId: arrQueueCleanupActions.targetId,
      runs,
      title: sql<
        string | null
      >`(array_agg(${arrQueueCleanupActions.title} ORDER BY ${arrQueueCleanupActions.createdAt} DESC))[1]`,
      downloadId: sql<
        string | null
      >`(array_agg(${arrQueueCleanupActions.downloadId} ORDER BY ${arrQueueCleanupActions.createdAt} DESC))[1]`,
    })
    .from(arrQueueCleanupActions)
    .where(
      and(
        eq(arrQueueCleanupActions.action, 'blocklisted_searched'),
        eq(arrQueueCleanupActions.outcome, 'done'),
        isNotNull(arrQueueCleanupActions.targetId),
        gte(arrQueueCleanupActions.createdAt, since7d),
      ),
    )
    .groupBy(arrQueueCleanupActions.instance, arrQueueCleanupActions.targetId)
    .having(sql`count(distinct ${arrQueueCleanupActions.createdAt}) >= 2`);
  const repeatSearches = repeatRows
    .map((r) => ({
      instance: r.instance,
      targetId: r.targetId,
      downloadId: r.downloadId,
      title: r.title,
      runs: Number(r.runs),
    }))
    .sort(
      (a, b) =>
        b.runs - a.runs || a.instance.localeCompare(b.instance) || (a.targetId ?? 0) - (b.targetId ?? 0),
    );
  return { skipped, repeatSearches };
}

/**
 * Build the nightly digest's janitor rollup (D-07) from the last-24h arr_queue_cleanup_actions rows: per
 * instance × class counts (census vs enforced), the top-3 distinct reasons per class with counts, and the
 * ladder line (level + age + next criteria) with the stagnation nag, and the loop lists (D-13). Returns null when
 * the janitor observed NOTHING in 24h (so a run that saw no queue items adds no section and does not force a
 * digest).
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
  const loops = await buildQueueCleanupDigestLoops(db, now);
  const releaseBlock = await janitorBlockDigest({ db, now });

  return {
    observed: recent.length,
    actions,
    instances,
    ladder: { level: ladder.level, ageDays: ladder.ageDays, nextCriteria: ladder.nextCriteria },
    promotionDue: ladder.promotionDue,
    loops,
    loopDetected: loops.skipped.length > 0 || loops.repeatSearches.length > 0,
    releaseBlock,
  };
}
