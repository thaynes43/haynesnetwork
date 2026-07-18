// ADR-072 / DESIGN-043 (PLAN-052 PR4a — direct-add) — the collections router for the first-class
// /collections page. Everyone adds/edits within the size cap (no grant on the safe path — `authedProcedure`);
// admins bypass the cap and are the only deleters + ticket approvers (`adminProcedure`). Over-cap escalates
// to a `collection_override` ticket carrying the FULL requested definition (D-11), which an admin Approve
// materializes automatically. Books/Audiobooks bind Libretto (this PR); Movies/TV bind Kometa (the
// auto-merge write path — PR4b), reported as "not available yet" here so the shell + IA ship whole. ALL
// Libretto calls go through the confined @hnet/libretto client via the @hnet/domain orchestrators — NEVER a
// browser call. A Libretto outage degrades honestly (overview.reachable=false).
import { z } from 'zod';
import {
  COLLECTION_BUILDER_TYPES,
  COLLECTION_MEDIA_TYPES,
  COLLECTION_SYNC_MODES,
  type CollectionMediaType,
  type CollectionOverridePayload,
  type TicketRow,
} from '@hnet/db';
import {
  applyCollectionScope,
  approveCollectionOverride,
  createCollectionOverrideTicket,
  declineCollectionOverride,
  deleteCollectionRecipe,
  getAppSetting,
  getCollectionRun,
  getCollectionsOverview,
  listCollectionOverrideTickets,
  previewRecipeRef,
  setAppSetting,
  upsertCollection,
} from '@hnet/domain';
import type { TRPCContext } from '../trpc';
import type {
  LibrettoCollection,
  LibrettoIssue,
  LibrettoRecipe,
  LibrettoRun,
  LibrettoValidateResponse,
} from '@hnet/libretto';
import { mapDomainErrors, resolveLibrettoBundle, router, authedProcedure } from '../trpc';
import { adminProcedure, resolveCollectionActions } from '../middleware/role';

/** The media types this PR serves through Libretto (direct API). Movies/TV are the Kometa leg (PR4b). */
const LIBRETTO_MEDIA_TYPES = new Set<CollectionMediaType>(['books', 'audiobooks']);

// The recipe draft the composer sends (validated tighter than the read ACL — it is OUR input).
const recipeDraftInput = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200).optional(),
  builderType: z.enum(COLLECTION_BUILDER_TYPES),
  builderRef: z.string().trim().min(1).max(400),
  targetLibrary: z.string().trim().min(1).max(200).optional(),
  ordered: z.boolean().optional(),
  syncMode: z.enum(COLLECTION_SYNC_MODES).optional(),
});
type RecipeDraftInput = z.infer<typeof recipeDraftInput>;

/** Map the router's flat draft input onto the @hnet/libretto RecipeDraft shape (acquisition OFF — D-03). */
function toLibrettoDraft(input: RecipeDraftInput) {
  return {
    id: input.id,
    ...(input.name ? { name: input.name } : {}),
    builder: { type: input.builderType, ref: input.builderRef },
    ...(input.targetLibrary ? { targetLibrary: input.targetLibrary } : {}),
    variables: {
      ...(input.syncMode ? { syncMode: input.syncMode } : {}),
      ...(input.ordered !== undefined ? { ordered: input.ordered } : {}),
      acquisitionEnabled: false,
    },
    enabled: true,
  };
}

/**
 * DESIGN-043 D-09 — derive a produced collection's media sub-section from its Libretto `targetKind`
 * (audiobookshelf/ABS → audiobooks; everything else → books). A recipe with no produced collection yet is a
 * Book by default (Kavita is the larger library). Honest best-effort — never fabricates a media type.
 */
function deriveMediaType(targetKind: string | null | undefined): CollectionMediaType {
  const k = (targetKind ?? '').toLowerCase();
  if (k.includes('abs') || k.includes('audio')) return 'audiobooks';
  return 'books';
}

// Explicit wire shapes (the fixWire idiom) — the Libretto ACL uses zod passthrough, whose loose types do
// not survive tRPC inference cleanly; the manager gets a stable, typed contract instead.
function recipeWire(r: LibrettoRecipe, mediaType: CollectionMediaType) {
  return {
    id: r.id,
    name: r.name ?? null,
    builderType: r.builder?.type ?? null,
    builderRef: r.builder?.ref ?? null,
    ordered: r.variables?.ordered ?? null,
    syncMode: r.variables?.syncMode ?? null,
    findMissing: r.variables?.acquisitionEnabled ?? false,
    enabled: r.enabled ?? true,
    mediaType,
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
    resolved: res.resolved
      ? { name: res.resolved.name ?? null, workCount: res.resolved.workCount ?? null }
      : null,
    issues: (res.issues ?? []).map((i) => i.message ?? 'issue'),
  };
}
function ticketWire(row: TicketRow) {
  const p = row.collectionOverridePayload;
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    authorUserId: row.authorUserId,
    collectionName: p?.name ?? row.title,
    mediaType: p?.mediaType ?? null,
    provider: p?.provider ?? null,
    size: p?.size ?? null,
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}

