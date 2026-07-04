# OPS-003: Local verification runbook (verify a change before it ships)

- **Status:** Accepted (2026-07-04)
- **Feeds:** every PR (the merge gate below IS the CI contract); ADR-009 (CI jobs),
  ADR-010 (test strategy)

**Run this top-to-bottom before you push.** No Docker exists in this WSL distro and
there is no live cluster on your machine — everything here runs against an embedded
Postgres 16 binary and in-process stubs. Do NOT touch the sibling `haynes-ops` repo (the
deploy runbook, OPS-004) until this passes locally. Deploy is a manual image-tag bump in
`haynes-ops`; shipping a red change wastes a full Flux reconcile to find out.

## 0. Prerequisites (one-time)

- **Node >= 22, pnpm >= 11** (`package.json` engines; repo is pinned to `pnpm@11.9.0`).
- `pnpm install` at the repo root — pnpm workspace, apps in `apps/*`, packages in
  `packages/*` (`@hnet/*`, raw TS, no per-package build).
- **`@embedded-postgres/linux-x64` MUST be in `allowBuilds`** in `pnpm-workspace.yaml`.
  Its postinstall re-creates the `lib`/`bin` symlinks that npm tarballs cannot carry; if
  the entry is missing or `pnpm install` ran with builds blocked, the PG binary is
  present but **non-functional** — every DB-touching test dies in `initdb`/`start`
  (`startPostgres` in `packages/test-utils/src/postgres.ts` retries 3× then throws). Fix
  by restoring the allowBuilds entry and re-running `pnpm install`.

## 1. The merge gate (map 1:1 to CI)

Run these five commands, in order. They reproduce exactly what the required CI checks
enforce (ADR-009). A PR cannot merge unless all three required jobs are green;
`main` is branch-protected (linear history, squash-merge only).

```
pnpm lint        # ESLint 9 flat config, pnpm -r lint          ┐
pnpm lint:css    # scripts/lint-css-hex.mjs (hard rule 2)      ├─ CI job: lint-and-typecheck
pnpm typecheck   # tsc --noEmit, pnpm -r typecheck             ┘
pnpm test        # pnpm -r test (Vitest per package)           ── CI job: test
pnpm build       # pnpm -r build (next build, standalone)      ── CI job: build
```

- The three required CI checks are **`lint-and-typecheck`, `test`, `build`**. The single
  `lint-and-typecheck` job runs `lint` + `lint:css` + `typecheck`; run all three locally.
- `pnpm lint:css` is the hard-rule-2 guard: no raw hex outside
  `packages/ui/src/theme/tokens.css`. Adding a color token means editing BOTH theme blocks
  AND `REQUIRED_TOKENS` in `tokenContract.ts`, or the token-contract test fails.
- **`e2e` is advisory, NOT a required check** (ADR-009 / ADR-010 C-07) — it does not block
  merge and is not in the five commands above. Run it (§5) when your change touches auth,
  routing, the dashboard/library/fix UI, or the resize matrix. It stays advisory until the
  hardening window closes; the Phase-1 e2e gate (R-64) still blocks the public cutover
  (OPS-005).

If all five pass you are clear to open the PR. Conventional-commit PR titles
(`feat:`/`fix:`/`feat!:`) drive release-please versioning.

## 2. Unit / integration tests (`pnpm test`)

`pnpm test` = `pnpm -r test`; each package runs its own `vitest run`. There is **no root
vitest config** — configs are per package (`packages/*/vitest.config.ts` and
`apps/web/vitest.config.ts`). `apps/web` includes only `lib/__tests__/**/*.test.ts`;
packages include `__tests__/**/*.test.ts`. Packages with no tests run
`vitest run --passWithNoTests` (e.g. `@hnet/test-utils`).

DB-touching layers boot a **real embedded Postgres 16** — never SQLite/MySQL (hard rule 1,
ADR-010). The binary is pinned to `16.14.0-beta.17` (`embedded-postgres` in
`packages/test-utils/package.json`) to match the cluster's CNPG PG16. Each integration run
calls `startPostgres()` → a throwaway data dir + free localhost port
(`initdb → start → createdb hnet_test`), then `withMigratedDb()` applies the real
`@hnet/db` migrations before the test body and tears the server down after (also on
failure).

What to expect:

- **First run is slow** and the DB-heavy suites use long hooks: `hookTimeout: 180_000`,
  `testTimeout: 60_000` (the `beforeAll` does `initdb` + `start` + migrate). Timeouts here
  usually mean a slow/cold machine or a wedged prior PG process, not a real failure — just
  re-run. CI caches the binary (ADR-010 C-05).
