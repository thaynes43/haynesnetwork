// ADR-023 / DESIGN-010 — the Trash section's tRPC surface (Maintainerr-backed deletion UI). Access
// is layered: the coarse `trash` section level gates VIEW (read_only browses pending/collections/
// rules/recently-deleted/activity), while each destructive/mutating action needs an explicit
// fine-grained grant (trashActionProcedure). Every Maintainerr call goes through @hnet/domain
// orchestrators (the confined write surface) wrapped in mapDomainErrors. Music/Lidarr is never a
// target (the media param is movie|tv only — R-87).
import { z } from 'zod';
import {
  APP_SETTING_DEFAULTS,
  arrKindForTrashMedia,
  auditMaintainerr,
  cancelBatch,
  createBatchFromPending,
  deleteTrashRule,
  expediteDeletion,
  getAppSettings,
  getBatchDetail,
  getBatchSaveStats,
  getTrashOverview,
  getTuningReport,
  greenlightBatch,
  listBatches,
  listNotifications,
  listRecentlyDeleted,
  listTrashPending,
  removeExclusion,
  restoreDeleted,
  saveExclusion,
  setAppSetting,
  setBatchItemSaved,
  sweepExpiredBatches,
  upsertTrashRule,
} from '@hnet/domain';
import { mapDomainErrors, resolveArrBundle, resolveMaintainerrBundle, router } from '../trpc';
import {
  adminProcedure,
  hasTrashAction,
  sectionProcedure,
  trashActionProcedure,
} from '../middleware/role';
import { posterUrlFor } from '../ledger-query';
import { TRPCError } from '@trpc/server';

/** movie|tv only — Lidarr/music is structurally undeletable (R-87). */
const trashMedia = z.enum(['movie', 'tv']);

