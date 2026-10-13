// ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7; the owner's Q-02 ruling, 2026-10-12) — the Seerr Issue bridge's writes
// and their single writer. Two writes, both posted as a dedicated Seerr user through `X-API-User` (never as user 1, the
// owner's account), both switched by the audited `seerr_issue_bridge` setting:
//
// - **The comment**, once per new issue: the fix-it-yourself invitation with the issue's `/r/seerr/<id>` link, worded
//   for what was reported, ending with the promise that staff still help when that doesn't sort it out (ADR-112 C-04).
// - **The resolve**, once per issue: when the Repair Request or Fix the guide ran FROM that issue's report has completed
//   (read, never assumed: DESIGN-055 D-02) and nothing linked to it is still open, a one-line outcome note, then
//   `POST /issue/{id}/resolved`. A failed or pending repair never resolves anything.
//
// Idempotence: one `seerr_issue_writes` row per issue and kind, ever (a unique index). The row commits as `intended`
// BEFORE the Seerr call and is completed after it; whoever inserts it (or reclaims a failed or stale one) owns the call,
// so the 10-minute sync and an issue webhook arriving together never both post. Before ANY post the issue is read fresh
// and a comment the bridge user already left with the same text is adopted instead of posting again, which makes a crash
// between the call and the row's completion safe too. The bridge never deletes, reopens or edits an issue or a comment.
import {
  fixRequests,
  mediaItems,
  repairRequests,
  seerrIssueWrites,
  seerrIssues,
  type DbClient,
  type SeerrIssueMediaType,
  type SeerrIssueRow,
  type SeerrIssueWriteKind,
  type SeerrIssueWriteRow,
  type SeerrIssueWriteState,
} from '@hnet/db';
import {
  ARR_CLUSTER_URL_DEFAULTS,
  SEERR_PERMISSION_ADMIN,
  SEERR_PERMISSION_MANAGE_ISSUES,
  type SeerrIssue,
  type SeerrUserDetail,
} from '@hnet/arr';
import { SeerrClient, SonarrClient } from '@hnet/arr/read';
import { SeerrWriteClient } from '@hnet/arr/write';
import { issuerOrigin } from '@hnet/oauth';
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getAppSetting, setAppSetting, type SeerrIssueBridgeSetting } from './app-settings';
import { inTransaction, resolveDb } from './db-client';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';
import { SeerrBridgeConfigInvalidError } from './errors';
import { seerrIssueTargetLabel } from './seerr-issues';

/** A failed write is tried again on later runs, up to this many attempts in all. */
export const SEERR_BRIDGE_MAX_ATTEMPTS = 5;
/** An `intended` row older than this is a crashed or lost call: it is reclaimed and reconciled against Seerr. */
export const SEERR_BRIDGE_STALE_INTENT_MS = 5 * 60 * 1000;
/** The longest error text a write row keeps. */
const ERROR_MAX = 300;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/** The Seerr reads the bridge makes (`SeerrClient` satisfies it). */
export interface SeerrBridgeReader {
  getIssue(issueId: number): Promise<SeerrIssue | null>;
  getUser(userId: number): Promise<SeerrUserDetail | null>;
}

/** The two Seerr writes (`SeerrWriteClient` satisfies it); every call names the bridge user. */
export interface SeerrBridgeWriter {
  commentOnIssue(issueId: number, message: string, asUserId: number): Promise<SeerrIssue>;
  resolveIssue(issueId: number, asUserId: number): Promise<SeerrIssue>;
}

/** The Sonarr read that tells whether a reported episode has a file (`SonarrClient` satisfies it). Optional. */
export interface SeerrBridgeEpisodeReader {
  listEpisodes(seriesId: number): Promise<Array<{ seasonNumber: number; episodeNumber: number; hasFile: boolean }>>;
}

export interface SeerrBridgeClients {
  read: SeerrBridgeReader;
  write: SeerrBridgeWriter;
  sonarr: SeerrBridgeEpisodeReader | null;
}

/** The bridge's clients from the environment; null when SEERR_API_KEY is absent. Sonarr is optional. */
export function seerrBridgeClientsFromEnv(
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 15_000,
): SeerrBridgeClients | null {
  const apiKey = env.SEERR_API_KEY?.trim();
  if (!apiKey) return null;
  const options = { baseUrl: env.SEERR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.seerr, apiKey, timeoutMs };
  const sonarrKey = env.SONARR_API_KEY?.trim();
  return {
    read: new SeerrClient(options),
    write: new SeerrWriteClient(options),
    sonarr: sonarrKey
      ? new SonarrClient({ baseUrl: env.SONARR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.sonarr, apiKey: sonarrKey, timeoutMs })
      : null,
  };
}

