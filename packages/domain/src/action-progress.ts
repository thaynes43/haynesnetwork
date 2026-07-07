// PLAN-015 / DESIGN-005 D-20 — the Action Feedback projection (ADR-028). A READ-ONLY,
// derive-on-demand view of a downstream *arr action's live progress: given a Fix row (or the
// latest Force-Search `search_requested` event) + a LIVE read of the owning *arr's download
// queue + the sync-ingested ledger milestones, it computes a user-facing Action Progress Phase.
//
// NOTHING here writes. No new table, no migration, no enum growth (ADR-028): the phase is a
// projection recomputed per poll. The single live *arr read is the queue (read side of the
// bundle — the @hnet/arr/write import guard is untouched); everything else is a cheap DB read
// of ledger_events (the authoritative grabbed/imported/download_failed milestones the sync cron
// already ingests, so History stays correct even when nobody is watching).
import {
  fixRequests,
  ledgerEvents,
  mediaItems,
  type ArrKind,
  type DbClient,
} from '@hnet/db';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { NotFoundError } from './errors';
import { guardArrCall, listMediaChildren, type MediaChildTarget } from './media-children';
import { resolveSearchTarget, type SearchScope } from './action-scope';
import type { ArrClientBundle } from './arr-clients';

// ---------------------------------------------------------------------------
// The phase model — the WIRE CONTRACT the Fable progress-UI agent consumes (DESIGN-005 D-20).
// ---------------------------------------------------------------------------

/**
 * DDD-001 T-90 — the derived, user-facing status of a downstream *arr action between trigger
 * and terminal. NEVER stored; recomputed per poll from (fix row | search event) + live Queue
 * (T-91) + recent ledger history.
 *
 *   non-terminal:  searching → queued → grabbed → downloading → importing
 *   terminal:      completed | nothing_found | stalled | failed
 */
export type ActionPhase =
  | 'queued'
  | 'searching'
  | 'grabbed'
  | 'downloading'
  | 'importing'
  | 'completed'
  | 'nothing_found'
  | 'stalled'
  | 'failed';

export interface ActionProgressChild {
  /** The *arr child id this row targets (sonarr episodeId / lidarr albumId). */
  childId: number;
  /** Display-durable label ('S06E02 · Rich' / album title). */
  label: string;
  phase: ActionPhase;
  /** 0–100 download percent (from size/sizeleft), when the child is in the queue. */
  progressPct?: number;
}

export interface ActionProgress {
  /** The headline phase (for a roll-up: the least-advanced non-terminal child). */
  phase: ActionPhase;
  /** 0–100 download percent (from size/sizeleft; summed across a roll-up's queue records). */
  progressPct?: number;
  /** Seconds until the *arr's estimatedCompletionTime (downloading only), floored at 0. */
  etaSeconds?: number;
  /** Per-child phases for a season/artist roll-up (T-89); absent for single targets. */
  perChild?: ActionProgressChild[];
  /** A short human note for the terminal/stalled cases (the stall reason). */
  message?: string;
}

// ---------------------------------------------------------------------------
// Never-stuck windows (ADR-028 D2/D3; constants, not settings v1).
// ---------------------------------------------------------------------------

/** No grab within this window after a search ⇒ the terminal `nothing_found` (ADR-028 D2). */
export const FOUND_NOTHING_WINDOW_MS = 15 * 60 * 1000; // 15 min

/**
 * A non-terminal action older than this with no queue/import activity ⇒ `stalled` (ADR-028
 * D3). `trackedDownloadStatus:'error'` on a live queue record is `stalled` immediately.
 */
export const STALLED_THRESHOLD_MS = 45 * 60 * 1000; // 45 min

const TERMINAL_PHASES: ReadonlySet<ActionPhase> = new Set([
  'completed',
  'nothing_found',
  'stalled',
  'failed',
]);

