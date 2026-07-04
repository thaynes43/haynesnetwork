# @hnet/api

The tRPC v11 surface for haynesnetwork. One `appRouter` (`src/routers/index.ts`),
mounted in `apps/web` at `/api/trpc/[trpc]`. Design of record: `docs/designs/003-trpc-surface.md`
(Phase 1: catalog/users/tags/profile) and `docs/designs/005-*.md` D-17 (Phase 2:
ledger/fix/restore). ADR-004 chose tRPC v11; ADR-003 mandates the transactional
audit co-writes.

Exports raw TS — no build step (see root `CLAUDE.md`). Consumed by `apps/web` (route
handler + React Query client) and by integration tests via `createCallerFactory`.

## Shape

- **Single `appRouter`.** Seven routers are mounted: `catalog`, `users`, `tags`,
  `ledger`, `fix`, `restore`, `profile` (`src/routers/index.ts`). `plex` is a RESERVED
  name for Phase 3 — do not repurpose it.
- **Procedure ladder** (`src/trpc.ts` + `src/middleware/role.ts`), fail-closed:
  - `publicProcedure` — no auth.
  - `authedProcedure` — throws `UNAUTHORIZED` if `ctx.user` is null, then narrows
    `ctx.user` to non-null for the resolver.
  - `adminProcedure` — composes on `authedProcedure`; throws `FORBIDDEN` unless
    `ctx.user.role === 'Admin'`. Roles are capitalized (`Member` / `Admin`).

  A few `authedProcedure` resolvers self-scope by role in the body rather than at the
  ladder (e.g. `tags.list`: Admin sees all tags + bundles + counts, Member sees only
  their own applied tags projected to `{id,name,description}`). That is deliberate —
  see DESIGN-003 D-12.
- **Context** (`createTRPCContext`) reads the Better Auth session from request headers
  via `@hnet/auth`'s `getServerSession` and hydrates `user: { id, email, displayName,
  role, isFamily }` where `isFamily` is the EFFECTIVE flag (direct OR any applied
  family tag). An unknown/missing role coerces the whole `user` to `null` (fail closed).
  `ctx.arr` is the optional *arr client bundle: absent in production (built lazily from
  env by `resolveArrBundle`), injected fetch-stubbed by tests (no live-API tests in CI,
  ADR-010).

## Adding a procedure

1. Put it in the right router file under `src/routers/`. Pick the rung:
   `authedProcedure` for any signed-in caller, `adminProcedure` for admin-only. Never
   use `publicProcedure` for anything that reads user data.
2. Validate input with a zod v4 schema. Reuse the shared fragments in `src/schemas.ts`
   (`catalogUrlSchema`, `CatalogEntryInput`, `CatalogEntryPatchInput`, `TagBundleInput`)
   where they fit rather than re-declaring shapes.
3. **Never write guarded permission/ledger state with raw drizzle in a resolver.** All
   mutations delegate to a single-writer helper in `@hnet/domain`, which performs the
   state change and its `permission_audit` / ledger row in the SAME transaction
   (ADR-003, hard rule 6). Direct drizzle writes to guarded tables outside
   `packages/domain` trip `no-direct-state-writes.test.ts`. Idempotent no-ops write no
   audit row and return `{ changed: false }` (DESIGN-003 D-11). Reads may query drizzle
   directly.
4. Wrap the domain call in `mapDomainErrors(async () => { ... })` so typed domain errors
   become the right `TRPCError` code (see below). Resolver-level `NOT_FOUND` /
   `UNAUTHORIZED` / `FORBIDDEN` are thrown directly, donor-style.
5. **No wire transformer** (DESIGN-003 D-03). Resolvers MUST return plain JSON-safe
   shapes — call `.toISOString()` on every `Date` field yourself before returning it. A
   raw `Date` leaking into a response is a bug. The ledger/fix/restore routers keep local
   `iso` / `isoOrNull` helpers for this; reuse that pattern.
6. **Pagination.** Phase 1 lists are unpaginated (household scale). The ledger/fix lists
   ARE paginated because the ledger is ~17k rows (the documented D-17 deviation from
   D-03). Use the opaque keyset cursors in `src/cursor.ts` (`encodeCursor` /
   `decodeCursor`). The cursor tuple MUST include a unique tiebreaker as its last
   element — every keyset `ORDER BY` is `(sortKey, id)` and the `WHERE` compares the
   full tuple `(col, id) > (:sortKey, :id::uuid)` — otherwise rows sharing a sort key are
   silently skipped or repeated across pages. `decodeCursor` rejects a
   malformed/tampered cursor with `BAD_REQUEST` (a cursor is untrusted client input).
7. **Client invalidation.** Any mutation that changes data a query reads obliges the
   caller to invalidate the affected React Query keys on success — the server does not
   push. Resolvers return enough of the mutated shape for the client to reconcile, but
   list/detail refreshes come from client-side invalidation.

## Adding a coded domain error (the appCode)

A domain error surfaces to the client as a stable machine-readable `data.appCode`
string (clients switch on it, never on the message). Adding one is a FOUR-place
coordinated edit. The first two live in `src/trpc.ts` and are INDEPENDENT — nothing
keeps them in sync, so it is easy to update one and forget the other:

1. **`APP_CODED_ERRORS`** (`src/trpc.ts`) — add the error class. ONLY the
   `errorFormatter` iterates this list to attach `data.appCode = cause.code`. An error
   missing from this list still maps to a TRPC code (step 2) but ships NO `appCode`.
2. **`mapDomainErrors`** (`src/trpc.ts`) — add an `instanceof` arm choosing the TRPC
   code (e.g. `CONFLICT`, `UNPROCESSABLE_CONTENT`, `TOO_MANY_REQUESTS`,
   `PRECONDITION_FAILED`, `BAD_GATEWAY`) and re-throwing with `cause: err` so the
   formatter can find it. This is a hand-written chain, not derived from
   `APP_CODED_ERRORS` — it also carries `NotFoundError` (which has no `appCode`). Keep
   the two lists in step by hand.
3. **DESIGN-003 D-13 table** (`docs/designs/003-trpc-surface.md`) — add the
   `domain error | appCode | TRPC code | thrown by` row.
4. **DESIGN-005 D-17 error-taxonomy table** (`docs/designs/005-*.md`, "Error taxonomy
   additions") — add the same row for any Phase 2 (ledger/fix/restore) error.

The error class itself and its `code` field live in `@hnet/domain`
(`packages/domain/src/errors.ts`); `@hnet/api` only translates it. The error-mapping
integration tests assert each `appCode` surfaces through the formatter — add a case
there too.
