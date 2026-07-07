// ADR-023 / DESIGN-010 — the Trash section's tRPC surface (Maintainerr-backed deletion UI). Access
// is layered: the coarse `trash` section level gates VIEW (read_only browses pending/collections/
// rules/recently-deleted/activity), while each destructive/mutating action needs an explicit
// fine-grained grant (trashActionProcedure). Every Maintainerr call goes through @hnet/domain
// orchestrators (the confined write surface) wrapped in mapDomainErrors. Music/Lidarr is never a
// target (the media param is movie|tv only — R-87).
import { z } from 'zod';
import {
  arrKindForTrashMedia,
  auditMaintainerr,
  deleteTrashRule,
  expediteDeletion,
  listNotifications,
  listRecentlyDeleted,
  listTrashPending,
  removeExclusion,
  restoreDeleted,
  saveExclusion,
  upsertTrashRule,
} from '@hnet/domain';
import { mapDomainErrors, resolveArrBundle, resolveMaintainerrBundle, router } from '../trpc';
import { sectionProcedure, trashActionProcedure } from '../middleware/role';
import { posterUrlFor } from '../ledger-query';

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

  /** DESIGN-010 D-07 (addendum c) — the Maintainerr Activity feed (from the notification store). */
  activity: sectionProcedure('trash', 'read_only')
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      return listNotifications({ db: ctx.db, source: 'maintainerr', limit: input?.limit ?? 50 });
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
});