export function isTerminalPhase(phase: ActionPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** Advancement order among the NON-terminal phases (roll-up picks the least-advanced). */
const ADVANCEMENT: Record<ActionPhase, number> = {
  searching: 0,
  queued: 1,
  grabbed: 2,
  downloading: 3,
  importing: 4,
  completed: 5,
  nothing_found: 5,
  stalled: 5,
  failed: 5,
};

// ---------------------------------------------------------------------------
// A kind-agnostic queue record — the normalized subset the derivation reasons over.
// ---------------------------------------------------------------------------

/** The kind-agnostic queue record the derivation reasons over (exported for the phase-matrix tests). */
export interface NormalizedQueueRecord {
  status: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  size: number;
  sizeleft: number;
  estimatedCompletionTime: string | null;
  message: string | null;
  /** sonarr episodeId / lidarr albumId; null for radarr (the movie is the target). */
  childId: number | null;
  /** sonarr season number; null otherwise. */
  seasonNumber: number | null;
}

function queueMessage(rec: {
  errorMessage?: string | null;
  statusMessages?: { title?: string | null; messages?: string[] | null }[] | null;
}): string | null {
  if (rec.errorMessage) return rec.errorMessage;
  const first = rec.statusMessages?.find((m) => (m.messages?.length ?? 0) > 0 || m.title);
  if (!first) return null;
  return first.messages?.[0] ?? first.title ?? null;
}

/** Read the owning *arr's live queue for a parent id and normalize to the kind-agnostic shape. */
async function readNormalizedQueue(
  arr: Pick<ArrClientBundle, 'read'>,
  kind: ArrKind,
  parentArrItemId: number,
): Promise<NormalizedQueueRecord[]> {
  const norm = (rec: {
    status: string;
    trackedDownloadStatus?: string | null;
    trackedDownloadState?: string | null;
    size?: number | null;
    sizeleft?: number | null;
    estimatedCompletionTime?: string | null;
    errorMessage?: string | null;
    statusMessages?: { title?: string | null; messages?: string[] | null }[] | null;
    childId: number | null;
    seasonNumber: number | null;
  }): NormalizedQueueRecord => ({
    status: rec.status ?? '',
    trackedDownloadStatus: rec.trackedDownloadStatus ?? '',
    trackedDownloadState: rec.trackedDownloadState ?? '',
    size: rec.size ?? 0,
    sizeleft: rec.sizeleft ?? 0,
    estimatedCompletionTime: rec.estimatedCompletionTime ?? null,
    message: queueMessage(rec),
    childId: rec.childId,
    seasonNumber: rec.seasonNumber,
  });

  if (kind === 'sonarr') {
    const records = await guardArrCall('sonarr GET /queue', () =>
      arr.read.sonarr.getQueue(parentArrItemId),
    );
    return records.map((r) =>
      norm({ ...r, childId: r.episodeId ?? null, seasonNumber: r.seasonNumber ?? null }),
    );
  }
  if (kind === 'lidarr') {
    const records = await guardArrCall('lidarr GET /queue', () =>
      arr.read.lidarr.getQueue(parentArrItemId),
    );
    return records.map((r) => norm({ ...r, childId: r.albumId ?? null, seasonNumber: null }));
  }
  const records = await guardArrCall('radarr GET /queue', () =>
    arr.read.radarr.getQueue(parentArrItemId),
  );
  return records.map((r) => norm({ ...r, childId: null, seasonNumber: null }));
}

// ---------------------------------------------------------------------------
// Pure derivation — exported for the phase-matrix unit tests (no DB, no *arr).
// ---------------------------------------------------------------------------

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Map ONE live queue record to a phase, ignoring the time windows (those apply only when a
 * target is ABSENT from the queue). Precedence: definitive failure → hard error (stalled,
 * ADR-028 D3) → import lifecycle → active download → client wait state.
 */
export function phaseFromQueueRecord(rec: {
  status: string;
  trackedDownloadStatus: string;
  trackedDownloadState: string;
  message?: string | null;
}): { phase: ActionPhase; message?: string } {
  const state = rec.trackedDownloadState.toLowerCase();
  const tds = rec.trackedDownloadStatus.toLowerCase();
  const status = rec.status.toLowerCase();
  const message = rec.message ?? undefined;

  if (state === 'failed' || state === 'failedpending' || status === 'failed') {
    return { phase: 'failed', message };
  }
  // A hard tracked-download error is stalled immediately (recoverable — retry affordance).
  if (tds === 'error') return { phase: 'stalled', message };
  if (state === 'imported') return { phase: 'completed' };
  if (state === 'importing' || state === 'importpending') return { phase: 'importing' };
  // Import needs manual attention (blocked/failed-to-import/ignored) — stalled, not failed.
  if (state === 'importblocked' || state === 'importfailed' || state === 'ignored') {
    return { phase: 'stalled', message };
  }
  // Client wait states — NOT actively pulling bytes even when the tracked state is 'downloading'
  // (a paused/delayed grab sits at 0% progress) → queued, checked before the downloading catch.
  if (status === 'queued' || status === 'delay' || status === 'paused') {
    return { phase: 'queued', message };
  }
  if (state === 'downloading' || status === 'downloading') return { phase: 'downloading' };
  if (status === 'completed') return { phase: 'importing' }; // download done, import imminent
  // A transient client warning with no download/import signal keeps moving (queued), not stalled:
  // warnings resolve on their own (verified live 2026-07-07); the 45-min window catches the rest.
  if (status === 'downloadclientunavailable' || status === 'warning' || tds === 'warning') {
    return { phase: 'queued', message };
  }
  return { phase: 'downloading', message };
}

function etaSecondsFrom(records: NormalizedQueueRecord[], now: Date): number | undefined {
  let latest: number | undefined;
  for (const r of records) {
    if (!r.estimatedCompletionTime) continue;
    const t = Date.parse(r.estimatedCompletionTime);
    if (Number.isNaN(t)) continue;
    latest = latest === undefined ? t : Math.max(latest, t);
  }
  if (latest === undefined) return undefined;
  return Math.max(0, Math.round((latest - now.getTime()) / 1000));
}

/** Aggregate the queue records that back ONE target into a single phase + percent + eta. */
function aggregateQueuePhase(
  records: NormalizedQueueRecord[],
  now: Date,
): { phase: ActionPhase; progressPct?: number; etaSeconds?: number; message?: string } {
  const perRec = records.map((r) => ({ ...phaseFromQueueRecord(r), rec: r }));
  const nonTerminal = perRec.filter((p) => !isTerminalPhase(p.phase));

  let phase: ActionPhase;
  let message: string | undefined;
  if (nonTerminal.length > 0) {
    // Least-advanced non-terminal record leads (mirrors the roll-up rule).
    const min = nonTerminal.reduce((a, b) =>
      ADVANCEMENT[a.phase] <= ADVANCEMENT[b.phase] ? a : b,
    );
    phase = min.phase;
    message = min.message;
  } else {
    const pick =
      perRec.find((p) => p.phase === 'completed') ??
      perRec.find((p) => p.phase === 'stalled') ??
      perRec.find((p) => p.phase === 'failed') ??
      perRec[0]!;
    phase = pick.phase;
    message = pick.message;
  }

  const sized = records.filter((r) => r.size > 0);
  const sumSize = sized.reduce((s, r) => s + r.size, 0);
  const sumLeft = sized.reduce((s, r) => s + Math.min(r.sizeleft, r.size), 0);
  const progressPct = sumSize > 0 ? clampPct(((sumSize - sumLeft) / sumSize) * 100) : undefined;
  const etaSeconds = phase === 'downloading' ? etaSecondsFrom(records, now) : undefined;
  return { phase, progressPct, etaSeconds, message };
}

export interface DeriveTargetInput {
  now: Date;
  /** The window anchor — fix.created_at OR the search_requested event's occurred_at. */
  anchorAt: Date;
  /** A hard terminal already stamped on the durable fix row (authority beats the projection). */
  rowTerminal?: 'completed' | 'failed';
  /** A bazarr_subtitle fix has no *arr queue/import — it rests at `searching` (never stalls). */
  isSubtitle?: boolean;
  /** The live queue records matching THIS target (already filtered). */
  queueRecords: NormalizedQueueRecord[];
  /** A matching `imported` ledger milestone landed since the anchor (⇒ completed). */
  hasImported?: boolean;
  /** A `grabbed` milestone landed since the anchor. */
  hasGrabbed?: boolean;
  /** A `download_failed` milestone landed since the anchor. */
  hasDownloadFailed?: boolean;
  /** The most recent matching ledger milestone time (staleness reference after a grab). */
  lastActivityAt?: Date;
}

/**
 * The heart of ADR-028 — derive ONE target's phase from (row terminal | live queue | ledger
 * milestones | the two windows). Pure; the DB/*arr I/O lives in compute{Fix,Search}Progress.
 */
export function derivePhaseForTarget(
  input: DeriveTargetInput,
): { phase: ActionPhase; progressPct?: number; etaSeconds?: number; message?: string } {
  // 1. The durable fix row is authority for its terminals (the projection never overrides it).
  if (input.rowTerminal === 'failed') return { phase: 'failed' };
  if (input.rowTerminal === 'completed' || input.hasImported) {
    return { phase: 'completed', progressPct: 100 };
  }

  // 2. Subtitle fixes never touch the *arr queue — fire-and-forget at `searching`.
  if (input.isSubtitle) return { phase: 'searching', message: 'subtitles requested' };

  // 3. A download_failed with nothing live in the queue is a hard failure.
  if (input.hasDownloadFailed && input.queueRecords.length === 0) return { phase: 'failed' };

  // 4. Live in the queue → download/import phase (the authoritative in-flight signal).
  if (input.queueRecords.length > 0) return aggregateQueuePhase(input.queueRecords, input.now);

  // 5. Grabbed but not (yet) in the queue and not imported → grabbed, unless it went stale.
  if (input.hasGrabbed) {
    const since = (input.lastActivityAt ?? input.anchorAt).getTime();
    if (input.now.getTime() - since >= STALLED_THRESHOLD_MS) {
      return { phase: 'stalled', message: 'the download stopped before importing' };
    }
    return { phase: 'grabbed' };
  }

  // 6. No queue, no grab: still searching inside the window, else the never-stuck nothing_found.
  const age = input.now.getTime() - input.anchorAt.getTime();
  return age >= FOUND_NOTHING_WINDOW_MS ? { phase: 'nothing_found' } : { phase: 'searching' };
}

/** Roll-up headline: the least-advanced NON-terminal child, else the best terminal. */
export function rollupHeadlinePhase(childPhases: ActionPhase[]): ActionPhase {
  if (childPhases.length === 0) return 'nothing_found';
  const nonTerminal = childPhases.filter((p) => !isTerminalPhase(p));
  if (nonTerminal.length > 0) {
    return nonTerminal.reduce((a, b) => (ADVANCEMENT[a] <= ADVANCEMENT[b] ? a : b));
  }
  if (childPhases.includes('completed')) return 'completed';
  if (childPhases.includes('stalled')) return 'stalled';
  if (childPhases.includes('failed')) return 'failed';
  return 'nothing_found';
}

// ---------------------------------------------------------------------------
// Ledger-milestone flags (the sync-ingested grabbed/imported/download_failed events).
// ---------------------------------------------------------------------------

interface MilestoneEvent {
  eventType: string;
  occurredAt: Date;
  childId: number | null; // payload.episodeId / payload.albumId
}

const MILESTONE_TYPES = ['grabbed', 'imported', 'download_failed'] as const;

async function loadMilestones(
  db: ReturnType<typeof resolveDb>,
  mediaItemId: string,
  since: Date,
): Promise<MilestoneEvent[]> {
  const rows = await db
    .select({
      eventType: ledgerEvents.eventType,
      occurredAt: ledgerEvents.occurredAt,
      payload: ledgerEvents.payload,
    })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.mediaItemId, mediaItemId),
        inArray(ledgerEvents.eventType, [...MILESTONE_TYPES]),
        gte(ledgerEvents.occurredAt, since),
      ),
    )
    .orderBy(desc(ledgerEvents.occurredAt));
  return rows.map((r) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const raw = payload.episodeId ?? payload.albumId ?? null;
    const childId = typeof raw === 'number' ? raw : raw != null ? Number(raw) : null;
    return {
      eventType: r.eventType,
      occurredAt: r.occurredAt,
      childId: childId != null && Number.isFinite(childId) ? childId : null,
    };
  });
}

