import {
  syncRuns,
  type DbClient,
  type SyncRunKind,
  type SyncRunStatus,
  type SyncSource,
} from '@hnet/db';
import { and, eq, sql } from 'drizzle-orm';
import { NotFoundError } from './errors';
import { inTransaction } from './db-client';

export interface StartSyncRunInput {
  db?: DbClient;
  source: SyncSource;
  runKind: SyncRunKind;
}

export interface FinishSyncRunInput {
  db?: DbClient;
  runId: string;
  status: Exclude<SyncRunStatus, 'running'>;
  /** Merged over the row's stats: {itemsSeen, upserted, tombstoned, eventsIngested, …}. */
  stats?: Record<string, unknown>;
  /** Failure/abort reason — incl. the D-14 mass-tombstone abort message. */
  error?: string | null;
}

/**
 * DESIGN-005 D-11/D-12 — open the observability row that brackets a sync run's batch
 * writers (one append-only row per run).
 */
export async function startSyncRun(
  input: StartSyncRunInput,
): Promise<{ runId: string; startedAt: Date }> {
  return inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .insert(syncRuns)
      .values({ source: input.source, runKind: input.runKind })
      .returning({ id: syncRuns.id, startedAt: syncRuns.startedAt });
    if (!row) {
      throw new Error('sync_runs insert returned no row');
    }
    return { runId: row.id, startedAt: row.startedAt };
  });
}

/**
 * DESIGN-005 D-11/D-12 — close a sync run exactly once: rows are never updated after
 * finish, so finishing targets status = 'running' and a second finish (or an unknown
 * run id) throws NotFoundError.
 */
export async function finishSyncRun(input: FinishSyncRunInput): Promise<void> {
  return inTransaction(input.db, async (tx) => {
    const updated = await tx
      .update(syncRuns)
      .set({
        status: input.status,
        ...(input.stats !== undefined ? { stats: input.stats } : {}),
        error: input.error ?? null,
        finishedAt: sql`now()`,
      })
      .where(and(eq(syncRuns.id, input.runId), eq(syncRuns.status, 'running')))
      .returning({ id: syncRuns.id });
    if (updated.length === 0) {
      throw new NotFoundError(`Sync run ${input.runId} not found or already finished`);
    }
  });
}