// ---------------------------------------------------------------------------
// The setting (the kill switch and the bridge user)
// ---------------------------------------------------------------------------

const validBridgeUserId = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 1;

/** The setting, per-field fail-safe: anything but `true` reads off; a bridge user must be an integer above 1. */
export async function getSeerrIssueBridge(input: { db?: DbClient }): Promise<SeerrIssueBridgeSetting> {
  const raw = (await getAppSetting(input.db, 'seerr_issue_bridge')) as unknown;
  const value = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const commentFrom =
    typeof value.commentFrom === 'string' && !Number.isNaN(new Date(value.commentFrom).getTime())
      ? value.commentFrom
      : null;
  return {
    comment: value.comment === true,
    resolve: value.resolve === true,
    bridgeUserId: validBridgeUserId(value.bridgeUserId) ? value.bridgeUserId : null,
    commentFrom,
  };
}

/**
 * The audited setting write (`update_app_setting`, the row and its audit in one transaction). Turning the comment on
 * stamps `commentFrom` with now, so only issues Seerr creates from then on get it; turning it off clears the stamp.
 * Either switch on needs a bridge user, and the bridge user is never Seerr user 1 (the owner's account).
 */
export async function setSeerrIssueBridge(input: {
  db?: DbClient;
  value: { comment: boolean; resolve: boolean; bridgeUserId: number | null };
  actorId: string | null;
  now?: Date;
}): Promise<{ before: SeerrIssueBridgeSetting; after: SeerrIssueBridgeSetting }> {
  const now = input.now ?? new Date();
  const { comment, resolve, bridgeUserId } = input.value;
  if (bridgeUserId !== null && !validBridgeUserId(bridgeUserId)) {
    throw new SeerrBridgeConfigInvalidError('The bridge user must be a Seerr user id above 1, never the owner (user 1).');
  }
  if ((comment || resolve) && bridgeUserId === null) {
    throw new SeerrBridgeConfigInvalidError('Name the Seerr bridge user before turning the comment or the resolve on.');
  }
  const before = await getSeerrIssueBridge({ db: input.db });
  const after: SeerrIssueBridgeSetting = {
    comment: comment === true,
    resolve: resolve === true,
    bridgeUserId,
    commentFrom: comment ? (before.comment && before.commentFrom !== null ? before.commentFrom : now.toISOString()) : null,
  };
  await setAppSetting({ db: input.db, key: 'seerr_issue_bridge', value: after, actorId: input.actorId });
  return { before, after };
}

// ---------------------------------------------------------------------------
// The words (user-facing: the owner's copy rules, no em-dashes, no names, no time-grounding, every link written out:
// Seerr's comment view shows plain text and does not make links clickable)
// ---------------------------------------------------------------------------

/** What the comment is worded for. */
export type SeerrCommentKind = 'missing' | 'wont_play' | 'wrong_language' | 'subtitles' | 'other';

/**
 * The comment's wording for one issue. A reported episode or movie with no file is `missing` whatever the type (the
 * guide opens Force Search on it, DESIGN-055 P3 decision 5); then Audio, Subtitles, and Video on an episode or movie
 * that has a file; everything else (Other, a whole season or show, a file nobody could read) names both buttons.
 */
export function seerrCommentKind(
  issue: { issueType: number; mediaType: SeerrIssueMediaType | null; problemSeason: number; problemEpisode: number },
  hasFile: boolean | null,
): SeerrCommentKind {
  const single = issue.mediaType === 'movie' || (issue.mediaType === 'tv' && issue.problemSeason > 0 && issue.problemEpisode > 0);
  if (single && hasFile === false) return 'missing';
  if (issue.issueType === 2) return 'wrong_language';
  if (issue.issueType === 3) return 'subtitles';
  if (issue.issueType === 1 && single && hasFile === true) return 'wont_play';
  return 'other';
}

/** `https://haynesnetwork.com/r/seerr/<id>` from the public origin (DESIGN-055 D-11). */
export function seerrIssueLinkUrl(origin: string, seerrIssueId: number): string {
  return `${origin.replace(/\/+$/, '')}/r/seerr/${seerrIssueId}`;
}