- **The `./postgres` subpath import gotcha:** import the DB lifecycle from
  `@hnet/test-utils/postgres`, NOT the package index, from anything that runs under a CJS
  TS loader (Playwright's transform, tsx subprocesses). The index barrel re-exports
  `withMigratedDb`, which imports `@hnet/db/migrate`; that module uses `import.meta`, which
  is invalid under the CJS transform and throws at load. Vitest (ESM) can use either entry;
  the e2e harness deliberately imports only `@hnet/test-utils/postgres` and runs migrations
  out of process (see §5).

Run a single package while iterating, e.g. `pnpm --filter @hnet/domain test` or
`pnpm --filter @hnet/db test`.

## 3. Interactive local run (`pnpm dev:local`)

The hands-on way to exercise the real UI with no Docker, no Authentik, no cluster, and no
real credentials. `pnpm dev:local` (`apps/web/dev/local.ts`) boots the **exact stack the
e2e suite uses** — embedded PG16 → real migrations + catalog seed → stub OIDC → stub *arr →
`next dev` — but long-running, on **port 3000** (`http://localhost:3000`).

- **Sign in** with the normal button. Which persona the stub OIDC mints is selected by
  **typing the persona name + Enter at the terminal** (sticky until changed):
  - `admin` → `bootstrap-admin@example.test` (promoted to Admin on login — bootstrap
    allowlist; roles are `Member`/`Admin`)
  - `member` → `member@example.test` (plain Member; the stub default)
  - `fresh-member` → `fresh-member@example.test` (never-granted first-login experience)
- **Stub *arr** (one HTTP server standing in for Sonarr/Radarr/Lidarr/Seerr — all four
  URLs point at it) serves fixture-shaped read endpoints and records the sanctioned writes,
  so you can drive the dashboard, library browse/detail, and the fix / force-search /
  restore flows end-to-end. The seeded Sonarr row is series 501 "Breaking Prod", 9/10
  episodes on disk (mirrors the stub).
- Everything is **throwaway**: the database is a temp dir deleted on Ctrl-C; restart for a
  pristine seeded catalog.
- Phone/tablet/PC layouts: use the browser devtools device toolbar.

Use this to eyeball a change; use §5 to prove it deterministically.

## 4. Local merge-gate summary

Green on §1's five commands = you match the required CI checks. Do §2 understanding
(embedded PG16, per-package configs) if a test misbehaves. Do §3/§5 for anything with a
runtime UI or auth surface.

## 5. e2e (`pnpm --filter web e2e`) — advisory, but run it for UI/auth changes

Playwright over the same harness as `dev:local`, on **port 3100** (so it coexists with a
`pnpm dev`/`dev:local` on 3000). `baseURL` is `http://localhost:3100`, kept in sync with
`DEFAULT_APP_PORT` in `e2e/support/env.ts`.

### Harness architecture (know this before debugging a flake)

- **The stack boots in Playwright's `globalSetup`, NOT its `webServer` block.** Playwright
  starts `webServer` BEFORE `globalSetup` runs, so a `webServer` would launch with a stale
  env — missing the embedded PG's `DATABASE_URL` and the stub's `OIDC_DISCOVERY_URL`, which
  only exist once the harness has booted. `global-setup.ts` calls `startStack()`
  (`harness.ts`), which does: `startPostgres()` → migrations as a **subprocess**
  (`pnpm --filter @hnet/db migrate`) → **seed-ledger as a `tsx` subprocess**
  (`e2e/support/seed-ledger.ts`) → stub OIDC → stub *arr → `spawn` `next dev`. Migrations
  and seed run out of process for the CJS-transform reason in §2 (the harness imports only
  `@hnet/test-utils/postgres`). `seed-ledger.ts` writes THROUGH the `@hnet/domain` single
  writers, never direct table writes (the no-direct-writes guard scans it too).
- **Env handoff via a file.** Test workers do not reliably inherit `process.env` mutations
  made in `globalSetup` across Playwright versions, so `globalSetup` writes the composed
  env to `apps/web/.playwright-tmp/env.json` (`writeRuntimeEnv`); workers read it back with
  `readRuntimeEnv()`. `global-teardown.ts` removes the dir.
- **Serial, sticky, shared.** `workers: 1`, `fullyParallel: false` — ONE app instance + ONE
  database whose rows are the personas' real state (repeat-login AC-03 depends on it), and
  the stub OIDC's persona selection is process-global and sticky (not consume-once). Specs
  mutate shared state (catalog, grants, tags); serial keeps it deterministic. CI retries
  once to absorb cold-runner jitter; locally retries are 0.
- **STRICT stub *arr eventType assertion.** The stub's paged `GET /history` rejects any
  non-integer `eventType` with the real ASP.NET `ValidationProblemDetails` 400 body — the
  real *arr binds `eventType` to the INTEGER `*HistoryEventType` enum (`grabbed === 1`, see
  `@hnet/arr` `SONARR_GRABBED_EVENT_TYPE`), and the lowercase string it returns in bodies
  is rejected on the way back in. This is the guard for the `fix/history-eventtype-enum`
  prod bug: if fix code sends `eventType=grabbed` again it will 400 in e2e, not in
  production.

Run it: `pnpm --filter web e2e` (or `pnpm e2e` from root). First run is slow — the harness
waits up to 180s for `next dev` and prewarms every user-facing route so first-hit compile
lag doesn't eat a per-test timeout. If it hangs on boot, check for a stale process holding
port 3100 or a leftover embedded-PG under the temp dir.