/** Resolve a draft's live membership size (the ref preview's workCount; 0 when unresolved). */
async function resolveDraftSize(
  ctx: TRPCContext,
  draft: ReturnType<typeof toLibrettoDraft>,
): Promise<number> {
  const preview = await previewRecipeRef({ libretto: resolveLibrettoBundle(ctx), draft });
  return preview.resolved?.workCount ?? 0;
}

export const collectionsRouter = router({
  /**
   * The per-media-type monitor (D-02/D-09): recipes (+ invalid-file issues) and produced collections for a
   * media sub-section, read LIVE from Libretto (reachable=false on an outage — the honest degrade). Movies /
   * TV report `available:false` (the Kometa leg is PR4b). Everyone may read (no grant); carries the live
   * size cap + whether the caller bypasses it (admin) + whether the caller can flip find-missing.
   */
  overview: authedProcedure
    .input(z.object({ mediaType: z.enum(COLLECTION_MEDIA_TYPES) }))
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const sizeCap = await getAppSetting(ctx.db, 'collection_size_cap');
        const actions = await resolveCollectionActions(ctx.db, ctx.user.role);
        const base = {
          mediaType: input.mediaType,
          sizeCap,
          capBypass: ctx.user.role.isAdmin,
          isAdmin: ctx.user.role.isAdmin,
          canFindMissing: actions.includes('find_missing'),
        };
        if (!LIBRETTO_MEDIA_TYPES.has(input.mediaType)) {
          // Movies/TV — the Kometa auto-merge write path lands in PR4b. Honest "not available yet".
          return {
            ...base,
            provider: 'kometa' as const,
            available: false,
            reachable: true,
            recipes: [],
            issues: [],
            collections: [],
          };
        }
        const overview = await getCollectionsOverview({ libretto: resolveLibrettoBundle(ctx) });
        const collectionByRecipe = new Map(
          overview.collections.filter((c) => c.recipeId).map((c) => [c.recipeId as string, c]),
        );
        const recipes = overview.recipes
          .map((r) => {
            const produced = collectionByRecipe.get(r.id);
            return recipeWire(r, deriveMediaType(produced?.targetKind));
          })
          .filter((r) => r.mediaType === input.mediaType);
        return {
          ...base,
          provider: 'libretto' as const,
          available: true,
          reachable: overview.reachable,
          recipes,
          issues: overview.issues.map(issueWire),
          collections: overview.collections.map(collectionWire),
        };
      });
    }),

  /** Preview/validate a draft ref before save (resolved name + work count + issues; the surviving C-07). */
  validate: authedProcedure.input(recipeDraftInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(async () =>
      validateWire(await previewRecipeRef({ libretto: resolveLibrettoBundle(ctx), draft: toLibrettoDraft(input) })),
    );
  }),

  /**
   * DIRECT add/edit (D-03) — everyone, capped. Resolves the live membership size, reads the cap, and the
   * domain writer asserts it (admins bypass) BEFORE the confined Libretto write + same-tx audit. An over-cap
   * non-admin gets `COLLECTION_SIZE_CAP_EXCEEDED` (the client opens the request-larger flow → requestOverride).
   */
  upsert: authedProcedure.input(recipeDraftInput).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(async () => {
      const draft = toLibrettoDraft(input);
      const size = ctx.user.role.isAdmin ? 0 : await resolveDraftSize(ctx, draft);
      const cap = await getAppSetting(ctx.db, 'collection_size_cap');
      await upsertCollection({
        db: ctx.db,
        libretto: resolveLibrettoBundle(ctx),
        actorId: ctx.user.id,
        draft,
        size,
        cap,
        isAdmin: ctx.user.role.isAdmin,
      });
      return { ok: true as const, id: input.id };
    });
  }),

  /** Apply a scope (a recipe id or 'all') → the async run id to poll. */
  applyRecipe: authedProcedure
    .input(z.object({ scope: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const runId = await applyCollectionScope({ libretto: resolveLibrettoBundle(ctx), scope: input.scope });
        return { runId };
      });
    }),

  /** Poll one run's state + counts (Libretto keeps only the last 50 — surfaced honestly). */
  run: authedProcedure
    .input(z.object({ runId: z.string().trim().min(1).max(120) }))
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        runWire(await getCollectionRun({ libretto: resolveLibrettoBundle(ctx), runId: input.runId })),
      );
    }),

  /** Delete a recipe (ADMIN only). Does NOT cascade by default (orphans the target); opt into deleteCollection. */
  remove: adminProcedure
    .input(z.object({ id: z.string().trim().min(1).max(80), deleteCollection: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        await deleteCollectionRecipe({
          db: ctx.db,
          libretto: resolveLibrettoBundle(ctx),
          actorId: ctx.user.id,
          id: input.id,
          deleteCollection: input.deleteCollection ?? false,
        });
        return { ok: true as const };
      });
    }),

  /**
   * Over-cap escalation (D-11): file a `collection_override` ticket CARRYING the full requested definition.
   * The server resolves the authoritative size (never trusting the client) and stamps the caller as author.
   * An admin's Approve materializes it unbounded.
   */
  requestOverride: authedProcedure
    .input(recipeDraftInput.extend({ mediaType: z.enum(COLLECTION_MEDIA_TYPES) }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const { mediaType, ...draftInput } = input;
        const draft = toLibrettoDraft(draftInput);
        const size = await resolveDraftSize(ctx, draft);
        const cap = await getAppSetting(ctx.db, 'collection_size_cap');
        const payload: CollectionOverridePayload = {
          provider: LIBRETTO_MEDIA_TYPES.has(mediaType) ? 'libretto' : 'kometa',
          mediaType,
          recipeId: draftInput.id,
          name: draftInput.name ?? draftInput.id,
          builderType: draftInput.builderType,
          builderRef: draftInput.builderRef,
          targetLibrary: draftInput.targetLibrary ?? null,
          ordered: draftInput.ordered,
          syncMode: draftInput.syncMode,
          size,
        };
        const ticket = await createCollectionOverrideTicket({
          db: ctx.db,
          authorId: ctx.user.id,
          cap,
          payload,
        });
        return { ticketId: ticket.id };
      });
    }),

  /** The caller's OWN over-cap requests (the Tickets sub-section, requester lens). */
  myTickets: authedProcedure.query(async ({ ctx }) => {
    const rows = await listCollectionOverrideTickets({ db: ctx.db, authorId: ctx.user.id, limit: 50 });
    return { tickets: rows.map(ticketWire) };
  }),

  /** ALL over-cap requests (ADMIN — the Tickets sub-section approve lens; newest-activity-first). */
  allTickets: adminProcedure.query(async ({ ctx }) => {
    const rows = await listCollectionOverrideTickets({ db: ctx.db, limit: 100 });
    return { tickets: rows.map(ticketWire) };
  }),

  /** Approve an over-cap request (ADMIN, one click) → materialize the collection unbounded + complete it. */
  approveOverride: adminProcedure
    .input(z.object({ ticketId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const res = await approveCollectionOverride({
          db: ctx.db,
          libretto: resolveLibrettoBundle(ctx),
          ticketId: input.ticketId,
          actorId: ctx.user.id,
        });
        return { ticketId: res.ticket.id, status: res.ticket.status };
      });
    }),

  /** Decline an over-cap request (ADMIN) with a reason. Materializes nothing. */
  declineOverride: adminProcedure
    .input(z.object({ ticketId: z.uuid(), reason: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const res = await declineCollectionOverride({
          db: ctx.db,
          ticketId: input.ticketId,
          actorId: ctx.user.id,
          reason: input.reason,
        });
        return { ticketId: res.ticket.id, status: res.ticket.status };
      });
    }),

  /** Admin Settings (D-10): the current configurable size cap. */
  settings: adminProcedure.query(async ({ ctx }) => {
    const sizeCap = await getAppSetting(ctx.db, 'collection_size_cap');
    return { sizeCap };
  }),

  /** Admin Settings (D-10): set the configurable size cap (audited setAppSetting). */
  setSizeCap: adminProcedure
    .input(z.object({ value: z.number().int().min(1).max(100000) }))
    .mutation(async ({ ctx, input }) => {
      const res = await setAppSetting({
        db: ctx.db,
        key: 'collection_size_cap',
        value: input.value,
        actorId: ctx.user.id,
      });
      return { sizeCap: res.after };
    }),
});
