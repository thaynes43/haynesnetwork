// ADR-070 / DESIGN-043 (PLAN-052) — the ACL zod schemas for Libretto's JSON responses (the
// provider-parity contract nouns, DESIGN-037 D-02/D-10). Kept TOLERANT (passthrough + nullish) because
// several field shapes are UNVERIFIED in DESIGN-037 (ABS batch body, Kavita identifier exposure) and
// Libretto is a young app whose wire may add fields — the ACL parses defensively; the domain decides.
// The write REQUEST shapes (RecipeDraft) are validated tighter (they are OUR input, echoed back by
// Libretto's strictObject PUT — an unknown key is a 400 we surface, not something we tolerate).
import { z } from 'zod';

/**
 * A recipe's builder — the SOURCE the collection is built from (DESIGN-037 D-05). `ref` is a single string
 * for most builders (a Hardcover series id, an NYT list name) OR a string ARRAY for the multi-source grains
 * (`static_ids`, and `hardcover_comics` since thaynes43/libretto PR #11). The read ACL stays TOLERANT
 * (union + nullish): a schema throw here would sink the WHOLE recipe list (upstream schema drift), so we
 * parse both shapes and let the domain decide what a given consumer needs.
 */
export const librettoBuilderSchema = z
  .object({
    type: z.string(),
    ref: z.union([z.string(), z.array(z.string())]).nullish(),
  })
  .passthrough();

/** A recipe's tunable variables (DESIGN-037 D-02). `acquisitionEnabled` is the content-pull knob. */
export const librettoVariablesSchema = z
  .object({
    syncMode: z.string().nullish(),
    ordered: z.boolean().nullish(),
    acquisitionEnabled: z.boolean().nullish(),
    tag: z.string().nullish(),
    schedule: z.string().nullish(),
  })
  .passthrough();

/** A Libretto recipe (read shape — `GET /api/recipes` items + `GET /api/recipes/:id`). */
export const librettoRecipeSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    builder: librettoBuilderSchema.nullish(),
    targetLibrary: z.unknown().nullish(),
    variables: librettoVariablesSchema.nullish(),
    enabled: z.boolean().nullish(),
  })
  .passthrough();
export type LibrettoRecipe = z.infer<typeof librettoRecipeSchema>;

/** A single issue Libretto reports (invalid recipe FILE, or a validate finding). */
export const librettoIssueSchema = z
  .object({
    path: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).nullish(),
    message: z.string().nullish(),
    recipeId: z.string().nullish(),
  })
  .passthrough();
export type LibrettoIssue = z.infer<typeof librettoIssueSchema>;

/** `GET /api/recipes` → `{ recipes, issues }` (invalid recipe FILES surface in `issues[]`, never recipes[]). */
export const librettoRecipesResponseSchema = z
  .object({
    recipes: z.array(librettoRecipeSchema).nullish(),
    issues: z.array(librettoIssueSchema).nullish(),
  })
  .passthrough();
export type LibrettoRecipesResponse = z.infer<typeof librettoRecipesResponseSchema>;

/** The per-recipe run counts (DESIGN-037 D-02; matchedByTitle is the honesty flag, D-04). */
export const librettoCountsSchema = z
  .object({
    matched: z.number().nullish(),
    matchedByTitle: z.number().nullish(),
    written: z.number().nullish(),
    added: z.number().nullish(),
    removed: z.number().nullish(),
    missing: z.number().nullish(),
    acquired: z.number().nullish(),
  })
  .passthrough();
export type LibrettoCounts = z.infer<typeof librettoCountsSchema>;

/** A Libretto run (`GET /api/runs/:id`). `status: warn` is the NORMAL partial-library state (informational). */
export const librettoRunSchema = z
  .object({
    id: z.string(),
    scope: z.string().nullish(),
    trigger: z.string().nullish(),
    status: z.string().nullish(),
    startedAt: z.string().nullish(),
    finishedAt: z.string().nullish(),
    counts: librettoCountsSchema.nullish(),
    // Per-recipe counts when scope=all; a { recipeId → counts } map, tolerated as unknown.
    recipes: z.unknown().nullish(),
    log: z.string().nullish(),
  })
  .passthrough();