export const trashRouter = router({
  /**
   * DESIGN-010 D-04 — the preflight safety verdict (integration health + reachability). Read-Only+.
   * The UX surfaces this as the safety banner; the destructive procedures re-run it server-side.
   */
  status: sectionProcedure('trash', 'read_only').query(async ({ ctx }) => {
    return mapDomainErrors(() =>
      auditMaintainerr({ maintainerr: resolveMaintainerrBundle(ctx) }),
    );
  }),

  /**
   * DESIGN-010 amendment (2026-07-08) — the OVERVIEW landing aggregate: one light read the tab shell
   * fetches ONCE to drive both the Overview cards and the Movies/TV count badges. Composes the
   * existing per-kind slated summary + open-batch lifecycle + Recently-Deleted/Activity heads (no new
   * query logic — see getTrashOverview). Read-Only+. A no-batch kind's live candidate read degrades
   * to `live:false` when Maintainerr can't answer, so the landing never hard-errors on a down install.
   */
  overview: sectionProcedure('trash', 'read_only').query(async ({ ctx }) => {
    return mapDomainErrors(() =>
      getTrashOverview({ db: ctx.db, maintainerr: resolveMaintainerrBundle(ctx) }),
    );
  }),

  /**
   * DESIGN-010 D-02 — the pending-deletion table for ONE media kind (movie|tv, never combined).
   * Read-through merge of Maintainerr's collections/media with our ledger; per-item size + a total.
   */
  pending: sectionProcedure('trash', 'read_only')
    .input(z.object({ media: trashMedia }))
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const result = await listTrashPending({
          db: ctx.db,
          maintainerr: resolveMaintainerrBundle(ctx),
          media: input.media,
          // DESIGN-010 D-08/D-09 — reflect exclusions made outside this session as Protected before
          // the `dnd` tag round-trips (the pending TAB is the only live-exclusion-aware read).
          includeLiveExclusions: true,
        });
        return {
          media: input.media,
          totalSizeBytes: result.totalSizeBytes,
          count: result.count,
          items: result.items.map((item) => ({
            ...item,
            posterUrl:
              item.mediaItemId === null
                ? null
                : posterUrlFor(item.mediaItemId, item.posterSource),
          })),
        };
      });
    }),

  /** DESIGN-010 D-02 — the raw Maintainerr collections (rules-editor context + admin insight). */
  collections: sectionProcedure('trash', 'read_only').query(async ({ ctx }) => {
    return mapDomainErrors(() => resolveMaintainerrBundle(ctx).read.getCollections());
  }),

  /** DESIGN-010 — the Maintainerr rule groups (the rules editor's data; read_only view). */
  rules: sectionProcedure('trash', 'read_only').query(async ({ ctx }) => {
    return mapDomainErrors(() => resolveMaintainerrBundle(ctx).read.getRules());
  }),

  /** DESIGN-010 — the rule-schema catalog (constants) for the rules editor. */
  ruleConstants: sectionProcedure('trash', 'read_only').query(async ({ ctx }) => {
    return mapDomainErrors(() => resolveMaintainerrBundle(ctx).read.getRuleConstants());
  }),

  /**
   * DESIGN-010 D-05 — Save/whitelist an item (protective; save_exclude grant). External exclusion
   * first, then the trash_excluded audit event (idempotent when already excluded).
   */
  saveExclusion: trashActionProcedure('save_exclude')
    .input(
      z.object({
        maintainerrMediaId: z.string().min(1),
        mediaItemId: z.uuid().nullish(),
        collectionId: z.number().int().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        saveExclusion({
          db: ctx.db,
          maintainerr: resolveMaintainerrBundle(ctx),
          maintainerrMediaId: input.maintainerrMediaId,
          mediaItemId: input.mediaItemId ?? null,
          collectionId: input.collectionId ?? undefined,
          actorId: ctx.user.id,
        }),
      );
    }),

  /** DESIGN-010 D-05 — un-save (remove_exclude grant). */
  removeExclusion: trashActionProcedure('remove_exclude')
    .input(
      z.object({
        maintainerrMediaId: z.string().min(1),
        mediaItemId: z.uuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        removeExclusion({
          db: ctx.db,
          maintainerr: resolveMaintainerrBundle(ctx),
          maintainerrMediaId: input.maintainerrMediaId,
          mediaItemId: input.mediaItemId ?? null,
          actorId: ctx.user.id,
        }),
      );
    }),

  /**
   * DESIGN-010 D-04/D-05 — expedite ONE item's deletion (destructive; expedite_item grant). Re-runs
   * the SAFE gate; a recently-watched/requested target is auto-protected instead of deleted.
   */
  expediteItem: trashActionProcedure('expedite_item')
    .input(
      z.object({
        media: trashMedia,
        collectionId: z.number().int(),
        maintainerrMediaId: z.string().min(1),
        mediaItemId: z.uuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        expediteDeletion({
          db: ctx.db,
          maintainerr: resolveMaintainerrBundle(ctx),
          scope: 'item',
          media: input.media,
          actorId: ctx.user.id,
          item: {
            collectionId: input.collectionId,
            maintainerrMediaId: input.maintainerrMediaId,
            mediaItemId: input.mediaItemId ?? null,
          },
        }),
      );
    }),

  /**
   * DESIGN-010 D-04/D-05/D-08 — expedite the WHOLE pending set (destructive; expedite_all grant).
   * Re-runs the SAFE gate; the watch guardian auto-whitelists recently-watched/requested items
   * first. F2 (2026-07-06 review): `maintainerrMediaIds` is the REQUIRED snapshot the user saw in
   * the confirm — the run processes exactly its intersection with the current pending set, so items
   * that became pending after the modal opened are never deleted (see `snapshotMediaIds`).
   */
  expediteAll: trashActionProcedure('expedite_all')
    .input(
      z.object({
        media: trashMedia,
        maintainerrMediaIds: z.array(z.string().min(1)).min(1).max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        expediteDeletion({
          db: ctx.db,
          maintainerr: resolveMaintainerrBundle(ctx),
          scope: 'all',
          media: input.media,
          actorId: ctx.user.id,
          snapshotMediaIds: input.maintainerrMediaIds,
        }),
      );
    }),

  /** DESIGN-010 D-02 — Recently Deleted (our tombstoned ledger rows), newest first. Read-Only+. */
  recentlyDeleted: sectionProcedure('trash', 'read_only')
    .input(z.object({ media: trashMedia }))
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const rows = await listRecentlyDeleted({ db: ctx.db, media: input.media });
        return rows.map((r) => ({
          ...r,
          posterUrl: posterUrlFor(r.mediaItemId, r.posterSource),
        }));
      });
    }),

  /**
   * DESIGN-010 D-02 — Restore a recently-deleted item (restore_deleted grant). Reuses the failsafe
   * executeRestore path + a trash_restored marker. media is movie|tv (music is never restorable).
   */
  restoreDeleted: trashActionProcedure('restore_deleted')
    .input(z.object({ media: trashMedia, mediaItemId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const result = await restoreDeleted({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          arrKind: arrKindForTrashMedia(input.media),
          mediaItemId: input.mediaItemId,
          actorId: ctx.user.id,
        });
        return { runId: result.runId, status: result.status };
      });
    }),

  /**
   * DESIGN-010 D-07 (addendum c) — the Activity feed (from the notification store). Reads BOTH the
   * webhook-sourced `maintainerr` events AND the app's own `trash` deletion events: Maintainerr does
   * NOT webhook our API-triggered per-item `/collections/media/handle` calls, so app-initiated
   * (Expedite / batch sweep) deletions arrive only as the `trash`-sourced rows the domain writes.
   */
  activity: sectionProcedure('trash', 'read_only')
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      return listNotifications({
        db: ctx.db,
        sources: ['maintainerr', 'trash'],
        limit: input?.limit ?? 50,
      });
    }),

  /**
   * DESIGN-010 — create/update a Maintainerr rule group (edit_rules grant + section Edit). Maintainerr
   * owns rule validation; the RulesDto payload is passed through the confined write client.
   */
  saveRule: trashActionProcedure('edit_rules', 'edit')
    .input(z.object({ payload: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        upsertTrashRule({ maintainerr: resolveMaintainerrBundle(ctx), payload: input.payload }),
      );
    }),

  /** DESIGN-010 — delete a Maintainerr rule group (edit_rules grant + section Edit). */
  deleteRule: trashActionProcedure('edit_rules', 'edit')
    .input(z.object({ ruleGroupId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        deleteTrashRule({
          maintainerr: resolveMaintainerrBundle(ctx),
          ruleGroupId: input.ruleGroupId,
        }),
      );
    }),

  // ADR-025 / DESIGN-011 — the CURATION PIPELINE surface (batches, poster review, Leaving Soon,
  // windowed deletion). Reads are section read_only; batch lifecycle needs the `manage_batches`
  // grant (admin ⇒ all actions); the per-item save is phase-gated (admin_review ⇒ manage_batches,
  // leaving_soon ⇒ save_leaving_soon) so a windowed user rescues with the narrow grant.
  batches: router({
    /** List batches (newest first), optionally by media kind. Section read_only+. */
    list: sectionProcedure('trash', 'read_only')
      .input(z.object({ mediaKind: trashMedia.optional() }).optional())
      .query(async ({ ctx, input }) => {
        return mapDomainErrors(() =>
          listBatches({ db: ctx.db, mediaKind: input?.mediaKind }),
        );
      }),

    /** One batch + its poster-grid item list (the review / Leaving-Soon wall source). read_only+. */
    get: sectionProcedure('trash', 'read_only')
      .input(z.object({ batchId: z.uuid() }))
      .query(async ({ ctx, input }) => {
        return mapDomainErrors(async () => {
          const detail = await getBatchDetail({ db: ctx.db, batchId: input.batchId });
          return {
            ...detail,
            items: detail.items.map((item) => ({
              ...item,
              posterUrl:
                item.mediaItemId === null
                  ? null
                  : posterUrlFor(item.mediaItemId, item.posterSource),
            })),
          };
        });
      }),

    /** Tuning-data summary for a batch (save/unsave totals + per-user breakdown). read_only+. */
    saveStats: sectionProcedure('trash', 'read_only')
      .input(z.object({ batchId: z.uuid() }))
      .query(async ({ ctx, input }) => {
        return mapDomainErrors(() => getBatchSaveStats({ db: ctx.db, batchId: input.batchId }));
      }),

    /** Create a batch from the current pending set for one media kind (manage_batches; admin ⇒ ok). */
    create: trashActionProcedure('manage_batches')
      .input(z.object({ mediaKind: trashMedia }))
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(() =>
          createBatchFromPending({
            db: ctx.db,
            maintainerr: resolveMaintainerrBundle(ctx),
            mediaKind: input.mediaKind,
            actorId: ctx.user.id,
          }),
        );
      }),

    /** Green-light a batch → Leaving Soon (manage_batches). Optional window override (else default). */
    greenlight: trashActionProcedure('manage_batches')
      .input(z.object({ batchId: z.uuid(), windowDays: z.number().int().min(1).max(365).optional() }))
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(() =>
          greenlightBatch({
            db: ctx.db,
            maintainerr: resolveMaintainerrBundle(ctx),
            batchId: input.batchId,
            windowDays: input.windowDays,
            actorId: ctx.user.id,
          }),
        );
      }),

    /** Cancel a batch (any non-terminal → cancelled; releases the Leaving-Soon collection). */
    cancel: trashActionProcedure('manage_batches')
      .input(z.object({ batchId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(() =>
          cancelBatch({
            db: ctx.db,
            maintainerr: resolveMaintainerrBundle(ctx),
            batchId: input.batchId,
            actorId: ctx.user.id,
          }),
        );
      }),

    /** Manually expire ONE batch NOW (manage_batches; mostly validation). Runs the guarded sweep for it.
     *  The scheduled path is the `trash-batch-sweep` sync job, which calls the domain orchestrator. */
    expire: trashActionProcedure('manage_batches')
      .input(z.object({ batchId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(() =>
          sweepExpiredBatches({
            db: ctx.db,
            maintainerr: resolveMaintainerrBundle(ctx),
            batchId: input.batchId,
            actorId: ctx.user.id,
          }),
        );
      }),

    /**
     * Flip one item pending⇄saved. PHASE-DEPENDENT gate (composed on section read_only): during
     * `admin_review` the caller needs `manage_batches` (admin curation); during `leaving_soon` the
     * narrow `save_leaving_soon` grant (the windowed user exercise). A role holding neither for the
     * batch's phase is FORBIDDEN — server-authoritative, never client-hidden only (AC-13).
     */
    setItemSaved: sectionProcedure('trash', 'read_only')
      .input(z.object({ batchId: z.uuid(), itemId: z.uuid(), saved: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(async () => {
          const detail = await getBatchDetail({ db: ctx.db, batchId: input.batchId });
          const requiredAction =
            detail.state === 'leaving_soon' ? 'save_leaving_soon' : 'manage_batches';
          if (!hasTrashAction(ctx.user.role, requiredAction)) {
            throw new TRPCError({ code: 'FORBIDDEN' });
          }
          return setBatchItemSaved({
            db: ctx.db,
            maintainerr: resolveMaintainerrBundle(ctx),
            batchId: input.batchId,
            itemId: input.itemId,
            saved: input.saved,
            actorId: ctx.user.id,
            // DESIGN-011 D-05 — the domain enforces the leaving_soon un-save ownership rule: a caller
            // holding `manage_batches`/admin may release ANY family member's rescue; a bare
            // `save_leaving_soon` holder only their own (TrashSaveNotOwnedError otherwise).
            callerCanManage: hasTrashAction(ctx.user.role, 'manage_batches'),
          });
        });
      }),
  }),

  /**
   * ADR-031 / DESIGN-014 (PLAN-014) — the RULES-TUNING report (admin-only). A READ, not an auto-tune:
   * per-resolution / per-rating-band / per-collection rescue-vs-delete stats from the curation
   * pipeline's outcomes (the save-data = labelled false positives), plus the skip-gate GRADUATION
   * readiness (ADR-025 C-08). The owner reads this to tune the Maintainerr rules by hand; the report
   * never mutates a rule.
   */
  tuning: adminProcedure.query(({ ctx }) => mapDomainErrors(() => getTuningReport({ db: ctx.db }))),

  // ADR-025 C-06 — the app-settings admin surface (skip-gate + default window). Admin-only.
  settings: router({
    get: adminProcedure.query(async ({ ctx }) => {
      return mapDomainErrors(async () => ({
        ...APP_SETTING_DEFAULTS,
        ...(await getAppSettings(ctx.db)),
      }));
    }),
    set: adminProcedure
      .input(
        z.object({
          trashSkipAdminGate: z.boolean().optional(),
          trashDefaultWindowDays: z.number().int().min(1).max(365).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(async () => {
          if (input.trashSkipAdminGate !== undefined) {
            await setAppSetting({
              db: ctx.db,
              key: 'trash_skip_admin_gate',
              value: input.trashSkipAdminGate,
              actorId: ctx.user.id,
            });
          }
          if (input.trashDefaultWindowDays !== undefined) {
            await setAppSetting({
              db: ctx.db,
              key: 'trash_default_window_days',
              value: input.trashDefaultWindowDays,
              actorId: ctx.user.id,
            });
          }
          return getAppSettings(ctx.db);
        });
      }),
  }),
});
