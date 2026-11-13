// DESIGN-008 D-03 (2026-11-13) — one-off household watch-history backfill.
//
// The 6-hourly metadata refresh pages the whole Tautulli history after this change, but the rows it
// already wrote still hold the old window (a play, or null). This reads the same history once and
// rewrites only the watch columns of live movies and shows that already have a metadata row.
//
// A stored 0 is written only when every configured instance returns its history through a short or
// empty page. An incomplete read writes nothing. `--dry-run` writes nothing either. A second
// `--apply` writes nothing when the stored watch columns already match.
//
// Music is left null (DESIGN-008 Q-11): track history is not joined to an artist, so a 0 would say
// "never played" for a library this harvest does not read.
import { mediaItems, mediaMetadata, type DbClient, type MediaMetadataRow } from '@hnet/db';
import {
  getPlexUserIdToAppUserMap,
  upsertMediaMetadataBatch,
  upsertUserMediaWatchBatch,
  type MediaMetadataFields,
  type UserMediaWatchInput,
} from '@hnet/domain';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { MetadataSourceClients } from './clients';
import { loadPlexRatingGuids } from './db-reads';
import type { SyncLogger } from './logger';
import {
  lookupHouseholdWatch,
  readHouseholdWatch,
  type HouseholdWatchInstance,
} from './metadata-refresh';

const WRITE_CHUNK = 500;

export interface WatchHistoryBackfillInput {
  db: DbClient;
  tautulli: MetadataSourceClients['tautulli'];
  logger: SyncLogger;
  apply: boolean;
  /** Test hook. Production uses the measured default (500). */
  pageSize?: number;
  /** Test hook. Production uses the measured cap (158). */
  maxPages?: number;
}

export interface WatchHistoryBackfillReport {
  apply: boolean;
  /** Every configured instance finished under the cap and no metadata lookup threw. */
  complete: boolean;
  instances: HouseholdWatchInstance[];
  /** Live movies and shows that already have a metadata row. */
  candidates: number;
  /** Live movies and shows with no metadata row. Left untouched (a new row would blank the other fields). */
  skippedNoMetadata: number;
  /** Candidates with a joined history row. */
  played: number;
  /**
   * Candidates with no joined history row. Null when the read is incomplete: a zero is not claimed,
   * and nothing is written. When set, played + zeros = candidates.
   */
  zeros: number | null;
  /** Candidates whose stored watch columns differ from this read. */
  changed: number;
  /** Rows persisted. 0 on a dry run and on an incomplete read. */
  written: number;
  unchanged: number;
  userWatchWritten: number;
  /** History keys that did not join a title, summed across instances. */
  unjoined: number;
}

interface Candidate {
  id: string;
  tmdbId: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  meta: MediaMetadataRow;
}

export async function backfillWatchHistory(
  input: WatchHistoryBackfillInput,
): Promise<WatchHistoryBackfillReport> {
  const { db, logger } = input;
  if (input.tautulli.length === 0) {
    return {
      apply: input.apply,
      complete: false,
      instances: [],
      candidates: 0,
      skippedNoMetadata: 0,
      played: 0,
      zeros: null,
      changed: 0,
      written: 0,
      unchanged: 0,
      userWatchWritten: 0,
      unjoined: 0,
    };
  }

  const ratingKeyGuids = await loadPlexRatingGuids(db);
  const read = await readHouseholdWatch({
    sources: { tautulli: input.tautulli },
    logger,
    db,
    ratingKeyGuids,
    tautulliPageSize: input.pageSize,
    tautulliMaxPages: input.maxPages,
  });
  const candidates = await loadCandidates(db);
  const skippedNoMetadata = await countMissingMetadata(db);
  const unjoined = read.instances.reduce((sum, inst) => sum + inst.unjoined, 0);

  const base = {
    apply: input.apply,
    complete: read.complete,
    instances: read.instances,
    candidates: candidates.length,
    skippedNoMetadata,
    unjoined,
  };

  if (!read.complete) {
    let played = 0;
    for (const row of candidates) {
      if (lookupHouseholdWatch(read.index, row)) played += 1;
    }
    logger.warn('watch-history-backfill: history read incomplete; wrote nothing', {
      instances: read.instances.map((inst) => ({
        slug: inst.slug,
        pages: inst.pages,
        finished: inst.finished,
        metadataErrors: inst.metadataErrors,
      })),
    });
    return {
      ...base,
      played,
      zeros: null,
      changed: 0,
      written: 0,
      unchanged: candidates.length,
      userWatchWritten: 0,
    };
  }

  const plexUserMap = await getPlexUserIdToAppUserMap(db);
  const changedRows: MediaMetadataFields[] = [];
  const userRows: UserMediaWatchInput[] = [];
  let played = 0;
  for (const row of candidates) {
    const watch = lookupHouseholdWatch(read.index, row);
    if (watch) played += 1;
    const next = watchFields(row.meta, watch);
    if (!watchDiffers(row.meta, next)) continue;
    changedRows.push(next);
    if (!watch) continue;
    for (const [plexUserId, stat] of watch.perUser) {
      const appUserId = plexUserMap.get(plexUserId);
      if (!appUserId) continue;
      userRows.push({
        mediaItemId: row.id,
        appUserId,
        playCount: stat.playCount,
        lastViewedAt: stat.lastViewedAt,
        watched: stat.watched,
        inProgress: stat.inProgress,
      });
    }
  }
  const zeros = candidates.length - played;

  let written = 0;
  let userWatchWritten = 0;
  if (input.apply && changedRows.length > 0) {
    for (let i = 0; i < changedRows.length; i += WRITE_CHUNK) {
      const chunk = changedRows.slice(i, i + WRITE_CHUNK);
      const result = await upsertMediaMetadataBatch({ db, rows: chunk });
      written += result.written;
    }
    if (userRows.length > 0) {
      const result = await upsertUserMediaWatchBatch({ db, rows: userRows });
      userWatchWritten = result.written;
    }
  }

  logger.info('watch-history-backfill: done', {
    apply: input.apply,
    complete: true,
    candidates: candidates.length,
    played,
    zeros,
    changed: changedRows.length,
    written,
  });
  return {
    ...base,
    played,
    zeros,
    changed: changedRows.length,
    written,
    unchanged: candidates.length - changedRows.length,
    userWatchWritten,
  };
}

