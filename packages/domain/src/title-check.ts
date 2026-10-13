// ADR-110 C-03 / DESIGN-055 D-05 (PLAN-077 P4) — the TITLE CHECK (T-305) and its single writer: the census that judges
// each imported Sonarr episode file's own name (Title Evidence, T-304) against the episodes Sonarr filed it on, one
// `title_checks` row per file. A census: it never moves a file and writes nothing to Sonarr (read-only toward it). A
// `disagrees` row whose file is still on its episodes is a FLAG on the title page that opens the Episode Re-map (D-04)
// pre-filled; once the file has left those episodes (a re-map, an upgrade, a delete) the flag is cleared.
//
// Four entry points, every write here (the no-direct-state-writes guard):
// - runTitleCheck: the hourly `title-check` sync mode. Reads `downloadFolderImported` history since its cursor (the
//   newest `history` row's import time less two hours of overlap; the last 48 hours on the first run), judges each
//   imported file, upserts its row, then re-validates the open flags.
// - backfillTitleChecks: the one-off library-wide check (`repair-guide.ts title-check --backfill`). Every import record
//   ever kept, and the scene name of a current file with no import record; only files that still exist are judged.
// - listTitleFlags: one title's open flags, verified live for its title page.
// - sourceTitlesForSeries: the judged name per episode file, the Episode Re-map's per-file evidence.
//
// Evidence comes only from names the release carried: the history record's `sourceTitle`, the base name of the file it
// was dropped as (`data.droppedPath`) and, for a file with no import record, its `sceneName`. Never the library file
// name (`relativePath`): Sonarr renames a file after the episode it sits on, so it always "agrees".
import {
  mediaItems,
  titleChecks,
  type DbClient,
  type TitleCheckOrigin,
  type TitleCheckRow,
  type TitleCheckVerdict,
  type Transaction,
} from '@hnet/db';
import { ARR_CLUSTER_URL_DEFAULTS, ArrConfigError, ArrHttpError, type SonarrImportHistoryRecord } from '@hnet/arr';
import { SonarrClient } from '@hnet/arr/read';
import { and, asc, count, eq, gte, inArray, isNull, max, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import {
  episodeTitleEvidence,
  TITLE_EVIDENCE_VERSION,
  type EpisodeTitleEvidence,
  type TitleEvidenceEpisode,
} from './title-evidence';

// ---------------------------------------------------------------------------
// Constants and reader shapes
// ---------------------------------------------------------------------------

/** The hourly read re-reads this much history before its cursor, so an import Sonarr records late is not missed. */
export const TITLE_CHECK_CURSOR_OVERLAP_MS = 2 * 60 * 60 * 1000;
/**
 * How long an import whose series cannot be read may hold the cursor (one day): past that, the run stops waiting for it
 * (counted in `abandoned`, logged in `errorSamples`) so one broken series cannot stall the census; the library-wide
 * backfill reads it again.
 */
export const TITLE_CHECK_HOLD_MAX_MS = 24 * 60 * 60 * 1000;
/** The first hourly run (no `history` row yet) reads this far back. */
export const TITLE_CHECK_FIRST_WINDOW_MS = 48 * 60 * 60 * 1000;
/** The most series whose open flags one hourly run re-reads from Sonarr (more rotate through later runs). */
export const TITLE_CHECK_REVALIDATE_SERIES_CAP = 200;
/** The backfill's history page size, and the most pages it reads before it refuses (200,000 import records). */
export const TITLE_CHECK_HISTORY_PAGE_SIZE = 1_000;
export const TITLE_CHECK_HISTORY_PAGE_LIMIT = 200;
/** The backfill's default number of series read at once. */
export const TITLE_CHECK_BACKFILL_CONCURRENCY = 3;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WRITE_CHUNK = 500;
const READ_CHUNK = 1_000;
const ERROR_SAMPLES = 10;

/** One Sonarr episode as the Title Check reads it (`GET /episode?seriesId=`). `SonarrClient` satisfies it. */
export interface TitleCheckEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
  /** The file on the episode (Sonarr sends 0 when there is none). */
  episodeFileId?: number | null | undefined;
}

/** One Sonarr episode file as the backfill reads it (`GET /episodefile?seriesId=`). Never judged by `relativePath`. */
export interface TitleCheckEpisodeFile {
  id: number;
  sceneName?: string | null | undefined;
  dateAdded?: string | null | undefined;
}

/** What the Title Check reads from Sonarr; `SonarrClient` satisfies it. Each entry point takes the reads it needs. */
export interface TitleCheckSonarrReader {
  getImportHistorySince(date: Date): Promise<SonarrImportHistoryRecord[]>;
  getImportHistoryPage(params: {
    page: number;
    pageSize?: number;
  }): Promise<{ totalRecords: number; records: SonarrImportHistoryRecord[] }>;
  listEpisodes(seriesId: number): Promise<TitleCheckEpisode[]>;
  listEpisodeFileReleases(seriesId: number): Promise<TitleCheckEpisodeFile[]>;
}

