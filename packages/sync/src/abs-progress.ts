// ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user read-state) — the ABS per-user listening-progress
// READ, folded into the books-sync mode as an isolated post-step (no new CronJob). For each app user
// with an ABS handle (user_account_map), read their `mediaProgress[]` via the ABS admin token, map each
// entry's libraryItemId to its books_items row (LIVE audiobooks), and UPSERT the per-user read-state via
// the @hnet/domain single-writer. Read-only against ABS; the domain writer owns the guarded table.
// Kavita read-state is DEFERRED (ADR-053 C-05) — this covers audiobooks only.
import type { AbsMediaProgress } from '@hnet/books';
import type { DbClient } from '@hnet/db';
import {
  deriveBookProgress,
  getAbsExternalIdToBooksItemId,
  listMappedAbsUsers,
  upsertUserBookProgressBatch,
  type UserBookProgressInput,
} from '@hnet/domain';
import { noopLogger, type SyncLogger } from './logger';

/** The minimal ABS client surface this step needs (the read-only `getUserProgress`). */
export interface AbsProgressClient {
  getUserProgress(userId: string): Promise<AbsMediaProgress[]>;
}

export interface SyncAbsUserProgressReport {
  /** Mapped ABS users this run attempted. */
  users: number;
  /** Per-user rows upserted (across all users). */
  written: number;
  /** Users whose progress read threw (isolated — one bad user never fails the step). */
  failedUsers: number;
}

/**
 * Read + upsert every mapped ABS user's per-item progress. A no-op (users:0) when no user has an ABS
 * handle. A per-user read failure is logged and skipped (isolated). Only entries that resolve to a LIVE
 * audiobooks row are written (an unmatched/tombstoned libraryItemId is dropped).
 */
export async function syncAbsUserProgress(input: {
  db: DbClient;
  abs: AbsProgressClient;
  logger?: SyncLogger;
}): Promise<SyncAbsUserProgressReport> {
  const logger = input.logger ?? noopLogger;
  const mapped = await listMappedAbsUsers(input.db);
  if (mapped.length === 0) return { users: 0, written: 0, failedUsers: 0 };

  const extToId = await getAbsExternalIdToBooksItemId(input.db);
  const rows: UserBookProgressInput[] = [];
  let failedUsers = 0;

  for (const user of mapped) {
    let progress: AbsMediaProgress[];
    try {
      progress = await input.abs.getUserProgress(user.absUserId);
    } catch (error) {
      failedUsers += 1;
      logger.warn('abs-progress: user read failed', {
        absUserId: user.absUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const entry of progress) {
      const libraryItemId = entry.libraryItemId;
      if (!libraryItemId) continue;
      const booksItemId = extToId.get(libraryItemId);
      if (!booksItemId) continue; // not a live audiobooks row we track
      const state = deriveBookProgress(entry);
      rows.push({ booksItemId, appUserId: user.appUserId, ...state });
    }
  }

  const { written } = await upsertUserBookProgressBatch({ db: input.db, rows });
  logger.info('abs-progress: synced', { users: mapped.length, written, failedUsers });
  return { users: mapped.length, written, failedUsers };
}
