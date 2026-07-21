// ADR-072 / DESIGN-043 (PLAN-052 PR4a — direct-add) — the collections router for the first-class
// /collections page. Everyone adds/edits within the size cap (no grant on the safe path — `authedProcedure`);
// admins bypass the cap and are the only deleters + ticket approvers (`adminProcedure`). Over-cap escalates
// to a `collection_override` ticket carrying the FULL requested definition (D-11), which an admin Approve
// materializes automatically. Books/Audiobooks bind Libretto (this PR); Movies/TV bind Kometa (the
// auto-merge write path — PR4b), reported as "not available yet" here so the shell + IA ship whole. ALL
// Libretto calls go through the confined @hnet/libretto client via the @hnet/domain orchestrators — NEVER a
// browser call. A Libretto outage degrades honestly (overview.reachable=false).
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  bookRequests,
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
  approveCollectionOverride,
  bookActionsForRole,
  createCollectionOverrideTicket,
  declineCollectionOverride,
  deleteCollectionRecipe,
  deleteKometaHandCollection,
  deleteKometaRecipe,
  editKometaHandCollection,
  forceSearchCollectionNow,
  getAppSetting,
  getCollectionRun,
  getCollectionsOverview,
  getKometaCollectionsOverview,
  KometaRecipeError,
  listCollectionOverrideTickets,
  previewCollectionMembers,
  previewKometaRef,
  previewRecipeRef,
  searchCollectionRefs,
  setAppSetting,
  setCollectionFindMissing,
  setKometaFindMissing,
  setKometaHandFindMissing,
  upsertCollection,
  upsertKometaCollection,
  type KometaHandCollectionView,
  type KometaMediaType,
  type KometaRecipe,
  type KometaRecipeView,
} from '@hnet/domain';
import type { TRPCContext } from '../trpc';
import type {
  LibrettoBuilderRef,
  LibrettoCollection,
  LibrettoIssue,
  LibrettoRecipe,
  LibrettoRun,
  LibrettoValidateResponse,
} from '@hnet/libretto';
import {
  mapDomainErrors,
  resolveArrBundle,
  resolveHaynesopsBundle,
  resolveLazyLibrarianBundle,
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

/**
 * A builder ref for the wire display: a scalar (string / numeric Hardcover id) shown as-is, an ARRAY
 * (static_ids / hardcover_comics) joined into the same comma-separated string the id-list builders already
 * use, and a `{ title, author }` entry shown by its title. Keeps `builderRef` a stable `string | null` for
 * the manager + edit form — an explicit display join, never a silent `String()` of an array.
 */
function builderRefToDisplay(ref: LibrettoBuilderRef | null | undefined): string | null {
  if (ref === null || ref === undefined) return null;
  if (!Array.isArray(ref)) return String(ref);
  const parts = ref
    .map((e) => (typeof e === 'object' && e !== null ? (e.title ?? '') : String(e)))
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts.join(', ') : null;
}

// Explicit wire shapes (the fixWire idiom) — the Libretto ACL uses zod passthrough, whose loose types do
// not survive tRPC inference cleanly; the manager gets a stable, typed contract instead.
function recipeWire(r: LibrettoRecipe, mediaType: CollectionMediaType, missingCount: number | null) {
  return {
    id: r.id,
    name: r.name ?? null,
    builderType: r.builder?.type ?? null,
    builderRef: builderRefToDisplay(r.builder?.ref),
    ordered: r.variables?.ordered ?? null,
    syncMode: r.variables?.syncMode ?? null,
    findMissing: r.variables?.acquisitionEnabled ?? false,
    enabled: r.enabled ?? true,
    mediaType,
    // The on-demand Force Search modal shows this: the collection's current missing-member (Wanted) count.
    // Null for a collection with no mirror row yet (nothing to count).
    missingCount,
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
    // Movies/TV have no app-side on-demand Force Search (Kometa's cron acquires) — so no missing count row.
    missingCount: null as number | null,
    state: r.state,
  };
}
/**
 * The Kometa HAND-collection wire (owner ruling 2026-07-18) — one of the estate's config-file collections
 * or a Defaults-produced mirror row. Carries its editability (a single allowlisted builder + valid ref),
 * its config `file` (the splice target; null for a Defaults-produced row), its builder + ref (for the
 * pre-loaded edit composer), its find-missing state, and its mirror item count.
 */
function handCollectionWire(h: KometaHandCollectionView) {
  return {
    name: h.name,
    file: h.file,
    source: h.source,
    builderType: h.builderType as string | null,
    builderRef: h.builderRef,
    findMissing: h.findMissing,
    editable: h.editable,
    editableReason: h.editableReason,
    itemCount: h.itemCount,
    mediaType: h.mediaType as CollectionMediaType,
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

/**
 * DESIGN-042 D-02 / DESIGN-043 D-02 amend (2026-07-18, owner-reported gap) — a READ-ONLY collection row: a
 * mirror collection that carries NO app-managed recipe, so the tab lists it honestly instead of claiming
 * "none yet". Kometa: a `created_by='kometa'` Plex collection the estate's own Kometa config built
 * (`managedBy: 'kometa_config'`). Libretto: a hand-made Kavita/ABS collection with `libretto_recipe_id IS
 * NULL` (`managedBy: 'hand_made'`; `source` picks the "made in ..." chip). No controls — the app does not
 * manage these; it only surfaces them.
 */
type ReadOnlyCollectionWire = {
  name: string;
  itemCount: number | null;
  managedBy: 'kometa_config' | 'hand_made';
  source: 'kavita' | 'audiobookshelf' | null;
};
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
        // ADR-076 C-01 / ADR-075 C-01 (PLAN-060) — the manager's Books/Audiobooks sub-tabs MERGED:
        // 'audiobooks' stays a tolerated wire value (old links, stored ticket payloads) but folds
        // into the one Books tab — its recipes list ONCE under Books.
        const mediaType = input.mediaType === 'audiobooks' ? 'books' : input.mediaType;
        const sizeCap = await getAppSetting(ctx.db, 'collection_size_cap');
        const actions = await resolveCollectionActions(ctx.db, ctx.user.role);
        // The books Force Search grant (force_search_book) gates the on-demand collection Force Search — the
        // SAME gate as the books detail. Ungranted ⇒ the client never renders the button; the mutation is
        // FORBIDDEN server-side regardless. Admin implies it (no query).
        const canForceSearch =
          ctx.user.role.isAdmin ||
          (await bookActionsForRole({ db: ctx.db, roleId: ctx.user.role.id })).includes(
            'force_search_book',
          );
        const base = {
          mediaType,
          sizeCap,
          capBypass: ctx.user.role.isAdmin,
          isAdmin: ctx.user.role.isAdmin,
          canFindMissing: actions.includes('find_missing'),
          canForceSearch,
        };
        if (isKometaMedia(mediaType)) {
          // Movies/TV — the Kometa write path (owner ruling 2026-07-18: EDIT the estate's collections, not
          // read-only). Reads the app-owned managed include + EVERY hand-authored config file + the
          // DESIGN-035 mirror + the open app PRs; degrades honestly (reachable=false) on a haynes-ops/GitHub
          // outage. The list is ONE population: app-managed recipes ("Added here") + the estate's hand-file
          // collections and Defaults-produced mirror rows ("Kometa config"), each source-badged.
          const overview = await getKometaCollectionsOverview({
            db: ctx.db,
            haynesops: resolveHaynesopsBundle(ctx),
            mediaType,
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
            readOnly: [] as ReadOnlyCollectionWire[],
            handCollections: overview.handCollections.map(handCollectionWire),
            pendingPrs: overview.pendingPrs,
          };
        }
        const overview = await getCollectionsOverview({ libretto: resolveLibrettoBundle(ctx) });
        const collectionByRecipe = new Map(
          overview.collections.filter((c) => c.recipeId).map((c) => [c.recipeId as string, c]),
        );
        // The mirror's recipe → source + local-id map (the D-13 exact join) — the media-type authority and
        // the key to a recipe's current missing-member (Wanted) count.
        const mirrorRows = await ctx.db
          .select({
            id: booksCollections.id,
            recipeId: booksCollections.librettoRecipeId,
            source: booksCollections.source,
          })
          .from(booksCollections)
          .where(isNotNull(booksCollections.librettoRecipeId));
        const sourceByRecipe = new Map(
          mirrorRows.map((m) => [m.recipeId as string, m.source as string]),
        );
        const collectionIdByRecipe = new Map(
          mirrorRows.map((m) => [m.recipeId as string, m.id]),
        );
        // The per-collection MISSING (origin='collection', still-unheld) want counts — the number the
        // on-demand Force Search modal shows. One grouped read, mapped back to each recipe via its mirror id.
        const wantCountRows = await ctx.db
          .select({ collectionId: bookRequests.collectionId, n: count() })
          .from(bookRequests)
          .where(
            and(eq(bookRequests.origin, 'collection'), isNull(bookRequests.matchedBooksItemId)),
          )
          .groupBy(bookRequests.collectionId);
        const missingByCollection = new Map(
          wantCountRows.map((r) => [r.collectionId as string, Number(r.n)]),
        );
        const missingForRecipe = (recipeId: string): number | null => {
          const cid = collectionIdByRecipe.get(recipeId);
          if (!cid) return null;
          return missingByCollection.get(cid) ?? 0;
        };
        // ADR-076 C-01 — the merged Books tab lists EVERY book-domain recipe once (both the
        // kavita- and audiobookshelf-produced ones; a future multi-target twin pair shares one
        // recipe id and therefore already lists once). The wire mediaType folds to 'books'.
        const recipes = overview.recipes
          .map((r) => {
            const produced = collectionByRecipe.get(r.id);
            const derived = deriveMediaType(sourceByRecipe.get(r.id), produced?.targetKind);
            return recipeWire(
              r,
              derived === 'audiobooks' ? 'books' : derived,
              missingForRecipe(r.id),
            );
          })
          .filter((r) => r.mediaType === mediaType);
        // The hand-made (no-recipe) mirror collections — read-only rows the app lists but does
        // not manage (both book servers land on the merged Books tab now). A
        // `libretto_recipe_id IS NULL` row has no Libretto recipe, so it was made in Kavita/ABS by hand.
        const handMadeRows = await ctx.db
          .select({
            title: booksCollections.title,
            itemCount: booksCollections.itemCount,
            source: booksCollections.source,
          })
          .from(booksCollections)
          .where(isNull(booksCollections.librettoRecipeId));
        const readOnly: ReadOnlyCollectionWire[] = handMadeRows.map((r) => ({
          name: r.title,
          itemCount: r.itemCount,
          managedBy: 'hand_made' as const,
          source: r.source as 'kavita' | 'audiobookshelf',
        }));
        return {
          ...base,
          provider: 'libretto' as const,
          available: true,
          reachable: overview.reachable,
          recipes,
          issues: overview.issues.map(issueWire),
          collections: overview.collections.map(collectionWire),
          readOnly,
          handCollections: [] as ReturnType<typeof handCollectionWire>[],
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
   * DESIGN-044 D-04 — the search-first ref typeahead. Books/Audiobooks proxy the confined @hnet/libretto
   * search; Movies/TV ride the confined @hnet/arr movie/series lookup (the ADR-055 confinement — never a
   * browser call to a provider). Everyone may search (the safe read path, no grant); a search outage
   * degrades to `reachable:false` so the field falls back to manual entry (D-04). The caller owns debounce.
   */
  search: authedProcedure
    .input(
      z.object({
        mediaType: z.enum(COLLECTION_MEDIA_TYPES),
        builderType: z.enum(COLLECTION_BUILDER_TYPES),
        q: z.string().trim().max(200),
        limit: z.number().int().min(1).max(25).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        searchCollectionRefs({
          libretto: resolveLibrettoBundle(ctx),
          arr: resolveArrBundle(ctx),
          builderType: input.builderType,
          q: input.q,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }),
      );
    }),

  /**
   * DESIGN-044 D-05/D-10 — the live member preview. Resolves a DRAFT builder's members and splits them
   * "In your library" vs "Missing" against the app's OWN mirrors (books_items / media_items), never asking a
   * provider. Books resolve through Libretto preview (ISBN match + the DESIGN-037 title fallback); Movies/TV
   * resolve id-lists + franchises through @hnet/arr; a URL-ref builder (or an outage) returns the honest
   * "preview unavailable" state. Read-only, mutates nothing, safe on every debounced ref change; NEVER a save
   * gate (the save re-resolves server-side under the real cap).
   */
  preview: authedProcedure
    .input(
      z.object({
        mediaType: z.enum(COLLECTION_MEDIA_TYPES),
        builderType: z.enum(COLLECTION_BUILDER_TYPES),
        ref: z.union([z.string().trim().max(400), z.array(z.string().trim().min(1).max(80)).max(200)]),
      }),
    )
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        previewCollectionMembers({
          db: ctx.db,
          libretto: resolveLibrettoBundle(ctx),
          arr: resolveArrBundle(ctx),
          mediaType: input.mediaType,
          builderType: input.builderType,
          ref: input.ref,
        }),
      );
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
   * EDIT a hand-authored Kometa collection (owner ruling 2026-07-18 — edit the estate's config, not
   * read-only). Everyone, capped: the confined writer SURGICALLY splices ONLY this collection's builder ref
   * in its own config file and opens a HUMAN-merged haynes-ops PR (hand-file PRs never auto-merge — D-10),
   * preserving every untouched byte. An over-cap non-admin gets `COLLECTION_SIZE_CAP_EXCEEDED` (the client
   * opens the request-larger flow); a ref whose size cannot be resolved without egress is treated as
   * over-cap for a non-admin (safe default). A too-custom collection / malformed ref rejects — never a lossy
   * rewrite. Movies/TV only (Kometa); Libretto collections edit through `upsert`.
   */
  editHandCollection: authedProcedure
    .input(
      z.object({
        mediaType: z.enum(['movies', 'tv']),
        file: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(200),
        builderType: z.enum(KOMETA_BUILDER_TYPES),
        builderRef: z.string().trim().min(1).max(400),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const cap = await getAppSetting(ctx.db, 'collection_size_cap');
        const preview = previewKometaRef(input.builderType, input.builderRef);
        const size = ctx.user.role.isAdmin ? 0 : preview.resolvedCount;
        const res = await editKometaHandCollection({
          db: ctx.db,
          haynesops: resolveHaynesopsBundle(ctx),
          actorId: ctx.user.id,
          file: input.file,
          name: input.name,
          mediaType: input.mediaType,
          builderType: input.builderType,
          builderRef: input.builderRef,
          size,
          cap,
          isAdmin: ctx.user.role.isAdmin,
        });
        return { ok: true as const, id: input.name, provider: 'kometa' as const, ...res };
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
        id: z.string().trim().min(1).max(200),
        mediaType: z.enum(COLLECTION_MEDIA_TYPES),
        on: z.boolean(),
        // A hand-authored Kometa collection carries its config file basename; find-missing then splices
        // that file (human-merged) instead of the app-owned managed include.
        handFile: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        if (isKometaMedia(input.mediaType)) {
          if (input.handFile) {
            const res = await setKometaHandFindMissing({
              db: ctx.db,
              haynesops: resolveHaynesopsBundle(ctx),
              actorId: ctx.user.id,
              file: input.handFile,
              name: input.id,
              mediaType: input.mediaType,
              on: input.on,
            });
            return { ok: true as const, provider: 'kometa' as const, findMissing: input.on, ...res };
          }
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

  /**
   * ADR-071 / DESIGN-043 D-02/D-07 amend (owner ruling 2026-07-18) — the ON-DEMAND collection FORCE SEARCH
   * that replaces the retired "Run now" on the Books/Audiobooks rows. One honest whole action composed in
   * order: (a) re-apply the recipe (fresh membership), (b) refresh the collection's missing-member wants (the
   * #394 mint), (c) force-search those resolved missing members NOW through the confined LazyLibrarian chain —
   * the SAME PR4c leg, run on demand (the 12h cooldown is bypassed; the per-call cap still bounds the fan-out).
   * GRANT-GATED by the books Force Search grant (`force_search_book`, the same gate as the books detail — admin
   * implies it); a forged call is FORBIDDEN server-side. Books/Audiobooks only — Movies/TV never expose this
   * (Kometa's own cron does acquisition). Single-writer + audit inside the domain. Returns the apply run id (to
   * poll counts) plus the mint/search tallies; `unreachable` when Libretto was down (nothing searched).
   */
  forceSearchCollection: authedProcedure
    .input(z.object({ recipeId: z.string().trim().min(1).max(80) }))
    .mutation(async ({ ctx, input }) => {
      const allowed =
        ctx.user.role.isAdmin ||
        (await bookActionsForRole({ db: ctx.db, roleId: ctx.user.role.id })).includes(
          'force_search_book',
        );
      if (!allowed) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to Force Search collections.',
        });
      }
      return mapDomainErrors(async () => {
        const report = await forceSearchCollectionNow({
          db: ctx.db,
          libretto: resolveLibrettoBundle(ctx),
          ll: resolveLazyLibrarianBundle(ctx),
          recipeId: input.recipeId,
          actorId: ctx.user.id,
        });
        return { ok: true as const, ...report };
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
        id: z.string().trim().min(1).max(200),
        mediaType: z.enum(COLLECTION_MEDIA_TYPES),
        deleteCollection: z.boolean().optional(),
        // A hand-authored Kometa collection carries its config file basename; delete then surgically
        // removes its block from that file (human-merged) instead of the app-owned managed include.
        handFile: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        if (isKometaMedia(input.mediaType)) {
          if (input.handFile) {
            const res = await deleteKometaHandCollection({
              db: ctx.db,
              haynesops: resolveHaynesopsBundle(ctx),
              actorId: ctx.user.id,
              file: input.handFile,
              name: input.id,
              mediaType: input.mediaType,
              deleteCollection: input.deleteCollection ?? false,
            });
            return { ok: true as const, provider: 'kometa' as const, ...res };
          }
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