/** The Sonarr read client for the `title-check` sync and the in-cluster tool (SONARR_API_KEY required). */
export function titleCheckSonarrFromEnv(
  env: Record<string, string | undefined> = process.env,
  timeoutMs = 60_000,
): SonarrClient {
  const apiKey = env.SONARR_API_KEY?.trim();
  if (!apiKey) throw new ArrConfigError(['SONARR_API_KEY']);
  return new SonarrClient({ baseUrl: env.SONARR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.sonarr, apiKey, timeoutMs });
}

// ---------------------------------------------------------------------------
// Judging one file (pure)
// ---------------------------------------------------------------------------

/** One file's Title Check, as `judgeTitleCheckFile` decides it. */
export interface TitleCheckJudgment {
  verdict: TitleCheckVerdict;
  /** The name that produced the kept verdict (stored as `source_title`). */
  name: string;
  /** The file's episodes, in season and episode order. */
  episodeIds: number[];
  /** The first of them, and its season. */
  episodeId: number;
  episodeNumber: number;
  seasonNumber: number;
  bestEpisodeId: number | null;
  bestEpisodeNumber: number | null;
  /** The file's own episodes' score. */
  score: number | null;
  bestScore: number | null;
}

const VERDICT_RANK: Record<TitleCheckVerdict, number> = { agrees: 3, disagrees: 2, ambiguous: 1, silent: 0 };
const VIDEO_EXTENSION = /\.(mkv|mp4|m4v|avi|wmv|mov|mpg|mpeg|ts|m2ts|webm|iso)$/i;

/** The base name of a path, its video extension dropped (`/a/b/Show.S01E07.Title.1080p-GRP.mkv` → `Show.S01E07...`). */
export function droppedFileName(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.split(/[\\/]/).filter((s) => s.length > 0).pop();
  if (!base) return null;
  const name = base.replace(VIDEO_EXTENSION, '').trim();
  return name.length > 0 ? name : null;
}

/**
 * D-05: judge one file. Every candidate name is scored against the series' episodes with the file's episodes as the
 * mapping; the kept verdict is any `agrees`, else the first `disagrees` (with its best episode and scores), else
 * `ambiguous`, else `silent`. Null when there is no name, or none of the file's episodes is in `episodes`.
 */
