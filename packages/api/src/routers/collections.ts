// ADR-070 / DESIGN-043 (PLAN-052 — collection manager) — the collections router. The manager mutations are
// gated by `collectionActionProcedure('manage')` (the integrations-floored capability); the acquisition
// knob is re-checked server-side (`canAcquire`); the member contribution rides `collectionSuggestProcedure`
// (suggest grant, no section floor — the affordance is on the books walls). ALL Libretto calls go through
// the confined @hnet/libretto client via the @hnet/domain orchestrators — NEVER a browser call. A Libretto
// outage degrades honestly (overview.reachable=false); a bad recipe save surfaces Libretto's per-path issues.
import { z } from 'zod';
import {
  COLLECTION_BUILDER_TYPES,
  COLLECTION_SUGGESTION_STATUSES,
  COLLECTION_SYNC_MODES,
  type CollectionSuggestionRow,
} from '@hnet/db';
import {
  applyCollectionScope,
  approveCollectionSuggestion,
  assertWithinCollectionSizeCap,
  createCollectionOverrideTicket,
  createCollectionSuggestion,
  declineCollectionSuggestion,
  deleteCollectionRecipe,
  getAppSetting,
  getCollectionRun,
  getCollectionsOverview,
  listCollectionSuggestions,
  previewRecipeRef,
  saveRecipe,
} from '@hnet/domain';
import type { TRPCContext } from '../trpc';
import type {
  LibrettoCollection,
  LibrettoIssue,
  LibrettoRecipe,
  LibrettoRun,
  LibrettoValidateResponse,
} from '@hnet/libretto';
import { mapDomainErrors, resolveLibrettoBundle, router } from '../trpc';
import {
  collectionActionProcedure,
  collectionSuggestProcedure,
  resolveCollectionActions,
} from '../middleware/role';

// The recipe draft the composer sends (validated tighter than the read ACL — it is OUR input).
const recipeDraftInput = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200).optional(),
  builderType: z.enum(COLLECTION_BUILDER_TYPES),
  builderRef: z.string().trim().min(1).max(400),
  targetLibrary: z.string().trim().min(1).max(200).optional(),
  ordered: z.boolean().optional(),
  syncMode: z.enum(COLLECTION_SYNC_MODES).optional(),
  acquisitionEnabled: z.boolean().optional(),
});
type RecipeDraftInput = z.infer<typeof recipeDraftInput>;

/** Map the router's flat draft input onto the @hnet/libretto RecipeDraft shape. */
function toLibrettoDraft(input: RecipeDraftInput) {
  return {
    id: input.id,
    ...(input.name ? { name: input.name } : {}),
    builder: { type: input.builderType, ref: input.builderRef },
    ...(input.targetLibrary ? { targetLibrary: input.targetLibrary } : {}),
    variables: {
      ...(input.syncMode ? { syncMode: input.syncMode } : {}),
      ...(input.ordered !== undefined ? { ordered: input.ordered } : {}),
      acquisitionEnabled: input.acquisitionEnabled ?? false,
    },
    enabled: true,
  };
}

/**
 * DESIGN-035 D-17 — refuse an over-cap CREATE for a non-admin. Previews the draft's builder to learn the
 * resolved membership size, reads the live `collection_size_cap`, and throws `CollectionSizeCapError`
 * (carrying `{ size, cap }`) when a non-admin would breach it. A no-op for admins (they bypass the cap
 * outright). Runs BEFORE the confined Libretto write, so an over-cap recipe never lands.
 */
async function assertDraftWithinCap(
  ctx: TRPCContext,
  isAdmin: boolean,
  draft: ReturnType<typeof toLibrettoDraft>,
): Promise<void> {
  if (isAdmin) return;
  const preview = await previewRecipeRef({ libretto: resolveLibrettoBundle(ctx), draft });
  const size = preview.resolved?.workCount ?? 0;
  const cap = await getAppSetting(ctx.db, 'collection_size_cap');
  assertWithinCollectionSizeCap({ size, cap, isAdmin: false });
}