/** " on S02E06", " on Season 2", or "" for a movie or a whole show. */
function onTarget(issue: { mediaType: SeerrIssueMediaType | null; problemSeason: number; problemEpisode: number }): string {
  const label = seerrIssueTargetLabel(issue);
  return label === null ? '' : ` on ${label}`;
}

const STAFF_LINE = "If that doesn't sort it out, reply here and staff will take a look.";

/** DESIGN-055 D-10 — the fix-it-yourself comment, worded for the report. */
export function seerrIssueCommentText(input: {
  kind: SeerrCommentKind;
  link: string;
  issue: { mediaType: SeerrIssueMediaType | null; problemSeason: number; problemEpisode: number };
}): string {
  const noun = input.issue.mediaType === 'movie' ? 'movie' : 'show';
  const on = onTarget(input.issue);
  const step1 = `1. Open ${input.link} and sign in with your Plex account. The link then opens the ${noun} this report is about.`;
  let steps: [string, string];
  let extra: string | null = null;
  switch (input.kind) {
    case 'missing':
      steps = [
        `2. Press Force Search${on}.`,
        '3. If a download is stuck, it offers to import it. If nothing turns up, it can list every available download so you can pick one.',
      ];
      break;
    case 'wont_play':
      steps = [
        `2. Press Fix${on} and pick the reason that fits, such as Won't play.`,
        '3. It checks the file first and shows what it will change before anything happens.',
      ];
      extra = "Also check that you're playing it from the HaynesTower or HaynesOps server, not from Plex's own free movies and shows.";
      break;
    case 'wrong_language':
      steps = [
        `2. Press Fix${on}, pick Wrong language, and choose the language you want.`,
        '3. If the file already has that language, it helps you switch to it. If not, it can look for a copy in that language.',
      ];
      break;
    case 'subtitles':
      steps = [
        `2. Press Fix${on} and pick Missing subtitles.`,
        '3. It searches for subtitles and leaves the video file alone.',
      ];
      break;
    case 'other':
      steps = [
        "2. Press Force Search if something is missing, or Fix if it won't play, is in the wrong language or quality, is the wrong episode, or is missing subtitles.",
        '3. Pick the reason that fits. It shows what it will do before anything changes.',
      ];
      break;
  }
  return [
    'Thanks for the report. You can try fixing this yourself on haynesnetwork.com:',
    [step1, ...steps].join('\n'),
    ...(extra !== null ? [extra] : []),
    STAFF_LINE,
  ].join('\n\n');
}

/** One completed record that earned a resolve, as the outcome line needs it. */
export interface ResolveSource {
  kind: 'repair' | 'fix';
  id: string;
  /** The Repair Request's kind; null for a Fix. */
  repairKind: string | null;
  targetLabel: string | null;
}

/** "S02E06" from "S02E06 · Title", "Season 2" as is, or the movie or show. */
function outcomeTarget(label: string | null, mediaType: SeerrIssueMediaType | null): string {
  const code = label ? /^S\d{1,4}E\d{1,4}/i.exec(label.trim()) : null;
  if (code) return code[0].toUpperCase();
  if (label && /^Season \d+/i.test(label.trim())) return label.trim().replace(/^season/i, 'Season');
  return mediaType === 'movie' ? 'the movie' : 'the show';
}

/** DESIGN-055 D-01 / D-10 — the outcome line, naming the tool that fixed it (ADR-112 C-02: the reply teaches it). */
export function seerrResolveOutcome(source: ResolveSource, mediaType: SeerrIssueMediaType | null): string {
  const t = outcomeTarget(source.targetLabel, mediaType);
  if (source.kind === 'fix') return `Fix replaced ${t} with a new copy.`;
  switch (source.repairKind) {
    case 'import_download':
      return `Force Search found the stuck download for ${t} and imported it.`;
    case 'release_pick':
      return `A release for ${t} was picked from the full list of downloads and imported.`;
    case 'remap':
      return `Fix moved the files for ${t} onto their right episodes.`;
    case 'audio_preference':
      return "Fix set the show's default audio to the language you asked for, on every server.";
    default:
      return `${t.charAt(0).toUpperCase()}${t.slice(1)} was fixed.`;
  }
}

/** DESIGN-055 D-10 — the resolve's note. */
export function seerrResolveNoteText(outcome: string): string {
  return `Fixed on haynesnetwork.com: ${outcome}\n\nIf something still isn't right, use Reopen with Comment and staff will take a look.`;
}

