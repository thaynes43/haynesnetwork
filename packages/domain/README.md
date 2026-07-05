# @hnet/domain

The **single-writer core**. Every mutation of a guarded table (roles, permissions,
catalog, and the Phase 2 media ledger) goes through a helper exported here, and the
only mutating path to the *arr stack (`@hnet/arr/write`) is confined to this package.
Nothing else in the workspace may write those tables or call a mutating *arr endpoint —
two CI guard tests fail the build if it tries.

Raw TS, no build step. Import from `@hnet/domain` (barrel is `src/index.ts`).

Normative sources: CLAUDE.md hard rules 4 + 6; ADR-003 (C-05); ADR-008 / ADR-011
(*arr write-back surface); DESIGN-001 D-12 (audit-in-transaction) and DESIGN-005 D-12
(the ledger extension of the rule).

---

## The invariant

> Every guarded-table mutation runs inside a transaction that **also** writes its
> audit / ledger row. The two commit together or not at all.

Mechanics, identical in every writer:

1. The helper takes an **optional `db` (`DbClient`)** in its input. Callers usually omit
   it (the lazy default client from `@hnet/db` is used); tests and composed transactions
   pass one in.
2. It runs its body via `inTransaction(input.db, async (tx) => …)` (see `src/db-client.ts`).
   `inTransaction` resolves the executor (injected or default) and opens a transaction;
   calling it inside an already-open transaction opens a **savepoint**, so writers nest
   safely.
3. Inside that one `tx` it performs the state change **and** inserts the audit row
   (`permission_audit`) or ledger row (`ledger_events`) — never in a second call, never
   after the transaction closes.
4. **Idempotent no-ops write no audit row.** A re-grant, re-set of an already-set flag,
   etc. returns `{ changed: false }` and inserts nothing. Only real state changes are
   audited. (`permission-writers.test.ts` pins this; `grantApp`/`revokeApp`/
   `setFamilyDesignation` all return `{ changed }`.)
5. Read-only orchestrators (`runFixRequest`, `runForceSearch`, `computeRestoreDiff`,
   `executeRestore`) use `resolveDb(input.db)` instead of `inTransaction` — they compose
   the writers above and the *arr calls, and each writer opens its own transaction.

Atomicity is **structural, not conventional**: because the audit insert shares the
transaction, a failed audit rolls the mutation back. `permission-writers.test.ts`
("a failed audit write rolls back the mutation") proves this by installing a trigger
that raises on `permission_audit` INSERT and asserting the grant does not survive.

Roles are **`Member` / `Admin`** (capitalized — `packages/db` `enums.ts` `ROLES`). Never
lowercase them.

---

## Writer → guarded-table ownership index

Each guarded table has exactly one owning module. To mutate a table, call its writer;
do not reach around it.

| Writer (exported)                                            | Module                     | Writes (state)                          | Co-writes (audit/ledger)     |
| ------------------------------------------------------------ | -------------------------- | --------------------------------------- | ---------------------------- |
| `transitionRole`                                             | `user-role-transitions.ts` | `users.role`                            | `user_role_transitions`      |
| `grantApp`, `revokeApp`                                      | `app-grants.ts`            | `user_app_grants`                       | `permission_audit`           |
| `setFamilyDesignation`                                       | `family.ts`                | `users.is_family`                       | `permission_audit`           |
| `createTag`, `updateTag`, `deleteTag`, `applyTag`, `removeTag` | `tags.ts`                | `tags`, `tag_app_grants`, `user_tags`   | `permission_audit`           |
| `createApp`, `updateApp`, `deleteApp`, `reorderCatalog`      | `catalog.ts`               | `app_catalog`                           | `permission_audit`           |
| `createFixRequest`, `recordFixAction`, `completeFixRequests` | `fix-requests.ts`          | `fix_requests`                          | `ledger_events`              |
| `recordSearchRequest`                                        | `search-requests.ts`       | —                                       | `ledger_events`              |
| `startRestoreRun`, `recordRestoreResult`, `finishRestoreRun` | `restore-runs.ts`          | `restore_runs`, `media_items`           | `ledger_events`              |
| `upsertMediaItemsBatch`, `tombstoneMissingItems`             | `media-sync.ts`            | `media_items`, `sync_state`             | `ledger_events` (tombstones) |
| `ingestLedgerEvents`, `backfillEventAttribution`             | `ledger-ingest.ts`         | `ledger_events`, `sync_state`           | (is the ledger)              |
| `startSyncRun`, `finishSyncRun`                              | `sync-runs.ts`             | `sync_runs`                             | —                            |

Orchestrators (compose the writers above + the *arr bundle, open no transaction of their
own): `runFixRequest` (`fix-flow.ts`), `runForceSearch` (`search-flow.ts`),
`computeRestoreDiff` + `executeRestore` (`restore-flow.ts`).

Pure / read-only helpers (no guarded writes): `effective-apps.ts` (`effectiveAppsForUser`),
`family.ts` (`isEffectivelyFamily`), `media-children.ts` (`listMediaChildren`,
`episodeLabel`, `guardArrCall`), `action-scope.ts` (`resolveSearchTarget`,
`resolveFixTarget` — the shared Fix/Force-Search scope validators), `url-assert.ts`
(`normalizeCatalogUrl`, `assertCatalogUrl` — normalize an arbitrary catalog URL to a canonical
`http(s)` form; ADR-013 retired the old `*.haynesnetwork.com` host allowlist),
`arr-clients.ts` (builds the read+write *arr client bundle).

