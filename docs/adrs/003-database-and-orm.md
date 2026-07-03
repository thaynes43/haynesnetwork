# ADR-003: PostgreSQL 16 (CNPG) + Drizzle, migrator init container, audit-in-transaction

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

The app persists users/roles, the app catalog, permissions and tags, the media ledger, fix
requests, and audit history — relational, transactional data (PRD-001 R-04, R-11, R-40..R-46).
The haynes-ops cluster already runs a CloudNativePG Postgres 16 cluster
(`postgres16-rw.database.svc.cluster.local:5432`), and todos-for-dues already pairs it with
Drizzle and an init-container migration runner. We must pick the engine, the TypeScript
persistence layer, the migration mechanism, and the discipline that makes audit rows
impossible to skip.

## Decision drivers

1. Use the database that already exists in the cluster — no new stateful service (R-62, R-63).
2. Schema-as-TypeScript that agents read like any other source (ADR-001's strict-TS graph).
3. Migrations applied before app start, from the same artifact that runs the app.
4. R-04 is a hard rule: role/permission mutations and their audit rows commit atomically.
5. No Docker in the local WSL distro → tests need Postgres without containers.

## Considered options

- **Option A** — PostgreSQL 16 (CNPG) + Drizzle ORM, cloning todos-for-dues.
- **Option B** — PostgreSQL 16 + Prisma.
- **Option C** — SQLite/MySQL anywhere (including as a test stand-in).

## Decision outcome

Chosen option: **Option A — PostgreSQL 16 on the existing CNPG cluster with Drizzle ORM** —
because the database is already operated, the donor's Drizzle integration (including the
Better Auth adapter, ADR-002) is proven, and schema-as-TS keeps one language end to end.
Prisma re-litigates a call the donor's ADR-004 already made against it (heavier runtime,
separate DSL). Option C is forbidden outright: Postgres-specific SQL (`gen_random_uuid()`,
`citext`, transactional DDL) must never be papered over by a lookalike engine — CLAUDE.md
hard rule 1.

Configuration of record:

- **Engine:** PostgreSQL 16, CNPG cluster `postgres16-rw.database.svc.cluster.local` in the
  haynes-ops cluster; app credentials via External Secrets + 1Password (R-63).
- **ORM:** Drizzle; schema in `packages/db` (ADR-001 layout); Better Auth uses the Drizzle
  adapter against the same database (ADR-002).
- **Migrations:** raw SQL files checked into git, applied by a **migrator init container
  that runs the same image** as the app (todos-for-dues pattern) — the web process never
  migrates, and app and schema version together (R-62).
- **IDs:** `uuid` primary keys defaulting to `gen_random_uuid()`.
- **Tests:** real Postgres via an embedded Postgres binary (no Docker locally); never
  SQLite/MySQL substitution anywhere, tests included.
- **Audit-in-transaction:** every role/permission mutation co-writes its audit row (e.g.
  `user_role_transitions`, AC-03) in the same transaction. Mutations go through
  **single-writer helpers in `packages/domain`**; a CI test forbids direct writes to the
  guarded tables from anywhere else (pattern borrowed from todos-for-dues).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: no new stateful infrastructure — backups, monitoring, and failover ride the existing CNPG operator. |
| C-02 | Good: same-image migrator init container guarantees schema/app lockstep and reuses the donor's deploy manifests (R-63). |
| C-03 | Good: audit rows cannot drift from mutations — atomicity is structural (single-writer helper + transaction), not conventional (R-04, AC-05). |
| C-04 | Good: embedded-Postgres tests exercise real Postgres semantics (constraints, `gen_random_uuid()`, transactional behavior) in CI and locally. |
| C-05 | Bad: the single-writer guard is enforced by a CI test, not the type system — new guarded tables must be added to the forbid-list as they appear (tags, app grants, library allowances). |
| C-06 | Bad: shared CNPG cluster means noisy-neighbor risk with other apps' databases; acceptable at family scale. |
| C-07 | Bad: embedded Postgres binaries add download weight and platform quirks to test setup; mitigated by `packages/test-utils` owning the harness once (ADR-001). |
| C-08 | Note: ledger sync tables (R-40..R-42) follow the same schema conventions but their write-path (sync jobs, not user mutations) is a design-doc concern, not decided here. |

## More information

- PRD-001: R-04, R-62, R-63; AC-03, AC-05.
- CLAUDE.md hard rules 1 (Postgres only) and 6 (audit-in-transaction).
- Kickoff environment facts: CNPG endpoint, postgres-init initContainer pattern, no Docker.
- Donor rationale: `../todos-for-dues/docs/adrs/004-db-and-orm.md`.
- Sibling ADRs: ADR-001 (package layout), ADR-002 (Drizzle adapter, bootstrap audit row),
  ADR-004 (procedures call `packages/domain` helpers).
