# PLAN-003: Plex library self-service (Phase 3)

- **Status:** Draft   _(Fable 5 flips Draft → Executing → Completed)_
- **Satisfies:** PRD-001 R-25..R-28 (+ resolves Q-03); NEW **ADR-016** (Plex sharing +
  role-library-grant model + family-as-a-role-grant); NEW **DESIGN-007** (supersedes
  DESIGN-001 Appendix A); DDD-001 T-17..T-21 finalized; DDD-002 BC-04 promoted intent → owned.
- **Depends on:** none. **Reads** ADR-012 (`docs/adrs/012-unified-role-model.md`, esp. C-09/C-12
  — family gating attaches to a *role attribute*, not the dropped `users.is_family`).
- **TODO source:** #2 of `.agents/plans/TODO.md` (Plex library self-service, Phase 3).

> Mirror the **Restore/Fix vertical** end-to-end: db pgTable (+ CHECK enums from
> `packages/db/src/schema/enums.ts`) → domain single-writers (each `inTransaction`, audit row
> same tx) → domain orchestrator (injected client bundle, re-derive fresh allowed set to avoid
> TOCTOU) → import-confined write client → tRPC router (`authed`/`adminProcedure` in
> `mapDomainErrors`) → `'use client'` page. The **Role vertical** is the closest structural
> match and is the primary thing to copy: `role_app_grants` → `role_library_grants`,
> `packages/domain/src/effective-apps.ts:37` (`effectiveAppsForUser`) →
> `effectiveAllowedLibrariesForUser`, `packages/api/src/routers/roles.ts` +
> `apps/web/app/(app)/admin/roles/page.tsx` extended with a library matrix.

---

## Goal

Users self-add/remove Plex libraries on **their own** Plex account across the **three servers**
— `haynestower` (Unraid legacy, `plex.haynesnetwork.com`), `haynesops`
(`plexops.haynesnetwork.com`), `hayneskube` (`k8plex.haynesnetwork.com`) — limited to the
libraries **their Role** is allowed. Admins assign, **per Role**, which libraries that role may
access (a checkbox matrix folded onto `/admin/roles`). The old **family-only** libraries
(`HNet Home Videos`, `HNet Photos`, HAYNESTOWER-only per OPS-002 line 15/19) become **ordinary
libraries granted only to the `Family` role** — this REPLACES `users.is_family` (removed by
ADR-012, migration `0007_unified_roles.sql`) and resolves the T-20/T-21 open modeling question
and DESIGN-001 Appendix A's deferred "inverts the grant model" question
(`docs/designs/001-database-schema.md:676`).

Library identity is **`(server, section_key)`, never name** (Q-03 resolved,
`docs/prds/001-haynesnetwork.md:180`; OPS-002 design-implication 1,
`docs/ops/002-plex-topology.md:41`): HAYNESOPS mirrors HAYNESTOWER's Movies/TV under different
names (`HOps Movies` vs `HNet Movies`).

---

## Docs-first artifacts to author (same PR as the code)

### PRD-001 (`docs/prds/001-haynesnetwork.md`)
- **R-25** (line 91): reword "within the set an admin allows them" → "within the set their
  **Role** allows them"; drop the "(or per-tag)" residue.
- **R-26** (line 92): the default allowed set is now expressed as the **Default role's** library
  grants (all libraries **except** the two HAYNESTOWER family libraries); `HNet Home Videos` /
  `HNet Photos` are the **Family role's** exclusive grants. Remove "family users" language →
  "the Family role".
- **R-27** (line 93): "per-user (or per-tag) allowed-library sets and designate Family" →
  "**per-Role** allowed-library sets; Family is just a Role whose grants include the family
  libraries" (aligns with ADR-012 C-09/C-12; kills the last per-user/per-tag reference).
- **R-28** (line 94): unchanged in intent (Plex sharing API, owner token from 1Password,
  audit-logged) — add the ADR-016 citation.
- **Q-03** (line 180): mark **Resolved** by DESIGN-007 (registry keys on `(server, section_key)`;
  mirror modeled by identity, not name).
- Actors table (lines 47-48): confirm Default/Family wording matches the role-grant model.