// Explicit wire shapes (the fixWire idiom) — the Libretto ACL uses zod passthrough, whose loose types do
// not survive tRPC inference cleanly; the manager gets a stable, typed contract instead.
function recipeWire(r: LibrettoRecipe) {
  return {
    id: r.id,
    name: r.name ?? null,
    builderType: r.builder?.type ?? null,
    builderRef: r.builder?.ref ?? null,
    ordered: r.variables?.ordered ?? null,
    syncMode: r.variables?.syncMode ?? null,
    acquisitionEnabled: r.variables?.acquisitionEnabled ?? false,
    enabled: r.enabled ?? true,
  };
}
function issueWire(i: LibrettoIssue) {
  return { recipeId: i.recipeId ?? null, message: i.message ?? 'invalid recipe' };
}
function collectionWire(c: LibrettoCollection) {
  return {
    recipeId: c.recipeId ?? null,
    name: c.name ?? null,
    itemCount: c.itemCount ?? null,
  };
}
function runWire(run: LibrettoRun) {
  return {
    id: run.id,
    status: run.status ?? null,
    counts: {
      matched: run.counts?.matched ?? null,
      matchedByTitle: run.counts?.matchedByTitle ?? null,
      missing: run.counts?.missing ?? null,
      acquired: run.counts?.acquired ?? null,
    },
  };
}
function validateWire(res: LibrettoValidateResponse) {
  return {
    resolved: res.resolved ? { name: res.resolved.name ?? null, workCount: res.resolved.workCount ?? null } : null,
    issues: (res.issues ?? []).map((i) => i.message ?? 'issue'),
  };
}

