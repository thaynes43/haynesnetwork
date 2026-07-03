# DESIGN-003: tRPC surface for Phase 1

- **Status:** Accepted
- **Last updated:** 2026-07-03
- **Satisfies:** PRD-001 R-04, R-10, R-11, R-13, R-14, R-15, R-20, R-21, R-22 (and serves R-01..R-03 session context to the UI); governed by ADR-003 (transactional permission-audit co-writes), ADR-004 (API layer: tRPC v11) — both drafted in parallel, referenced by number.
- **Companions:** DESIGN-001 (database schema — table shapes and the `permission_audit` action enum are normative there); DESIGN-002 (auth/session wiring); DESIGN-004 (UI shell and dashboard) is the consumer of this surface.

## Overview

Phase 1 exposes a single tRPC v11 router from `packages/api`, mounted in `apps/web` at
`/api/trpc/[trpc]` (Next.js App Router route handler), mirroring the todos-for-dues
donor (`../todos-for-dues/packages/api/src/`): a context factory that reads the Better
Auth session, a small procedure ladder (`publicProcedure → authedProcedure →
adminProcedure`), feature routers, typed domain errors surfaced through an
`errorFormatter` that attaches a machine-readable `appCode`, and **all
permission-touching mutations delegating to `packages/domain` helpers that co-write
`permission_audit` rows in the same transaction** (ADR-003, PRD R-04).

Phase 1 routers: `profile`, `catalog`, `users`, `tags`. The reserved Phase 2 names
`ledger` and `fix` were claimed by DESIGN-005 D-17 (which also claimed `restore` as the
third Phase 2 router — recorded here per its note); `plex` (Phase 3) remains
**reserved**. This document designs only the Phase 1 surface.

## Detailed design

### D-01 — Context

`createTRPCContext` reads the Better Auth session from request headers and derives a
single nullable `user` object. Role and family designation are Better Auth additional
user fields hydrated by the auth package (DESIGN-002; this doc consumes its output
shape only). `isFamily` is the **effective** family flag — direct `users.is_family` OR
any applied tag with `tags.is_family` (DESIGN-001 D-11) — so the UI never re-derives it.

```ts
// packages/api/src/trpc.ts
export type Role = 'Member' | 'Admin';          // PRD Actors table; Family is a
                                                // designation flag, NOT a role.
export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  isFamily: boolean;
}

export interface TRPCContext {
  db: typeof db;                                 // @app/db drizzle instance
  user: AuthedUser | null;                       // null ⇢ no/invalid session
}

export const createTRPCContext = async ({ req }: { req: Request }): Promise<TRPCContext> => {
  const session = await auth.api.getSession({ headers: req.headers });
  return { db, user: session ? toAuthedUser(session.user) : null };
};
```

Unknown/missing `role` values coerce to `null` user (fail closed), same as the donor's
`isRole()` guard.

### D-02 — Procedure ladder

Exactly three rungs in Phase 1 (donor: `trpc.ts` + `middleware/role.ts`):

```ts
export const publicProcedure = t.procedure;

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, user: ctx.user } });   // narrowed non-null
});

// packages/api/src/middleware/role.ts
export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'Admin') throw new TRPCError({ code: 'FORBIDDEN' });
  return next();
});
```

No `moderatorProcedure`/`privilegedProcedure` equivalents — haynesnetwork has two roles.
Zod input schemas provide the second line of defense (e.g. no self-elevation shapes
exist at all: Phase 1 has **no role-mutation procedure**; Admin comes only from the
`BOOTSTRAP_ADMIN_EMAILS` first-login bootstrap, R-02 — see Q-01).

### D-03 — Transport conventions (mirroring the donor)

- tRPC v11, `httpBatchLink`, React Query on the client; `createCallerFactory` for
  server-component prefetch and integration tests.
- **No wire transformer** (donor has none): procedures return plain-JSON-safe shapes;
  timestamps are emitted as ISO-8601 strings explicitly, never raw `Date` fields.
- No pagination in Phase 1 lists (household scale: tens of users, tens of catalog
  entries). Revisit only if a list demonstrably grows.

### D-04 — Catalog URL validation (R-14, AC-04)

User-facing links must be `https://<sub>.haynesnetwork.com[/path]` and nothing else.
`*.haynesops.com` (LAN-only Traefik ingresses, CLAUDE.md hard rule 3) is rejected — as
is every other host, `http:`, the bare apex, ports, credentials, and IP literals.
Enforced at three layers; the first two live here (the third is the
`app_catalog_url_haynesnetwork_only` CHECK constraint, DESIGN-001 D-05):