### NEW **ADR-016** — Plex library sharing & the role-library-grant model (MADR 3.0)
Copy `docs/adrs/000-template.md`. Fable 5 **authors AND ratifies (Accepts)** it. Decisions it
must resolve (record each as a numbered consequence C-NN):
- **Allow-list, not deny-list.** `role_library_grants` is a **positive** grant table mirroring
  `role_app_grants` (`packages/db/src/schema/role-app-grants.ts`) — a role sees exactly the
  libraries granted, unioned across nothing (single role per user, ADR-012). This settles the
  Appendix A "grants may become exceptions/deny rows" question (`001-database-schema.md:676`) in
  favor of positive grants; seeding fills Default with the non-family set and Family with the
  full set (see Data model → seeding).
- **Family = a role grant, not a flag.** No `plex_libraries.is_family_only` column (supersedes
  the Appendix A sketch); the two family libraries are simply libraries only the `Family` role is
  granted. Directly discharges ADR-012 **C-09** ("family gating attaches to a role attribute")
  and **C-12**.
- **Owner-token handling.** Each server's owner token lives in 1Password (HaynesKube vault) and
  is surfaced to the app as an env var via ExternalSecret; `plex_servers.token_ref` stores the
  **reference name** (env var name / 1Password item→field), **never the token** (CLAUDE.md rule
  7). The write client reads the actual token from `process.env` at call time.
- **`base_url` is server-side and EXEMPT** from the arbitrary-http(s) catalog rule (CLAUDE.md
  rule 3 / ADR-013) — same exemption OPS-002 and Appendix A already note.
- **Share application is enforcement, never decision** (DDD-002 BC-04, `002-bounded-contexts.md:90`):
  the request is validated against the role's allowed set **before** any Plex call; the domain
  re-derives the fresh allowed set inside the transaction (TOCTOU guard, mirroring
  `executeRestore`).
- Relate to ADR-011 (`@hnet/arr/write` confinement) — the new `@hnet/plex/write` gets the
  **same** import confinement.
- Open sub-decisions the ADR must close: Plex sharing API mechanics, refresh cadence, remove
  semantics, haynestower write scope — see **Open decisions** below; each becomes an ADR
  consequence or a doc `Q-NN`.

### DDD glossary (`docs/domain-driven-design/001-ubiquitous-language.md`) — finalize T-17..T-21
- **T-17 Plex Server** (line 56): confirm the three slugs `haynestower`/`haynesops`/`hayneskube`
  (OPS-002 line 9 — note the slug is `haynesops`, not `plexops`); table now built (`plex_servers`).
- **T-18 Plex Library** (line 57): drop "Whether names align … is open (Q-03)"; identity is
  `(server_id, section_key)`; table built.
- **T-19 Library Grant** (line 58): **redefine** — no longer per-user/tag (`library_grants` /
  `tag_libraries` retired before they were built); it is a **Role → Library** grant
  (`role_library_grants`), mirroring T-46 Role App Grant.
- **T-20 Allowed Library Set** (line 59): finalize as "derived from the user's Role's
  `role_library_grants`" (union of nothing — one role per user).
- **T-21 Family-Only Library** (line 60): **redefine** — a library granted only to the `Family`
  role; there is **no** `plex_libraries.is_family_only` column (supersede that cell).
- **New terms:** **Plex Share** (an applied per-user library share on a server), **Library
  Registry Refresh** (the admin-triggered `GET /library/sections` sync that upserts
  `plex_servers`/`plex_libraries`), **Machine Identifier** (Plex server GUID used by the sharing
  API). Add to the glossary + a changelog row dated 2026-07-05 (matches the ADR-012 changelog
  row style at line 105).

### DDD bounded contexts (`docs/domain-driven-design/002-bounded-contexts.md`) — BC-04
- Promote BC-04 (`:90`) aggregates from **intent** ("will apply") to **owned/built**: Plex Server
  registry, Plex Library registry, Plex Share audit rows. Update relationship rule
  (`:112` "BC-04 owns library identity; BC-02 references it") to name `role_library_grants` as the
  BC-02→BC-04 reference. Add a changelog row.