function suggestionWire(row: CollectionSuggestionRow) {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    builderType: row.builderType,
    builderRef: row.builderRef,
    targetLibrary: row.targetLibrary,
    note: row.note,
    status: row.status,
    decisionNote: row.decisionNote,
    createdRecipeId: row.createdRecipeId,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

export const collectionsRouter = router({
  /**
   * The manager monitor: recipes (+ invalid-file issues) and produced collections, read LIVE from Libretto
   * (reachable=false on an outage — the honest degrade). Carries the caller's `canAcquire` flag so the
   * composer can enable/disable the acquisition toggle, plus the pending suggestion queue.
   */
  overview: collectionActionProcedure('manage').query(async ({ ctx }) => {
    return mapDomainErrors(async () => {
      const overview = await getCollectionsOverview({ libretto: resolveLibrettoBundle(ctx) });
      const actions = await resolveCollectionActions(ctx.db, ctx.user.role);
      const pending = await listCollectionSuggestions({ db: ctx.db, status: 'pending' });
      // DESIGN-035 D-17 — the composer needs the live size cap + whether the caller bypasses it (admin)
      // so it can pre-empt an over-cap save with the override Modal.
      const sizeCap = await getAppSetting(ctx.db, 'collection_size_cap');
      return {
        reachable: overview.reachable,
        recipes: overview.recipes.map(recipeWire),
        issues: overview.issues.map(issueWire),
        collections: overview.collections.map(collectionWire),
        canAcquire: actions.includes('acquire'),
        sizeCap,
        capBypass: ctx.user.role.isAdmin,
        pendingSuggestions: pending.map(suggestionWire),
      };
    });
  }),

  /** Preview/validate a draft ref before save (resolved name + work count + issues; ADR-070 C-07). */
  validate: collectionActionProcedure('manage')
    .input(recipeDraftInput)
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        validateWire(await previewRecipeRef({ libretto: resolveLibrettoBundle(ctx), draft: toLibrettoDraft(input) })),
      );
    }),

  /** Create/edit a recipe (idempotent PUT). Enabling acquisition needs the `acquire` grant (re-checked). */
  save: collectionActionProcedure('manage')
    .input(recipeDraftInput)
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const draft = toLibrettoDraft(input);
        // DESIGN-035 D-17 — a non-admin cannot create/edit an over-cap collection (opens the over-cap
        // Modal client-side, which files the admin-override ticket). Admins bypass.
        await assertDraftWithinCap(ctx, ctx.user.role.isAdmin, draft);
        const actions = await resolveCollectionActions(ctx.db, ctx.user.role);
        await saveRecipe({
          libretto: resolveLibrettoBundle(ctx),
          draft,
          canAcquire: actions.includes('acquire'),
        });
        return { ok: true as const, id: input.id };
      });
    }),

  /** Apply a scope (a recipe id or 'all') → the async run id to poll. */
  applyRecipe: collectionActionProcedure('manage')
    .input(z.object({ scope: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const runId = await applyCollectionScope({ libretto: resolveLibrettoBundle(ctx), scope: input.scope });
        return { runId };
      });
    }),

  /**
   * DESIGN-035 D-17 — the over-cap admin-override request. A non-admin whose create hit the size cap
   * files a `collection_override` ticket (reusing the ADR-050 helpdesk board + its atomic outbox ping +
   * admin email) so an admin can approve a larger bound. The server reads the live cap (never trusting a
   * client-sent cap) and stamps the requesting user as the author.
   */
  requestOverride: collectionActionProcedure('manage')
    .input(
      z.object({
        collectionName: z.string().trim().min(1).max(200),
        size: z.number().int().nonnegative().max(100000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const cap = await getAppSetting(ctx.db, 'collection_size_cap');
        const ticket = await createCollectionOverrideTicket({
          db: ctx.db,
          authorId: ctx.user.id,
          provider: 'libretto',
          collectionName: input.collectionName,
          size: input.size,
          cap,
        });
        return { ticketId: ticket.id };
      });
    }),

  /** Poll one run's state + counts (Libretto keeps only the last 50 — surfaced honestly). */
  run: collectionActionProcedure('manage')
    .input(z.object({ runId: z.string().trim().min(1).max(120) }))
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        runWire(await getCollectionRun({ libretto: resolveLibrettoBundle(ctx), runId: input.runId })),
      );
    }),

  /** Delete a recipe. Does NOT cascade by default (orphans the target collection); opt into deleteCollection. */
  remove: collectionActionProcedure('manage')
    .input(z.object({ id: z.string().trim().min(1).max(80), deleteCollection: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        await deleteCollectionRecipe({
          libretto: resolveLibrettoBundle(ctx),
          id: input.id,
          deleteCollection: input.deleteCollection ?? false,
        });
        return { ok: true as const };
      });
    }),

  /** The manager's suggestion review queue (default pending). */
  suggestions: collectionActionProcedure('manage')
    .input(z.object({ status: z.enum(COLLECTION_SUGGESTION_STATUSES).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await listCollectionSuggestions({
        db: ctx.db,
        ...(input?.status ? { status: input.status } : { status: 'pending' as const }),
      });
      return { suggestions: rows.map(suggestionWire) };
    }),

  /** Approve or decline a member suggestion. Approve materializes the recipe via the confined writer. */
  reviewSuggestion: collectionActionProcedure('manage')
    .input(
      z.discriminatedUnion('decision', [
        z.object({
          decision: z.literal('approve'),
          suggestionId: z.uuid(),
          recipeId: z.string().trim().min(1).max(80).optional(),
          targetLibrary: z.string().trim().min(1).max(200).optional(),
          ordered: z.boolean().optional(),
          syncMode: z.enum(COLLECTION_SYNC_MODES).optional(),
          enableAcquisition: z.boolean().optional(),
        }),
        z.object({
          decision: z.literal('decline'),
          suggestionId: z.uuid(),
          reason: z.string().trim().min(1).max(1000),
        }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        if (input.decision === 'decline') {
          const row = await declineCollectionSuggestion({
            db: ctx.db,
            suggestionId: input.suggestionId,
            reviewerId: ctx.user.id,
            reason: input.reason,
          });
          return suggestionWire(row);
        }
        const actions = await resolveCollectionActions(ctx.db, ctx.user.role);
        const row = await approveCollectionSuggestion({
          db: ctx.db,
          libretto: resolveLibrettoBundle(ctx),
          suggestionId: input.suggestionId,
          reviewerId: ctx.user.id,
          canAcquire: actions.includes('acquire'),
          enableAcquisition: input.enableAcquisition ?? false,
          ...(input.recipeId ? { recipeId: input.recipeId } : {}),
          ...(input.targetLibrary ? { targetLibrary: input.targetLibrary } : {}),
          ...(input.ordered !== undefined ? { ordered: input.ordered } : {}),
          ...(input.syncMode ? { syncMode: input.syncMode } : {}),
        });
        return suggestionWire(row);
      });
    }),

  /**
   * The member contribution: propose a collection (a PENDING row; applies nothing). Gated by the `suggest`
   * grant only (no section floor — the affordance is on the books walls).
   */
  suggest: collectionSuggestProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(200),
        builderType: z.enum(COLLECTION_BUILDER_TYPES),
        builderRef: z.string().trim().min(1).max(400),
        targetLibrary: z.string().trim().min(1).max(200).optional(),
        note: z.string().trim().min(1).max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await createCollectionSuggestion({
        db: ctx.db,
        suggesterId: ctx.user.id,
        name: input.name,
        builderType: input.builderType,
        builderRef: input.builderRef,
        targetLibrary: input.targetLibrary ?? null,
        note: input.note ?? null,
      });
      return suggestionWire(row);
    }),

  /** The suggester's own suggestions (newest-first) — the wall affordance's state read. */
  mySuggestions: collectionSuggestProcedure.query(async ({ ctx }) => {
    const rows = await listCollectionSuggestions({ db: ctx.db, suggesterId: ctx.user.id, limit: 25 });
    return { suggestions: rows.map(suggestionWire) };
  }),
});
