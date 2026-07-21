# 2026-07-21 — Libretto `builder.ref` schema drift silently killed the MAM demand injector

Branch `fix/libretto-ref-array`. The `@hnet/libretto` READ ACL required a recipe's `builder.ref` to be a
single string, but Libretto's comics grain (thaynes43/libretto PR #11, `hardcover_comics`) emits
`builder.ref` as a string ARRAY. The zod parse of `GET /api/recipes` therefore threw on the WHOLE recipe
list, and because the throw is not a `LibrettoUnreachableError` it was NOT classified as the "skip this
pass" degrade — so the hourly `collection-force-search` leg inside `books-collections-sync` aborted every
run. That leg is the app-side complement to Libretto's own acquisition: it is what force-searches a
find-missing collection's still-missing wants through the confined LazyLibrarian chain, i.e. the app-side
MAM demand injector. It has been dead since the comics recipes landed.

## The failure signature (read-only cluster evidence)

Newest `sync-books-collections` job at time of diagnosis (`…-29743707`, ns `frontend`, run 08:27 UTC):

```
08:28:01.908  collection-wants complete   collectionsProcessed:46 minted:0 removed:0 resolved:25 unreachable:false
08:28:01.930  collection-force-search pass failed
              error: Libretto GET /api/recipes → response failed shape validation (upstream schema drift?):
                     recipes.15.builder.ref: Invalid input: expected string, received array;
                     recipes.30.builder.ref: Invalid input: expected string, received array
08:28:01.930  sync finished  mode:books-collections-sync  totalFailure:false
```

Two live recipes (indices 15 and 30 — the `hardcover_comics` ones) carry an array `ref`. Note the shape:
the mirror upsert and the `collection-wants` pass BOTH complete fine (they never call `listRecipes`); only
the force-search leg calls `listRecipes` and dies on the parse. The job exits 0 (`totalFailure:false`), so
nothing pages — the leg fails silently inside an otherwise-green run. The drift is deterministic: every
parse of a recipe list containing an array ref fails identically, so every hourly run since PR #11's comics
recipes landed aborted the same way. The morning watch put the dead window at roughly 14h; the exact
first-failing run can't be pinned from the cluster (older job pods are GC'd), but the 08:27 run is the
confirmed signature and the mechanism is deterministic.

## Root cause (code-proven)

`packages/libretto/src/schemas.ts` `librettoBuilderSchema` (the READ ACL) had `ref: z.string().nullish()`.
An array value is neither string, null, nor undefined, so `.parse` rejects it. `LibrettoReadClient.listRecipes`
(`read.ts`) parses the response through this schema; the rejection surfaces as the "response failed shape
validation" error above. In `forceSearchFindMissingCollections` (`collection-force-search.ts:229-242`) that
error is NOT a `LibrettoUnreachableError`, so the `instanceof` degrade at line 234 is skipped and the error
re-throws at line 241 — the orchestrator catches it and logs "collection-force-search pass failed", skipping
the whole leg.

The bitter part: that consumer never USES `builder.ref`. It filters recipes by `variables.acquisitionEnabled`
and reads `id` only (lines 229-231). The array ref is irrelevant to what the pass does — the abort is purely
a parse rejection of a field the pass ignores. The WRITE ACL (`librettoRecipeDraftSchema`, ~line 264) carried
the same string-only assumption; latent, but it would reject a comics recipe round-tripped by
`collections-manager.ts` `recipeToDraft` (the find-missing toggle / edit re-PUT).

## The fix (minimal, honest)

1. **Read ACL** (`schemas.ts` `librettoBuilderSchema`): `ref: z.union([z.string(), z.array(z.string())]).nullish()`
   — kept TOLERANT (union + nullish) in the read ACL's local style. This alone unblocks the force-search leg.
2. **Write ACL** (`schemas.ts` `librettoRecipeDraftSchema`): `ref: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])`
   — kept TIGHT (min-1) in the write draft's local style, so a comics recipe read back can be re-PUT unchanged.
3. **tRPC wire** (`packages/api/src/routers/collections.ts` `recipeWire`): an array `ref` is comma-joined to the
   same `string | null` display string the id-list builders already emit (`'9741, 358'`), keeping the UI
   contract unchanged (no UI diff). This is an explicit display join, not a silent coercion.

Consumers audited across `packages/libretto`, `packages/domain`, `packages/sync`, `apps/web`: the
builder-page preview path (`collection-builder.ts`) was already array-aware (`Array.isArray(input.ref)` at the
id-list and franchise previews); `recipeToDraft` passes the ref through unchanged (now type-compatible); the
`upsert_collection` audit stores the ref into a jsonb detail (an array is honest there); the search-result
`ref` is a distinct always-string shape. No `String()` coercion of an array anywhere on the product path.

## Tests

`packages/libretto/__tests__/client.test.ts` gains two regressions: (a) `listRecipes` parsing a recipe list
that MIXES string refs and `hardcover_comics` array refs (mirroring the live shape) — asserts the whole list
parses, the array survives as an array (no coercion), and the `acquisitionEnabled` filter the cron uses stays
readable across both shapes; (b) `upsertRecipe` round-tripping a comics recipe whose `builder.ref` is an array
— asserts the PUT body carries the array unchanged. Full suite green
(`pnpm typecheck && pnpm lint && pnpm test && pnpm build`): libretto 19, domain 778, api 524, web 378, sync
125, auth 70, db 107.

## Impact / the unblock

Once deployed (the cron runs the app image, so the fix only matters live), the hourly `collection-force-search`
leg parses all recipes — including the two comics array-ref ones — and resumes force-searching its
off-cooldown wants (25/run cap, 12h cooldown) through the confined LazyLibrarian chain. That restarts app-side
MAM demand injection. This fix is the unblock cited by the morning-watch verdict
(`2026-07-21-morning-watch-gb-mam.md`) to HOLD the MAM governor de-escalation: the currently-low unsatisfied
count (107 vs gate 185) is artificially low precisely because this injector has been dead.

Did NOT touch Libretto: it is headless-by-design and correct to emit array refs for the comics grain
(Kometa-for-books, generic). This is purely the app-side client ACL catching up to PR #11 — app-specific
concerns stay app-side, per the suite-repo doctrine.