async function loadCandidates(db: DbClient): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: mediaItems.id,
      tmdbId: mediaItems.tmdbId,
      imdbId: mediaItems.imdbId,
      tvdbId: mediaItems.tvdbId,
      meta: mediaMetadata,
    })
    .from(mediaItems)
    .innerJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(
      and(
        isNull(mediaItems.deletedFromArrAt),
        inArray(mediaItems.arrKind, ['radarr', 'sonarr']),
      ),
    );
  return rows;
}

async function countMissingMetadata(db: DbClient): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(
      and(
        isNull(mediaItems.deletedFromArrAt),
        inArray(mediaItems.arrKind, ['radarr', 'sonarr']),
        isNull(mediaMetadata.id),
      ),
    );
  const n = Number(row?.n ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** The stored row with only the household watch columns replaced. Every other column is copied through. */
function watchFields(
  meta: MediaMetadataRow,
  watch: ReturnType<typeof lookupHouseholdWatch>,
): MediaMetadataFields {
  const sources = { ...(meta.sources ?? {}) };
  const extra = { ...(meta.extra ?? {}) };
  if (watch) {
    sources.tautulli = true;
    extra.tautulli = watch.household.perInstance;
  } else {
    delete sources.tautulli;
    delete extra.tautulli;
  }
  return {
    mediaItemId: meta.mediaItemId,
    imdbRating: asNumber(meta.imdbRating),
    imdbVotes: meta.imdbVotes,
    tmdbRating: asNumber(meta.tmdbRating),
    tmdbVotes: meta.tmdbVotes,
    rtTomatometer: meta.rtTomatometer,
    rtPopcorn: meta.rtPopcorn,
    runtimeMinutes: meta.runtimeMinutes,
    resolution: meta.resolution,
    genres: meta.genres ?? [],
    arrAddedAt: meta.arrAddedAt,
    releasedAt: meta.releasedAt,
    playCount: watch ? watch.household.playCount : 0,
    lastViewedAt: watch?.household.lastViewedAt ?? null,
    lastWatchedAt: watch?.household.lastViewedAt ?? null,
    lastWatchedServer: watch?.household.lastWatchedServer ?? null,
    requesters: meta.requesters ?? [],
    sourceCollections: meta.sourceCollections ?? [],
    posterSource: meta.posterSource,
    posterRef: meta.posterRef,
    sources,
    extra,
  };
}

function watchDiffers(meta: MediaMetadataRow, next: MediaMetadataFields): boolean {
  if ((meta.playCount ?? null) !== (next.playCount ?? null)) return true;
  if (instant(meta.lastViewedAt) !== instant(next.lastViewedAt)) return true;
  if (instant(meta.lastWatchedAt) !== instant(next.lastWatchedAt)) return true;
  if ((meta.lastWatchedServer ?? null) !== (next.lastWatchedServer ?? null)) return true;
  if ((meta.sources?.tautulli === true) !== (next.sources?.tautulli === true)) return true;
  return canonical(meta.extra?.tautulli ?? null) !== canonical(next.extra?.tautulli ?? null);
}

function instant(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null;
}

function asNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
