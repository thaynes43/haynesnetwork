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
  getPoolRefreshCadence,
  getTrashOverview,
  getTuningReport,
  greenlightBatch,
  listBatches,
  POOL_REFRESH_DELAY_MAX,
  POOL_REFRESH_DELAY_MIN,
  listNotifications,
  listOpenBatchMediaIds,
  listRecentlyDeleted,
  listTrashPendingCandidates,
  listTrashPendingPage,
  refreshTrashCandidates,
  removeExclusion,
  removeTrashCandidateRows,
  requestPoolRefreshAfterSave,
  restoreDeleted,
  saveExclusion,
  setAppSetting,
  setBatchItemSaved,
  sweepExpiredBatches,
  triggerCandidateRefresh,
  unprotectBatchItem,
  upsertTrashRule,
  type TrashPendingSort,
} from '@hnet/domain';
import {
  mapDomainErrors,
  resolveArrBundle,
  resolveMaintainerrBundle,
  router,
  type TRPCContext,
} from '../trpc';
import { decodeCursor, encodeCursor } from '../cursor';
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

/**
 * DESIGN-010/014 amendment (build D) — arm the debounced post-save Maintainerr rule re-execution for a
 * kind after a save/un-save. Best-effort and non-blocking on failure: the exclusion write already
 * succeeded and is the durable outcome, so a marker-write or Maintainerr-config hiccup must NEVER fail
 * the user's save. A no-op when `pool_refresh_after_save` is off (checked inside the domain helper).
 */