### NEW **DESIGN-007** — Plex library self-service (supersedes DESIGN-001 Appendix A)
Copy `docs/designs/000-template.md`. Mark DESIGN-001 Appendix A
(`docs/designs/001-database-schema.md:661`) **superseded by DESIGN-007** (leave the sketch, add a
banner). D-NN entries:
- **D-01** schema: `plex_servers`, `plex_libraries`, `role_library_grants`, `plex_share_audit`
  (see Data model).
- **D-02** enums added to `enums.ts` (`PLEX_MEDIA_TYPES`, `PLEX_SHARE_EVENTS`).
- **D-03** `@hnet/plex` read/write split + env contract.
- **D-04** domain single-writers + `effectiveAllowedLibrariesForUser` + the share orchestrator
  (injected `PlexClientBundle`, fresh re-derive).
- **D-05** tRPC `plex` router (authed self-service + admin registry/assignment).
- **D-06** UI: user self-service page + `/admin/roles` library matrix; Modal vs ConfirmButton;
  no-reorient note.
- **D-07** ops: ExternalSecret refs, e2e stub, live validation.

---

## Data model (`packages/db/src/schema/*`, migration `0009_plex_libraries.sql`)

New schema files mirroring `roles.ts` / `role-app-grants.ts`:

- **`plex-servers.ts`** — `plex_servers`: `id` uuid PK; `slug` text UNIQUE (`'haynestower'` |
  `'haynesops'` | `'hayneskube'` — OPS-002 line 9); `name` text; `base_url` text (server-side,
  **EXEMPT** from the R-14/ADR-013 http(s) CHECK — comment it explicitly); `token_ref` text
  (1Password/env **reference name**, never the token — CLAUDE.md rule 7); `machine_identifier`
  text; `created_at`/`updated_at`.
- **`plex-libraries.ts`** — `plex_libraries`: `id` uuid PK; `server_id` → `plex_servers` CASCADE;
  `section_key` text (Plex section id); `name` text; `media_type` text `$type<PlexMediaType>()`
  (CHECK from enum); `synced_at` timestamptz; **UNIQUE(`server_id`, `section_key`)**. **No
  `is_family_only`** (ADR-016 — family is a role grant).
- **`role-library-grants.ts`** — `role_library_grants`: `roleId` → `roles` CASCADE +
  `plexLibraryId` → `plex_libraries` CASCADE; composite PK `(roleId, plexLibraryId)`. **Exact
  mirror** of `role-app-grants.ts:12`.
- **`plex-share-audit.ts`** — `plex_share_audit`: `id`; `userId` → `users`; `plexLibraryId` →
  `plex_libraries`; `event` text `$type<PlexShareEvent>()` (CHECK); `actorId` (self vs admin);
  `detail` jsonb; `created_at`. **BC-04 owns its own audit** (like BC-03 media aggregates —
  DESIGN-005 D-12 note in `enums.ts:22`), so this is a **new** table, **not** `permission_audit`.

**Enums** (`packages/db/src/schema/enums.ts` — the single source of truth for TS types AND SQL
CHECK, per its header comment at line 1):
```
export const PLEX_MEDIA_TYPES = ['movie','show','artist','photo','homevideo'] as const;
export const PLEX_SHARE_EVENTS = ['share_added','share_removed'] as const;
```
(Fable 5 confirms the exact `media_type` value set against the live `GET /library/sections`
`type` field during registry refresh — `movie|show|artist|photo`; `homevideo` covers the
HAYNESTOWER family libraries if Plex reports them distinctly.)

**Register** all four tables in `packages/db/src/schema/index.ts` and the barrel `@hnet/db`
export.

**Guard-list updates** (mandatory — CLAUDE.md rule 6):
`packages/domain/__tests__/no-direct-state-writes.test.ts:33` — add `plexServers`,
`plexLibraries`, `roleLibraryGrants`, `plexShareAudit` (Drizzle forms) and their snake_case
SQL names to `FORBIDDEN_PATTERNS` (insert/update/delete on registry + grants + audit) so no
code outside `packages/domain/` writes them. Extend the comment block at `:29`.