export type LibrettoRun = z.infer<typeof librettoRunSchema>;

/** `POST /api/apply {scope}` → 202 `{ runId }`. */
export const librettoApplyResponseSchema = z.object({ runId: z.string() }).passthrough();

/** A produced collection (`GET /api/collections`). Read-back from the targets, tolerant. */
export const librettoCollectionSchema = z
  .object({
    recipeId: z.string().nullish(),
    targetCollectionId: z.union([z.string(), z.number()]).nullish(),
    targetKind: z.string().nullish(),
    name: z.string().nullish(),
    itemCount: z.number().nullish(),
  })
  .passthrough();
export type LibrettoCollection = z.infer<typeof librettoCollectionSchema>;

export const librettoCollectionsResponseSchema = z
  .object({ collections: z.array(librettoCollectionSchema).nullish() })
  .passthrough();

/**
 * One MISSING member's identity (`GET /api/collections/:recipeId/missing`) — a book a recipe wants but the
 * target library does not hold. Carries enough identity (title/author/ISBN/identifier refs) to mint one
 * `book_requests` row per missing book. Tolerant (Libretto is young): the domain decides what it needs.
 */
export const librettoMissingMemberSchema = z
  .object({
    /** The builder's human handle ("Wind and Truth (#5 in The Stormlight Archive)"). */
    label: z.string().nullish(),
    title: z.string().nullish(),
    authors: z.array(z.string()).nullish(),
    /** Primary ISBN-13, when known (Kavita epubs are null by design). */
    isbn: z.string().nullish(),
    /** All normalized identifier refs ("isbn:<13>", "asin:<10>", opaque) — the acquisition "ll ref" set. */
    identifiers: z.array(z.string()).nullish(),
  })
  .passthrough();
export type LibrettoMissingMember = z.infer<typeof librettoMissingMemberSchema>;

/** `GET /api/collections/:recipeId/missing` → the recipe's missing member identities + held/missing counts. */
export const librettoMissingResponseSchema = z
  .object({
    recipeId: z.string().nullish(),
    server: z.string().nullish(),
    libraryId: z.string().nullish(),
    name: z.string().nullish(),
    total: z.number().nullish(),
    heldCount: z.number().nullish(),
    missingCount: z.number().nullish(),
    missing: z.array(librettoMissingMemberSchema).nullish(),
  })
  .passthrough();
export type LibrettoMissingResponse = z.infer<typeof librettoMissingResponseSchema>;

/**
 * `POST /api/resolve` → the ISBN-first resolve broker result (the M3 direction-a service). Resolves an
 * ISBN|title+author to a Google-Books volume id (the LazyLibrarian addBook key). `resolved: null` is an
 * HONEST no-match (a 200, not an error); the domain treats it as "un-resolvable this run".
 */