// ---------------------------------------------------------------------------
// The single writer
// ---------------------------------------------------------------------------

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, ERROR_MAX) || 'error';

const sameText = (a: string | null | undefined, b: string) =>
  typeof a === 'string' && a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();

/** The bridge user's comment with exactly this text, newest first (a crash after the post, or Seerr's own answer). */
function bridgeComment(issue: SeerrIssue, bridgeUserId: number, body: string): number | null {
  const mine = (issue.comments ?? [])
    .filter((c) => c.user?.id === bridgeUserId && sameText(c.message, body))
    .map((c) => c.id)
    .sort((a, b) => b - a);
  return mine[0] ?? null;
}

/**
 * Claim the write: insert the `intended` row, or take back a failed one (under the attempt cap) or a stale `intended`
 * one. Commits before returning, so the row exists before any Seerr call. Null: another runner owns it, or it is done.
 */
async function claimWrite(
  db: DbClient | undefined,
  input: {
    seerrIssueId: number;
    kind: SeerrIssueWriteKind;
    body: string;
    bridgeUserId: number;
    repairRequestId?: string | null;
    fixRequestId?: string | null;
    now: Date;
  },
): Promise<{ id: string; body: string } | null> {
  return inTransaction(db, async (tx) => {
    const [inserted] = await tx
      .insert(seerrIssueWrites)
      .values({
        seerrIssueId: input.seerrIssueId,
        kind: input.kind,
        state: 'intended',
        body: input.body,
        seerrUserId: input.bridgeUserId,
        repairRequestId: input.repairRequestId ?? null,
        fixRequestId: input.fixRequestId ?? null,
        attempts: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: [seerrIssueWrites.seerrIssueId, seerrIssueWrites.kind] })
      .returning({ id: seerrIssueWrites.id, body: seerrIssueWrites.body });
    if (inserted) return inserted;
    // A retry keeps the first body, so a crash's post is recognised by its exact text.
    const staleBefore = new Date(input.now.getTime() - SEERR_BRIDGE_STALE_INTENT_MS);
    const [reclaimed] = await tx
      .update(seerrIssueWrites)
      .set({
        state: 'intended',
        seerrUserId: input.bridgeUserId,
        attempts: sql`${seerrIssueWrites.attempts} + 1`,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(seerrIssueWrites.seerrIssueId, input.seerrIssueId),
          eq(seerrIssueWrites.kind, input.kind),
          or(
            and(eq(seerrIssueWrites.state, 'failed'), lt(seerrIssueWrites.attempts, SEERR_BRIDGE_MAX_ATTEMPTS)),
            and(eq(seerrIssueWrites.state, 'intended'), lt(seerrIssueWrites.updatedAt, staleBefore)),
          ),
        ),
      )
      .returning({ id: seerrIssueWrites.id, body: seerrIssueWrites.body });
    return reclaimed ?? null;
  });
}

/** Complete a claimed write (only while it is still `intended`: a reclaimed row is never overwritten by a late call). */
async function finishWrite(
  db: DbClient | undefined,
  id: string,
  outcome:
    | { state: 'done'; seerrCommentId: number | null }
    | { state: 'failed'; error: string }
    | { state: 'skipped'; reason: string },
  now: Date,
): Promise<void> {
  const set: Partial<typeof seerrIssueWrites.$inferInsert> = { state: outcome.state, updatedAt: now };
  if (outcome.state === 'done') {
    set.doneAt = now;
    set.seerrCommentId = outcome.seerrCommentId;
    set.lastError = null;
  } else if (outcome.state === 'failed') {
    set.lastError = outcome.error;
  } else {
    set.skipReason = outcome.reason;
  }
  await resolveDb(db)
    .update(seerrIssueWrites)
    .set(set)
    .where(and(eq(seerrIssueWrites.id, id), eq(seerrIssueWrites.state, 'intended')));
}

export type SeerrBridgeWriteOutcome =
  | 'posted'
  | 'adopted'
  | 'resolved'
  | 'skipped_resolved'
  | 'skipped_removed'
  | 'failed'
  | 'claimed_elsewhere';