1. **Edge (zod v4)** — rejects before any logic runs:

```ts
/** R-14: only https://<sub>.haynesnetwork.com[/path?query] survives. */
export const catalogUrlSchema = z
  .url({
    protocol: /^https$/,
    hostname: /^([a-z0-9-]+\.)+haynesnetwork\.com$/i,   // ≥1 subdomain label
  })
  .refine((raw) => {
    const u = new URL(raw);
    return u.port === '' && u.username === '' && u.password === '';
  }, { error: 'Catalog URLs must be https://<sub>.haynesnetwork.com — no ports, no credentials, and never *.haynesops.com' });
```

2. **Domain (defense in depth)** — `packages/domain` re-asserts the same predicate
   (`assertUserFacingUrl`) inside `createCatalogEntry`/`updateCatalogEntry`, throwing
   `ForbiddenHostError`, so a future non-tRPC caller (seed script, admin CLI) cannot
   bypass the rule. The seed data for R-12/R-13 flows through the same helper.

### D-05 — Effective apps: one domain helper, provenance optional

The union rule (R-22, AC-06) is defined once — the `effective_app_grants` SQL view with
its typed wrapper in `packages/domain` (DESIGN-001 D-11); this API only projects it:

```
effective(user) = defaultVisible entries (app_catalog)
                ∪ direct grants (user_app_grants)
                ∪ tag grants (user_tags → tag_app_grants)
ordered by sort_order, name
```

One wrapper serves both call sites:

- `catalog.myApps` → provenance-free projection (dashboard tiles; DESIGN-004 §D-07).
- Admin views recompute provenance client-side from `users.list` + `catalog.adminList`
  + `tags.list` (all admin data is already in hand; no extra endpoint — see D-09).

Tags grant **by reference, not by copy**: applying a tag creates only a
`user↔tag` association; effective permissions are computed at read time. Removing the
tag therefore removes exactly the tag-derived permissions (AC-06), and editing a tag's
bundle instantly changes every tagged user's effective set (R-21) — which is why tag
bundle edits are audited (D-08).

### D-06 — Router tree (TypeScript-ish sketch, zod v4)

File layout mirrors the donor:

```
packages/api/src/
  trpc.ts               context, ladder, errorFormatter, mapDomainErrors
  middleware/role.ts    adminProcedure
  routers/
    index.ts            appRouter
    profile.ts  catalog.ts  users.ts  tags.ts
```