async function schedulePoolRefresh(ctx: TRPCContext, media: 'movie' | 'tv'): Promise<void> {
  try {
    await requestPoolRefreshAfterSave({
      db: ctx.db,
      maintainerr: resolveMaintainerrBundle(ctx),
      kind: media,
      actorId: ctx.user?.id ?? null,
    });
  } catch {
    // swallowed — see the doc comment (the save is the durable outcome).
  }
}

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
   * DESIGN-010 D-02 (owner-directed 2026-07-09) — the PAGINATED pending-deletion wall for ONE media
   * kind (movie|tv, never combined). Read-through merge of Maintainerr's collections/media with our
   * ledger, shaped SERVER-SIDE (search/filter/sort) and sliced into ~50-item pages so the wall no
   * longer loads 776 tiles (and 776 exclusion reads) at once — the live-exclusion cross-check is
   * scoped to the returned page. `excludeOpenBatch` subtracts the open batch's members so the same
   * endpoint drives the "Potential in future batches" strip. The first page carries the facet menus,
   * the Expedite-all preview, and the full actionable-id snapshot the confirm pins the run to.
   */
  pending: sectionProcedure('trash', 'read_only')
    .input(
      z.object({
        media: trashMedia,
        query: z.string().optional(),
        genres: z.array(z.string()).optional(),
        resolutions: z.array(z.string()).optional(),
        requesters: z.array(z.string()).optional(),
        sourceCollections: z.array(z.string()).optional(),
        ratingMin: z.number().min(0).max(10).optional(),
        ratingMax: z.number().min(0).max(10).optional(),
        sort: z
          .object({
            // DESIGN-010/014 amendment (build D) — 'scheduled' ("Deletes") retired; 'strategy' ("Next up",
            // the default) mirrors the active batch-selection strategy so the top = the front of the queue.
            field: z.enum(['strategy', 'title', 'size', 'rating']),
            dir: z.enum(['asc', 'desc']),
          })
          .optional(),
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().optional(),
        /** The future-batch strip: drop the open batch's members from the candidate set. */
        excludeOpenBatch: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const offset =
          input.cursor !== undefined ? Number(decodeCursor(input.cursor, ['number'])[0]) : 0;
        const excludeMaintainerrIds =
          input.excludeOpenBatch === true
            ? await listOpenBatchMediaIds({ db: ctx.db, media: input.media })
            : undefined;
        const page = await listTrashPendingPage({
          db: ctx.db,
          maintainerr: resolveMaintainerrBundle(ctx),
          media: input.media,
          filters: {
            query: input.query,
            genres: input.genres,
            resolutions: input.resolutions,
            requesters: input.requesters,
            sourceCollections: input.sourceCollections,
            ratingMin: input.ratingMin,
            ratingMax: input.ratingMax,
          },
          sort: input.sort as TrashPendingSort | undefined,
          limit: input.limit,
          offset,
          excludeMaintainerrIds,
        });
        return {
          media: input.media,
          total: page.total,
          totalSizeBytes: page.totalSizeBytes,
          filteredCount: page.filteredCount,
          filteredSizeBytes: page.filteredSizeBytes,
          refreshedAt: page.refreshedAt,
          facets: page.facets,
          expeditePreview: page.expeditePreview,
          allActionableIds: page.allActionableIds,
          nextCursor: page.nextCursor === null ? null : encodeCursor([page.nextCursor]),
          items: page.items.map((item) => ({
            ...item,
            posterUrl:
              item.mediaItemId === null
                ? null
                : posterUrlFor(item.mediaItemId, item.posterSource),
          })),
        };
      });
    }),

  /**
   * The full actionable-candidate list for a kind + the TRUE candidate count — backs the admin
   * Start-a-batch target preview and the per-kind "N candidates" header without the paginated wall's
   * per-page live-exclusion cost. Read-Only+ (the header is admin-gated client-side).
   */
  pendingCandidates: sectionProcedure('trash', 'read_only')
    .input(z.object({ media: trashMedia }))
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const result = await listTrashPendingCandidates({
          db: ctx.db,
          maintainerr: resolveMaintainerrBundle(ctx),
          media: input.media,
        });
        return {
          media: input.media,
          count: result.count,
          refreshedAt: result.refreshedAt,
          candidates: result.candidates.map((c) => ({
            ...c,
            posterUrl:
              c.mediaItemId === null ? null : posterUrlFor(c.mediaItemId, c.posterSource),
          })),
        };
      });
    }),

  /**
   * ADR-035 — rebuild the Trash candidate snapshot ON DEMAND (the walls' "Refresh" affordance).
   * Read-model only: crawls Maintainerr's rule collections and replaces trash_candidates — no
   * Maintainerr write, nothing destructive — but gated like the batch lifecycle (manage_batches;
   * admin ⇒ ok) since it drives upstream load and belongs to the curation workflow.
   */
  refreshCandidates: trashActionProcedure('manage_batches').mutation(async ({ ctx }) => {
    return mapDomainErrors(() =>
      refreshTrashCandidates({ db: ctx.db, maintainerr: resolveMaintainerrBundle(ctx) }),
    );
  }),

  /**
   * DESIGN-010/014 amendment (build D) — the HONEST pool re-evaluation cadence for the walls' counts
   * bar ("pool re-evaluates every N h"). Reads Maintainerr's own rule-handler cron (GET /api/settings),
   * cached in-process; degrades to `everyHours: null` (label omitted) when Maintainerr is unreachable.
   * Read-Only+ — a plain honesty readout, not an action.
   */
  poolCadence: sectionProcedure('trash', 'read_only').query(async ({ ctx }) => {
    return getPoolRefreshCadence({ maintainerr: resolveMaintainerrBundle(ctx) });
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
        // The saved item's kind (movie|tv) — drives the per-kind debounced pool-refresh marker.
        media: trashMedia,
        maintainerrMediaId: z.string().min(1),
        mediaItemId: z.uuid().nullish(),
        collectionId: z.number().int().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const res = await saveExclusion({
          db: ctx.db,
          maintainerr: resolveMaintainerrBundle(ctx),
          maintainerrMediaId: input.maintainerrMediaId,
          mediaItemId: input.mediaItemId ?? null,
          collectionId: input.collectionId ?? undefined,
          actorId: ctx.user.id,
        });
        // No candidate-snapshot invalidation needed: an exclusion never changes collection
        // MEMBERSHIP (Maintainerr drops the item on ITS next rule run → the next refresh), and the
        // wall's protection badge is cross-checked LIVE per page (ADR-035). DESIGN-014 amendment
        // (build D) — but DO enqueue the debounced pool refresh so that rule run happens minutes
        // (not up to 8 h) from now; a no-op when the setting is off. Best-effort — never fail the save.
        await schedulePoolRefresh(ctx, input.media);
        return res;
      });
    }),

  /** DESIGN-010 D-05 — un-save (remove_exclude grant). */
  removeExclusion: trashActionProcedure('remove_exclude')
    .input(
      z.object({
        media: trashMedia,
        maintainerrMediaId: z.string().min(1),
        mediaItemId: z.uuid().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const res = await removeExclusion({
          db: ctx.db,
          maintainerr: resolveMaintainerrBundle(ctx),
          maintainerrMediaId: input.maintainerrMediaId,
          mediaItemId: input.mediaItemId ?? null,
          actorId: ctx.user.id,
        });
        // Same as saveExclusion — membership unchanged; protection is read live per page. An un-save
        // reshapes the pool too (a rescued item may re-enter), so it also arms the debounced refresh.
        await schedulePoolRefresh(ctx, input.media);
        return res;
      });
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
      return mapDomainErrors(async () => {
        const res = await expediteDeletion({
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
        });
        // ADR-035 — drop the just-deleted items from the candidate read-model so the wall reflects
        // the deletion on its next paint (the next sync refresh would catch it anyway).
        await removeTrashCandidateRows({ db: ctx.db, maintainerrMediaIds: res.expeditedIds });
        return res;
      });
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
      return mapDomainErrors(async () => {
        const res = await expediteDeletion({
          db: ctx.db,
          maintainerr: resolveMaintainerrBundle(ctx),
          scope: 'all',
          media: input.media,
          actorId: ctx.user.id,
          snapshotMediaIds: input.maintainerrMediaIds,
        });
        // ADR-035 — same read-model cleanup as expediteItem.
        await removeTrashCandidateRows({ db: ctx.db, maintainerrMediaIds: res.expeditedIds });
        return res;
      });
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
      return mapDomainErrors(async () => {
        const res = await upsertTrashRule({
          maintainerr: resolveMaintainerrBundle(ctx),
          payload: input.payload,
        });
        // ADR-035 — a rule edit reshapes the candidate pool; refresh the snapshot in the
        // background (Maintainerr re-evaluates rules on its own schedule, so the sync cadence
        // still provides the eventual truth — this just shortens the window).
        triggerCandidateRefresh({ db: ctx.db, maintainerr: resolveMaintainerrBundle(ctx) });
        return res;
      });
    }),

  /** DESIGN-010 — delete a Maintainerr rule group (edit_rules grant + section Edit). */
  deleteRule: trashActionProcedure('edit_rules', 'edit')
    .input(z.object({ ruleGroupId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const res = await deleteTrashRule({
          maintainerr: resolveMaintainerrBundle(ctx),
          ruleGroupId: input.ruleGroupId,
        });
        // ADR-035 — same background snapshot refresh as saveRule.
        triggerCandidateRefresh({ db: ctx.db, maintainerr: resolveMaintainerrBundle(ctx) });
        return res;
      });
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

    /**
     * Create a batch from the current pending set for one media kind (manage_batches; admin ⇒ ok).
     * DESIGN-011 amendment (2026-07-08) — optional reclaim targeting: `targetBytes` (free at least N
     * bytes) and/or `maxItems` cap the snapshot to the greedily-chosen deletable subset ranked by
     * `strategy` (default 'largest'). Absent ⇒ ALL current candidates (today's behavior). The server
     * does the authoritative pick from a FRESH snapshot; the client preview is advisory.
     */
    create: trashActionProcedure('manage_batches')
      .input(
        z.object({
          mediaKind: trashMedia,
          targetBytes: z.number().int().positive().optional(),
          maxItems: z.number().int().positive().max(100000).optional(),
          strategy: z.enum(['largest', 'worst-rated']).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const targeting =
          input.targetBytes !== undefined ||
          input.maxItems !== undefined ||
          input.strategy !== undefined
            ? {
                targetBytes: input.targetBytes,
                maxItems: input.maxItems,
                strategy: input.strategy,
              }
            : undefined;
        return mapDomainErrors(() =>
          createBatchFromPending({
            db: ctx.db,
            maintainerr: resolveMaintainerrBundle(ctx),
            mediaKind: input.mediaKind,
            actorId: ctx.user.id,
            targeting,
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

    /**
     * Manually expire ONE batch NOW (manage_batches; mostly validation). Runs the guarded sweep for it.
     * The scheduled path is the `trash-batch-sweep` sync job, which calls the domain orchestrator.
     * DESIGN-011 amendment (2026-07-08) — `forceOverride` is the owner-directed ADMIN OVERRIDE: sweep a
     * `leaving_soon` batch whose save window has NOT closed yet (bypasses ONLY the expiry gate — every
     * per-item safety layer still runs; the sweep is audited `forcedEarly`). Gated by `manage_batches`
     * exactly like the rest of the batch lifecycle, so a member without it can never force.
     */
    expire: trashActionProcedure('manage_batches')
      .input(z.object({ batchId: z.uuid(), forceOverride: z.boolean().optional() }))
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(() =>
          sweepExpiredBatches({
            db: ctx.db,
            maintainerr: resolveMaintainerrBundle(ctx),
            batchId: input.batchId,
            forceOverride: input.forceOverride,
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

    /**
     * ADR-025 errata (2026-07-09) — un-protect a `protected` (exclusion-held) wall item so the owner
     * can act on it. Removes the standing Maintainerr exclusion (the audited guarded seam) and
     * re-classifies the frozen row (requester-carrying ⇒ the requested person-shield; else pending).
     * Same PHASE gate as setItemSaved: `leaving_soon` ⇒ `save_leaving_soon`; otherwise `manage_batches`.
     */
    unprotectItem: sectionProcedure('trash', 'read_only')
      .input(z.object({ batchId: z.uuid(), itemId: z.uuid() }))
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(async () => {
          const detail = await getBatchDetail({ db: ctx.db, batchId: input.batchId });
          const requiredAction =
            detail.state === 'leaving_soon' ? 'save_leaving_soon' : 'manage_batches';
          if (!hasTrashAction(ctx.user.role, requiredAction)) {
            throw new TRPCError({ code: 'FORBIDDEN' });
          }
          return unprotectBatchItem({
            db: ctx.db,
            maintainerr: resolveMaintainerrBundle(ctx),
            batchId: input.batchId,
            itemId: input.itemId,
            actorId: ctx.user.id,
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
          // DESIGN-010/014 amendment (build D) — the debounced post-save pool refresh (enable + delay).
          poolRefreshAfterSave: z
            .object({
              enabled: z.boolean(),
              delayMinutes: z
                .number()
                .int()
                .min(POOL_REFRESH_DELAY_MIN)
                .max(POOL_REFRESH_DELAY_MAX),
            })
            .optional(),
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
          if (input.poolRefreshAfterSave !== undefined) {
            // Same audited single-writer (update_app_setting row same-tx); no new audit action needed.
            await setAppSetting({
              db: ctx.db,
              key: 'pool_refresh_after_save',
              value: input.poolRefreshAfterSave,
              actorId: ctx.user.id,
            });
          }
          return getAppSettings(ctx.db);
        });
      }),
  }),
});
