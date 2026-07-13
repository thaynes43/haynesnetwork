// ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user watch/read-state) — the per-user VIDEO watch
// read-model (`user_media_watch`). The metadata harvest re-keys the Tautulli history `user_id` through
// the user_account_map into per-user rows, ADDITIVE to the untouched household SUM/MAX on media_metadata
// (ADR-053 C-03). Written ONLY by `upsertUserMediaWatchBatch` (the guard forbids any other writer). No
// per-row audit event — a rebuildable read-model (data of record = Tautulli), the media_metadata class.
import { userMediaWatch, type DbClient } from '@hnet/db';
import { and, eq, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';

/** One (instance × user) contribution for a title, before the per-user cross-instance merge. */
export interface UserWatchContribution {
  playCount: number;
  lastViewedAt: Date | null;
  /** This contribution includes a COMPLETED play (Tautulli watched_status 1). */
  watched: boolean;
  /** This contribution includes a PARTIAL play (Tautulli watched_status 0.x). */
  inProgress: boolean;
}

/** A user's unified watch signal for one title (SUM plays / MAX last-viewed / any-watched). */
export interface UserWatchStat {
  playCount: number;
  lastViewedAt: Date | null;
  watched: boolean;
  inProgress: boolean;
}

/**
 * DESIGN-026 D-07 — merge one user's per-instance contributions for a title into the unified signal:
 * play_count = SUM, last_viewed_at = MAX, `watched` = ANY completed play, `inProgress` = a partial play
 * with no completed one (a finished title is "watched", never "in progress"). Pure + unit-tested.
 */
export function mergeUserWatchContributions(
  contributions: readonly UserWatchContribution[],
): UserWatchStat {
  let playCount = 0;
  let lastViewedAt: Date | null = null;
  let watched = false;
  let anyInProgress = false;
  for (const c of contributions) {
    playCount += c.playCount;
    if (c.lastViewedAt && (!lastViewedAt || c.lastViewedAt > lastViewedAt)) lastViewedAt = c.lastViewedAt;
    if (c.watched) watched = true;
    if (c.inProgress) anyInProgress = true;
  }
  return { playCount, lastViewedAt, watched, inProgress: anyInProgress && !watched };
}

/** One per-user watch rollup row the harvest upserts (keyed by (media_item, app_user)). */
export interface UserMediaWatchInput {
  mediaItemId: string;
  appUserId: string;
  playCount: number | null;
  lastViewedAt: Date | null;
  watched: boolean;
  inProgress: boolean;
}

export interface UpsertUserMediaWatchBatchInput {
  db?: DbClient;
  rows: UserMediaWatchInput[];
}

const WATCH_UPSERT_CHUNK = 500;

/**
 * The SINGLE WRITER for the per-user video watch read-model: upsert on (media_item_id, app_user_id) —
 * a refresh REPLACES the row from the freshly-attributed values (synced-copy semantics, like
 * media_metadata). One transaction, chunked. No per-row audit (the documented read-model exemption).
 */
export async function upsertUserMediaWatchBatch(
  input: UpsertUserMediaWatchBatchInput,
): Promise<{ written: number }> {
  if (input.rows.length === 0) return { written: 0 };
  return inTransaction(input.db, async (tx) => {
    const now = new Date();
    for (let i = 0; i < input.rows.length; i += WATCH_UPSERT_CHUNK) {
      const chunk = input.rows.slice(i, i + WATCH_UPSERT_CHUNK).map((r) => ({
        mediaItemId: r.mediaItemId,
        appUserId: r.appUserId,
        playCount: r.playCount,
        lastViewedAt: r.lastViewedAt,
        watched: r.watched,
        inProgress: r.inProgress,
        updatedAt: now,
      }));
      await tx
        .insert(userMediaWatch)
        .values(chunk)
        .onConflictDoUpdate({
          target: [userMediaWatch.mediaItemId, userMediaWatch.appUserId],
          set: {
            playCount: sql`excluded.play_count`,
            lastViewedAt: sql`excluded.last_viewed_at`,
            watched: sql`excluded.watched`,
            inProgress: sql`excluded.in_progress`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
    return { written: input.rows.length };
  });
}

/**
 * Populated-value gate (ADR-051 C-06) — whether a viewer has ANY per-user watch rows, so the registry's
 * Watched / In-progress video facets are offered ONLY when they would filter something (no dead chip).
 */
export async function viewerHasWatchData(
  db: DbClient | undefined,
  appUserId: string,
): Promise<boolean> {
  const executor = resolveDb(db);
  const [row] = await executor
    .select({ id: userMediaWatch.id })
    .from(userMediaWatch)
    .where(eq(userMediaWatch.appUserId, appUserId))
    .limit(1);
  return row !== undefined;
}

/** The per-user watch state for one item+viewer (the item-detail card / test assertions). null = none. */
export async function getUserMediaWatch(
  db: DbClient | undefined,
  mediaItemId: string,
  appUserId: string,
): Promise<UserWatchStat | null> {
  const executor = resolveDb(db);
  const [row] = await executor
    .select({
      playCount: userMediaWatch.playCount,
      lastViewedAt: userMediaWatch.lastViewedAt,
      watched: userMediaWatch.watched,
      inProgress: userMediaWatch.inProgress,
    })
    .from(userMediaWatch)
    .where(and(eq(userMediaWatch.mediaItemId, mediaItemId), eq(userMediaWatch.appUserId, appUserId)));
  if (!row) return null;
  return {
    playCount: row.playCount ?? 0,
    lastViewedAt: row.lastViewedAt,
    watched: row.watched,
    inProgress: row.inProgress,
  };
}