```ts
// ---------- shared input fragments ----------
const TagBundleInput = z.object({
  appIds: z.array(z.uuid()).default([]),        // → tag_app_grants (DESIGN-001 D-08)
  isFamily: z.boolean().default(false),         // → tags.is_family (R-20 family designation)
  // allowedPlexLibraries: RESERVED for Phase 3 (R-20/R-26/R-27) — do not add ad hoc.
});

const CatalogEntryInput = z.object({
  slug: z.string().trim().regex(/^[a-z0-9-]+$/).min(1).max(48), // stable machine key (DESIGN-001 D-05)
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(280).default(''),
  icon: z.enum(ICON_KEYS).nullable().default(null), // code-shipped icon registry key, D-10
  url: catalogUrlSchema,                            // D-04, R-14
  defaultVisible: z.boolean().default(false),       // R-12 seeds true; R-13 seeds false
});

// ---------- profile ----------
export const profileRouter = router({
  /** Session identity for chrome (topbar name, admin link, family badge).
   *  Deliberately does NOT include the app list — the dashboard uses
   *  catalog.myApps so tile data has exactly one source. */
  me: authedProcedure.query(({ ctx }) => ctx.user), // { id, email, displayName, role, isFamily }
});

// ---------- catalog ----------
export const catalogRouter = router({
  /** R-10: effective visible apps for the caller, ordered by sort_order, name
   *  (DESIGN-001 D-05). Provenance-free: { id, slug, name, description, icon, url }[]. */
  myApps: authedProcedure.query(({ ctx }) => effectiveAppsFor(ctx.user.id)),

  /** R-11: every entry incl. hidden ones + defaultVisible + sortOrder. */
  adminList: adminProcedure.query(/* full rows, ordered by sortOrder, name */),

  create: adminProcedure
    .input(CatalogEntryInput)
    .mutation(/* domain.createCatalogEntry — audits 'create_app' (D-07/D-08) */),

  update: adminProcedure
    // slug omitted: it is the stable machine key (DESIGN-001 D-05) referenced by
    // audit detail snapshots — immutable after create.
    .input(CatalogEntryInput.omit({ slug: true }).partial().extend({ id: z.uuid() }))
    .mutation(/* domain.updateCatalogEntry — audits 'update_app' with before/after
                 detail (defaultVisible flips are permission-affecting, D-08) */),

  delete: adminProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(/* domain.deleteCatalogEntry — audits 'delete_app'; dependent grants
                 cascade (DESIGN-001 D-06) in the SAME transaction (ADR-003) */),

  /** Total reordering: client sends the complete id set in the new order; server
   *  reassigns sort_order in gaps of 10 (10, 20, …) matching the seed convention
   *  (DESIGN-001). A stale/partial set → ReorderMismatchError (CONFLICT) rather
   *  than silently interleaving. Audited — see D-08. */
  reorder: adminProcedure
    .input(z.object({ orderedIds: z.array(z.uuid()).min(1) }))
    .mutation(/* domain.reorderCatalog */),
});

// ---------- users ----------
export const usersRouter = router({
  /** R-15/R-22 admin roster: id, displayName, email, role, isFamily, createdAt,
   *  tags: {id,name}[], directGrants: {appId}[]. Feeds /admin and
   *  /admin/users/[id] (no getById — D-09). */
  list: adminProcedure.query(/* ... */),

  /** DIRECT family designation (Actors table; feeds R-26 in Phase 3; effective
   *  family also flows from tags — DESIGN-001 D-11). Idempotent (D-11). */
  setFamily: adminProcedure
    .input(z.object({ userId: z.uuid(), isFamily: z.boolean() }))
    .mutation(/* domain.setFamilyDesignation — audits 'set_family'/'unset_family' */),

  /** R-15 direct per-user app grant/revoke. Idempotent (D-11). */
  grantApp: adminProcedure
    .input(z.object({ userId: z.uuid(), appId: z.uuid() }))
    .mutation(/* domain.grantApp — audits 'grant_app' */),
  revokeApp: adminProcedure
    .input(z.object({ userId: z.uuid(), appId: z.uuid() }))
    .mutation(/* domain.revokeApp — audits 'revoke_app' */),
});

// ---------- tags ----------
export const tagsRouter = router({
  /** D-12: authed, role-scoped (the one non-admin tags procedure). */
  list: authedProcedure.query(/* Admin → all tags + bundles + tagged-user counts;
                                 Member → own applied tags {id,name,description} only */),

  create: adminProcedure
    .input(z.object({
      name: z.string().trim().min(1).max(48),
      description: z.string().trim().max(280).default(''),
      bundle: TagBundleInput,
    }))
    .mutation(/* domain.createTag — audits 'create_tag'; TAG_NAME_CONFLICT on dup name */),

  update: adminProcedure
    .input(z.object({
      id: z.uuid(),
      name: z.string().trim().min(1).max(48).optional(),
      description: z.string().trim().max(280).optional(),
      bundle: TagBundleInput.optional(),        // replace-whole-bundle semantics
    }))
    .mutation(/* domain.updateTag — audits 'update_tag' with the bundle delta in
                 permission_audit.detail (DESIGN-001 D-08, R-21) */),

  delete: adminProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(/* domain.deleteTag — audits 'delete_tag'; user_tags/tag_app_grants
                 rows cascade (DESIGN-001 D-07..D-09) */),

  /** R-21 apply/remove. By-reference semantics (D-05). Idempotent (D-11). */
  applyToUser: adminProcedure
    .input(z.object({ tagId: z.uuid(), userId: z.uuid() }))
    .mutation(/* domain.applyTag — audits 'apply_tag' */),
  removeFromUser: adminProcedure
    .input(z.object({ tagId: z.uuid(), userId: z.uuid() }))
    .mutation(/* domain.removeTag — audits 'remove_tag' */),
});

// ---------- root ----------
export const appRouter = router({
  profile: profileRouter,
  catalog: catalogRouter,
  users: usersRouter,
  tags: tagsRouter,
  // RESERVED router names — do not repurpose:
  //   ledger, fix   → Phase 2 (R-40..R-52)
  //   plex          → Phase 3 (R-25..R-28)
});
export type AppRouter = typeof appRouter;
```

Non-existent targets (`userId`/`appId`/`tagId` not found) throw
`TRPCError({ code: 'NOT_FOUND' })` directly in the procedure, donor-style.

### D-07 — Audit co-writes (ADR-003, R-04)

