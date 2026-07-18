// ADR-072 / DESIGN-043 (PLAN-052 PR4a — direct-add) — the collections router for the first-class
// /collections page. Everyone adds/edits within the size cap (no grant on the safe path — `authedProcedure`);
// admins bypass the cap and are the only deleters + ticket approvers (`adminProcedure`). Over-cap escalates
// to a `collection_override` ticket carrying the FULL requested definition (D-11), which an admin Approve
// materializes automatically. Books/Audiobooks bind Libretto (this PR); Movies/TV bind Kometa (the
// auto-merge write path — PR4b), reported as "not available yet" here so the shell + IA ship whole. ALL
// Libretto calls go through the confined @hnet/libretto client via the @hnet/domain orchestrators — NEVER a
// browser call. A Libretto outage degrades honestly (overview.reachable=false).
import { z } from 'zod';
import { isNotNull } from 'drizzle-orm';
import {
  booksCollections,
  COLLECTION_BUILDER_TYPES,
  COLLECTION_MEDIA_TYPES,
  COLLECTION_SYNC_MODES,
  KOMETA_BUILDER_TYPES,
  type CollectionMediaType,
  type CollectionOverridePayload,
  type KometaBuilderType,
  type TicketRow,
} from '@hnet/db';
import {
  applyCollectionScope,
  approveCollectionOverride,
  createCollectionOverrideTicket,
  declineCollectionOverride,
  deleteCollectionRecipe,
  deleteKometaRecipe,
  getAppSetting,
  getCollectionRun,
  getCollectionsOverview,
  getKometaCollectionsOverview,
  KometaRecipeError,
  listCollectionOverrideTickets,
  previewKometaRef,
  previewRecipeRef,
  setAppSetting,
  setCollectionFindMissing,
  setKometaFindMissing,
  upsertCollection,
  upsertKometaCollection,
  type KometaMediaType,
  type KometaRecipe,
  type KometaRecipeView,
} from '@hnet/domain';
import type { TRPCContext } from '../trpc';
import type {
  LibrettoCollection,
  LibrettoIssue,
  LibrettoRecipe,
  LibrettoRun,
  LibrettoValidateResponse,
} from '@hnet/libretto';
import {
  mapDomainErrors,
  resolveHaynesopsBundle,
  resolveLibrettoBundle,
  router,
  authedProcedure,
} from '../trpc';
import { adminProcedure, collectionActionProcedure, resolveCollectionActions } from '../middleware/role';

/** The media types this PR serves through Libretto (direct API). Movies/TV are the Kometa leg (PR4b). */
const LIBRETTO_MEDIA_TYPES = new Set<CollectionMediaType>(['books', 'audiobooks']);
const KOMETA_BUILDER_SET = new Set<string>(KOMETA_BUILDER_TYPES);

/** Movies/TV bind Kometa; Books/Audiobooks bind Libretto. */
function isKometaMedia(mediaType: CollectionMediaType): mediaType is 'movies' | 'tv' {
  return mediaType === 'movies' || mediaType === 'tv';
}

/** Normalize a collection title for the produced-collection ↔ recipe join (trim + collapse ws + casefold). */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Map the flat composer input onto the confined Kometa recipe shape (acquisition OFF — D-07). */
function toKometaRecipe(input: RecipeDraftInput, mediaType: 'movies' | 'tv'): KometaRecipe {
  if (!KOMETA_BUILDER_SET.has(input.builderType)) {
    // A Libretto builder on a Movies/TV draft — reject before the confined write (D-04).
    throw new KometaRecipeError(`"${input.builderType}" is not a Movies/TV collection builder.`);
  }
  return {
    id: input.id,
    name: input.name ?? input.id,
    mediaType: mediaType as KometaMediaType,
    builderType: input.builderType as KometaBuilderType,
    builderRef: input.builderRef,
    ...(input.syncMode ? { syncMode: input.syncMode } : {}),
    ...(input.ordered !== undefined ? { ordered: input.ordered } : {}),
    findMissing: false,
  };
}

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