export const librettoResolveResponseSchema = z
  .object({
    resolved: z
      .object({
        volumeId: z.string(),
        isbn13: z.string().nullish(),
        via: z.string().nullish(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
export type LibrettoResolveResponse = z.infer<typeof librettoResolveResponseSchema>;
export type LibrettoResolved = NonNullable<LibrettoResolveResponse['resolved']>;

/**
 * `POST /api/validate` → the preview/validate result: `issues[]` plus an OPTIONAL resolution the composer
 * shows before save (resolved name + work count). DESIGN-037 has no dedicated resolve endpoint (ADR-070
 * C-07) — validate is the honest preview; when Libretto resolves the ref it echoes `resolved`, otherwise
 * the UI says so. Tolerant: a bare `{ issues }` (no resolution) is valid.
 */
export const librettoValidateResponseSchema = z
  .object({
    ok: z.boolean().nullish(),
    issues: z.array(librettoIssueSchema).nullish(),
    resolved: z
      .object({
        name: z.string().nullish(),
        workCount: z.number().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type LibrettoValidateResponse = z.infer<typeof librettoValidateResponseSchema>;

/**
 * One typeahead search hit (`GET /api/search`) — the ref a user can paste straight into a builder,
 * a human name, and (when the source exposes them) an approximate member count + primary author. The
 * builder page's ref field renders these so a user finds a series/list by NAME, never a slug.
 */
export const librettoSearchResultSchema = z
  .object({
    /** The value to place in `builder.ref` (a Hardcover series id, an NYT list_name_encoded). */
    ref: z.string(),
    name: z.string().nullish(),
    /** Approximate member count when the source exposes one (Hardcover primary_books_count). */
    workCount: z.number().nullish(),
    author: z.string().nullish(),
  })
  .passthrough();
export type LibrettoSearchResult = z.infer<typeof librettoSearchResultSchema>;

/** `GET /api/search?type=&q=&limit=` → bounded typeahead hits + an honest `truncated` flag. */
export const librettoSearchResponseSchema = z
  .object({
    type: z.string().nullish(),
    query: z.string().nullish(),
    results: z.array(librettoSearchResultSchema).nullish(),
    /** True when the source had more matches than were returned (cap hit). */
    truncated: z.boolean().nullish(),
  })
  .passthrough();
export type LibrettoSearchResponse = z.infer<typeof librettoSearchResponseSchema>;

/**
 * One resolved member of a DRAFT builder (`POST /api/preview`) — the full membership a run WOULD
 * produce (not just the missing ones), so the app can split held vs missing against its own mirrors
 * before save. `author` is the primary author; `position` is the series position / list rank when the
 * source is ordered. Tolerant (Libretto is young): the domain decides what it consumes.
 */
export const librettoPreviewMemberSchema = z
  .object({
    /** The builder's human handle ("Wind and Truth (#5 in The Stormlight Archive)"). */
    label: z.string().nullish(),
    title: z.string().nullish(),
    author: z.string().nullish(),
    /** Primary ISBN-13, when known (Kavita epubs are null by design). */
    isbn: z.string().nullish(),
    /** Series position / list rank, when the source is ordered. */
    position: z.number().nullish(),
    /** All normalized identifier refs ("isbn:<13>", "asin:<10>", opaque) — the app's held-match keys. */
    identifiers: z.array(z.string()).nullish(),
  })
  .passthrough();
export type LibrettoPreviewMember = z.infer<typeof librettoPreviewMemberSchema>;

/**
 * `POST /api/preview` → the resolved member list for a draft builder + a `total` and an honest
 * `truncated` flag (Libretto caps the list at 100; the app applies the per-user size cap on top). A
 * 0-member container slug comes back `total: 0` honestly — the UI surfaces it, never fabricates.
 */
export const librettoPreviewResponseSchema = z
  .object({
    builder: librettoBuilderSchema.nullish(),
    total: z.number().nullish(),
    truncated: z.boolean().nullish(),
    members: z.array(librettoPreviewMemberSchema).nullish(),
  })
  .passthrough();
export type LibrettoPreviewResponse = z.infer<typeof librettoPreviewResponseSchema>;

/** `GET /api/health` — liveness (D-14). Tolerant: any 2xx body means reachable. */
export const librettoHealthResponseSchema = z
  .object({ status: z.string().nullish() })
  .passthrough();

// ---------------------------------------------------------------------------
// WRITE request shapes — OUR input to PUT /api/recipes/:id (echoed by Libretto's strictObject; an
// unknown key comes back as a 400 we surface). Validated tighter than the read ACL on purpose.
// ---------------------------------------------------------------------------

export const librettoRecipeDraftSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  // `ref` mirrors the read builder: a single string, or the multi-source array (static_ids / hardcover_comics)
  // so a recipe READ back (recipeToDraft — the find-missing toggle / edit round-trip) can be re-PUT unchanged.
  builder: z.object({
    type: z.string().min(1),
    ref: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  }),
  targetLibrary: z.unknown().optional(),
  variables: z
    .object({
      syncMode: z.enum(['append', 'sync']).optional(),
      ordered: z.boolean().optional(),
      acquisitionEnabled: z.boolean().optional(),
      tag: z.string().optional(),
      schedule: z.string().optional(),
    })
    .optional(),
  enabled: z.boolean().optional(),
});
export type LibrettoRecipeDraft = z.infer<typeof librettoRecipeDraftSchema>;