/** Post the comment for one issue (the row is claimed first). */
async function commentOne(
  db: DbClient | undefined,
  clients: SeerrBridgeClients,
  input: { issueId: number; body: string; bridgeUserId: number; now: () => Date },
): Promise<SeerrBridgeWriteOutcome> {
  const claimed = await claimWrite(db, {
    seerrIssueId: input.issueId,
    kind: 'comment',
    body: input.body,
    bridgeUserId: input.bridgeUserId,
    now: input.now(),
  });
  if (!claimed) return 'claimed_elsewhere';
  let fresh: SeerrIssue | null;
  try {
    fresh = await clients.read.getIssue(input.issueId);
  } catch (error) {
    await finishWrite(db, claimed.id, { state: 'failed', error: errorText(error) }, input.now());
    return 'failed';
  }
  if (fresh === null) {
    await finishWrite(db, claimed.id, { state: 'skipped', reason: 'removed_in_seerr' }, input.now());
    return 'skipped_removed';
  }
  const already = bridgeComment(fresh, input.bridgeUserId, claimed.body);
  if (already !== null) {
    await finishWrite(db, claimed.id, { state: 'done', seerrCommentId: already }, input.now());
    return 'adopted';
  }
  if (fresh.status === 2) {
    await finishWrite(db, claimed.id, { state: 'skipped', reason: 'resolved_in_seerr' }, input.now());
    return 'skipped_resolved';
  }
  try {
    const after = await clients.write.commentOnIssue(input.issueId, claimed.body, input.bridgeUserId);
    await finishWrite(
      db,
      claimed.id,
      { state: 'done', seerrCommentId: bridgeComment(after, input.bridgeUserId, claimed.body) },
      input.now(),
    );
    return 'posted';
  } catch (error) {
    await finishWrite(db, claimed.id, { state: 'failed', error: errorText(error) }, input.now());
    return 'failed';
  }
}

/** Post the outcome note, then resolve, for one issue (the row is claimed first; each step is checked before it runs). */
async function resolveOne(
  db: DbClient | undefined,
  clients: SeerrBridgeClients,
  input: { issueId: number; body: string; bridgeUserId: number; source: ResolveSource; now: () => Date },
): Promise<SeerrBridgeWriteOutcome> {
  const claimed = await claimWrite(db, {
    seerrIssueId: input.issueId,
    kind: 'resolve',
    body: input.body,
    bridgeUserId: input.bridgeUserId,
    repairRequestId: input.source.kind === 'repair' ? input.source.id : null,
    fixRequestId: input.source.kind === 'fix' ? input.source.id : null,
    now: input.now(),
  });
  if (!claimed) return 'claimed_elsewhere';
  try {
    const fresh = await clients.read.getIssue(input.issueId);
    if (fresh === null) {
      await finishWrite(db, claimed.id, { state: 'skipped', reason: 'removed_in_seerr' }, input.now());
      return 'skipped_removed';
    }
    let noteId = bridgeComment(fresh, input.bridgeUserId, claimed.body);
    if (fresh.status === 2) {
      // Resolved already: by this write before a crash (its note is there), or by someone else (left as it is).
      if (noteId !== null) {
        await finishWrite(db, claimed.id, { state: 'done', seerrCommentId: noteId }, input.now());
        return 'adopted';
      }
      await finishWrite(db, claimed.id, { state: 'skipped', reason: 'resolved_in_seerr' }, input.now());
      return 'skipped_resolved';
    }
    if (noteId === null) {
      const withNote = await clients.write.commentOnIssue(input.issueId, claimed.body, input.bridgeUserId);
      noteId = bridgeComment(withNote, input.bridgeUserId, claimed.body);
    }
    const after = await clients.write.resolveIssue(input.issueId, input.bridgeUserId);
    if (after.status !== 2) throw new Error(`Seerr answered the resolve with status ${after.status}`);
    await finishWrite(db, claimed.id, { state: 'done', seerrCommentId: noteId }, input.now());
    return 'resolved';
  } catch (error) {
    await finishWrite(db, claimed.id, { state: 'failed', error: errorText(error) }, input.now());
    return 'failed';
  }
}

const OPEN_REPAIR = new Set(['pending', 'actioned']);
const OPEN_FIX = new Set(['pending', 'actioned', 'search_triggered']);

/**
 * What earns a resolve: among the Repair Requests and Fixes that name this issue, none is still open and the newest has
 * completed. Null otherwise (nothing linked, something still running, or the newest failed, timed out or was closed).
 */
