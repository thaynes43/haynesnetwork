# PLAN-063: Rate-limit storage — in-memory → database (shared across replicas)

- **Status:** 🚧 **IN PROGRESS** (PR open; docs + code + tests green locally; NOT merged — the
  coordinator sequences merges/releases). Docs of record:
  [DESIGN-002 D-14](../../docs/designs/002-auth-and-authentik.md) (dated amendment 2026-07-28).
- **Number note:** 063 assigned by the coordinator (numbers are stable, never reused — this folder's
  README). This app-side leg executes haynes-ops saga **haynesnetwork-ha** plan 05
  ([backlog/05-shared-rate-limit-storage.md](https://github.com/thaynes43/haynes-ops/blob/main/.agents/sagas/haynesnetwork-ha/backlog/05-shared-rate-limit-storage.md)).
  Saga statuses are owned by the coordinator; this plan does not edit saga files.
- **Depends on:** nothing. Correct before or after the app goes to 2 replicas (saga plan 02); the
  window where limits are ×N is accepted per the saga. Parallel with saga plans 01/03/06.

## The problem

`packages/auth/src/config.ts` sets the Better Auth `rateLimit` window/max/customRules but no
`storage`, so better-auth defaults to **in-memory buckets**. better-auth 1.6.23's memory store is a
**module-level `Map` created once per process** (`dist/api/rate-limiter/index.mjs:6`), so each pod
keeps its own bucket set. The moment the app runs more than one replica (saga plan 02 → 2 replicas),
the replicas count independently and the effective limit multiplies by N — throttling becomes
inconsistent per client and fails open. DESIGN-002 D-14 and backlog-recon **O-5** flagged exactly
this for the day the app scales past one replica.

## Scope — the behavior spec

Point better-auth's rate limiter at shared Postgres so all replicas enforce ONE combined limit,
preserving the existing budget and IP/customRules behavior.

- `rateLimit.storage: 'database'` in `packages/auth/src/config.ts`. `window` (60s), `max` (100),
  `customRules['/sign-in/oauth2'] = { window: 60, max: 10 }`, `enabled` (prod-only), and the
  `advanced.ipAddress` header order are all **unchanged**.
- A `rate_limit` table in `@hnet/db` matching better-auth 1.6.23's `get-tables` default for the
  `rateLimit` model (`@better-auth/core/db/get-tables.ts`, gated on `storage === 'database'`):
  `key` (unique bucket key `ip|path`), `count` (int), `last_request` (bigint epoch-ms). `id` is a
  `uuid` to match the other Better Auth tables under `advanced.database.generateId: 'uuid'`.
- Registered on the drizzle adapter under the model key **`rateLimit`** — the adapter resolves the
  table by `schema[model]` (`@better-auth/drizzle-adapter` `getSchema`), and indexes fields by the
  better-auth field name (`key`/`count`/`lastRequest`), so the Drizzle property keys must be those.
- Runtime path: better-auth's DB storage wrapper uses the **atomic `incrementOne`** the drizzle
  adapter implements (single `UPDATE … SET count = count + 1 … WHERE count < max RETURNING`), so
  concurrent requests across replicas cannot each pass a stale read — strict enforcement, not
  best-effort. The added cost is one indexed upsert **only on rate-limited `/api/auth` paths**; the
  app's hot paths never touch the table.

**Verified against the installed better-auth (1.6.23), not from memory:** option surface
(`storage: 'memory' | 'database' | 'secondary-storage'`, model `rateLimit`, fields
`key`/`count`/`lastRequest`) read from `@better-auth/core` source; `incrementOne` presence + shape
read from `@better-auth/drizzle-adapter` source; `id`-column requirement (idColumn in `incrementOne`)
and `uuid` id (via the app's `generateId: 'uuid'`) confirmed.

## DB (`@hnet/db`)

- `src/schema/rate-limit.ts` — new `rateLimit` Drizzle table (`rate_limit`), re-exported from
  `src/schema/index.ts`. Property keys `key`/`count`/`lastRequest` (the better-auth field names);
  `last_request` is `bigint({ mode: 'number' })`; `key` unique; index on `last_request` (the
  pruner scans it).
- `migrations/0072_auth_rate_limit.sql` + `meta/_journal.json` idx 71 — hand-authored SQL per the
  package README (the schema TS never emits DDL here). `CREATE TABLE IF NOT EXISTS` + the unique
  constraint + the `last_request` index. Down: `DROP TABLE` (no dependents; buckets self-recreate).
- **Not** added to the `no-direct-state-writes` guard: `rate_limit` is library-managed operational
  state written only by better-auth's own adapter — not a role/permission/ledger single-writer
  table, and it has no audit surface. (Its test-only direct writes are legitimate for the same
  reason.)

## Auth (`packages/auth`)

- `src/config.ts` — import `rateLimit` from `@hnet/db`; add `storage: 'database'` to the
  `rateLimit` block; add `rateLimit` to the `drizzleAdapter` `schema` map.

## Tests

- `packages/auth/__tests__/rate-limit-shared.test.ts` (new) — two Better Auth instances (own pools,
  standing in for two replicas) over ONE embedded Postgres 16, both `storage: 'database'`, `max: 4`:
  1. Budget of 4 split 2-through-A + 2-through-B; the 5th combined request 429s on **either** →
     ONE combined limit.
  2. Exactly one `rate_limit` row (`<ip>|/ok`) holds the combined count (== max) → the count lives
     in Postgres, not per-instance memory.
  3. Deleting that one shared row in the DB frees **both** instances at once → both derive their
     decision from the single shared row (the substrate a separate replica also reads).

  Why this is a faithful cross-replica proof despite running in one process: with
  `storage: 'database'` the limiter keeps **zero** per-instance state (every consume hits the DB),
  so two in-process instances behave exactly like two pods on one DB. (The default `memory` store,
  by contrast, is a per-process `Map` — which is the multiply-by-N bug being fixed. This was
  confirmed empirically with a throwaway `memory`-storage variant during development.)
- `packages/auth/__tests__/config.test.ts` — asserts `rateLimit.storage === 'database'` and that
  the window/max/customRules budget is unchanged by the flip.

## Quality gates

`pnpm typecheck && pnpm lint && pnpm test` green (auth + db + api + full workspace); `pnpm lint:css`
and `pnpm build` also green (local merge-gate parity with CI `lint-and-typecheck` / `test` / `build`).
`pnpm --filter web e2e`: the sign-in e2e specs (`apps/web/e2e/auth.spec.ts`) run under `next dev`
where `rateLimit.enabled` is **false** (prod-only), so this change is inert on that lane and cannot
regress it; the advisory e2e lane in CI exercises it regardless.

## O-5 closure

This plan closes backlog-recon **O-5** ("Rate-limit storage in-memory → database if the app ever
scales past one replica", `.agents/context/2026-07-05-backlog-recon.md`). That recon file is a dated
point-in-time snapshot whose O-items are not marked closed even when done (e.g. O-1 root-domain
cutover, O-3 cosign both shipped and remain un-annotated there) — the convention is to **not** edit
that history — so O-5's closure is recorded here and in the DESIGN-002 D-14 amendment rather than in
the recon note.

## Rollout

1. **This repo:** branch → PR → required checks (`lint-and-typecheck`, `test`, `build`) green →
   squash-merge → release-please cuts a `fix` patch. DO NOT MERGE until the coordinator sequences it.
2. **Deploy:** the migrate initContainer (ADR-003) applies `0072` before the app starts; no
   haynes-ops change is required for this leg beyond the normal image-tag bump on release. The
   2-replica bump itself is saga plan 02 (haynes-ops), independent of this leg.