/** The draft plus its media sub-section — the composer always knows which tab it is on (routes the provider). */
const recipeDraftWithMedia = recipeDraftInput.extend({ mediaType: z.enum(COLLECTION_MEDIA_TYPES) });

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
 * DESIGN-043 D-09 — a produced collection's media sub-section. The MIRROR is the authority: the
 * books-collections sync records which SERVER produced each Libretto recipe's collection
 * (`books_collections.source` + `libretto_recipe_id`, the D-13 exact join), so `audiobookshelf` ⇒
 * Audiobooks and `kavita` ⇒ Books with no guessing. The `targetKind` string heuristic remains only
 * as the fallback for a recipe the mirror has not seen yet (owner-reported live miss 2026-07-18:
 * `dune-audiobooks` landed on the Books tab — the heuristic alone is not enough). A recipe with no
 * produced collection anywhere defaults to Books (Kavita is the larger library).
 */
function deriveMediaType(
  mirrorSource: string | undefined,
  targetKind: string | null | undefined,
): CollectionMediaType {
  if (mirrorSource === 'audiobookshelf') return 'audiobooks';
  if (mirrorSource === 'kavita') return 'books';
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
    // Libretto writes are instant — a recipe has no async config→run→mirror gap, so no pending state.
    state: null as 'live' | 'pending_run' | null,
  };
}

