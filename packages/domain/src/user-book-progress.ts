// ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user watch/read-state) — the per-user ABS book read-state
// read-model (`user_book_progress`, audiobooks only; Kavita DEFERRED — ADR-053 C-05). The ABS admin
// `mediaProgress[]` read is joined on books_items.external_id = ABS libraryItemId through the
// user_account_map ABS handle. Written ONLY by `upsertUserBookProgressBatch` (the guard forbids any
// other writer). No per-row audit event — a rebuildable read-model (data of record = ABS).
import { booksItems, userBookProgress, type DbClient } from '@hnet/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';

/** The derived per-user read-state for one audiobook, from an ABS mediaProgress entry. */
export interface BookProgressState {
  isFinished: boolean;
  /** Fractional progress 0..1 (null when the source omitted it). */
  progress: number | null;
  /** Started but not finished (0 < progress < 1 and not isFinished). */
  inProgress: boolean;
}

/**
 * DESIGN-026 D-07 — normalize an ABS `mediaProgress[]` entry to the read-state we store. `isFinished`
 * wins; `progress` is clamped to [0,1] (a bad value drops to null); `inProgress` = started-but-unfinished.
 * Pure + unit-tested.
 */
export function deriveBookProgress(entry: {
  progress?: number | null;
  isFinished?: boolean | null;
}): BookProgressState {
  const isFinished = entry.isFinished === true;
  let progress: number | null = null;
  if (typeof entry.progress === 'number' && Number.isFinite(entry.progress)) {
    progress = Math.min(1, Math.max(0, entry.progress));
  }
  const inProgress = !isFinished && progress !== null && progress > 0;
  return { isFinished, progress, inProgress };
}

/** One per-user book-progress rollup row (keyed by (books_item, app_user)). */
export interface UserBookProgressInput {
  booksItemId: string;
  appUserId: string;
  isFinished: boolean;
  progress: number | null;
  inProgress: boolean;
}

export interface UpsertUserBookProgressBatchInput {
  db?: DbClient;
  rows: UserBookProgressInput[];
}

const PROGRESS_UPSERT_CHUNK = 500;

/**
 * The SINGLE WRITER for the per-user book read-state: upsert on (books_item_id, app_user_id) — a refresh
 * REPLACES the row from the freshly-read ABS progress (synced-copy semantics). One transaction, chunked.
 * No per-row audit (the documented read-model exemption).
 */
export async function upsertUserBookProgressBatch(
  input: UpsertUserBookProgressBatchInput,
): Promise<{ written: number }> {
  if (input.rows.length === 0) return { written: 0 };
  return inTransaction(input.db, async (tx) => {
    const now = new Date();
    for (let i = 0; i < input.rows.length; i += PROGRESS_UPSERT_CHUNK) {
      const chunk = input.rows.slice(i, i + PROGRESS_UPSERT_CHUNK).map((r) => ({
        booksItemId: r.booksItemId,
        appUserId: r.appUserId,
        isFinished: r.isFinished,
        progress: r.progress,
        inProgress: r.inProgress,
        updatedAt: now,
      }));
      await tx
        .insert(userBookProgress)
        .values(chunk)
        .onConflictDoUpdate({
          target: [userBookProgress.booksItemId, userBookProgress.appUserId],
          set: {
            isFinished: sql`excluded.is_finished`,
            progress: sql`excluded.progress`,
            inProgress: sql`excluded.in_progress`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
    return { written: input.rows.length };
  });
}

/**
 * The ABS libraryItemId → books_item id map for LIVE audiobook rows (the join the ABS progress read maps
 * each `mediaProgress[].libraryItemId` through). Only source='audiobookshelf', non-tombstoned rows.
 */
export async function getAbsExternalIdToBooksItemId(
  db: DbClient | undefined,
): Promise<Map<string, string>> {
  const executor = resolveDb(db);
  const rows = await executor
    .select({ id: booksItems.id, externalId: booksItems.externalId })
    .from(booksItems)
    .where(and(eq(booksItems.source, 'audiobookshelf'), isNull(booksItems.deletedAt)));
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.externalId, r.id);
  return map;
}

/**
 * Populated-value gate (ADR-051 C-06) — whether a viewer has ANY per-user book progress rows, so the
 * Audiobooks Read / In-progress facet is offered ONLY when it would filter something.
 */
export async function viewerHasBookProgress(
  db: DbClient | undefined,
  appUserId: string,
): Promise<boolean> {
  const executor = resolveDb(db);
  const [row] = await executor
    .select({ id: userBookProgress.id })
    .from(userBookProgress)
    .where(eq(userBookProgress.appUserId, appUserId))
    .limit(1);
  return row !== undefined;
}