No router writes permission state with raw drizzle. Every mutation above calls a
`packages/domain` helper that, **inside one `db.transaction`**, performs the state
change and inserts the corresponding `permission_audit` row (actor id — null = system,
action, subject/app/tag FKs, denormalized `detail` snapshot). Pattern is the donor's
`transitionRole` (`todos-for-dues/packages/domain/src/user-role-transitions.ts`).
The table shape and action enum are **owned by DESIGN-001 D-10**; this surface maps
onto it one-to-one:

| Procedure | `permission_audit.action` |
|---|---|
| `users.grantApp` / `users.revokeApp` | `grant_app` / `revoke_app` |
| `users.setFamily` | `set_family` / `unset_family` |
| `tags.create` / `tags.update` / `tags.delete` | `create_tag` / `update_tag` (bundle delta in `detail`) / `delete_tag` |
| `tags.applyToUser` / `tags.removeFromUser` | `apply_tag` / `remove_tag` |
| `catalog.create` / `catalog.update` / `catalog.delete` | `create_app` / `update_app` (before/after in `detail`) / `delete_app` |

Role changes are **not** in `permission_audit` — the Admin bootstrap (R-02/AC-03)
writes `user_role_transitions` (DESIGN-001 D-04, owned by DESIGN-002); Phase 1 has no
role-mutation procedure (Q-01).

### D-08 — What counts as "touching permissions"

Every catalog write is audited (DESIGN-001 D-05 invariant), not just grant rows —
`update_app` can flip `defaultVisible` and a URL edit is permission-relevant;
`delete_app` cascades grants away. The `detail` jsonb carries before/after values so a
`defaultVisible` flip or tag-bundle edit is reconstructable. `catalog.reorder` keeps
the invariant with a single `update_app` row (`app_id` null, `detail` = full
before/after id ordering) rather than one row per shifted entry.

### D-09 — No `users.getById` in Phase 1

`/admin/users/[id]` composes `users.list` + `catalog.adminList` + `tags.list` (all
already needed by sibling admin pages, all cached by React Query) and computes
provenance client-side per D-05. At household scale this avoids a fourth projection
endpoint; add `getById` only if `users.list` payloads ever become a problem.

### D-10 — Icons are code-shipped, selected by the `icon` key

`app_catalog.icon` (nullable — DESIGN-001 D-05) is validated against `ICON_KEYS`, the
enum exported by the inline-SVG icon registry (seed keys: `seerr`, `plex`, `immich`,
`open-webui`, `paperless`, `tautulli`, …); `null`/unknown renders the generic tile
glyph. Admins never upload markup — no SVG/XSS surface, icons theme via `currentColor`
(DESIGN-004 D-09). Adding an icon is a code change. Registry location: `packages/ui`
so that `packages/api` can import `ICON_KEYS` without depending on the Next app —
DESIGN-001's D-05 comment says "in apps/web"; reconcile to `packages/ui` while both
docs are Draft. Arbitrary admin-supplied icons: Q-02.

### D-11 — Idempotent permission mutations

`grantApp`, `revokeApp`, `applyToUser`, `removeFromUser`, `setFamily` are idempotent:
if the requested state already holds, the helper makes **no change, writes no audit
row**, and returns `{ changed: false }`. Rationale: double-clicks and refetch races
shouldn't spray CONFLICT toasts or fabricate audit history; AC-03 sets the precedent
(repeat bootstrap logins are no-ops).

### D-12 — `tags.list` visibility (the one decided-here access question)

`tags.list` is `authedProcedure`, role-scoped in the resolver:

- **Admin** → all tags with full bundles and tagged-user counts (feeds `/admin/tags`).
- **Member** → only tags applied to the caller, projected to `{ id, name, description }`
  — no bundle contents, no other users.

Rationale: R-22's "UI shows where each permission comes from" is admin-facing, but a
member seeing "you have the *family* tag" on their own profile is harmless and useful,
and scoping in one resolver is cheaper than a second procedure. Consequence: **tag
names become member-visible** — admins must name tags accordingly (flagged as Q-03 for
owner sign-off).

### D-13 — Error taxonomy

Donor pattern exactly: typed domain errors in `packages/domain/src/errors.ts`, a
`mapDomainErrors(fn)` wrapper translating them to `TRPCError` codes, and the
`errorFormatter` attaching `data.appCode` so clients switch on a stable string instead
of parsing messages.