interface TargetFlags {
  hasImported: boolean;
  hasGrabbed: boolean;
  hasDownloadFailed: boolean;
  lastActivityAt?: Date;
}

/**
 * Reduce the milestone events to per-target flags. `childId === null` (radarr / show / artist /
 * item) matches ANY milestone for the media item (mirrors completeFixRequests' radarr rule);
 * a specific child matches events whose payload episode/album id equals it.
 */
function flagsForTarget(events: MilestoneEvent[], childId: number | null): TargetFlags {
  const flags: TargetFlags = { hasImported: false, hasGrabbed: false, hasDownloadFailed: false };
  for (const e of events) {
    if (childId !== null && e.childId !== childId) continue;
    if (e.eventType === 'imported') flags.hasImported = true;
    else if (e.eventType === 'grabbed') flags.hasGrabbed = true;
    else if (e.eventType === 'download_failed') flags.hasDownloadFailed = true;
    if (!flags.lastActivityAt || e.occurredAt > flags.lastActivityAt) {
      flags.lastActivityAt = e.occurredAt;
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Roll-up projection (season episodes / artist albums).
// ---------------------------------------------------------------------------

function projectRollup(
  children: MediaChildTarget[],
  queue: NormalizedQueueRecord[],
  events: MilestoneEvent[],
  now: Date,
  anchorAt: Date,
): ActionProgress {
  const perChild: ActionProgressChild[] = children.map((child) => {
    const records = queue.filter((r) => r.childId === child.arrChildId);
    const flags = flagsForTarget(events, child.arrChildId);
    const derived = derivePhaseForTarget({
      now,
      anchorAt,
      queueRecords: records,
      hasImported: flags.hasImported,
      hasGrabbed: flags.hasGrabbed,
      hasDownloadFailed: flags.hasDownloadFailed,
      lastActivityAt: flags.lastActivityAt,
    });
    return {
      childId: child.arrChildId,
      label: child.label,
      phase: derived.phase,
      ...(derived.progressPct !== undefined ? { progressPct: derived.progressPct } : {}),
    };
  });

  const phase = rollupHeadlinePhase(perChild.map((c) => c.phase));
  // Overall percent across every child's queue records (household "42% overall").
  const sized = queue.filter((r) => r.size > 0);
  const sumSize = sized.reduce((s, r) => s + r.size, 0);
  const sumLeft = sized.reduce((s, r) => s + Math.min(r.sizeleft, r.size), 0);
  const progressPct = sumSize > 0 ? clampPct(((sumSize - sumLeft) / sumSize) * 100) : undefined;

  return {
    phase,
    ...(progressPct !== undefined ? { progressPct } : {}),
    perChild,
  };
}

// ---------------------------------------------------------------------------
// The two projectors — the tRPC procedures call these (queries, never mutations).
// ---------------------------------------------------------------------------

export interface ComputeFixProgressInput {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  fixRequestId: string;
  /** The caller — own-fix (requester) or admin may read; anyone else sees NOT_FOUND (no leak). */
  requesterId: string;
  requesterIsAdmin?: boolean;
}

/**
 * ADR-028 — the live Action Progress Phase for a Fix. Reads the fix row (authority for its own
 * terminals) + ONE live queue read + the sync-ingested ledger milestones, and derives the phase.
 * Own-fix or admin only. A season fix reports per-child episode phases + the roll-up headline.
 */
export async function computeFixProgress(input: ComputeFixProgressInput): Promise<ActionProgress> {
  const db = resolveDb(input.db);
  const [fix] = await db
    .select({
      id: fixRequests.id,
      requesterId: fixRequests.requesterId,
      status: fixRequests.status,
      targetScope: fixRequests.targetScope,
      targetArrChildId: fixRequests.targetArrChildId,
      targetSeason: fixRequests.targetSeason,
      pathTaken: fixRequests.pathTaken,
      createdAt: fixRequests.createdAt,
      mediaItemId: fixRequests.mediaItemId,
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
    })
    .from(fixRequests)
    .innerJoin(mediaItems, eq(mediaItems.id, fixRequests.mediaItemId))
    .where(eq(fixRequests.id, input.fixRequestId));
  if (!fix) throw new NotFoundError(`Fix request ${input.fixRequestId} not found`);
  // Own-fix or admin. Non-owners get NOT_FOUND (never reveal another member's fix exists).
  if (fix.requesterId !== input.requesterId && !input.requesterIsAdmin) {
    throw new NotFoundError(`Fix request ${input.fixRequestId} not found`);
  }

  const now = new Date();
  const anchorAt = fix.createdAt;
  const kind = fix.arrKind;
  const rowTerminal =
    fix.status === 'completed' ? 'completed' : fix.status === 'failed' ? 'failed' : undefined;
  const isSubtitle = fix.pathTaken === 'bazarr_subtitle';

  const queue = await readNormalizedQueue(input.arr, kind, fix.arrItemId);
  const events = await loadMilestones(db, fix.mediaItemId, anchorAt);

  // Season roll-up — per-episode phases + the least-advanced headline.
  if (fix.targetScope === 'season' && fix.targetSeason !== null) {
    const children = await listMediaChildren({
      db: input.db,
      arr: input.arr,
      mediaItemId: fix.mediaItemId,
    });
    const seasonChildren = children.filter((c) => c.seasonNumber === fix.targetSeason);
    if (seasonChildren.length > 0) {
      return projectRollup(seasonChildren, queue, events, now, anchorAt);
    }
    // Fall through to a headline over the whole-series queue if no children resolve.
  }

  const childId = fix.targetArrChildId; // null for radarr / item / season-fallback
  const records = childId === null ? queue : queue.filter((r) => r.childId === childId);
  const flags = flagsForTarget(events, childId);
  return derivePhaseForTarget({
    now,
    anchorAt,
    rowTerminal,
    isSubtitle,
    queueRecords: records,
    hasImported: flags.hasImported,
    hasGrabbed: flags.hasGrabbed,
    hasDownloadFailed: flags.hasDownloadFailed,
    lastActivityAt: flags.lastActivityAt,
  });
}

export interface ComputeSearchProgressInput {
  db?: DbClient;
  arr: Pick<ArrClientBundle, 'read'>;
  mediaItemId: string;
  scope?: SearchScope;
  targetChildId?: number;
  seasonNumber?: number;
  /** The caller — own-search (the event's requester) or admin; else NOT_FOUND. */
  requesterId: string;
  requesterIsAdmin?: boolean;
}

/**
 * ADR-028 — the live Action Progress Phase for a Force Search. Force Search leaves no
 * fix_requests row, so this keys off the MOST RECENT `search_requested` ledger event for the
 * grain (its occurred_at is the window/staleness anchor). Own-search or admin only. Season/artist
 * scopes report per-child phases; whole-show is a headline over the series queue.
 */
export async function computeSearchProgress(
  input: ComputeSearchProgressInput,
): Promise<ActionProgress> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({ id: mediaItems.id, arrKind: mediaItems.arrKind, arrItemId: mediaItems.arrItemId })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);

  const kind = item.arrKind;
  // Resolve the grain exactly as recordSearchRequest did, so we match the stored event.
  const resolved = resolveSearchTarget(kind, {
    scope: input.scope,
    targetChildId: input.targetChildId,
    seasonNumber: input.seasonNumber,
  });

  const searchEvents = await db
    .select({
      occurredAt: ledgerEvents.occurredAt,
      requestedByUserId: ledgerEvents.requestedByUserId,
      payload: ledgerEvents.payload,
    })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.mediaItemId, input.mediaItemId),
        eq(ledgerEvents.eventType, 'search_requested'),
      ),
    )
    .orderBy(desc(ledgerEvents.occurredAt));

  const match = searchEvents.find((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const childRaw = p.targetArrChildId;
    const child = typeof childRaw === 'number' ? childRaw : childRaw != null ? Number(childRaw) : null;
    const seasonRaw = p.seasonNumber;
    const season = typeof seasonRaw === 'number' ? seasonRaw : seasonRaw != null ? Number(seasonRaw) : null;
    return p.scope === resolved.scope && child === resolved.targetChildId && season === resolved.seasonNumber;
  });
  if (!match) {
    throw new NotFoundError(`No force-search on record for this target`);
  }
  // Own-search or admin. Non-owners get NOT_FOUND (no leak).
  if (match.requestedByUserId !== input.requesterId && !input.requesterIsAdmin) {
    throw new NotFoundError(`No force-search on record for this target`);
  }

  const now = new Date();
  const anchorAt = match.occurredAt;
  const queue = await readNormalizedQueue(input.arr, kind, item.arrItemId);
  const events = await loadMilestones(db, input.mediaItemId, anchorAt);

  // Season / artist roll-up — per-child phases (episodes of the season / the artist's albums).
  if (resolved.scope === 'season' && resolved.seasonNumber !== null) {
    const children = await listMediaChildren({
      db: input.db,
      arr: input.arr,
      mediaItemId: input.mediaItemId,
    });
    const seasonChildren = children.filter((c) => c.seasonNumber === resolved.seasonNumber);
    if (seasonChildren.length > 0) return projectRollup(seasonChildren, queue, events, now, anchorAt);
  }
  if (resolved.scope === 'artist') {
    const children = await listMediaChildren({
      db: input.db,
      arr: input.arr,
      mediaItemId: input.mediaItemId,
    });
    if (children.length > 0) return projectRollup(children, queue, events, now, anchorAt);
  }

  // Single target (episode / album / movie) or a whole-show headline over the series queue.
  const childId = resolved.targetChildId; // null for item / show
  const records = childId === null ? queue : queue.filter((r) => r.childId === childId);
  // A whole-show search has no single completion — don't let one episode's import read as complete.
  const treatImportAsComplete = resolved.scope !== 'show';
  const flags = flagsForTarget(events, childId);
  return derivePhaseForTarget({
    now,
    anchorAt,
    queueRecords: records,
    hasImported: treatImportAsComplete && flags.hasImported,
    hasGrabbed: flags.hasGrabbed,
    hasDownloadFailed: flags.hasDownloadFailed,
    lastActivityAt: flags.lastActivityAt,
  });
}
