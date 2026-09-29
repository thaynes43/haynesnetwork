// ADR-083 / DESIGN-046 D-08 (PLAN-065) — the *arr queue-janitor admin surface. Admin-only (automated *arr
// write-back config, not member-facing). One READ (status: resolved config + the promotion-ladder readout +
// a last-7-days census/action summary) and one WRITE (config.set) that delegates to the @hnet/domain
// setArrQueueCleanupConfig single-writer — it validates the invariants and co-writes an `update_app_setting`
// permission_audit row in the SAME transaction (hard rule 6; the audited app_settings store, no bespoke
// table). Ships all-census; every census→enforce flip rides the ConfirmButton two-step in the UI (ADR-014).
import { z } from 'zod';
import { getArrQueueCleanupStatus, setArrQueueCleanupConfig } from '@hnet/domain';
import { mapDomainErrors, router } from '../trpc';
import { adminProcedure } from '../middleware/role';

const modeSchema = z.enum(['census', 'enforce']);

/** The 3 enforce cells every instance has (unknown has no cell — ADR-083 normative). */
const cellSchema = z.object({
  have_better: modeSchema,
  retry_import: modeSchema,
  bad_release: modeSchema,
});

/** Lidarr's cells: the shared three plus `manual_match` (DESIGN-046 D-13). Absent reads as census, so a client
 *  that predates the cell can never enforce it by omission. */
const lidarrCellSchema = cellSchema.extend({ manual_match: modeSchema.default('census') });

/** LazyLibrarian's cells (DESIGN-046 D-18) and Kapowarr's (D-19). REQUIRED here, unlike in a stored config (D-16):
 *  a page that predates them cannot save without them, so it can never reset an enforced cell to census by omission. */
const lazylibrarianCellSchema = z.object({
  retry_import: modeSchema,
  bad_release: modeSchema,
  leftover: modeSchema,
});
const kapowarrCellSchema = z.object({ bad_release: modeSchema });

/**
 * The zod mirror of `queueCleanupConfigError` (defense in depth — the domain writer re-validates). The mode
 * grid (3 cells per *arr, plus Lidarr's manual_match; LazyLibrarian's three and Kapowarr's one since ADR-095) plus
 * the three numeric rails, each range-checked exactly like the domain invariant (caps 1..100, age 0..168, escalate
 * 1..48).
 */
export const QueueCleanupConfigInput = z.object({
  modes: z.object({
    sonarr: cellSchema,
    radarr: cellSchema,
    lidarr: lidarrCellSchema,
    lazylibrarian: lazylibrarianCellSchema,
    kapowarr: kapowarrCellSchema,
  }),
  maxActionsPerRun: z.number().int().min(1).max(100),
  minItemAgeHours: z.number().int().min(0).max(168),
  retryEscalateRuns: z.number().int().min(1).max(48),
});

export const queueCleanupRouter = router({
  /** The /admin/janitor read: resolved config + provenance, the ladder readout, and the 7-day summary. */
  status: adminProcedure.query(({ ctx }) => getArrQueueCleanupStatus({ db: ctx.db })),

  config: router({
    /** Save the DB-backed audited janitor config (validated at the edge AND the domain writer). */
    set: adminProcedure.input(QueueCleanupConfigInput).mutation(({ ctx, input }) =>
      mapDomainErrors(() =>
        setArrQueueCleanupConfig({ db: ctx.db, config: input, actorId: ctx.user.id }),
      ),
    ),
  }),
});