**Migration** `0009_plex_libraries.sql`: create the four tables + CHECK constraints + unique
indexes. **Seed** (a follow-on migration `0010_seed_plex.sql` or the same file): after the
admin runs the first registry refresh the libraries exist; seeding the **grants** is a
data/admin step, but the migration MAY seed the `Family` role → both family libraries and the
`Default` role → the non-family set once library ids are known. **Decision point for Fable 5**
(see Open decisions): seed grants in migration vs. via an admin action post-refresh — leaning
admin action, because library ids come from live refresh, not a fixture.

---

## Domain (`packages/domain/src/*`)

- **`effective-allowed-libraries.ts`** — `effectiveAllowedLibrariesForUser(userId, dbc?)`,
  **structural mirror** of `effective-apps.ts:37`: join `users ⋈ roles`, then
  `role_library_grants ⋈ plex_libraries ⋈ plex_servers`; return per-server library rows the
  user's role may self-add. Admin role (`roles.is_admin`) sees **all** libraries (mirror the
  `is_admin || grants_all` short-circuit at `effective-apps.ts:48` — decide whether a Plex
  `grants_all`-equivalent applies; simplest: Admin ⇒ all libraries, everyone else ⇒ their
  role's grants). Export from `packages/domain/src/index.ts` (alongside `effective-apps` at
  `:9`).
- **`plex-shares.ts`** — single-writers `shareLibrary` / `unshareLibrary`, each `inTransaction`
  (mirror `roles.ts` writers): validate the target library is in the caller's
  `effectiveAllowedLibrariesForUser` set **inside the tx** (TOCTOU — re-derive, do not trust the
  client), call the injected write client, then insert the `plex_share_audit` row
  (`share_added`/`share_removed`) **in the same tx**. On a role-gate failure throw a coded domain
  error (new `LibraryNotAllowedError` → appCode `LIBRARY_NOT_ALLOWED`, FORBIDDEN).
- **`plex-registry.ts`** — `refreshPlexRegistry({ db, plex })`: admin-only orchestrator that
  reads `GET /library/sections` (+ server identity for `machine_identifier`) via the **read**
  client and upserts `plex_servers`/`plex_libraries` keyed on `(server_id, section_key)`; sets
  `synced_at`. Writes go through domain (registry tables are on the guard list).
- **`plex-clients.ts`** — `PlexClientBundle` type + `plexClientBundleFromEnv()` (mirror
  `arr-clients.ts` / `packages/api/src/trpc.ts:43` `resolveArrBundle`), bundling one
  read+write client per server keyed by slug, tokens from env.
- **New error classes** in `packages/domain/src/errors.ts`: `LibraryNotAllowedError`,
  `PlexServerUnavailableError` (mirror `SystemRoleImmutableError` shape with a `code`).

**Invariants:** (1) every share/unshare co-writes its audit row in the same tx; (2) a share is
applied only if the fresh role-derived allowed set contains it; (3) registry tables and grants
are written only through `packages/domain`.

---

## Client / integration — NEW `@hnet/plex` package

Mirror `@hnet/arr` exactly (`packages/arr/package.json` exports `.` / `./read` / `./write`;
raw-TS, no build step — CLAUDE.md "eight packages" note now nine):
- `packages/plex/src/config.ts` — env contract mirroring `arr/src/config.ts:6`: per server
  `PLEX_<SLUG>_URL` (server-side base URL default; e.g. `http://plex.media.svc.cluster.local:32400`
  for k8s servers, LAN ingress for haynestower) + `PLEX_<SLUG>_TOKEN` (**required secret**, never
  echoed in errors — copy the `assertArrEnv` missing-key pattern). Token env var names are the
  `token_ref` values stored on `plex_servers`.
- `packages/plex/src/read.ts` — `GET /library/sections` (registry), server identity
  (`machine_identifier`), and **list a user's current shares** (`GET` the sharing/friends
  resource). Zod-validated (mirror `arr/src/schemas`).
- `packages/plex/src/write.ts` — **the write surface** (`@hnet/plex/write`): apply/remove a
  library share via the Plex sharing API using that server's **owner token**. Header comment must
  state, like `arr/src/write.ts:1`, that this entrypoint is importable **only** by
  `packages/domain` (+ `packages/plex` itself).
