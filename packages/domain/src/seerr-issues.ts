// ADR-111 C-01, C-02 / ADR-112 C-02, C-03 / DESIGN-055 D-10, D-11, D-12 (PLAN-077 P3) — the Seerr Issue mirror (T-311)
// and its single writer. Read-only toward Seerr: the `seerr-issues` sync (every 10 minutes) pages every issue, an issue
// webhook and the `/r/seerr/<id>` link read one issue fresh; a webhook body is never state. The mirror keeps one row
// per Seerr issue with the ledger item (movie by tmdb, TV by tvdb: DESIGN-005 D-14), the Sonarr episode, the reporter's
// app account (by email, never stored) and the first message. The staff note and the "fixed by hand" mark are the app's
// own (D-12), written with their permission_audit row in one transaction (hard rule 6).
//
// The linked repairs an admin sees come from the app's own records (ADR-111 C-08): Repair Requests, Fixes and Force
// Searches on the same title and grain, made from the day of the report until a day after Seerr marked it resolved.
// Nothing here scores an outcome (ADR-112 C-01).
import {
  fixRequests,
  ledgerEvents,
  mediaItems,
  permissionAudit,
  repairRequests,
  roles,
  seerrIssues,
  users,
  type DbClient,
  type SeerrIssueMediaType,
  type SeerrIssueRow,
  type SeerrIssueStatus,
  type SeerrIssueType,
  type Transaction,
} from '@hnet/db';
import { ARR_CLUSTER_URL_DEFAULTS, ArrConfigError, type SeerrIssue } from '@hnet/arr';
import { SeerrClient, SonarrClient } from '@hnet/arr/read';
import { aliasedTable, and, desc, eq, gte, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { NotFoundError } from './errors';
import { resolveMediaItemId, resolveUserIdByEmail } from './ledger-ingest';

/** D-10 — what the mirror reads from Seerr. `SeerrClient` satisfies it; tests inject a stub. */
export interface SeerrIssueReader {
  listAllIssues(): Promise<SeerrIssue[]>;
  getIssue(issueId: number): Promise<SeerrIssue | null>;
}

/** D-10 — the Sonarr read that turns (season, episode) into the episode id. `SonarrClient` satisfies it. */
export interface SeerrIssueEpisodeReader {
  listEpisodes(seriesId: number): Promise<Array<{ id: number; seasonNumber: number; episodeNumber: number }>>;
}

/** The Seerr read client for the web app (webhook, link) and the sync; null when SEERR_API_KEY is absent. */
export function seerrIssueReaderFromEnv(
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 10_000,
): SeerrClient | null {
  const apiKey = env.SEERR_API_KEY?.trim();
  if (!apiKey) return null;
  return new SeerrClient({ baseUrl: env.SEERR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.seerr, apiKey, timeoutMs });
}

/**
 * The `seerr-issues` sync's clients: the Seerr reader (SEERR_API_KEY required: throws ArrConfigError naming it) and the
 * OPTIONAL Sonarr reader for an episode's id (absent SONARR_API_KEY ⇒ null, and episode ids stay unknown).
 */
export function seerrIssueSyncClientsFromEnv(env: Record<string, string | undefined> = process.env): {
  seerr: SeerrClient;
  sonarr: SonarrClient | null;
} {
  const seerr = seerrIssueReaderFromEnv(env, 30_000);
  if (!seerr) throw new ArrConfigError(['SEERR_API_KEY']);
  const sonarrKey = env.SONARR_API_KEY?.trim();
  const sonarr = sonarrKey
    ? new SonarrClient({ baseUrl: env.SONARR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.sonarr, apiKey: sonarrKey })
    : null;
  return { seerr, sonarr };
}

/** Seerr's issue types, in Seerr's numbering (D-10). */
export const SEERR_ISSUE_TYPE_LABELS: Record<SeerrIssueType, string> = {
  1: 'Video',
  2: 'Audio',
  3: 'Subtitles',
  4: 'Other',
};

/** The longest first message the mirror keeps (Seerr's own limit is far larger; the banner shows a few lines). */
export const SEERR_ISSUE_MESSAGE_MAX = 2_000;
/** The longest staff note (D-12). */
export const SEERR_ISSUE_NOTE_MAX = 2_000;
/** D-12 — a resolved issue links the repairs made up to a day after Seerr last changed it. */
export const SEERR_ISSUE_LINK_GRACE_MS = 24 * 60 * 60 * 1000;

/** One Seerr issue as the mirror stores it (pure; the email is for matching only). */
export interface MappedSeerrIssue {
  seerrIssueId: number;
  issueType: SeerrIssueType;
  status: SeerrIssueStatus;
  problemSeason: number;
  problemEpisode: number;
  mediaType: SeerrIssueMediaType | null;
  tmdbId: number | null;
  tvdbId: number | null;
  reporterSeerrUserId: number | null;
  reporterName: string | null;
  reporterEmail: string | null;
  message: string | null;
  commentCount: number;
  seerrCreatedAt: Date;
  seerrUpdatedAt: Date;
}

const positiveOrNull = (n: number | null | undefined): number | null =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;

const nonNegative = (n: number | null | undefined): number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;

function trimmedOrNull(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function dateOr(value: string, fallback: Date): Date {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/** D-10 — map one Seerr issue to the mirror's columns. Seerr status 2 is resolved; anything else reads open. */
export function mapSeerrIssue(issue: SeerrIssue, now: Date = new Date()): MappedSeerrIssue {
  const type = ([1, 2, 3, 4] as const).includes(issue.issueType as SeerrIssueType)
    ? (issue.issueType as SeerrIssueType)
    : 4;
  const mediaType =
    issue.media?.mediaType === 'movie' ? 'movie' : issue.media?.mediaType === 'tv' ? 'tv' : null;
  // Seerr files the report's own text as the first comment; the oldest comment is it.
  const comments = [...(issue.comments ?? [])].sort(
    (a, b) => dateOr(a.createdAt, now).getTime() - dateOr(b.createdAt, now).getTime() || a.id - b.id,
  );
  const reporter = issue.createdBy ?? null;
  const reporterName =
    trimmedOrNull(reporter?.displayName, 200) ??
    trimmedOrNull(reporter?.plexUsername, 200) ??
    trimmedOrNull(reporter?.username, 200);
  const created = dateOr(issue.createdAt, now);
  return {
    seerrIssueId: issue.id,
    issueType: type,
    status: issue.status === 2 ? 'resolved' : 'open',
    problemSeason: nonNegative(issue.problemSeason),
    problemEpisode: nonNegative(issue.problemEpisode),
    mediaType,
    tmdbId: positiveOrNull(issue.media?.tmdbId),
    tvdbId: positiveOrNull(issue.media?.tvdbId),
    reporterSeerrUserId: positiveOrNull(reporter?.id),
    reporterName,
    reporterEmail: trimmedOrNull(reporter?.email, 320),
    message: trimmedOrNull(comments[0]?.message, SEERR_ISSUE_MESSAGE_MAX),
    commentCount: comments.length,
    seerrCreatedAt: created,
    seerrUpdatedAt: dateOr(issue.updatedAt, created),
  };
}

/** "S02E06", "Season 2", or null for the whole title (D-10: 0 means the whole season or title). */
export function seerrIssueTargetLabel(issue: {
  mediaType: SeerrIssueMediaType | null;
  problemSeason: number;
  problemEpisode: number;
}): string | null {
  if (issue.mediaType === 'movie' || issue.problemSeason <= 0) return null;
  const s = String(issue.problemSeason).padStart(2, '0');
  if (issue.problemEpisode <= 0) return `Season ${issue.problemSeason}`;
  return `S${s}E${String(issue.problemEpisode).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The single writer (D-10): the sync, the webhook's read and the link's read all upsert through here.
// ---------------------------------------------------------------------------

interface ResolveContext {
  sonarr: SeerrIssueEpisodeReader | null;
  /** Per run: a series' episodes, read once. */
  episodes: Map<number, Map<string, number> | null>;
  episodeLookupFailures: number;
}

async function episodeIdFor(
  ctx: ResolveContext,
  seriesId: number,
  season: number,
  episode: number,
): Promise<number | null> {
  if (!ctx.sonarr) return null;
  let map = ctx.episodes.get(seriesId);
  if (map === undefined) {
    try {
      const list = await ctx.sonarr.listEpisodes(seriesId);
      map = new Map(list.map((e) => [`${e.seasonNumber}:${e.episodeNumber}`, e.id]));
    } catch {
      // Sonarr is down or the series is gone: the episode stays unknown until a later read.
      ctx.episodeLookupFailures += 1;
      map = null;
    }
    ctx.episodes.set(seriesId, map);
  }
  return map?.get(`${season}:${episode}`) ?? null;
}

type UpsertOutcome = 'inserted' | 'updated' | 'unchanged';

const SEERR_COLUMNS = [
  'issueType',
  'status',
  'problemSeason',
  'problemEpisode',
  'mediaType',
  'tmdbId',
  'tvdbId',
  'mediaItemId',
  'targetChildId',
  'reporterSeerrUserId',
  'reporterName',
  'reporterUserId',
  'message',
  'commentCount',
] as const;

/** An episode report's ledger item and Sonarr episode, looked up BEFORE the write transaction opens. */
type EpisodeTargets = Map<number, { mediaItemId: string; targetChildId: number | null }>;

const isEpisodeReport = (m: MappedSeerrIssue) =>
  m.mediaType === 'tv' && m.problemSeason > 0 && m.problemEpisode > 0;

const sameEpisode = (existing: SeerrIssueRow | undefined, mediaItemId: string, m: MappedSeerrIssue) =>
  existing !== undefined &&
  existing.mediaItemId === mediaItemId &&
  existing.problemSeason === m.problemSeason &&
  existing.problemEpisode === m.problemEpisode &&
  existing.targetChildId !== null;

/**
 * The Sonarr episode of each episode report: kept while the item, season and episode are unchanged; read again
 * otherwise. Runs OUTSIDE any transaction, so a slow Sonarr never holds a lock on the mirror (the webhook's read and
 * the staff note take row locks).
 */
async function episodeTargetsFor(
  db: DbClient | undefined,
  mapped: readonly MappedSeerrIssue[],
  existing: ReadonlyMap<number, SeerrIssueRow>,
  ctx: ResolveContext,
): Promise<EpisodeTargets> {
  const out: EpisodeTargets = new Map();
  const exec = resolveDb(db);
  for (const m of mapped) {
    if (!isEpisodeReport(m)) continue;
    const mediaItemId = await resolveMediaItemId(exec, { mediaType: m.mediaType, tmdbId: m.tmdbId, tvdbId: m.tvdbId });
    if (mediaItemId === null) continue;
    const ex = existing.get(m.seerrIssueId);
    if (sameEpisode(ex, mediaItemId, m)) {
      out.set(m.seerrIssueId, { mediaItemId, targetChildId: ex!.targetChildId });
      continue;
    }
    const [item] = await exec
      .select({ arrKind: mediaItems.arrKind, arrItemId: mediaItems.arrItemId })
      .from(mediaItems)
      .where(eq(mediaItems.id, mediaItemId));
    const targetChildId =
      item?.arrKind === 'sonarr' ? await episodeIdFor(ctx, item.arrItemId, m.problemSeason, m.problemEpisode) : null;
    out.set(m.seerrIssueId, { mediaItemId, targetChildId });
  }
  return out;
}

async function upsertMapped(
  tx: Transaction,
  mapped: MappedSeerrIssue,
  existing: SeerrIssueRow | undefined,
  targets: EpisodeTargets,
  now: Date,
): Promise<UpsertOutcome> {
  const mediaItemId = await resolveMediaItemId(tx, {
    mediaType: mapped.mediaType,
    tmdbId: mapped.tmdbId,
    tvdbId: mapped.tvdbId,
  });
  const reporterUserId = await resolveUserIdByEmail(tx, mapped.reporterEmail);

  // The episode looked up before the transaction; no *arr call happens inside it.
  let targetChildId: number | null = null;
  if (mediaItemId !== null && isEpisodeReport(mapped)) {
    const pre = targets.get(mapped.seerrIssueId);
    if (pre !== undefined && pre.mediaItemId === mediaItemId) targetChildId = pre.targetChildId;
    else if (sameEpisode(existing, mediaItemId, mapped)) targetChildId = existing!.targetChildId;
  }

  const values = {
    issueType: mapped.issueType,
    status: mapped.status,
    problemSeason: mapped.problemSeason,
    problemEpisode: mapped.problemEpisode,
    mediaType: mapped.mediaType,
    tmdbId: mapped.tmdbId,
    tvdbId: mapped.tvdbId,
    mediaItemId,
    targetChildId,
    reporterSeerrUserId: mapped.reporterSeerrUserId,
    reporterName: mapped.reporterName,
    reporterUserId,
    message: mapped.message,
    commentCount: mapped.commentCount,
  };

  if (existing === undefined) {
    await tx
      .insert(seerrIssues)
      .values({
        seerrIssueId: mapped.seerrIssueId,
        ...values,
        seerrCreatedAt: mapped.seerrCreatedAt,
        seerrUpdatedAt: mapped.seerrUpdatedAt,
        readAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        // A concurrent read (the webhook beside the sync) got there first: take this read.
        target: seerrIssues.seerrIssueId,
        set: { ...values, seerrUpdatedAt: mapped.seerrUpdatedAt, readAt: now, removedAt: null, updatedAt: now },
      });
    return 'inserted';
  }

  const changed =
    SEERR_COLUMNS.some((k) => existing[k] !== values[k]) ||
    existing.seerrUpdatedAt.getTime() !== mapped.seerrUpdatedAt.getTime() ||
    existing.seerrCreatedAt.getTime() !== mapped.seerrCreatedAt.getTime() ||
    existing.removedAt !== null;
  await tx
    .update(seerrIssues)
    .set({
      ...values,
      seerrCreatedAt: mapped.seerrCreatedAt,
      seerrUpdatedAt: mapped.seerrUpdatedAt,
      readAt: now,
      removedAt: null,
      ...(changed ? { updatedAt: now } : {}),
    })
    .where(eq(seerrIssues.seerrIssueId, mapped.seerrIssueId));
  return changed ? 'updated' : 'unchanged';
}

export interface SyncSeerrIssuesResult {
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Mirrored issues a complete read no longer lists (deleted in Seerr). */
  removed: number;
  /** Series whose episodes could not be read this run (their episode ids stay unknown). */
  episodeLookupFailures: number;
}

/**
 * D-10 — the `seerr-issues` sync: read every Seerr issue (all statuses) and upsert the mirror. Read-only toward Seerr
 * and Sonarr. A failed list read throws before anything is written (the CronJob fails; the mirror keeps its last read).
 */
export async function syncSeerrIssues(input: {
  db?: DbClient;
  seerr: Pick<SeerrIssueReader, 'listAllIssues'>;
  sonarr?: SeerrIssueEpisodeReader | null;
  now?: Date;
}): Promise<SyncSeerrIssuesResult> {
  const now = input.now ?? new Date();
  const issues = await input.seerr.listAllIssues();
  const mapped = issues.map((i) => mapSeerrIssue(i, now));
  const ctx: ResolveContext = { sonarr: input.sonarr ?? null, episodes: new Map(), episodeLookupFailures: 0 };
  const result: SyncSeerrIssuesResult = {
    fetched: mapped.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    episodeLookupFailures: 0,
  };
  const ids = mapped.map((m) => m.seerrIssueId);
  const readExisting = async (exec: DbClient | undefined) =>
    new Map(
      (ids.length > 0
        ? await resolveDb(exec).select().from(seerrIssues).where(inArray(seerrIssues.seerrIssueId, ids))
        : []
      ).map((r) => [r.seerrIssueId, r] as const),
    );
  // Sonarr is read before the transaction opens (a slow Sonarr must not hold the mirror's row locks).
  const targets = await episodeTargetsFor(input.db, mapped, await readExisting(input.db), ctx);
  await inTransaction(input.db, async (tx) => {
    const existing = await readExisting(tx);
    for (const m of mapped) {
      const outcome = await upsertMapped(tx, m, existing.get(m.seerrIssueId), targets, now);
      result[outcome] += 1;
    }
    // A complete read that no longer lists an issue: it was deleted in Seerr. Kept (its staff note too), marked.
    const gone = await tx
      .update(seerrIssues)
      .set({ removedAt: now, updatedAt: now })
      .where(
        and(
          isNull(seerrIssues.removedAt),
          ids.length > 0 ? notInArray(seerrIssues.seerrIssueId, ids) : sql`true`,
        ),
      )
      .returning({ id: seerrIssues.seerrIssueId });
    result.removed = gone.length;
  });
  result.episodeLookupFailures = ctx.episodeLookupFailures;
  return result;
}

/**
 * D-10 / D-11 — read ONE issue fresh from Seerr and upsert it (the issue webhook, and the `/r/seerr/<id>` link when its
 * row is missing or has no app reporter yet). A 404 marks a mirrored issue removed. Never throws for Seerr being
 * unreachable: the answer is `unavailable` and the 10-minute sync catches up.
 */
export async function refreshSeerrIssue(input: {
  db?: DbClient;
  seerr: Pick<SeerrIssueReader, 'getIssue'>;
  sonarr?: SeerrIssueEpisodeReader | null;
  seerrIssueId: number;
  now?: Date;
}): Promise<{ outcome: UpsertOutcome | 'not_found' | 'unavailable' }> {
  const now = input.now ?? new Date();
  let issue: SeerrIssue | null;
  try {
    issue = await input.seerr.getIssue(input.seerrIssueId);
  } catch {
    return { outcome: 'unavailable' };
  }
  if (issue === null) {
    await resolveDb(input.db)
      .update(seerrIssues)
      .set({ removedAt: now, updatedAt: now })
      .where(and(eq(seerrIssues.seerrIssueId, input.seerrIssueId), isNull(seerrIssues.removedAt)));
    return { outcome: 'not_found' };
  }
  const mapped = mapSeerrIssue(issue, now);
  const ctx: ResolveContext = { sonarr: input.sonarr ?? null, episodes: new Map(), episodeLookupFailures: 0 };
  const rowOf = async (exec: DbClient | undefined, lock: boolean) => {
    const q = resolveDb(exec).select().from(seerrIssues).where(eq(seerrIssues.seerrIssueId, mapped.seerrIssueId));
    const [row] = lock ? await q.for('update') : await q;
    return row;
  };
  // Sonarr first, outside the transaction; the row lock is held only for the write.
  const before = await rowOf(input.db, false);
  const targets = await episodeTargetsFor(
    input.db,
    [mapped],
    new Map(before ? [[before.seerrIssueId, before] as const] : []),
    ctx,
  );
  const outcome = await inTransaction(input.db, async (tx) => {
    const existing = await rowOf(tx, true);
    return upsertMapped(tx, mapped, existing, targets, now);
  });
  return { outcome };
}

/**
 * D-10 / D-11 — `refreshSeerrIssue` with the clients built from the environment (the web app's issue webhook and the
 * `/r/seerr/<id>` link). `unconfigured` when SEERR_API_KEY is absent; Sonarr (for the episode id) is optional. A short
 * timeout: a webhook or a page view never waits long on Seerr, and the 10-minute sync catches up.
 */
export async function refreshSeerrIssueFromEnv(input: {
  db?: DbClient;
  seerrIssueId: number;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<{ outcome: UpsertOutcome | 'not_found' | 'unavailable' | 'unconfigured' }> {
  const env = input.env ?? process.env;
  const seerr = seerrIssueReaderFromEnv(env, input.timeoutMs ?? 5_000);
  if (!seerr) return { outcome: 'unconfigured' };
  const sonarrKey = env.SONARR_API_KEY?.trim();
  const sonarr = sonarrKey
    ? new SonarrClient({
        baseUrl: env.SONARR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.sonarr,
        apiKey: sonarrKey,
        timeoutMs: input.timeoutMs ?? 5_000,
      })
    : null;
  return refreshSeerrIssue({ db: input.db, seerr, sonarr, seerrIssueId: input.seerrIssueId });
}

/**
 * ADR-112 C-02 / D-12 — staff mark an issue fixed by hand (a note naming what was missing is required), change its note,
 * or clear both. The row and its `update_seerr_issue_note` permission_audit row commit together (hard rule 6). A mark
 * keeps the time and person of the first mark while it stays on.
 */
export async function setSeerrIssueStaffNote(input: {
  db?: DbClient;
  actorId: string;
  seerrIssueId: number;
  note: string | null;
  fixedByHand: boolean;
  now?: Date;
}): Promise<{ fixedByHand: boolean; note: string | null; staffHandledAt: Date | null }> {
  const now = input.now ?? new Date();
  const note = trimmedOrNull(input.note, SEERR_ISSUE_NOTE_MAX);
  if (input.fixedByHand && note === null) {
    throw new Error('A fixed-by-hand mark needs a note naming what was missing');
  }
  return inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .select({
        staffHandledAt: seerrIssues.staffHandledAt,
        staffHandledBy: seerrIssues.staffHandledBy,
        staffNote: seerrIssues.staffNote,
      })
      .from(seerrIssues)
      .where(eq(seerrIssues.seerrIssueId, input.seerrIssueId))
      .for('update');
    if (!row) throw new NotFoundError(`Seerr issue ${input.seerrIssueId} is not in the mirror`);
    const before = { fixedByHand: row.staffHandledAt !== null, note: row.staffNote };
    const staffHandledAt = input.fixedByHand ? (row.staffHandledAt ?? now) : null;
    const staffHandledBy = input.fixedByHand ? (row.staffHandledAt !== null ? row.staffHandledBy : input.actorId) : null;
    await tx
      .update(seerrIssues)
      .set({ staffHandledAt, staffHandledBy, staffNote: note, updatedAt: now })
      .where(eq(seerrIssues.seerrIssueId, input.seerrIssueId));
    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_seerr_issue_note',
      detail: { seerrIssueId: input.seerrIssueId, before, after: { fixedByHand: input.fixedByHand, note } },
    });
    return { fixedByHand: input.fixedByHand, note, staffHandledAt };
  });
}

// ---------------------------------------------------------------------------
// Reads: the title page banner (D-10), the link (D-11) and the admin list with linked repairs (D-12).
// ---------------------------------------------------------------------------

/** One report as the title page shows it (D-10). The reporter's name is for admins only (ADR-111 C-02). */
export interface TitleSeerrIssue {
  seerrIssueId: number;
  issueType: SeerrIssueType;
  status: SeerrIssueStatus;
  problemSeason: number;
  problemEpisode: number;
  mediaType: SeerrIssueMediaType | null;
  targetChildId: number | null;
  targetLabel: string | null;
  message: string | null;
  reportedAt: string;
  /** The viewer is the person who reported it (their app account matched by email). */
  viewerIsReporter: boolean;
  /** Admins only; null for everyone else. */
  reporterName: string | null;
}

/**
 * D-10 — the reports to show on a title page: its open issues, plus the one a `/r/seerr/<id>` link arrived with
 * (whatever its status). Issues deleted in Seerr are left out. The caller has already checked the viewer may see the
 * item (ADR-047).
 */
export async function seerrIssuesForItem(input: {
  db?: DbClient;
  mediaItemId: string;
  viewerUserId: string;
  viewerIsAdmin: boolean;
  arrivedIssueId?: number | null;
}): Promise<TitleSeerrIssue[]> {
  const db = resolveDb(input.db);
  const arrived = input.arrivedIssueId ?? null;
  const rows = await db
    .select()
    .from(seerrIssues)
    .where(
      and(
        eq(seerrIssues.mediaItemId, input.mediaItemId),
        isNull(seerrIssues.removedAt),
        arrived !== null
          ? sql`(${seerrIssues.status} = 'open' OR ${seerrIssues.seerrIssueId} = ${arrived})`
          : eq(seerrIssues.status, 'open'),
      ),
    )
    .orderBy(desc(seerrIssues.seerrCreatedAt))
    .limit(20);
  return rows.map((r) => ({
    seerrIssueId: r.seerrIssueId,
    issueType: r.issueType as SeerrIssueType,
    status: r.status,
    problemSeason: r.problemSeason,
    problemEpisode: r.problemEpisode,
    mediaType: r.mediaType,
    targetChildId: r.targetChildId,
    targetLabel: seerrIssueTargetLabel(r),
    message: r.message,
    reportedAt: r.seerrCreatedAt.toISOString(),
    viewerIsReporter: r.reporterUserId !== null && r.reporterUserId === input.viewerUserId,
    reporterName: input.viewerIsAdmin ? r.reporterName : null,
  }));
}

/** D-11 — where `/r/seerr/<id>` goes: the mirrored issue's title, or why it cannot go there yet. */
export type SeerrIssueLinkTarget =
  | { kind: 'title'; mediaItemId: string; status: SeerrIssueStatus; reporterUserId: string | null }
  | { kind: 'no_title'; status: SeerrIssueStatus; mediaType: SeerrIssueMediaType | null }
  | { kind: 'removed' }
  | { kind: 'unknown' };

/** D-11 — the link's lookup (no Seerr call; the route refreshes a missing row first). */
export async function seerrIssueLinkTarget(input: {
  db?: DbClient;
  seerrIssueId: number;
}): Promise<SeerrIssueLinkTarget> {
  const db = resolveDb(input.db);
  const [row] = await db
    .select({
      mediaItemId: seerrIssues.mediaItemId,
      status: seerrIssues.status,
      mediaType: seerrIssues.mediaType,
      removedAt: seerrIssues.removedAt,
      reporterUserId: seerrIssues.reporterUserId,
    })
    .from(seerrIssues)
    .where(eq(seerrIssues.seerrIssueId, input.seerrIssueId));
  if (!row) return { kind: 'unknown' };
  if (row.removedAt !== null) return { kind: 'removed' };
  if (row.mediaItemId === null) return { kind: 'no_title', status: row.status, mediaType: row.mediaType };
  return { kind: 'title', mediaItemId: row.mediaItemId, status: row.status, reporterUserId: row.reporterUserId };
}

/** One of the app's own records linked to an issue (D-12). */
export interface LinkedRepair {
  kind: 'repair' | 'fix' | 'search';
  id: string;
  /** What it was: "Import", "Fix: Wrong language", "Force Search", ... */
  what: string;
  targetLabel: string | null;
  status: string;
  at: string;
  requesterName: string | null;
  requesterIsAdmin: boolean;
}

/** The grain of one record, as the linking rule reads it. */
export interface RepairGrain {
  /** item (movie), show, season, episode (album and artist never match a Seerr issue). */
  scope: string;
  season: number | null;
  childIds: readonly number[];
  label: string | null;
}

const EPISODE_CODE = /^S(\d{1,4})E(\d{1,4})/i;

/**
 * D-12 — does a record on the issue's title match the issue's grain? A movie report matches every record on the movie;
 * a whole-title TV report matches every record; a season report matches the season, its episodes and the whole show; an
 * episode report matches that episode (by id, or by its SxxEyy label), its season and the whole show.
 */
export function repairMatchesIssue(
  issue: { mediaType: SeerrIssueMediaType | null; problemSeason: number; problemEpisode: number; targetChildId: number | null },
  rec: RepairGrain,
): boolean {
  if (issue.mediaType !== 'tv' || issue.problemSeason <= 0) return rec.scope !== 'album' && rec.scope !== 'artist';
  if (rec.scope === 'show' || rec.scope === 'item') return true;
  const code = rec.label ? EPISODE_CODE.exec(rec.label) : null;
  const recSeason = rec.season ?? (code ? Number(code[1]) : null);
  if (rec.scope === 'season') return recSeason === issue.problemSeason;
  if (rec.scope !== 'episode') return false;
  if (issue.problemEpisode <= 0) return recSeason === issue.problemSeason;
  if (issue.targetChildId !== null && rec.childIds.includes(issue.targetChildId)) return true;
  return code !== null && Number(code[1]) === issue.problemSeason && Number(code[2]) === issue.problemEpisode;
}

const REPAIR_KIND_LABELS: Record<string, string> = {
  remap: 'Episode Re-map',
  import_download: 'Import',
  release_pick: 'Release Pick',
  audio_preference: 'Audio preference',
  language_search: 'Language search',
};

const FIX_REASON_WORDS: Record<string, string> = {
  wont_play_corrupt: "Won't play",
  wrong_language: 'Wrong language',
  wrong_version_quality: 'Wrong version or quality',
  missing_subtitles: 'Missing subtitles',
  wrong_content: 'Wrong content',
  other: 'Other',
};

interface IssueWindow {
  seerrIssueId: number;
  mediaItemId: string;
  mediaType: SeerrIssueMediaType | null;
  problemSeason: number;
  problemEpisode: number;
  targetChildId: number | null;
  from: Date;
  until: Date | null;
}

function windowOf(r: SeerrIssueRow): IssueWindow | null {
  if (r.mediaItemId === null) return null;
  return {
    seerrIssueId: r.seerrIssueId,
    mediaItemId: r.mediaItemId,
    mediaType: r.mediaType,
    problemSeason: r.problemSeason,
    problemEpisode: r.problemEpisode,
    targetChildId: r.targetChildId,
    from: r.seerrCreatedAt,
    until: r.status === 'resolved' ? new Date(r.seerrUpdatedAt.getTime() + SEERR_ISSUE_LINK_GRACE_MS) : null,
  };
}

const inWindow = (w: IssueWindow, at: Date) => at >= w.from && (w.until === null || at <= w.until);

/** D-12 — the app's own Repair Requests, Fixes and Force Searches linked to each issue (by title, grain and time). */
export async function linkedRepairsFor(
  db: DbClient | undefined,
  rows: readonly SeerrIssueRow[],
): Promise<Map<number, LinkedRepair[]>> {
  const out = new Map<number, LinkedRepair[]>(rows.map((r) => [r.seerrIssueId, []]));
  const windows = rows.map(windowOf).filter((w): w is IssueWindow => w !== null);
  if (windows.length === 0) return out;
  const exec = resolveDb(db);
  const itemIds = [...new Set(windows.map((w) => w.mediaItemId))];
  const earliest = new Date(Math.min(...windows.map((w) => w.from.getTime())));
  const requester = aliasedTable(users, 'requester');

  const repairs = await exec
    .select({
      id: repairRequests.id,
      mediaItemId: repairRequests.mediaItemId,
      kind: repairRequests.kind,
      scope: repairRequests.scope,
      season: repairRequests.seasonNumber,
      childIds: repairRequests.targetChildIds,
      label: repairRequests.targetLabel,
      status: repairRequests.status,
      seerrIssueId: repairRequests.seerrIssueId,
      at: repairRequests.createdAt,
      name: requester.displayName,
      isAdmin: roles.isAdmin,
    })
    .from(repairRequests)
    .leftJoin(requester, eq(requester.id, repairRequests.requesterId))
    .leftJoin(roles, eq(roles.id, requester.roleId))
    .where(and(inArray(repairRequests.mediaItemId, itemIds), gte(repairRequests.createdAt, earliest)));

  const fixes = await exec
    .select({
      id: fixRequests.id,
      mediaItemId: fixRequests.mediaItemId,
      scope: fixRequests.targetScope,
      season: fixRequests.targetSeason,
      child: fixRequests.targetArrChildId,
      label: fixRequests.targetLabel,
      reason: fixRequests.reason,
      status: fixRequests.status,
      at: fixRequests.createdAt,
      name: requester.displayName,
      isAdmin: roles.isAdmin,
    })
    .from(fixRequests)
    .leftJoin(requester, eq(requester.id, fixRequests.requesterId))
    .leftJoin(roles, eq(roles.id, requester.roleId))
    .where(and(inArray(fixRequests.mediaItemId, itemIds), gte(fixRequests.createdAt, earliest)));

  const searches = await exec
    .select({
      id: ledgerEvents.id,
      mediaItemId: ledgerEvents.mediaItemId,
      payload: ledgerEvents.payload,
      at: ledgerEvents.occurredAt,
      name: requester.displayName,
      isAdmin: roles.isAdmin,
    })
    .from(ledgerEvents)
    .leftJoin(requester, eq(requester.id, ledgerEvents.requestedByUserId))
    .leftJoin(roles, eq(roles.id, requester.roleId))
    .where(
      and(
        eq(ledgerEvents.eventType, 'search_requested'),
        eq(ledgerEvents.source, 'app'),
        inArray(ledgerEvents.mediaItemId, itemIds),
        gte(ledgerEvents.occurredAt, earliest),
      ),
    );

  for (const w of windows) {
    const list = out.get(w.seerrIssueId)!;
    for (const r of repairs) {
      const explicit = r.seerrIssueId === w.seerrIssueId;
      if (r.mediaItemId !== w.mediaItemId) continue;
      if (!explicit && !(inWindow(w, r.at) && repairMatchesIssue(w, { scope: r.scope, season: r.season, childIds: r.childIds, label: r.label }))) {
        continue;
      }
      list.push({
        kind: 'repair',
        id: r.id,
        what: REPAIR_KIND_LABELS[r.kind] ?? r.kind,
        targetLabel: r.label,
        status: r.status,
        at: r.at.toISOString(),
        requesterName: r.name,
        requesterIsAdmin: r.isAdmin === true,
      });
    }
    for (const f of fixes) {
      if (f.mediaItemId !== w.mediaItemId || !inWindow(w, f.at)) continue;
      const grain = { scope: f.scope, season: f.season, childIds: f.child !== null ? [f.child] : [], label: f.label };
      if (!repairMatchesIssue(w, grain)) continue;
      list.push({
        kind: 'fix',
        id: f.id,
        what: `Fix: ${FIX_REASON_WORDS[f.reason] ?? f.reason}`,
        targetLabel: f.label,
        status: f.status,
        at: f.at.toISOString(),
        requesterName: f.name,
        requesterIsAdmin: f.isAdmin === true,
      });
    }
    for (const s of searches) {
      if (s.mediaItemId !== w.mediaItemId || !inWindow(w, s.at)) continue;
      const p = s.payload ?? {};
      const child = typeof p.targetArrChildId === 'number' ? p.targetArrChildId : null;
      const grain = {
        scope: typeof p.scope === 'string' ? p.scope : 'item',
        season: typeof p.seasonNumber === 'number' ? p.seasonNumber : null,
        childIds: child !== null ? [child] : [],
        label: typeof p.targetLabel === 'string' ? p.targetLabel : null,
      };
      if (!repairMatchesIssue(w, grain)) continue;
      list.push({
        kind: 'search',
        id: s.id,
        what: p.queueRemoval ? 'Force Search (removed a download first)' : 'Force Search',
        targetLabel: grain.label,
        status: 'searched',
        at: s.at.toISOString(),
        requesterName: s.name,
        requesterIsAdmin: s.isAdmin === true,
      });
    }
    list.sort((a, b) => a.at.localeCompare(b.at));
  }
  return out;
}

/** One row of the `/admin` Seerr issues list (D-10, D-12). */
export interface AdminSeerrIssue {
  seerrIssueId: number;
  issueType: SeerrIssueType;
  status: SeerrIssueStatus;
  removed: boolean;
  problemSeason: number;
  problemEpisode: number;
  targetLabel: string | null;
  mediaType: SeerrIssueMediaType | null;
  item: { id: string; title: string; year: number | null; arrKind: string } | null;
  message: string | null;
  commentCount: number;
  reportedAt: string;
  updatedAt: string;
  reporterName: string | null;
  reporterAccount: { id: string; displayName: string } | null;
  staff: { fixedByHand: boolean; note: string | null; at: string | null; byName: string | null };
  linkedRepairs: LinkedRepair[];
}

export const ADMIN_SEERR_ISSUE_FILTERS = ['open', 'all'] as const;
export type AdminSeerrIssueFilter = (typeof ADMIN_SEERR_ISSUE_FILTERS)[number];

/** D-10 / D-12 — the admin list, newest first, keyset-paged by Seerr's issue id (ids grow with time). */
export async function listSeerrIssuesForAdmin(input: {
  db?: DbClient;
  filter: AdminSeerrIssueFilter;
  limit: number;
  /** The last issue id of the previous page. */
  before?: number | null;
}): Promise<{ items: AdminSeerrIssue[]; nextBefore: number | null }> {
  const db = resolveDb(input.db);
  const limit = Math.max(1, Math.min(100, input.limit));
  const reporter = aliasedTable(users, 'reporter');
  const handler = aliasedTable(users, 'handler');
  const rows = await db
    .select({
      issue: seerrIssues,
      title: mediaItems.title,
      year: mediaItems.year,
      arrKind: mediaItems.arrKind,
      reporterDisplayName: reporter.displayName,
      handlerName: handler.displayName,
    })
    .from(seerrIssues)
    .leftJoin(mediaItems, eq(mediaItems.id, seerrIssues.mediaItemId))
    .leftJoin(reporter, eq(reporter.id, seerrIssues.reporterUserId))
    .leftJoin(handler, eq(handler.id, seerrIssues.staffHandledBy))
    .where(
      and(
        input.filter === 'open' ? and(eq(seerrIssues.status, 'open'), isNull(seerrIssues.removedAt)) : undefined,
        input.before != null ? lt(seerrIssues.seerrIssueId, input.before) : undefined,
      ),
    )
    .orderBy(desc(seerrIssues.seerrIssueId))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const linked = await linkedRepairsFor(db, page.map((r) => r.issue));
  const items: AdminSeerrIssue[] = page.map(({ issue: r, title, year, arrKind, reporterDisplayName, handlerName }) => ({
    seerrIssueId: r.seerrIssueId,
    issueType: r.issueType as SeerrIssueType,
    status: r.status,
    removed: r.removedAt !== null,
    problemSeason: r.problemSeason,
    problemEpisode: r.problemEpisode,
    targetLabel: seerrIssueTargetLabel(r),
    mediaType: r.mediaType,
    item: r.mediaItemId !== null && title !== null ? { id: r.mediaItemId, title, year, arrKind: arrKind ?? '' } : null,
    message: r.message,
    commentCount: r.commentCount,
    reportedAt: r.seerrCreatedAt.toISOString(),
    updatedAt: r.seerrUpdatedAt.toISOString(),
    reporterName: r.reporterName,
    reporterAccount:
      r.reporterUserId !== null && reporterDisplayName !== null
        ? { id: r.reporterUserId, displayName: reporterDisplayName }
        : null,
    staff: {
      fixedByHand: r.staffHandledAt !== null,
      note: r.staffNote,
      at: r.staffHandledAt ? r.staffHandledAt.toISOString() : null,
      byName: handlerName ?? null,
    },
    linkedRepairs: linked.get(r.seerrIssueId) ?? [],
  }));
  return { items, nextBefore: rows.length > limit ? page[page.length - 1]!.issue.seerrIssueId : null };
}
