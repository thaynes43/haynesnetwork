import {
  ledgerEvents,
  mediaItems,
  restoreRuns,
  type ArrAddReason,
  type ArrKind,
  type DbClient,
  type RestorePreviewItem,
  type RestoreRunStatus,
} from '@hnet/db';
import { and, eq, sql } from 'drizzle-orm';
import { NotFoundError } from './errors';
import { inTransaction } from './db-client';

export interface StartRestoreRunInput {
  db?: DbClient;
  arrKind: ArrKind;
  arrInstanceId?: string;
  /** The initiating admin (SET NULL on user deletion; snapshot lives in preview). */
  initiatedBy: string | null;
  /** ADR-022 C-01 — how the run was initiated ('restore' default; 'ledger_add' for Ledger). */
  reason?: ArrAddReason;
  /** The exact diff the admin approved (D-16 step 2) — persisted verbatim (R-52). */
  preview: RestorePreviewItem[];
}

/**
 * DESIGN-005 D-10/D-12/D-16 — open the durable record of a Restore execution BEFORE
 * any *arr POST: the approved preview and item count persist even if the process dies
 * mid-run (R-52 audit).
 */
export async function startRestoreRun(input: StartRestoreRunInput): Promise<{ runId: string }> {
  return inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .insert(restoreRuns)
      .values({
        arrKind: input.arrKind,
        arrInstanceId: input.arrInstanceId ?? 'main',
        initiatedBy: input.initiatedBy,
        reason: input.reason ?? 'restore',
        preview: input.preview,
        itemCount: input.preview.length,
      })
      .returning({ id: restoreRuns.id });
    if (!row) {
      throw new Error('restore_runs insert returned no row');
    }
    return { runId: row.id };
  });
}

export interface RecordRestoreResultInput {
  db?: DbClient;
  runId: string;
  result: {
    mediaItemId: string;
    ok: boolean;
    /**
     * ADR-022 D-02 — which per-item outcome this was:
     *   'added'     (default) — absent from the live *arr, re-added monitored: clears the
     *               tombstone, adopts `newArrItemId`, writes the 'restored' write-back event;
     *   'monitored' — present-but-unmonitored, flipped to monitored in place: sets
     *               media_items.monitored=true, NO tombstone clear, NO 'restored' event.
     */
    outcome?: 'added' | 'monitored';
    /** The id the target *arr assigned on POST /series|/movie|/artist ('added' outcome). */
    newArrItemId?: number;
    /** ADR-022 D-02 — a search command was triggered ⇒ also write a 'search_requested' event. */
    searched?: boolean;
    /** ADR-022 D-02 — the add/monitor succeeded but the (best-effort) search command failed. */
    searchError?: string;
    error?: string;
  };
}

/**
 * DESIGN-005 D-12/D-16, generalized by ADR-022 D-02 — append one per-item result as each
 * *arr write returns, in ONE transaction. For an 'added' success it clears the media item's
 * tombstone, updates arr_item_id to the id the rebuilt *arr assigned, and writes the
 * 'restored' ledger event (the sanctioned write-back record — ADR-008). For a 'monitored'
 * success (Ledger Add-&-search flipping a present item) it sets monitored=true in place. When
 * `searched`, a 'search_requested' ledger event is written in the SAME tx (hard rule 6).
 */