- `packages/plex/src/http.ts`, `errors.ts`, `index.ts` — mirror the arr equivalents.

**Import confinement (mandatory):** add `@hnet/plex/write` to the confinement guard. Simplest:
extend `packages/domain/__tests__/arr-write-import-guard.test.ts:19` `IMPORT_PATTERN` to also
match `@hnet/plex/write` (or clone it to `plex-write-import-guard.test.ts`). Allowed dirs:
`packages/domain/` and `packages/plex/` (mirror `:17`).

**Env/secret refs (names only — CLAUDE.md rule 7, never values):**
`PLEX_HAYNESTOWER_TOKEN` (1Password HaynesKube → `homepage`→`HAYNESTOWER_PLEX_API_KEY`),
`PLEX_HAYNESOPS_TOKEN` (`homepage`→`HAYNESOPS_PLEX_API_KEY` — OPS-002 line 26 prefers the
homepage copy over the colliding `plexops` item field), `PLEX_HAYNESKUBE_TOKEN`
(`homepage`→`HAYNESKUBE_PLEX_API_KEY`). All three validated against `GET /library/sections`
2026-07-03 (OPS-002 line 29). Server URLs are non-secret config.

---

## API (`packages/api/src/routers/plex.ts` — claims the RESERVED `plex` name)

Register in `packages/api/src/routers/index.ts` — replace the reserved-name comment at `:22`
with `plex: plexRouter`. Wrap every domain call in `mapDomainErrors` (`trpc.ts`), inject the
bundle via a `resolvePlexBundle(ctx)` helper mirroring `resolveArrBundle` (`trpc.ts:43`). Add
the new appCodes (`LIBRARY_NOT_ALLOWED`) to `APP_CODED_ERRORS` (`trpc.ts:79`) + the
`mapDomainErrors` chain + the DESIGN-007 appCode table (two-place edit, per ADR-012 C-10 note).

- **`myLibraries`** `authedProcedure.query` — the caller's `effectiveAllowedLibrariesForUser`
  grouped by server, each annotated with whether the user currently shares it (from the read
  client's list-shares). Feeds the self-service page.
- **`addLibrary`** `authedProcedure.mutation({ libraryId })` — `shareLibrary` for
  `ctx.user.id` (role-gated in-domain).
- **`removeLibrary`** `authedProcedure.mutation({ libraryId })` — `unshareLibrary`.
- **`refreshRegistry`** `adminProcedure.mutation` — `refreshPlexRegistry` (all servers or one).
- **`roleLibraryGrants` / `setRoleLibraryGrants`** `adminProcedure` — read the per-role grant
  matrix and replace-whole-set a role's library grants (mirror `roles.update`'s replace-whole
  app-set semantics, `roles.ts:56` → `updateRole` appIds at `packages/domain/src/roles.ts:193`).
  Writes via a domain single-writer `setRoleLibraries` (audit to `plex_share_audit`? no — this is
  a permission change; decide: reuse `permission_audit` with a new action **or** keep grant edits
  auditless like `role_app_grants` edits which ride inside `update_role`). **Decision point** —
  simplest is a domain writer that co-writes a `permission_audit` row with a new action
  `update_role_libraries` (add to `PERMISSION_AUDIT_ACTIONS`, `enums.ts:10`).

Auth levels: self add/remove = `authedProcedure` (own account only — the procedure takes no
`userId`, always `ctx.user.id`); all registry + role assignment = `adminProcedure`
(`packages/api/src/middleware/role.ts`).

---

## UI (`apps/web/app/(app)/*`)

- **User self-service page** — new `apps/web/app/(app)/library/plex/page.tsx` (or a tab under the
  existing library area; there is already `apps/web/e2e/library.spec.ts`). `'use client'`, tRPC
  hooks (`trpc.plex.myLibraries`, `addLibrary`, `removeLibrary`). Grouped **per server**
  (haynestower/haynesops/hayneskube), each library a row with add / remove. **Remove is
  destructive → `@hnet/ui` `ConfirmButton`** inline two-step (ADR-014, CLAUDE.md rule 8 —
  never `window.confirm`); add is a plain action. Non-permitted libraries are **not offered**
  (the query returns only the allowed set). Nav: add under the existing app nav (mirror where
  `/admin/roles` and library live).