---

## Guard maintenance — do this when you touch the perimeter

The two guards are static-analysis tests that scan the whole repo. They are dumb regex
scanners; they only protect what you list. **When you widen the perimeter you must widen
the guards in the same change, or the guard silently lets the new hole through.**

### Adding a newly guarded table

1. Write its single-writer in `packages/domain/src` (transaction + audit/ledger row) and
   `export * from './your-writer'` in `src/index.ts`.
2. Edit **both regex families** in `__tests__/no-direct-state-writes.test.ts`
   `FORBIDDEN_PATTERNS` — the raw-SQL forms **and** the Drizzle forms:
   - SQL: `INSERT INTO …`, `UPDATE … SET`, `DELETE FROM …` (snake_case table name).
   - Drizzle: `.insert(<table>)`, `.update(<table>)`, `.delete(<table>)` (camelCase
     schema identifier, e.g. `mediaItems`).
   Add the table to whichever of the six patterns can mutate it. Missing one family
   leaves that call shape unguarded.
3. Do **not** add the table to `ALLOWED_FILES` — that set is a frozen exception for two
   `packages/db` schema tests; new code routes through `@hnet/domain` instead.

The scan skips `packages/domain/` itself and ignored dirs (node_modules, migrations,
docs, .agents, .claude, build outputs, …). A hit anywhere else — `packages/api`,
`apps/web`, `packages/sync`, scripts — fails `pnpm test`.

### Adding a mutating *arr call

`@hnet/arr/write` (`LidarrWriteClient` / `RadarrWriteClient` / `SonarrWriteClient`:
history/failed, file deletes, commands, add-item, tag) is importable **only** by
`packages/domain` and `packages/arr` itself. `arr-clients.ts` is the sole domain importer;
everything else receives clients through the bundle it builds.

- Route the new mutating call through the domain fix/restore/search orchestrators. Do
  **not** `import … from '@hnet/arr/write'` in `packages/api`, `apps/web`, or
  `packages/sync` — `__tests__/arr-write-import-guard.test.ts` scans for the literal
  string `@hnet/arr/write` and fails the build on any reference outside the two allowed
  prefixes.
- Read-only *arr access uses `@hnet/arr/read` and is not restricted.

---

## Error contract (`src/errors.ts`)

Domain errors carry a **stable `readonly code`** — the wire `appCode`. `@hnet/api`'s
`mapDomainErrors` maps each to a `TRPCError` code and forwards the `appCode` on the wire.
**Clients switch on `appCode`, never on `message` text** (messages are for humans/logs and
may change).

| Error class                   | `code` (appCode)               | Meaning                                                   |
| ----------------------------- | ------------------------------ | --------------------------------------------------------- |
| `InvalidCatalogUrlError`      | `CATALOG_URL_INVALID`          | catalog URL is not a well-formed `http(s)` URL (ADR-013). |
| `RoleNameConflictError`       | `ROLE_NAME_CONFLICT`           | role create/rename hit an existing name (ADR-012).        |
| `ReorderMismatchError`        | `REORDER_SET_MISMATCH`         | `reorderCatalog` got a stale/partial id set.              |
| `ConcurrentTransitionError`   | `CONCURRENT_TRANSITION`        | optimistic-concurrency guard tripped in `transitionRole`. |
| `NotFoundError`               | `NOT_FOUND`                    | target user/app/tag row does not exist.                   |
| `FixRateLimitError`           | `FIX_RATE_LIMIT_EXCEEDED`      | R-47: requester over the per-hour fix budget (admins exempt). |
| `FixAlreadyOpenError`         | `FIX_ALREADY_OPEN`             | an open fix already targets this item+child.              |
| `FixTargetRequiredError`      | `FIX_TARGET_REQUIRED`          | scope/target mismatch (see `action-scope.ts`).            |
| `LedgerItemTombstonedError`   | `LEDGER_ITEM_TOMBSTONED`       | fix requested on a tombstoned item — nothing in the *arr. |
| `InvalidFixTransitionError`   | `FIX_INVALID_TRANSITION`       | illegal fix-status transition (T-43 lifecycle).           |
| `ArrUpstreamError`            | `ARR_UPSTREAM_UNAVAILABLE`     | an *arr/Seerr call failed serving a request (→ BAD_GATEWAY); original rides as `cause`. |
| `RestoreProfileUnmappedError` | `RESTORE_PROFILE_UNMAPPED`     | ledger profile snapshot has no match on the live *arr — never silently defaulted. |
| `MassTombstoneAbortedError`   | `SYNC_MASS_TOMBSTONE_ABORTED`  | D-14 guard: tombstone pass would exceed the guard %/min; carries `detail.{wouldTombstone,liveCount}`. |

Also exported: SQLSTATE helpers `isPostgresCheckViolation` (23514),
`isPostgresUniqueViolation` (23505), `isPostgresForeignKeyViolation` (23503) — they unwrap
a nested `cause`, so use them instead of matching Postgres error codes by hand.

When you add an error, give it a new stable `code`, export it from the barrel, and map it
in `@hnet/api` `mapDomainErrors`. Never reuse or rename an existing `code` — it is a wire
contract clients depend on.