export function judgeTitleCheckFile(input: {
  names: ReadonlyArray<string | null | undefined>;
  episodes: readonly TitleEvidenceEpisode[];
  fileEpisodeIds: readonly number[];
}): TitleCheckJudgment | null {
  const wanted = new Set(input.fileEpisodeIds);
  const held = input.episodes
    .filter((e) => wanted.has(e.id))
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  const first = held[0];
  if (!first) return null;
  const names = [...new Set(input.names.map((n) => n?.trim() ?? '').filter((n) => n.length > 0))];
  if (names.length === 0) return null;
  const episodeIds = held.map((e) => e.id);

  let kept: { name: string; evidence: EpisodeTitleEvidence } | null = null;
  for (const name of names) {
    const evidence = episodeTitleEvidence({ name, episodes: input.episodes, againstEpisodeIds: episodeIds });
    if (kept === null || VERDICT_RANK[evidence.verdict] > VERDICT_RANK[kept.evidence.verdict]) {
      kept = { name, evidence };
    }
  }
  const { name, evidence } = kept!;
  return {
    verdict: evidence.verdict,
    name,
    episodeIds,
    episodeId: first.id,
    episodeNumber: first.episodeNumber,
    seasonNumber: first.seasonNumber,
    bestEpisodeId: evidence.bestEpisodeId,
    bestEpisodeNumber:
      evidence.bestEpisodeId === null
        ? null
        : (input.episodes.find((e) => e.id === evidence.bestEpisodeId)?.episodeNumber ?? null),
    score: evidence.againstScore,
    bestScore: evidence.bestScore,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** One imported file, from its history records (Sonarr writes one record per episode). */
interface ImportedFile {
  fileId: number;
  seriesId: number;
  episodeIds: number[];
  sourceTitle: string | null;
  droppedPath: string | null;
  importedAt: Date;
}

function groupImportsByFile(records: readonly SonarrImportHistoryRecord[], now: Date): Map<number, ImportedFile> {
  const files = new Map<number, ImportedFile>();
  for (const r of records) {
    if (r.fileId === null) continue;
    const parsed = new Date(r.date);
    const date = Number.isNaN(parsed.getTime()) ? now : parsed;
    const file = files.get(r.fileId);
    if (!file) {
      files.set(r.fileId, {
        fileId: r.fileId,
        seriesId: r.seriesId,
        episodeIds: [r.episodeId],
        sourceTitle: r.sourceTitle,
        droppedPath: r.droppedPath,
        importedAt: date,
      });
      continue;
    }
    if (!file.episodeIds.includes(r.episodeId)) file.episodeIds.push(r.episodeId);
    file.sourceTitle ??= r.sourceTitle;
    file.droppedPath ??= r.droppedPath;
    if (date > file.importedAt) file.importedAt = date;
  }
  return files;
}

const toEvidenceEpisodes = (episodes: readonly TitleCheckEpisode[]): TitleEvidenceEpisode[] =>
  episodes.map((e) => ({ id: e.id, seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber, title: e.title }));

/** Episode file id → the episodes holding it now (Sonarr's 0 means no file). */
function filesOnEpisodes(episodes: readonly TitleCheckEpisode[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const e of episodes) {
    const fileId = e.episodeFileId ?? 0;
    if (fileId <= 0) continue;
    const list = out.get(fileId);
    if (list) list.push(e.id);
    else out.set(fileId, [e.id]);
  }
  return out;
}

/** A flag still holds while its file is the file of every one of its episodes. */
function flagStillHolds(
  flag: Pick<TitleCheckRow, 'episodeIds' | 'episodeFileId'>,
  episodes: readonly TitleCheckEpisode[],
): boolean {
  const byId = new Map(episodes.map((e) => [e.id, e] as const));
  return flag.episodeIds.every((id) => (byId.get(id)?.episodeFileId ?? 0) === flag.episodeFileId);
}

const emptyVerdicts = (): Record<TitleCheckVerdict, number> => ({ agrees: 0, disagrees: 0, silent: 0, ambiguous: 0 });

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run `fn` over `items` with at most `limit` at once, keeping order. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** The live ledger items of these Sonarr series (not tombstoned): series id → item id and title. */
async function seriesItems(
  executor: DbClient | undefined,
  seriesIds: readonly number[],
): Promise<Map<number, { id: string; title: string }>> {
  const out = new Map<number, { id: string; title: string }>();
  for (const ids of chunks([...new Set(seriesIds)], READ_CHUNK)) {
    const rows = await resolveDb(executor)
      .select({ id: mediaItems.id, title: mediaItems.title, seriesId: mediaItems.arrItemId })
      .from(mediaItems)
      .where(
        and(eq(mediaItems.arrKind, 'sonarr'), inArray(mediaItems.arrItemId, ids), isNull(mediaItems.deletedFromArrAt)),
      );
    for (const r of rows) if (!out.has(r.seriesId)) out.set(r.seriesId, { id: r.id, title: r.title });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The single writer
// ---------------------------------------------------------------------------

interface TitleCheckWrite {
  seriesId: number;
  mediaItemId: string | null;
  judgment: TitleCheckJudgment;
  episodeFileId: number;
  origin: TitleCheckOrigin;
  importedAt: Date;
}

interface UpsertCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  flagsOpened: number;
}

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
/** `score` and `best_score` are float4: compare at its precision. */
const sameScore = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-6);
const isOpenFlag = (r: Pick<TitleCheckRow, 'verdict' | 'clearedAt'>) => r.verdict === 'disagrees' && r.clearedAt === null;

/**
 * Upsert one row per file (`instance`, `episode_file_id`). A row whose stored verdict, evidence and mapping already
 * match is left alone. On an update the row keeps its `origin` and `created_at`, and keeps `cleared_at` while its
 * `episode_ids` are unchanged (a re-read of the same import never reopens a cleared flag); a new mapping is a new
 * judgment, so it opens again.
 */
async function upsertTitleChecks(tx: Transaction, writes: readonly TitleCheckWrite[], now: Date): Promise<UpsertCounts> {
  const counts: UpsertCounts = { inserted: 0, updated: 0, unchanged: 0, flagsOpened: 0 };
  const byFile = new Map(writes.map((w) => [w.episodeFileId, w] as const));
  const existing = new Map<number, TitleCheckRow>();
  for (const ids of chunks([...byFile.keys()], READ_CHUNK)) {
    const rows = await tx
      .select()
      .from(titleChecks)
      .where(and(eq(titleChecks.instance, 'sonarr'), inArray(titleChecks.episodeFileId, ids)));
    for (const r of rows) existing.set(r.episodeFileId, r);
  }

  const toWrite: TitleCheckWrite[] = [];
  for (const w of byFile.values()) {
    const j = w.judgment;
    const old = existing.get(w.episodeFileId);
    const keepsMapping = old !== undefined && sameIds(old.episodeIds, j.episodeIds);
    const openAfter = j.verdict === 'disagrees' && (keepsMapping ? old!.clearedAt === null : true);
    if (openAfter && !(old && isOpenFlag(old))) counts.flagsOpened += 1;
    if (
      old &&
      keepsMapping &&
      old.verdict === j.verdict &&
      old.seriesId === w.seriesId &&
      old.mediaItemId === w.mediaItemId &&
      old.seasonNumber === j.seasonNumber &&
      old.episodeId === j.episodeId &&
      old.episodeNumber === j.episodeNumber &&
      old.sourceTitle === j.name &&
      old.bestEpisodeId === j.bestEpisodeId &&
      old.bestEpisodeNumber === j.bestEpisodeNumber &&
      sameScore(old.score, j.score) &&
      sameScore(old.bestScore, j.bestScore) &&
      old.evidenceVersion === TITLE_EVIDENCE_VERSION &&
      old.importedAt.getTime() === w.importedAt.getTime()
    ) {
      counts.unchanged += 1;
      continue;
    }
    if (old) counts.updated += 1;
    else counts.inserted += 1;
    toWrite.push(w);
  }

  for (const batch of chunks(toWrite, WRITE_CHUNK)) {
    await tx
      .insert(titleChecks)
      .values(
        batch.map((w) => ({
          instance: 'sonarr',
          seriesId: w.seriesId,
          mediaItemId: w.mediaItemId,
          seasonNumber: w.judgment.seasonNumber,
          episodeId: w.judgment.episodeId,
          episodeNumber: w.judgment.episodeNumber,
          episodeIds: w.judgment.episodeIds,
          episodeFileId: w.episodeFileId,
          sourceTitle: w.judgment.name,
          verdict: w.judgment.verdict,
          bestEpisodeId: w.judgment.bestEpisodeId,
          bestEpisodeNumber: w.judgment.bestEpisodeNumber,
          score: w.judgment.score,
          bestScore: w.judgment.bestScore,
          evidenceVersion: TITLE_EVIDENCE_VERSION,
          origin: w.origin,
          importedAt: w.importedAt,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [titleChecks.instance, titleChecks.episodeFileId],
        set: {
          seriesId: sql`excluded.series_id`,
          mediaItemId: sql`excluded.media_item_id`,
          seasonNumber: sql`excluded.season_number`,
          episodeId: sql`excluded.episode_id`,
          episodeNumber: sql`excluded.episode_number`,
          episodeIds: sql`excluded.episode_ids`,
          sourceTitle: sql`excluded.source_title`,
          verdict: sql`excluded.verdict`,
          bestEpisodeId: sql`excluded.best_episode_id`,
          bestEpisodeNumber: sql`excluded.best_episode_number`,
          score: sql`excluded.score`,
          bestScore: sql`excluded.best_score`,
          evidenceVersion: sql`excluded.evidence_version`,
          importedAt: sql`excluded.imported_at`,
          clearedAt: sql`CASE WHEN "title_checks"."episode_ids" = excluded.episode_ids THEN "title_checks"."cleared_at" ELSE NULL END`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  return counts;
}

/** Close these flags (their file has left their episodes). */
async function clearFlags(executor: DbClient | undefined, ids: readonly string[], now: Date): Promise<number> {
  let cleared = 0;
  for (const batch of chunks(ids, READ_CHUNK)) {
    const rows = await resolveDb(executor)
      .update(titleChecks)
      .set({ clearedAt: now, updatedAt: now })
      .where(and(inArray(titleChecks.id, batch), isNull(titleChecks.clearedAt)))
      .returning({ id: titleChecks.id });
    cleared += rows.length;
  }
  return cleared;
}

const openFlagWhere = () =>
  and(eq(titleChecks.instance, 'sonarr'), eq(titleChecks.verdict, 'disagrees'), isNull(titleChecks.clearedAt));

// ---------------------------------------------------------------------------
// The hourly census
// ---------------------------------------------------------------------------

export interface TitleCheckRunResult {
  /** The history read's start (the cursor less the overlap, or the first-run window). */
  since: string;
  /** `downloadFolderImported` records read. */
  records: number;
  /** Distinct imported files judged. */
  files: number;
  /** Files not judged: no name, or none of their episodes is on the series any more (or its read failed). */
  skipped: number;
  /**
   * Judged files not written because an earlier import's series could not be read (a transient failure): the cursor is
   * held at that import so the next run reads it again; these files are re-read then too.
   */
  deferred: number;
  /** Imports of a transiently unreadable series older than TITLE_CHECK_HOLD_MAX_MS: no longer held for. */
  abandoned: number;
  verdicts: Record<TitleCheckVerdict, number>;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Rows inserted or updated. */
  written: number;
  flagsOpened: number;
  flagsCleared: number;
  /** Series whose episodes were read from Sonarr (judging and re-validation). */
  seriesRead: number;
  /** Per-series read failures (each skipped, never fatal to the run). */
  errors: number;
  errorSamples: string[];
}

/**
 * D-05 / ADR-110 C-03 — the hourly Title Check (sync mode `title-check`). Throws only when the history read itself
 * fails (the mode's totalFailure); a failed episode read for one series is counted and that series skipped.
 */
export async function runTitleCheck(input: {
  db?: DbClient;
  sonarr: Pick<TitleCheckSonarrReader, 'getImportHistorySince' | 'listEpisodes'>;
  now?: Date;
}): Promise<TitleCheckRunResult> {
  const now = input.now ?? new Date();
  const db = resolveDb(input.db);
  const [cursorRow] = await db
    .select({ last: max(titleChecks.importedAt) })
    .from(titleChecks)
    .where(and(eq(titleChecks.instance, 'sonarr'), eq(titleChecks.origin, 'history')));
  const last = cursorRow?.last ?? null;
  const since = last
    ? new Date(last.getTime() - TITLE_CHECK_CURSOR_OVERLAP_MS)
    : new Date(now.getTime() - TITLE_CHECK_FIRST_WINDOW_MS);

  const records = await input.sonarr.getImportHistorySince(since);
  const files = groupImportsByFile(records, now);
  const result: TitleCheckRunResult = {
    since: since.toISOString(),
    records: records.length,
    files: 0,
    skipped: 0,
    deferred: 0,
    abandoned: 0,
    verdicts: emptyVerdicts(),
    inserted: 0,
    updated: 0,
    unchanged: 0,
    written: 0,
    flagsOpened: 0,
    flagsCleared: 0,
    seriesRead: 0,
    errors: 0,
    errorSamples: [],
  };
  const fail = (seriesId: number, error: unknown) => {
    result.errors += 1;
    if (result.errorSamples.length < ERROR_SAMPLES) result.errorSamples.push(`series ${seriesId}: ${errorText(error)}`);
  };

  // Each touched series' episodes, read once (before any transaction opens: a slow Sonarr holds no row lock).
  const episodesBySeries = new Map<number, TitleCheckEpisode[]>();
  /** Series whose read failed for a reason that may pass (not a 404: a series deleted from Sonarr is gone for good). */
  const transient = new Set<number>();
  const readEpisodes = async (seriesId: number) => {
    try {
      episodesBySeries.set(seriesId, await input.sonarr.listEpisodes(seriesId));
      result.seriesRead += 1;
    } catch (error) {
      fail(seriesId, error);
      if (!(error instanceof ArrHttpError && error.status === 404)) transient.add(seriesId);
    }
  };
  const touched = [...new Set([...files.values()].map((f) => f.seriesId))];
  for (const seriesId of touched) await readEpisodes(seriesId);

  // The cursor is the newest written import, so a write past a transiently unread import would skip that import for
  // good. Hold the line: nothing newer than the oldest such import is written this run; the next run reads it all again.
  // The hold is bounded: an import older than TITLE_CHECK_HOLD_MAX_MS is given up on (the backfill reads it again).
  let holdAt: number | null = null;
  const holdFloor = now.getTime() - TITLE_CHECK_HOLD_MAX_MS;
  for (const f of files.values()) {
    if (!transient.has(f.seriesId)) continue;
    if (f.importedAt.getTime() < holdFloor) {
      result.abandoned += 1;
      continue;
    }
    if (holdAt === null || f.importedAt.getTime() < holdAt) holdAt = f.importedAt.getTime();
  }
  const items = await seriesItems(input.db, touched);
  const writes: TitleCheckWrite[] = [];
  for (const file of files.values()) {
    const episodes = episodesBySeries.get(file.seriesId);
    const judgment = episodes
      ? judgeTitleCheckFile({
          names: [file.sourceTitle, droppedFileName(file.droppedPath)],
          episodes: toEvidenceEpisodes(episodes),
          fileEpisodeIds: file.episodeIds,
        })
      : null;
    if (!judgment) {
      result.skipped += 1;
      continue;
    }
    if (holdAt !== null && file.importedAt.getTime() >= holdAt) {
      result.deferred += 1;
      continue;
    }
    result.files += 1;
    result.verdicts[judgment.verdict] += 1;
    writes.push({
      seriesId: file.seriesId,
      mediaItemId: items.get(file.seriesId)?.id ?? null,
      judgment,
      episodeFileId: file.fileId,
      origin: 'history',
      importedAt: file.importedAt,
    });
  }
  if (writes.length > 0) {
    const counts = await inTransaction(input.db, (tx) => upsertTitleChecks(tx, writes, now));
    result.inserted = counts.inserted;
    result.updated = counts.updated;
    result.unchanged = counts.unchanged;
    result.flagsOpened = counts.flagsOpened;
  }
  result.written = result.inserted + result.updated;

  // Re-validate the open flags: the series read above are checked for free; of the rest, a window of at most
  // TITLE_CHECK_REVALIDATE_SERIES_CAP series, rotating by the hour so every series is reached.
  const openSeries = (
    await db.selectDistinct({ seriesId: titleChecks.seriesId }).from(titleChecks).where(openFlagWhere())
  )
    .map((r) => r.seriesId)
    .sort((a, b) => a - b);
  const unread = openSeries.filter((id) => !episodesBySeries.has(id) && !touched.includes(id));
  let window = unread;
  if (unread.length > TITLE_CHECK_REVALIDATE_SERIES_CAP) {
    const pages = Math.ceil(unread.length / TITLE_CHECK_REVALIDATE_SERIES_CAP);
    const page = Math.floor(now.getTime() / HOUR_MS) % pages;
    window = unread.slice(page * TITLE_CHECK_REVALIDATE_SERIES_CAP, (page + 1) * TITLE_CHECK_REVALIDATE_SERIES_CAP);
  }
  for (const seriesId of window) await readEpisodes(seriesId);
  const checkable = openSeries.filter((id) => episodesBySeries.has(id));
  const stale: string[] = [];
  for (const ids of chunks(checkable, READ_CHUNK)) {
    const flags = await db
      .select({
        id: titleChecks.id,
        seriesId: titleChecks.seriesId,
        episodeIds: titleChecks.episodeIds,
        episodeFileId: titleChecks.episodeFileId,
      })
      .from(titleChecks)
      .where(and(openFlagWhere(), inArray(titleChecks.seriesId, ids)));
    for (const f of flags) if (!flagStillHolds(f, episodesBySeries.get(f.seriesId)!)) stale.push(f.id);
  }
  result.flagsCleared = await clearFlags(input.db, stale, now);
  return result;
}

// ---------------------------------------------------------------------------
// The one-off backfill
// ---------------------------------------------------------------------------

export interface TitleCheckEpisodeRef {
  episodeId: number;
  episodeNumber: number;
  title: string | null;
}

/** One `disagrees` file in the backfill report. */
export interface TitleCheckBackfillDisagreement {
  seriesId: number;
  seriesTitle: string;
  seasonNumber: number;
  episodeFileId: number;
  /** The episode the file sits on (the first, for a multi-episode file) and every episode it holds. */
  episode: TitleCheckEpisodeRef;
  episodeIds: number[];
  best: TitleCheckEpisodeRef | null;
  score: number | null;
  bestScore: number | null;
  /** The judged name, and where it came from (an import record, or the file's scene name). */
  name: string;
  nameFrom: 'history' | 'scene_name';
}

export interface TitleCheckBackfillReport {
  dryRun: boolean;
  historyRecords: number;
  /** Distinct files in the import history (current or not). */
  historyFiles: number;
  /** Series read (every series with an import record). */
  series: number;
  /** Current files judged, by the source of their name. */
  filesJudged: number;
  fromHistory: number;
  fromSceneName: number;
  /** Current files with no import record and no scene name: nothing to judge. */
  noEvidence: number;
  verdicts: Record<TitleCheckVerdict, number>;
  /** Rows inserted or updated (0 on a dry run). */
  written: number;
  /** Flags the run opened (on a dry run: would open). */
  flagsOpened: number;
  disagrees: TitleCheckBackfillDisagreement[];
  /** Series whose reads failed (skipped). */
  errors: number;
  errorSamples: string[];
}

/**
 * D-05 — the one-off library-wide Title Check. Pages every `downloadFolderImported` record, then reads each series with
 * one (its episodes and episode files, `concurrency` series at once, each series' reads in turn) and judges every file
 * that still exists: by its import record's names against the episodes holding it now, else by its scene name. Writes
 * `origin = 'backfill'` rows unless `dryRun`. Read-only toward Sonarr.
 */
export async function backfillTitleChecks(input: {
  db?: DbClient;
  sonarr: Pick<TitleCheckSonarrReader, 'getImportHistoryPage' | 'listEpisodes' | 'listEpisodeFileReleases'>;
  dryRun: boolean;
  concurrency?: number;
  now?: Date;
  onProgress?: (progress: { phase: 'history' | 'series'; done: number; total: number }) => void;
}): Promise<TitleCheckBackfillReport> {
  const now = input.now ?? new Date();
  const records: SonarrImportHistoryRecord[] = [];
  for (let page = 1; ; page += 1) {
    if (page > TITLE_CHECK_HISTORY_PAGE_LIMIT) {
      throw new Error(
        `import history: more than ${TITLE_CHECK_HISTORY_PAGE_LIMIT * TITLE_CHECK_HISTORY_PAGE_SIZE} records`,
      );
    }
    const res = await input.sonarr.getImportHistoryPage({ page, pageSize: TITLE_CHECK_HISTORY_PAGE_SIZE });
    records.push(...res.records);
    input.onProgress?.({ phase: 'history', done: records.length, total: res.totalRecords });
    if (res.records.length < TITLE_CHECK_HISTORY_PAGE_SIZE || records.length >= res.totalRecords) break;
  }
  const history = groupImportsByFile(records, now);
  const seriesIds = [...new Set([...history.values()].map((f) => f.seriesId))].sort((a, b) => a - b);

  const report: TitleCheckBackfillReport = {
    dryRun: input.dryRun,
    historyRecords: records.length,
    historyFiles: history.size,
    series: seriesIds.length,
    filesJudged: 0,
    fromHistory: 0,
    fromSceneName: 0,
    noEvidence: 0,
    verdicts: emptyVerdicts(),
    written: 0,
    flagsOpened: 0,
    disagrees: [],
    errors: 0,
    errorSamples: [],
  };

  const items = await seriesItems(input.db, seriesIds);
  const writes: TitleCheckWrite[] = [];
  let done = 0;
  await mapPool(seriesIds, input.concurrency ?? TITLE_CHECK_BACKFILL_CONCURRENCY, async (seriesId) => {
    let episodes: TitleCheckEpisode[];
    let files: TitleCheckEpisodeFile[];
    try {
      episodes = await input.sonarr.listEpisodes(seriesId);
      files = await input.sonarr.listEpisodeFileReleases(seriesId);
    } catch (error) {
      report.errors += 1;
      if (report.errorSamples.length < ERROR_SAMPLES) report.errorSamples.push(`series ${seriesId}: ${errorText(error)}`);
      return;
    } finally {
      done += 1;
      input.onProgress?.({ phase: 'series', done, total: seriesIds.length });
    }
    const evidenceEpisodes = toEvidenceEpisodes(episodes);
    const byEpisode = new Map(episodes.map((e) => [e.id, e] as const));
    const fileInfo = new Map(files.map((f) => [f.id, f] as const));
    for (const [fileId, onEpisodes] of filesOnEpisodes(episodes)) {
      const imported = history.get(fileId);
      const info = fileInfo.get(fileId);
      const sceneName = info?.sceneName?.trim() ? info.sceneName : null;
      let names: Array<string | null>;
      let importedAt: Date;
      let nameFrom: 'history' | 'scene_name';
      if (imported) {
        names = [imported.sourceTitle, droppedFileName(imported.droppedPath)];
        importedAt = imported.importedAt;
        nameFrom = 'history';
      } else if (sceneName) {
        names = [sceneName];
        const added = info?.dateAdded ? new Date(info.dateAdded) : null;
        importedAt = added && !Number.isNaN(added.getTime()) ? added : now;
        nameFrom = 'scene_name';
      } else {
        report.noEvidence += 1;
        continue;
      }
      const judgment = judgeTitleCheckFile({ names, episodes: evidenceEpisodes, fileEpisodeIds: onEpisodes });
      if (!judgment) {
        report.noEvidence += 1;
        continue;
      }
      report.filesJudged += 1;
      if (nameFrom === 'history') report.fromHistory += 1;
      else report.fromSceneName += 1;
      report.verdicts[judgment.verdict] += 1;
      writes.push({
        seriesId,
        mediaItemId: items.get(seriesId)?.id ?? null,
        judgment,
        episodeFileId: fileId,
        origin: 'backfill',
        importedAt,
      });
      if (judgment.verdict === 'disagrees') {
        const ref = (id: number | null): TitleCheckEpisodeRef | null => {
          const e = id === null ? undefined : byEpisode.get(id);
          return e ? { episodeId: e.id, episodeNumber: e.episodeNumber, title: e.title } : null;
        };
        report.disagrees.push({
          seriesId,
          seriesTitle: items.get(seriesId)?.title ?? `series ${seriesId}`,
          seasonNumber: judgment.seasonNumber,
          episodeFileId: fileId,
          episode: ref(judgment.episodeId)!,
          episodeIds: judgment.episodeIds,
          best: ref(judgment.bestEpisodeId),
          score: judgment.score,
          bestScore: judgment.bestScore,
          name: judgment.name,
          nameFrom,
        });
      }
    }
  });
  report.disagrees.sort(
    (a, b) =>
      a.seriesTitle.localeCompare(b.seriesTitle) ||
      a.seasonNumber - b.seasonNumber ||
      a.episode.episodeNumber - b.episode.episodeNumber,
  );

  if (input.dryRun) {
    // What a write would open: the same comparison, without the write.
    const existing = new Map<number, Pick<TitleCheckRow, 'verdict' | 'clearedAt' | 'episodeIds'>>();
    for (const ids of chunks(
      writes.map((w) => w.episodeFileId),
      READ_CHUNK,
    )) {
      const rows = await resolveDb(input.db)
        .select({
          episodeFileId: titleChecks.episodeFileId,
          verdict: titleChecks.verdict,
          clearedAt: titleChecks.clearedAt,
          episodeIds: titleChecks.episodeIds,
        })
        .from(titleChecks)
        .where(and(eq(titleChecks.instance, 'sonarr'), inArray(titleChecks.episodeFileId, ids)));
      for (const r of rows) existing.set(r.episodeFileId, r);
    }
    for (const w of writes) {
      if (w.judgment.verdict !== 'disagrees') continue;
      const old = existing.get(w.episodeFileId);
      const keepsMapping = old !== undefined && sameIds(old.episodeIds, w.judgment.episodeIds);
      const openAfter = keepsMapping ? old!.clearedAt === null : true;
      if (openAfter && !(old && isOpenFlag(old))) report.flagsOpened += 1;
    }
    return report;
  }

  if (writes.length > 0) {
    const counts = await inTransaction(input.db, (tx) => upsertTitleChecks(tx, writes, now));
    report.written = counts.inserted + counts.updated;
    report.flagsOpened = counts.flagsOpened;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Reads for the title page and the Episode Re-map
// ---------------------------------------------------------------------------

/** One open Title Check flag on a title page (D-05): "This file's name says it is E23, All You Can Fit". */
export interface TitleFlag {
  titleCheckId: string;
  seasonNumber: number;
  /** The episode the file sits on (the first, for a multi-episode file), and every episode it holds. */
  episodeId: number;
  episodeNumber: number;
  episodeTitle: string | null;
  episodeIds: number[];
  episodeFileId: number;
  /** The judged name. */
  sourceTitle: string;
  /** The episode the name points to. */
  best: TitleCheckEpisodeRef | null;
  score: number | null;
  bestScore: number | null;
}

/**
 * D-05 — the open flags of one Sonarr title, verified live with one episode read: a flag whose file is no longer on its
 * episodes is left out and cleared. No flag, no Sonarr read. Not a Sonarr title (or unknown): []. A failed read throws.
 */
export async function listTitleFlags(input: {
  db?: DbClient;
  sonarr: Pick<TitleCheckSonarrReader, 'listEpisodes'>;
  mediaItemId: string;
  now?: Date;
}): Promise<TitleFlag[]> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({ seriesId: mediaItems.arrItemId })
    .from(mediaItems)
    .where(and(eq(mediaItems.id, input.mediaItemId), eq(mediaItems.arrKind, 'sonarr')));
  if (!item) return [];
  const flags = await db
    .select()
    .from(titleChecks)
    .where(and(openFlagWhere(), eq(titleChecks.seriesId, item.seriesId)))
    .orderBy(asc(titleChecks.seasonNumber), asc(titleChecks.episodeId));
  if (flags.length === 0) return [];

  const episodes = await input.sonarr.listEpisodes(item.seriesId);
  const byId = new Map(episodes.map((e) => [e.id, e] as const));
  const stale = flags.filter((f) => !flagStillHolds(f, episodes)).map((f) => f.id);
  if (stale.length > 0) await clearFlags(input.db, stale, input.now ?? new Date());

  const ref = (id: number | null): TitleCheckEpisodeRef | null => {
    const e = id === null ? undefined : byId.get(id);
    return e ? { episodeId: e.id, episodeNumber: e.episodeNumber, title: e.title } : null;
  };
  return flags
    .filter((f) => !stale.includes(f.id))
    .map((f) => {
      const on = byId.get(f.episodeId)!;
      return {
        titleCheckId: f.id,
        seasonNumber: on.seasonNumber,
        episodeId: f.episodeId,
        episodeNumber: on.episodeNumber,
        episodeTitle: on.title,
        episodeIds: f.episodeIds,
        episodeFileId: f.episodeFileId,
        sourceTitle: f.sourceTitle,
        best: ref(f.bestEpisodeId),
        score: f.score,
        bestScore: f.bestScore,
      };
    })
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

/** D-04 / D-05 — episode file id → the name the Title Check judged it by, for one series (the Episode Re-map's evidence). */
export async function sourceTitlesForSeries(input: { db?: DbClient; seriesId: number }): Promise<Map<number, string>> {
  const rows = await resolveDb(input.db)
    .select({ episodeFileId: titleChecks.episodeFileId, sourceTitle: titleChecks.sourceTitle })
    .from(titleChecks)
    .where(and(eq(titleChecks.instance, 'sonarr'), eq(titleChecks.seriesId, input.seriesId)));
  return new Map(rows.map((r) => [r.episodeFileId, r.sourceTitle] as const));
}

/** D-05 — the nightly digest's Title Check line: flags opened in the last 24 hours, and open flags in all. */
export async function titleCheckDigestCounts(input: {
  db?: DbClient;
  now?: Date;
}): Promise<{ opened24h: number; open: number }> {
  const db = resolveDb(input.db);
  const since = new Date((input.now ?? new Date()).getTime() - DAY_MS);
  const [opened] = await db
    .select({ n: count() })
    .from(titleChecks)
    .where(
      and(eq(titleChecks.instance, 'sonarr'), eq(titleChecks.verdict, 'disagrees'), gte(titleChecks.createdAt, since)),
    );
  const [open] = await db.select({ n: count() }).from(titleChecks).where(openFlagWhere());
  return { opened24h: opened?.n ?? 0, open: open?.n ?? 0 };
}

/** One open flag as the admin Title Check card lists it (stored numbers, so it reads without Sonarr). */
export interface TitleCheckSummaryFlag {
  titleCheckId: string;
  mediaItemId: string | null;
  seriesId: number;
  seriesTitle: string | null;
  seasonNumber: number;
  episodeNumber: number;
  bestEpisodeNumber: number | null;
  sourceTitle: string;
  origin: TitleCheckOrigin;
  importedAt: Date;
}

export interface TitleCheckSummary {
  counts: Record<TitleCheckVerdict, number>;
  openFlags: number;
  /** The newest open flags (newest import first), at most `limit`. */
  recentFlags: TitleCheckSummaryFlag[];
}

/** DESIGN-055 D-05 (PLAN-077 P4) — the admin read of the census: verdict counts, open flags, the newest open flags. */
export async function titleCheckSummary(input: { db?: DbClient; limit?: number } = {}): Promise<TitleCheckSummary> {
  const db = resolveDb(input.db);
  const rows = await db
    .select({ verdict: titleChecks.verdict, n: count() })
    .from(titleChecks)
    .where(eq(titleChecks.instance, 'sonarr'))
    .groupBy(titleChecks.verdict);
  const counts: Record<TitleCheckVerdict, number> = { agrees: 0, disagrees: 0, silent: 0, ambiguous: 0 };
  for (const r of rows) counts[r.verdict] = Number(r.n);
  const [open] = await db.select({ n: count() }).from(titleChecks).where(openFlagWhere());
  const recent = await db
    .select({
      titleCheckId: titleChecks.id,
      mediaItemId: titleChecks.mediaItemId,
      seriesId: titleChecks.seriesId,
      seriesTitle: mediaItems.title,
      seasonNumber: titleChecks.seasonNumber,
      episodeNumber: titleChecks.episodeNumber,
      bestEpisodeNumber: titleChecks.bestEpisodeNumber,
      sourceTitle: titleChecks.sourceTitle,
      origin: titleChecks.origin,
      importedAt: titleChecks.importedAt,
    })
    .from(titleChecks)
    .leftJoin(mediaItems, eq(mediaItems.id, titleChecks.mediaItemId))
    .where(openFlagWhere())
    .orderBy(sql`${titleChecks.importedAt} DESC`)
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 500));
  return { counts, openFlags: Number(open?.n ?? 0), recentFlags: recent };
}