export async function recordRestoreResult(
  input: RecordRestoreResultInput,
): Promise<{ successCount: number }> {
  return inTransaction(input.db, async (tx) => {
    const [run] = await tx
      .select({ id: restoreRuns.id, status: restoreRuns.status })
      .from(restoreRuns)
      .where(eq(restoreRuns.id, input.runId))
      .for('update');
    if (!run || run.status !== 'running') {
      throw new NotFoundError(`Restore run ${input.runId} not found or not running`);
    }

    const outcome = input.result.outcome ?? 'added';
    const entry = {
      mediaItemId: input.result.mediaItemId,
      ok: input.result.ok,
      at: new Date().toISOString(),
      ...(input.result.outcome !== undefined ? { outcome } : {}),
      ...(input.result.searched ? { searched: true } : {}),
      ...(input.result.searchError !== undefined ? { searchError: input.result.searchError } : {}),
      ...(input.result.newArrItemId !== undefined
        ? { newArrItemId: input.result.newArrItemId }
        : {}),
      ...(input.result.error !== undefined ? { error: input.result.error } : {}),
    };
    const [updated] = await tx
      .update(restoreRuns)
      .set({
        results: sql`${restoreRuns.results} || ${JSON.stringify([entry])}::jsonb`,
        ...(input.result.ok ? { successCount: sql`${restoreRuns.successCount} + 1` } : {}),
      })
      .where(eq(restoreRuns.id, input.runId))
      .returning({ successCount: restoreRuns.successCount });

    if (input.result.ok) {
      if (outcome === 'added') {
        // Absent → re-added monitored: clear the tombstone, adopt the new *arr id, write the
        // sanctioned 'restored' write-back event (ADR-008 / D-16).
        await tx
          .update(mediaItems)
          .set({
            deletedFromArrAt: null,
            ...(input.result.newArrItemId !== undefined
              ? { arrItemId: input.result.newArrItemId }
              : {}),
            lastSeenAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(mediaItems.id, input.result.mediaItemId));
        await tx.insert(ledgerEvents).values({
          mediaItemId: input.result.mediaItemId,
          eventType: 'restored',
          source: 'app',
          occurredAt: new Date(),
          payload: {
            restoreRunId: input.runId,
            ...(input.result.newArrItemId !== undefined
              ? { newArrItemId: input.result.newArrItemId }
              : {}),
          },
        });
      } else {
        // Present-but-unmonitored → flipped to monitored in place (ADR-022 D-02). The item is
        // live (not tombstoned), so no 'restored' write-back — only reflect monitored locally
        // (the next sync reconciles it either way).
        await tx
          .update(mediaItems)
          .set({ monitored: true, lastSeenAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(mediaItems.id, input.result.mediaItemId));
      }
      if (input.result.searched) {
        // A search command was triggered — the audited search intent, in the same tx (D-17 /
        // hard rule 6). Reuses the T-44 'search_requested' event type.
        await tx.insert(ledgerEvents).values({
          mediaItemId: input.result.mediaItemId,
          eventType: 'search_requested',
          source: 'app',
          occurredAt: new Date(),
          payload: {
            restoreRunId: input.runId,
            outcome,
            ...(input.result.newArrItemId !== undefined
              ? { arrItemId: input.result.newArrItemId }
              : {}),
          },
        });
      }
    }

    return { successCount: updated?.successCount ?? 0 };
  });
}

export interface FinishRestoreRunInput {
  db?: DbClient;
  runId: string;
  /**
   * Omitted ⇒ derived from the counts: every item succeeded → 'completed', else
   * 'completed_with_errors'. Pass 'failed' explicitly for a catastrophic abort.
   */
  status?: Exclude<RestoreRunStatus, 'running'>;
}

/**
 * DESIGN-005 D-12/D-16 — close the run (AC-09's report is the row itself: preview +
 * per-item results + counts). Finishing targets status = 'running'; a second finish
 * or an unknown run id throws NotFoundError.
 */
export async function finishRestoreRun(
  input: FinishRestoreRunInput,
): Promise<{ status: RestoreRunStatus }> {
  return inTransaction(input.db, async (tx) => {
    const [run] = await tx
      .select({
        status: restoreRuns.status,
        itemCount: restoreRuns.itemCount,
        successCount: restoreRuns.successCount,
      })
      .from(restoreRuns)
      .where(eq(restoreRuns.id, input.runId))
      .for('update');
    if (!run || run.status !== 'running') {
      throw new NotFoundError(`Restore run ${input.runId} not found or already finished`);
    }

    const status =
      input.status ?? (run.successCount === run.itemCount ? 'completed' : 'completed_with_errors');
    await tx
      .update(restoreRuns)
      .set({ status, finishedAt: sql`now()` })
      .where(and(eq(restoreRuns.id, input.runId), eq(restoreRuns.status, 'running')));
    return { status };
  });
}
