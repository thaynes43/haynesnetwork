// DESIGN-005 D-17 — the restore router (admin-only, R-50..R-52, AC-09). `diff` is a
// read-only live comparison (never persisted); `execute` takes the EXPLICIT id list
// the admin approved, re-validates against a fresh diff, and runs the D-16 re-adds
// with searches OFF (Q-04) through @hnet/domain's executeRestore. The durable report
// is the restore_runs row.
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { desc, eq } from 'drizzle-orm';
import { ARR_KINDS, restoreRuns, users } from '@hnet/db';
import { computeRestoreDiff, executeRestore } from '@hnet/domain';
import { mapDomainErrors, resolveArrBundle, router } from '../trpc';
import { adminProcedure } from '../middleware/role';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());

export const restoreRouter = router({
  /** D-16 step 1 — live preview: monitored ledger rows absent from the target *arr. */
  diff: adminProcedure
    .input(
      z.object({
        arrKind: z.enum(ARR_KINDS),
        arrInstanceId: z.string().default('main'),
      }),
    )
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        computeRestoreDiff({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          arrKind: input.arrKind,
          arrInstanceId: input.arrInstanceId,
        }),
      );
    }),

  /** D-16 step 2 — execute the approved list; awaited, returns {runId} (report via `run`). */
  execute: adminProcedure
    .input(
      z.object({
        arrKind: z.enum(ARR_KINDS),
        arrInstanceId: z.string().default('main'),
        mediaItemIds: z.array(z.uuid()).min(1).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const result = await executeRestore({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          arrKind: input.arrKind,
          arrInstanceId: input.arrInstanceId,
          initiatedBy: ctx.user.id,
          mediaItemIds: input.mediaItemIds,
        });
        return { runId: result.runId, status: result.status };
      });
    }),

  /** AC-09's report — the restore_runs row: preview, per-item results, counts. */
  run: adminProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select({
        id: restoreRuns.id,
        arrKind: restoreRuns.arrKind,
        arrInstanceId: restoreRuns.arrInstanceId,
        status: restoreRuns.status,
        preview: restoreRuns.preview,
        results: restoreRuns.results,
        itemCount: restoreRuns.itemCount,
        successCount: restoreRuns.successCount,
        startedAt: restoreRuns.startedAt,
        finishedAt: restoreRuns.finishedAt,
        initiatedByDisplayName: users.displayName,
      })
      .from(restoreRuns)
      .leftJoin(users, eq(users.id, restoreRuns.initiatedBy))
      .where(eq(restoreRuns.id, input.id));
    if (!row) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `Restore run ${input.id} not found` });
    }
    return {
      ...row,
      startedAt: iso(row.startedAt),
      finishedAt: isoOrNull(row.finishedAt),
    };
  }),

  /** Recent runs, newest first (R-52 audit browsing). */
  runs: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: restoreRuns.id,
        arrKind: restoreRuns.arrKind,
        arrInstanceId: restoreRuns.arrInstanceId,
        status: restoreRuns.status,
        itemCount: restoreRuns.itemCount,
        successCount: restoreRuns.successCount,
        startedAt: restoreRuns.startedAt,
        finishedAt: restoreRuns.finishedAt,
        initiatedByDisplayName: users.displayName,
      })
      .from(restoreRuns)
      .leftJoin(users, eq(users.id, restoreRuns.initiatedBy))
      .orderBy(desc(restoreRuns.startedAt))
      .limit(20);
    return rows.map((row) => ({
      ...row,
      startedAt: iso(row.startedAt),
      finishedAt: isoOrNull(row.finishedAt),
    }));
  }),
});