export async function resolveSourceFor(
  db: DbClient | undefined,
  seerrIssueId: number,
): Promise<ResolveSource | null> {
  const exec = resolveDb(db);
  const repairs = await exec
    .select({
      id: repairRequests.id,
      kind: repairRequests.kind,
      status: repairRequests.status,
      label: repairRequests.targetLabel,
      at: repairRequests.createdAt,
    })
    .from(repairRequests)
    .where(eq(repairRequests.seerrIssueId, seerrIssueId));
  const fixes = await exec
    .select({ id: fixRequests.id, status: fixRequests.status, label: fixRequests.targetLabel, at: fixRequests.createdAt })
    .from(fixRequests)
    .where(eq(fixRequests.seerrIssueId, seerrIssueId));
  const all = [
    ...repairs.map((r) => ({ ...r, source: 'repair' as const, open: OPEN_REPAIR.has(r.status) })),
    ...fixes.map((f) => ({ ...f, kind: null, source: 'fix' as const, open: OPEN_FIX.has(f.status) })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  if (all.length === 0 || all.some((r) => r.open)) return null;
  const latest = all[all.length - 1]!;
  if (latest.status !== 'completed') return null;
  return { kind: latest.source, id: latest.id, repairKind: latest.kind, targetLabel: latest.label };
}

export interface SeerrBridgeReport {
  status: 'off' | 'no_bridge_user' | 'bridge_user_invalid' | 'seerr_unavailable' | 'ok';
  comments: Partial<Record<SeerrBridgeWriteOutcome, number>>;
  resolves: Partial<Record<SeerrBridgeWriteOutcome, number>>;
}

/** Whether a Seerr user may be the bridge: the id named, not user 1, holds MANAGE_ISSUES, not an admin. */
export function bridgeUserProblem(user: SeerrUserDetail | null, bridgeUserId: number): string | null {
  if (user === null) return 'no such Seerr user';
  if (user.id !== bridgeUserId || user.id <= 1) return 'not the configured bridge user';
  if ((user.permissions & SEERR_PERMISSION_ADMIN) !== 0) return 'the bridge user must not be a Seerr admin';
  if ((user.permissions & SEERR_PERMISSION_MANAGE_ISSUES) === 0) return 'the bridge user lacks MANAGE_ISSUES';
  return null;
}

/** Does the reported episode (or movie) have a file? Null when nobody can tell. */
async function hasFileFor(
  sonarr: SeerrBridgeEpisodeReader | null,
  row: SeerrIssueRow,
  item: { arrKind: string; arrItemId: number; onDiskFileCount: number },
  cache: Map<number, Array<{ seasonNumber: number; episodeNumber: number; hasFile: boolean }> | null>,
): Promise<boolean | null> {
  if (row.mediaType === 'movie') return item.arrKind === 'radarr' ? item.onDiskFileCount > 0 : null;
  if (row.mediaType !== 'tv' || row.problemSeason <= 0 || row.problemEpisode <= 0) return null;
  if (item.arrKind !== 'sonarr' || sonarr === null) return null;
  let episodes = cache.get(item.arrItemId);
  if (episodes === undefined) {
    try {
      episodes = await sonarr.listEpisodes(item.arrItemId);
    } catch {
      episodes = null;
    }
    cache.set(item.arrItemId, episodes);
  }
  const ep = episodes?.find((e) => e.seasonNumber === row.problemSeason && e.episodeNumber === row.problemEpisode);
  return ep ? ep.hasFile : null;
}

const bump = (m: Partial<Record<SeerrBridgeWriteOutcome, number>>, k: SeerrBridgeWriteOutcome) => {
  m[k] = (m[k] ?? 0) + 1;
};

/**
 * ADR-111 C-03 — one pass of the bridge: the comment on each new open issue, then the resolve on each open issue whose
 * linked repair has completed. Runs after every `seerr-issues` sync and after an issue webhook's read (`issueIds`
 * limits it to that issue). Never throws for Seerr: a failed call is recorded on its row and tried again later.
 */
export async function runSeerrIssueBridge(input: {
  db?: DbClient;
  clients: SeerrBridgeClients;
  /** The public origin the link is built from (`https://haynesnetwork.com`). */
  linkOrigin: string;
  issueIds?: readonly number[];
  now?: () => Date;
  logger?: DomainLogger;
}): Promise<SeerrBridgeReport> {
  const now = input.now ?? (() => new Date());
  const logger = input.logger ?? consoleDomainLogger;
  const report: SeerrBridgeReport = { status: 'ok', comments: {}, resolves: {} };
  const setting = await getSeerrIssueBridge({ db: input.db });
  if (!setting.comment && !setting.resolve) return { ...report, status: 'off' };
  if (setting.bridgeUserId === null) return { ...report, status: 'no_bridge_user' };
  const bridgeUserId = setting.bridgeUserId;
  let user: SeerrUserDetail | null;
  try {
    user = await input.clients.read.getUser(bridgeUserId);
  } catch (error) {
    logger.warn('[seerr-bridge] seerr_unavailable', { error: errorText(error) });
    return { ...report, status: 'seerr_unavailable' };
  }
  const problem = bridgeUserProblem(user, bridgeUserId);
  if (problem !== null) {
    logger.error('[seerr-bridge] bridge_user_invalid', { bridgeUserId, problem });
    return { ...report, status: 'bridge_user_invalid' };
  }

  const exec = resolveDb(input.db);
  const scope = input.issueIds && input.issueIds.length > 0 ? inArray(seerrIssues.seerrIssueId, [...input.issueIds]) : undefined;
  const staleBefore = new Date(now().getTime() - SEERR_BRIDGE_STALE_INTENT_MS);
  const writable = (kind: SeerrIssueWriteKind) =>
    sql`NOT EXISTS (SELECT 1 FROM ${seerrIssueWrites} w WHERE w.seerr_issue_id = ${seerrIssues.seerrIssueId}
          AND w.kind = ${kind}
          AND NOT ((w.state = 'failed' AND w.attempts < ${SEERR_BRIDGE_MAX_ATTEMPTS})
                   OR (w.state = 'intended' AND w.updated_at < ${staleBefore.toISOString()}::timestamptz)))`;

  if (setting.comment && setting.commentFrom !== null) {
    const rows = await exec
      .select({
        issue: seerrIssues,
        arrKind: mediaItems.arrKind,
        arrItemId: mediaItems.arrItemId,
        onDiskFileCount: mediaItems.onDiskFileCount,
      })
      .from(seerrIssues)
      .innerJoin(mediaItems, eq(mediaItems.id, seerrIssues.mediaItemId))
      .where(
        and(
          eq(seerrIssues.status, 'open'),
          isNull(seerrIssues.removedAt),
          isNull(mediaItems.deletedFromArrAt),
          gte(seerrIssues.seerrCreatedAt, new Date(setting.commentFrom)),
          writable('comment'),
          scope,
        ),
      )
      .orderBy(asc(seerrIssues.seerrIssueId));
    const cache = new Map<number, Array<{ seasonNumber: number; episodeNumber: number; hasFile: boolean }> | null>();
    for (const r of rows) {
      const hasFile = await hasFileFor(input.clients.sonarr, r.issue, r, cache);
      const body = seerrIssueCommentText({
        kind: seerrCommentKind(r.issue, hasFile),
        link: seerrIssueLinkUrl(input.linkOrigin, r.issue.seerrIssueId),
        issue: r.issue,
      });
      const outcome = await commentOne(input.db, input.clients, {
        issueId: r.issue.seerrIssueId,
        body,
        bridgeUserId,
        now,
      });
      bump(report.comments, outcome);
      logger.info('[seerr-bridge] comment', { seerrIssueId: r.issue.seerrIssueId, outcome });
    }
  }

  if (setting.resolve) {
    const rows = await exec
      .select({ id: seerrIssues.seerrIssueId, mediaType: seerrIssues.mediaType })
      .from(seerrIssues)
      .where(
        and(
          eq(seerrIssues.status, 'open'),
          isNull(seerrIssues.removedAt),
          or(
            sql`EXISTS (SELECT 1 FROM ${repairRequests} r WHERE r.seerr_issue_id = ${seerrIssues.seerrIssueId})`,
            sql`EXISTS (SELECT 1 FROM ${fixRequests} f WHERE f.seerr_issue_id = ${seerrIssues.seerrIssueId})`,
          ),
          writable('resolve'),
          scope,
        ),
      )
      .orderBy(asc(seerrIssues.seerrIssueId));
    for (const r of rows) {
      const source = await resolveSourceFor(input.db, r.id);
      if (source === null) continue;
      const outcome = await resolveOne(input.db, input.clients, {
        issueId: r.id,
        body: seerrResolveNoteText(seerrResolveOutcome(source, r.mediaType)),
        bridgeUserId,
        source,
        now,
      });
      bump(report.resolves, outcome);
      logger.info('[seerr-bridge] resolve', { seerrIssueId: r.id, outcome, source: source.kind });
    }
  }
  return report;
}

/**
 * `runSeerrIssueBridge` with the clients and the link's origin from the environment (the sync's `seerr-issues` mode and
 * the web app's issue webhook). `unconfigured` without SEERR_API_KEY.
 */
export async function runSeerrIssueBridgeFromEnv(input: {
  db?: DbClient;
  issueIds?: readonly number[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  logger?: DomainLogger;
}): Promise<SeerrBridgeReport | { status: 'unconfigured' }> {
  const bridge = seerrBridgeFromEnv(input.env ?? process.env, input.timeoutMs ?? 15_000);
  if (!bridge) return { status: 'unconfigured' };
  return runSeerrIssueBridge({ db: input.db, ...bridge, issueIds: input.issueIds, logger: input.logger });
}

/** The bridge's clients and the link's public origin (BETTER_AUTH_URL) from the environment; null without SEERR_API_KEY. */
export function seerrBridgeFromEnv(
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 15_000,
): { clients: SeerrBridgeClients; linkOrigin: string } | null {
  const clients = seerrBridgeClientsFromEnv(env, timeoutMs);
  return clients ? { clients, linkOrigin: issuerOrigin(env) } : null;
}

// ---------------------------------------------------------------------------
// Reads (the admin list)
// ---------------------------------------------------------------------------

/** The bridge's state for `/admin/seerr`: the setting, and the bridge user as Seerr has it now. */
export interface SeerrIssueBridgeStatus {
  setting: SeerrIssueBridgeSetting;
  /** The bridge user read live (null when none is set or Seerr could not be read). */
  user: { id: number; displayName: string | null; problem: string | null } | null;
  /** `unconfigured` (no SEERR_API_KEY), `unreachable`, or `ok`. */
  seerr: 'unconfigured' | 'unreachable' | 'ok';
}

/** The admin read of the bridge: the setting, then the bridge user from Seerr (short timeout; never throws for Seerr). */
export async function readSeerrIssueBridgeStatus(input: {
  db?: DbClient;
  reader?: Pick<SeerrBridgeReader, 'getUser'> | null;
  env?: Record<string, string | undefined>;
}): Promise<SeerrIssueBridgeStatus> {
  const setting = await getSeerrIssueBridge({ db: input.db });
  const reader = input.reader !== undefined ? input.reader : (seerrBridgeClientsFromEnv(input.env ?? process.env, 5_000)?.read ?? null);
  if (reader === null) return { setting, user: null, seerr: 'unconfigured' };
  if (setting.bridgeUserId === null) return { setting, user: null, seerr: 'ok' };
  try {
    const user = await reader.getUser(setting.bridgeUserId);
    return {
      setting,
      user: {
        id: setting.bridgeUserId,
        displayName: user?.displayName ?? null,
        problem: bridgeUserProblem(user, setting.bridgeUserId),
      },
      seerr: 'ok',
    };
  } catch {
    return { setting, user: null, seerr: 'unreachable' };
  }
}

/** One write as `/admin/seerr` shows it. */
export interface SeerrIssueWriteSummary {
  state: SeerrIssueWriteState;
  at: string;
  attempts: number;
  lastError: string | null;
  skipReason: string | null;
}

/** The bridge's writes for these issues, by issue and kind. */
export async function seerrIssueWritesFor(
  db: DbClient | undefined,
  seerrIssueIds: readonly number[],
): Promise<Map<number, Partial<Record<SeerrIssueWriteKind, SeerrIssueWriteSummary>>>> {
  const out = new Map<number, Partial<Record<SeerrIssueWriteKind, SeerrIssueWriteSummary>>>();
  if (seerrIssueIds.length === 0) return out;
  const rows: SeerrIssueWriteRow[] = await resolveDb(db)
    .select()
    .from(seerrIssueWrites)
    .where(inArray(seerrIssueWrites.seerrIssueId, [...seerrIssueIds]));
  for (const r of rows) {
    const entry = out.get(r.seerrIssueId) ?? {};
    entry[r.kind] = {
      state: r.state,
      at: (r.doneAt ?? r.updatedAt).toISOString(),
      attempts: r.attempts,
      lastError: r.lastError,
      skipReason: r.skipReason,
    };
    out.set(r.seerrIssueId, entry);
  }
  return out;
}