| Domain error | `appCode` | TRPC code | Thrown by |
|---|---|---|---|
| `ForbiddenHostError` | `CATALOG_URL_FORBIDDEN_HOST` | `UNPROCESSABLE_CONTENT` | domain URL assert (D-04 layer 2; zod normally rejects first with `BAD_REQUEST`) |
| `TagNameConflictError` | `TAG_NAME_CONFLICT` | `CONFLICT` | `tags.create` / `tags.update` |
| `ReorderMismatchError` | `REORDER_SET_MISMATCH` | `CONFLICT` | `catalog.reorder` on stale/partial id set |
| `FixRateLimitError` | `FIX_RATE_LIMIT_EXCEEDED` | `TOO_MANY_REQUESTS` | `fix.create` (R-47, DESIGN-005 D-09) |
| `FixAlreadyOpenError` | `FIX_ALREADY_OPEN` | `CONFLICT` | `fix.create` open-fix dedupe (DESIGN-005 D-09) |
| `FixTargetRequiredError` | `FIX_TARGET_REQUIRED` | `UNPROCESSABLE_CONTENT` | sonarr/lidarr fix without child target (DESIGN-005 D-15) |
| `LedgerItemTombstonedError` | `LEDGER_ITEM_TOMBSTONED` | `PRECONDITION_FAILED` | `fix.create` on a tombstoned item (DESIGN-005 D-17) |
| `ArrUpstreamError` | `ARR_UPSTREAM_UNAVAILABLE` | `BAD_GATEWAY` | any *arr call failure surfaced to the client (DESIGN-005 D-17) |
| `RestoreProfileUnmappedError` | `RESTORE_PROFILE_UNMAPPED` | `UNPROCESSABLE_CONTENT` | restore execute per-item profile mapping (DESIGN-005 D-16) |
| — (`TRPCError` direct) | — | `NOT_FOUND` / `UNAUTHORIZED` / `FORBIDDEN` | resolvers / ladder |

(Phase 2 rows added 2026-07-03 with the ledger/fix/restore routers, as this section
planned.)

## Alternatives considered

- **Copy-on-apply tag grants** (materialize grant rows when a tag is applied): rejected
  — breaks R-21/AC-06 edit-propagation and tag-removal semantics; by-reference union at
  read time is trivially correct at this scale.
- **`profile.me` returning the effective app list too**: rejected — two sources of
  truth for tiles; dashboard uses `catalog.myApps` (task brief; D-05).
- **superjson transformer**: rejected for donor parity; ISO-string timestamps are an
  explicit convention instead (D-03).
- **Admin-only `tags.list` + separate `profile.myTags`**: more surface for the same
  data; folded into one role-scoped query (D-12).
- **Public `getSession` procedure** (donor has one): dropped — Next server components
  read the Better Auth session directly for the signed-out redirect (DESIGN-004 §D-12);
  no tRPC round-trip needed.

## Test strategy

- **Integration (embedded Postgres, R-62 — no Docker):** `createCallerFactory` callers
  per role. Ladder: unauthenticated → `UNAUTHORIZED`; Member on every admin procedure →
  `FORBIDDEN`. Grants/tags/family: state change + `permission_audit` row asserted **in
  the same transaction outcome** (R-04, AC-05, AC-06); idempotent replays produce
  `{ changed: false }` and no extra audit rows (D-11).
- **R-14 table-driven URL tests:** reject `http://…`, `https://sonarr.haynesops.com`,
  `https://haynesnetwork.com` (bare apex), `https://evil.com/?x=.haynesnetwork.com`,
  `https://evil.haynesnetwork.com.attacker.io` (suffix attack — DESIGN-001 D-05),
  `https://a.haynesnetwork.com:8443`, credentials, IP literals; accept
  `https://plex.haynesnetwork.com` and deep paths (AC-04). Run the same table against
  both the zod schema and the domain assert (the DB CHECK is exercised by DESIGN-001's
  schema tests).
- **Union/provenance:** default ∪ direct ∪ tag with overlap dedupe; tag removal leaves
  direct grants intact (AC-06); catalog delete cascades and audits.
- **Error mapping:** each domain error surfaces its `appCode` through the formatter.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Phase 1 has no procedure to grant/revoke the Admin role (bootstrap allowlist only, R-02). Is that acceptable until Phase 2, or is a `users.setRole` (with min-one-admin invariant, donor-style) wanted now? | (open) |
| Q-02 | Will the owner ever want admin-supplied catalog icons (upload/URL) instead of the code-shipped `ICON_KEYS` registry (D-10)? | (open) |
| Q-03 | D-12 makes tag names visible to the tagged member. OK, or should member scope return nothing? | (open) |