- **Admin per-role library matrix** — **fold onto** `apps/web/app/(app)/admin/roles/page.tsx`
  (mirror the app-grants checkbox matrix already there — the page loads `catalog.adminList` at
  `:26`; add a `plex.roleLibraryGrants` query and a second checkbox matrix of libraries grouped by
  server in the same inline editor). Replace-whole-set on save via `setRoleLibraries`.
- **No layout reorientation** (ADR-015 / DESIGN-004 D-14, CLAUDE.md rule 9): add/remove and
  matrix toggles change color/emphasis only — no reflow of neighbors; `ConfirmButton` reserves
  width for the armed label. Mutations invalidate-and-refetch (mirror the `invalidate()` pattern
  at `admin/roles/page.tsx:37`).

---

## Ops

- **ExternalSecret / env** (`docs/ops/`, sibling `haynes-ops`): the three owner tokens are
  already in 1Password (HaynesKube vault, OPS-002 §"Token locations"). Add
  `PLEX_HAYNESTOWER_TOKEN` / `PLEX_HAYNESOPS_TOKEN` / `PLEX_HAYNESKUBE_TOKEN` to the app's
  ExternalSecret + `.env.example` + `apps/web/.env.local` contract (reference names only — never
  commit values). Server URLs to the same. Update `docs/ops/003-local-verification.md` (the
  `pnpm dev:local` stub set) to include a stub Plex server.
- **e2e stub** — new `apps/web/e2e/support/stub-plex.ts`, mirroring
  `apps/web/e2e/support/stub-arr.ts:1` (a real `node:http` server because Next calls Plex over
  the network; serve `GET /library/sections`, list-shares, and record the sharing write calls;
  `/_stub/calls` + `/_stub/reset` control endpoints). Wire into `global-setup.ts` and point
  `PLEX_*_URL` at it. One stub stands in for all three servers (per-slug URLs point at the same
  stub with distinct machine identifiers).
- **Deploy** per `docs/ops/004-deploy-runbook.md`: bump the image tag in
  `haynes-ops` `kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`, flux
  reconcile; ensure the new ExternalSecret keys are synced before rollout.

---

## Open decisions Fable 5 must make (authorized to decide + record as ADR-016 C-NN / doc Q-NN)

1. **Plex sharing API mechanics** — friend/invite vs. `PUT`/`POST` share-sections per user; the
   exact endpoint (`plex.tv` `/api/v2/shared_servers` vs. per-server). Whether a user must
   already be a Plex friend/home member before a section can be shared, and how the app maps a
   haynesnetwork user → a Plex account id (the OIDC identity is Plex-backed via Authentik —
   confirm the Plex user id is available). **This is the hardest unknown; verify against a real
   server before writing `@hnet/plex/write`.**
2. **Registry refresh cadence** — admin-button-only (simplest, chosen default) vs. a CronJob like
   the *arr sync. Lean: manual admin refresh for now; note a future CronJob.
3. **Remove-share semantics** — does un-sharing a single section leave the user as a friend with
   the other sections, or is it a per-user section-set replace? (Most Plex APIs replace the full
   shared-section list per user — the write client likely computes the new set = current − removed
   and PUTs it.) Decide and encode in `unshareLibrary`.
4. **haynestower (Unraid) vs. k8s plex/plexops** — same Plex sharing API surface? Confirm the
   legacy server's Plex version supports the chosen endpoint. **Whether haynestower is in-scope
   for WRITES tonight** — if its API differs or is risky, ship read/registry for all three but
   gate writes to `haynesops`/`hayneskube` first, with haynestower writes a fast follow (record
   as a Q-NN). Family libraries live **only** on haynestower (OPS-002 line 19), so deferring
   haynestower writes defers real family-library self-service — weigh this.
5. **Grant seeding** — seed Default/Family library grants in migration `0010` (needs live library
   ids) vs. an admin post-refresh step. Lean: admin action after first refresh.
