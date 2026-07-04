# @hnet/db

Postgres 16 data layer for haynesnetwork: Drizzle schema, raw-SQL migrations, and a
node-postgres migrator. Exports raw TS — no build step. Postgres 16 ONLY (CLAUDE.md hard
rule 1); tests boot an embedded PG16 binary, never SQLite/MySQL, never Docker.

Design of record: `docs/designs/001-database-schema.md` (Phase 1) and
`docs/designs/005-media-ledger.md` (Phase 2 ledger / Fix / Restore / sync tables).

## Package shape

- `src/schema/*` — Drizzle table + view declarations, re-exported from `src/schema/index.ts`.
  `src/index.ts` re-exports all of it plus the lazy `db` client.
- `src/index.ts` — `db` is a `Proxy` over a Drizzle client built lazily from `DATABASE_URL`
  on first property access, so importing `@hnet/db` never connects (CI builds and non-DB unit
  tests need no `DATABASE_URL`). Also exports `getPool()`, and the `Database` / `Transaction`
  / `DbClient` types the `@hnet/domain` writers accept.
- `src/migrate.ts` — `runMigrations({ databaseUrl, migrationsFolder? })` drives the Drizzle
  node-postgres migrator; idempotent (applied migrations are tracked in
  `drizzle.__drizzle_migrations`). Exported as `@hnet/db/migrate`.
- `src/scripts/migrate.ts` — thin CLI wrapper (`pnpm --filter @hnet/db migrate`); requires
  `DATABASE_URL`. This is the file the in-cluster migrate initContainer runs
  (`tsx /migrator/src/scripts/migrate.ts`, ADR-003).
- `migrations/NNNN_slug.sql` — the actual DDL, hand-authored. `migrations/meta/_journal.json`
  is the migrator's index of which files to apply (see below).
- `drizzle.config.ts` — for `drizzle-kit generate` only; points at `src/schema/index.ts`.

### The schema is NOT the source of migration DDL — read this before editing a table

Two mechanisms in this package look like they generate SQL but do NOT:

- **Enums are `text` columns + a CHECK constraint, not Postgres `enum` types.** `src/schema/enums.ts`
  const arrays (`ROLES`, `ARR_KINDS`, `LEDGER_EVENT_TYPES`, `FIX_TARGET_SCOPES`, …) are the
  single source of truth, wired into columns via `text(...).$type<...>()`. The DB-level CHECK
  is hand-written into migration SQL. Editing the const array changes the TS type but emits NO
  DDL — you must also write the `DROP CONSTRAINT` / `ADD CONSTRAINT` in a migration.
- **Views are `pgView(...).existing()`.** `effective_app_grants` (`src/schema/effective-app-grants.ts`)
  and `wanted_items` (`src/schema/wanted-items.ts`) declare only their row shape for query
  typing. `.existing()` means Drizzle emits no `CREATE VIEW` — the DDL is hand-written into
  migration SQL (0001 and 0003 respectively). Editing the TS view declaration changes nothing
  in the database.

Consequently the migration files are hand-audited SQL, not `drizzle-kit generate` output.
`generate` exists (`pnpm --filter @hnet/db generate`) but is at most a starting-point diff;
do not trust it to emit the CHECK/view/`.existing()` DDL, and never let it rewrite the journal.

## Adding a migration — the procedure

The migrator applies files in `_journal.json` order; **a `.sql` file NOT listed in the journal
is silently skipped**. This is the top footgun. Steps:

1. **Author `migrations/NNNN_slug.sql`.** Next zero-padded index after the last entry (current
   tail is `0006`). Separate independent statements with `--> statement-breakpoint`. Make it
   idempotent / safe on partially-migrated data where you can (`IF NOT EXISTS`, guarded
   `UPDATE` backfills) — see 0002 and 0005 for the pattern.
2. **Manually append a `meta/_journal.json` entry.** The file is a JSON object
   `{ "version": "7", "dialect": "postgresql", "entries": [...] }`; append one entry:
   ```json
   { "idx": 6, "version": "7", "when": 1782950406000, "tag": "0006_fix_target_scope", "breakpoints": true }
   ```
   `idx` = previous + 1; `tag` = the filename without `.sql`; `when` is a synthetic, strictly
   increasing epoch-ms (existing entries just step +1000ms from `1782950400000` — keep that
   convention, the real wall-clock value is irrelevant). Omit this entry and your migration
   never runs.
3. **New enum value** → in the SAME change: (a) add the value to the const array in
   `src/schema/enums.ts`, and (b) in the migration, `DROP CONSTRAINT` then `ADD CONSTRAINT`
   the CHECK with the full new value list (see `0004_search_requested_event.sql`). The CHECK
   list must exactly match the const array — they are asserted against each other by tests.
4. **New / changed view** → hand-write the `CREATE VIEW` (or `CREATE OR REPLACE VIEW`) in the
   migration and keep the `pgView(...).existing()` row shape in sync by hand. The canonical DDL
   for each view lives in a comment above its declaration in `src/schema/`.
5. **Seeding `app_catalog`** → any seeded `url` MUST satisfy the DB CHECK
   `app_catalog_url_haynesnetwork_only` (end-anchored `^https://[a-z0-9.-]+\.haynesnetwork\.com(/.*)?$`
   — CLAUDE.md hard rule 3, R-14). Never seed a `*.haynesops.com` URL; it will be rejected at
   INSERT. Seed guarded by `WHERE NOT EXISTS (SELECT 1 FROM app_catalog)` so admin edits win
   forever after (see `0002_seed_app_catalog.sql`).

## Applying migrations

- **Local / cluster CLI**: `DATABASE_URL=... pnpm --filter @hnet/db migrate`.
- **Tests**: never call the CLI. Use `@hnet/test-utils`' `withMigratedDb(fn)`, which boots an
  embedded PG16, runs `runMigrations`, invokes `fn(connectionString)`, and tears down. Every
  new migration is exercised by every test that uses it — so a journal you forgot to update, a
  CHECK that rejects a valid row, or a view whose columns drifted will fail the suite.
- **In-cluster**: a migrate initContainer runs `src/scripts/migrate.ts` from the shared GHCR
  image before the app starts (ADR-003; deploy details in `docs/ops/004-deploy-runbook.md`).

## Current migrations

| idx | tag | what |
| --- | --- | --- |
| 0 | `0001_init` | Phase 1 schema: users/session/account/verification, role transitions, app catalog (+ URL CHECK), user/tag app grants, tags, permission audit, `effective_app_grants` view. |
| 1 | `0002_seed_app_catalog` | First-deploy-only catalog seed (guarded by `NOT EXISTS`). |
| 2 | `0003_media_ledger` | Phase 2: `media_items`, `ledger_events`, `fix_requests`, `restore_runs`, `sync_runs`, `sync_state`, and the `wanted_items` view. |
| 3 | `0004_search_requested_event` | Adds `search_requested` to the `ledger_events` event-type CHECK (Force Search — D-17). |
| 4 | `0005_unaccent_search` | `CREATE EXTENSION IF NOT EXISTS unaccent` for accent-insensitive library search. |
| 5 | `0006_fix_target_scope` | `fix_requests.target_scope` / `target_season` (+ CHECKs) for season roll-up Fixes (D-09). |