/** The Kometa recipe wire — same shape as the Libretto one plus the honest async `state` (D-07). */
function kometaRecipeWire(r: KometaRecipeView) {
  return {
    id: r.id,
    name: r.name,
    builderType: r.builderType as string,
    builderRef: r.builderRef,
    ordered: r.ordered ?? null,
    syncMode: r.syncMode ?? null,
    findMissing: r.findMissing,
    enabled: true,
    mediaType: r.mediaType as CollectionMediaType,
    state: r.state,
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
function ticketWire(row: TicketRow & { authorName?: string | null }) {
  const p = row.collectionOverridePayload;
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    authorUserId: row.authorUserId,
    requestedBy: row.authorName ?? null,
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
        if (isKometaMedia(input.mediaType)) {
          // Movies/TV — the Kometa auto-merge write path (PR4b). Reads the app-owned managed include
          // back + the DESIGN-035 mirror + the open app PRs; degrades honestly (reachable=false) on a
          // haynes-ops/GitHub outage. Produced collections join to recipes by normalized title (Kometa
          // collections carry no recipe id the mirror reads — Q-05 reconcile-by-title).
          const overview = await getKometaCollectionsOverview({
            db: ctx.db,
            haynesops: resolveHaynesopsBundle(ctx),
            mediaType: input.mediaType,
          });
          const recipeByTitle = new Map(overview.recipes.map((r) => [normalizeTitle(r.name), r.id]));
          return {
            ...base,
            provider: 'kometa' as const,
            available: true,
            reachable: overview.reachable,
            recipes: overview.recipes.map(kometaRecipeWire),
            issues: [] as ReturnType<typeof issueWire>[],
            collections: overview.collections.map((c) => ({
              recipeId: recipeByTitle.get(normalizeTitle(c.title)) ?? null,
              name: c.title,
              itemCount: c.childCount,
            })),
            pendingPrs: overview.pendingPrs,
          };
        }
        const overview = await getCollectionsOverview({ libretto: resolveLibrettoBundle(ctx) });
        const collectionByRecipe = new Map(
          overview.collections.filter((c) => c.recipeId).map((c) => [c.recipeId as string, c]),
        );
        // The mirror's recipe → source map (the D-13 exact join) — the media-type authority.
        const mirrorRows = await ctx.db
          .select({
            recipeId: booksCollections.librettoRecipeId,
            source: booksCollections.source,
          })
          .from(booksCollections)
          .where(isNotNull(booksCollections.librettoRecipeId));
        const sourceByRecipe = new Map(
          mirrorRows.map((m) => [m.recipeId as string, m.source as string]),
        );
        const recipes = overview.recipes
          .map((r) => {
            const produced = collectionByRecipe.get(r.id);
            return recipeWire(r, deriveMediaType(sourceByRecipe.get(r.id), produced?.targetKind));
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
          pendingPrs: [] as { number: number; title: string; url: string }[],
        };
      });
    }),

  /**
   * Preview/validate a draft ref before save. Libretto resolves name + work count LIVE (the surviving
   * C-07); Kometa validates the ref SHAPE and previews the count only when it is knowable without egress
   * (an id-list length) — a URL/collection-id renders the honest "preview unavailable" note, never a proxy
   * workaround (DESIGN-042 Q-06, canary-first).
   */
  validate: authedProcedure.input(recipeDraftWithMedia).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(async () => {
      if (isKometaMedia(input.mediaType)) {
        const recipe = toKometaRecipe(input, input.mediaType);
        const p = previewKometaRef(recipe.builderType, recipe.builderRef);
        return { resolved: { name: p.note, workCount: p.resolvedCount }, issues: [] as string[] };
      }
      return validateWire(
        await previewRecipeRef({ libretto: resolveLibrettoBundle(ctx), draft: toLibrettoDraft(input) }),
      );
    });
  }),

  /**
   * DIRECT add/edit (D-03/D-07) — everyone, capped. Resolves the live membership size, reads the cap, and
   * the confined provider writer asserts it (admins bypass) BEFORE the write + same-tx audit. Libretto
   * writes instantly; Kometa compiles the managed include, opens a bot haynes-ops PR, and AUTO-MERGES the
   * safe case (within-cap, grouping-only, managed-file-only, CI green — D-10). An over-cap non-admin gets
   * `COLLECTION_SIZE_CAP_EXCEEDED` (the client opens the request-larger flow → requestOverride); a Kometa
   * ref whose size cannot be resolved without egress is treated as over-cap for a non-admin (safe default).
   */
  upsert: authedProcedure.input(recipeDraftWithMedia).mutation(async ({ ctx, input }) => {
    return mapDomainErrors(async () => {
      const cap = await getAppSetting(ctx.db, 'collection_size_cap');
      if (isKometaMedia(input.mediaType)) {
        const recipe = toKometaRecipe(input, input.mediaType);
        // previewKometaRef validates the ref shape + yields the egress-free count (null when unknowable).
        const preview = previewKometaRef(recipe.builderType, recipe.builderRef);
        const size = ctx.user.role.isAdmin ? 0 : preview.resolvedCount;
        const res = await upsertKometaCollection({
          db: ctx.db,
          haynesops: resolveHaynesopsBundle(ctx),
          actorId: ctx.user.id,
          recipe,
          size,
          cap,
          isAdmin: ctx.user.role.isAdmin,
        });
        return { ok: true as const, id: input.id, provider: 'kometa' as const, ...res };
      }
      const draft = toLibrettoDraft(input);
      const size = ctx.user.role.isAdmin ? 0 : await resolveDraftSize(ctx, draft);
      await upsertCollection({
        db: ctx.db,
        libretto: resolveLibrettoBundle(ctx),
        actorId: ctx.user.id,
        draft,
        size,
        cap,
        isAdmin: ctx.user.role.isAdmin,
      });
      return { ok: true as const, id: input.id, provider: 'libretto' as const };
    });
  }),

  /**
   * DESIGN-043 D-14 / DESIGN-042 D-06 (PLAN-052 PR4c) — flip the per-collection FIND-MISSING knob (the
   * acquisition lever). GRANT-GATED: `collectionActionProcedure('find_missing')` (admin implies it) — a
   * non-granted caller gets FORBIDDEN server-side even with a forged flag (never a client hide). Libretto
   * (books/audiobooks) sets `variables.acquisitionEnabled` via a direct API write (instant); Kometa
   * (movies/TV) recompiles the managed include and opens a HUMAN-merged haynes-ops PR (enabling acquisition
   * is one of the two non-auto-merge cases — D-10). Every write is audited same-tx (upsert_collection +
   * find_missing detail). When it opens a Kometa PR, the row shows the honest pending/awaiting-merge state.
   */
  setFindMissing: collectionActionProcedure('find_missing')
    .input(
      z.object({
        id: z.string().trim().min(1).max(80),
        mediaType: z.enum(COLLECTION_MEDIA_TYPES),
        on: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        if (isKometaMedia(input.mediaType)) {
          const res = await setKometaFindMissing({
            db: ctx.db,
            haynesops: resolveHaynesopsBundle(ctx),
            actorId: ctx.user.id,
            id: input.id,
            mediaType: input.mediaType,
            on: input.on,
          });
          return { ok: true as const, provider: 'kometa' as const, findMissing: input.on, ...res };
        }
        const res = await setCollectionFindMissing({
          db: ctx.db,
          libretto: resolveLibrettoBundle(ctx),
          actorId: ctx.user.id,
          id: input.id,
          on: input.on,
        });
        return { ok: true as const, provider: 'libretto' as const, findMissing: res.findMissing };
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

  /**
   * Delete a recipe (ADMIN only). Does NOT cascade by default (orphans the target); opt into
   * deleteCollection. Libretto deletes instantly; Kometa removes the recipe from the managed include via a
   * PR (managed-file-only + CI-green ⇒ auto-merged — D-10); the produced collection is orphaned either way.
   */
  remove: adminProcedure
    .input(
      z.object({
        id: z.string().trim().min(1).max(80),
        mediaType: z.enum(COLLECTION_MEDIA_TYPES),
        deleteCollection: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        if (isKometaMedia(input.mediaType)) {
          const res = await deleteKometaRecipe({
            db: ctx.db,
            haynesops: resolveHaynesopsBundle(ctx),
            actorId: ctx.user.id,
            id: input.id,
            mediaType: input.mediaType,
            deleteCollection: input.deleteCollection ?? false,
          });
          return { ok: true as const, provider: 'kometa' as const, ...res };
        }
        await deleteCollectionRecipe({
          db: ctx.db,
          libretto: resolveLibrettoBundle(ctx),
          actorId: ctx.user.id,
          id: input.id,
          deleteCollection: input.deleteCollection ?? false,
        });
        return { ok: true as const, provider: 'libretto' as const };
      });
    }),

  /**
   * Over-cap escalation (D-11): file a `collection_override` ticket CARRYING the full requested definition.
   * The server resolves the authoritative size (never trusting the client) and stamps the caller as author.
   * An admin's Approve materializes it unbounded.
   */
  requestOverride: authedProcedure
    .input(recipeDraftWithMedia)
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const { mediaType, ...draftInput } = input;
        const cap = await getAppSetting(ctx.db, 'collection_size_cap');
        // Resolve the authoritative size per provider (never trusting the client). A Kometa ref whose size
        // is not resolvable without egress records cap+1 (an honest "could not confirm within the limit").
        let size: number;
        if (isKometaMedia(mediaType)) {
          const recipe = toKometaRecipe(draftInput, mediaType);
          size = previewKometaRef(recipe.builderType, recipe.builderRef).resolvedCount ?? cap + 1;
        } else {
          size = await resolveDraftSize(ctx, toLibrettoDraft(draftInput));
        }
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
        // Resolve the haynes-ops bundle LAZILY: a Libretto (books/audiobooks) approval never needs it, so a
        // not-yet-provisioned HAYNESOPS_WRITE_TOKEN must not block those. A Kometa payload with no bundle
        // surfaces the honest "write path unavailable" from the domain (never a silent drop).
        let haynesops: ReturnType<typeof resolveHaynesopsBundle> | undefined;
        try {
          haynesops = resolveHaynesopsBundle(ctx);
        } catch {
          haynesops = undefined;
        }
        const res = await approveCollectionOverride({
          db: ctx.db,
          libretto: resolveLibrettoBundle(ctx),
          ...(haynesops ? { haynesops } : {}),
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