6. **`media_type` value set** — finalize `PLEX_MEDIA_TYPES` against live `GET /library/sections`.
7. **Role-library-grant audit** — new `permission_audit` action `update_role_libraries` vs.
   auditless (mirror `role_app_grants` edits). Lean: audited.

---

## Verification

**Unit (`vitest`, embedded PG16):**
- `effectiveAllowedLibrariesForUser` — Admin ⇒ all libraries; a role ⇒ exactly its grants;
  Family role ⇒ includes the two family libraries; Default role ⇒ excludes them (R-26).
- `shareLibrary`/`unshareLibrary` — audit row (`plex_share_audit`) written **in the same tx**
  (mirror the roles single-writer tests); rollback leaves no audit row.
- **Role gating** — `shareLibrary` for a library **outside** the user's role set throws
  `LibraryNotAllowedError` and makes **no** write-client call (inject a spy client).
- Guard tests pass: no-direct-state-writes covers the four new tables; `@hnet/plex/write` import
  confinement holds.
- `refreshPlexRegistry` upserts keyed on `(server_id, section_key)` (mirror name-collision: two
  servers with a same-named `Movies` library stay distinct).

**Integration / e2e (`pnpm --filter web e2e`, hermetic via `stub-plex.ts`):**
- User sees only their role's libraries; add records a share write at the stub; remove
  (via `ConfirmButton`) records the un-share; a non-permitted library is absent from the page.
- Admin refresh populates the registry; admin grants a library to a role and the user then sees
  it. Resize-matrix + no-reorient assertions on the new page.

**LIVE Playwright** (real staging `https://haynesnetwork.haynesops.com` + **real Plex servers**,
per the driver contract; full live access approved):
- As a **test user**, add a **permitted** library on a server and confirm the share appears on
  the **real** Plex server (verify via `GET /library/sections` / the user's shares with the owner
  token, or the Plex web UI).
- Remove it and confirm the share is gone on the real server.
- Confirm a **non-permitted** library (e.g. a family library for a non-Family test user) is **not
  offered** in the UI.
- Exercise all three servers' read/registry; writes per the Open-decision-4 scope (at minimum
  `haynesops`/`hayneskube`).

---

## Definition of Done

Docs authored + ADR-016 ratified (Accepted) in the same PR as the code · local merge gate green
(`pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`) · branch
`feat/plex-library-self-service` → PR → required checks (`lint-and-typecheck`, `test`, `build`)
green → squash-merge · deployed to staging via the haynes-ops image-tag bump + flux reconcile ·
**LIVE-validated** (the three Playwright journeys above against real staging + real Plex) · plan
marked **Completed** and `git mv`'d to `.agents/plans/completed/003-plex-library-self-service.md`.

---

## Out of scope

- Automatic "which server should this user watch on" load-balancing (OPS-002 design-implication 3
  — schema must not preclude it, but no feature now).
- Authentik-side enforcement of app access (R-30 follow-on) — hiding non-permitted libraries is
  the accepted enforcement start (DDD-002 §4, `002-bounded-contexts.md:106`).
- Tautulli watch-history enrichment (OPS-002 §Tautulli — that's Phase 2 ledger territory).
- Per-user (non-role) allowed sets — explicitly rejected by ADR-012 C-08 / this plan's role model.
- The shared filter/table engine (PLAN-004) — the self-service page uses simple per-server lists;
  it does **not** depend on `@hnet/ui` filters.

## Rollback

- **Pre-merge:** abandon the branch; nothing shipped.
- **Post-merge, pre-deploy:** revert the squash-merge commit; `plex` router + `@hnet/plex` are
  additive (no existing surface changed except the reserved-name comment and PRD/DDD text).
- **Post-deploy:** re-point the staging image tag to the prior release in
  `haynes-ops` helmrelease + flux reconcile. Migration `0009` is additive (four new tables) —
  safe to leave in place; if a full down is needed, drop `plex_share_audit`, `role_library_grants`,
  `plex_libraries`, `plex_servers` (reverse FK order). **No write-backs to real Plex are
  auto-undone** — a bad share can be removed via the same un-share path or the owner token; note
  this in the runbook.
```
