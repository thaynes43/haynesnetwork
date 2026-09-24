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
  - **Scriptable download queue (ADR-028 action feedback).** `GET /queue` serves records
    you stage via `POST <stub-arr>/_stub/queue` with `{"records": [...]}` (empty by
    default; `POST /_stub/reset` clears it). To demo a Fix advancing live, submit a Fix in
    the UI and re-stage the same record with a shrinking `sizeleft`
    (queued → downloading → `trackedDownloadState:"importing"` → empty-after-import) —
    the dialog/item/My-Fixes surfaces walk the phases as they poll. Join keys:
    `seriesId`+`episodeId` / `movieId` / `artistId`+`albumId`. The harness also shortens
    the found-nothing window to 30 s (`ACTION_FOUND_NOTHING_WINDOW_MS`; prod default
    15 min) so the `nothing_found` terminal is reachable while you watch.
- **Stub Bazarr** (a second HTTP server; `BAZARR_URL` points at it) serves the
  subtitle-state reads and accepts the `search-missing` PATCH, so the **missing-subtitles
  Fix** (ADR-016 / DESIGN-005 D-19) runs end-to-end without a real Bazarr. It records its
  writes at `/_stub/calls` just like the stub *arr.
- **Stub Prometheus** (`PROMETHEUS_URL` points at it; ADR-030 C-04 amendment 2026-07-09)
  synthesizes the exportarr free-space matrix across any `query_range` window, so the
  Storage tab's **native free-space trend chart** renders full 7d–1y lines locally.
  `POST <stub-prometheus>/_stub/state` with `{"mode":"down"}` flips it unreachable (the
  chart's `unavailable` degrade); `{"mode":"ok"}` restores it.
- **Stub Gatus** (`GATUS_URL` points at it; ADR-079 / DESIGN-004 D-25) serves the apex
  check's plain-text uptime ratios + JSON statuses, so the Home **uptime badge** renders
  its up state locally. `POST <stub-gatus>/_stub/state` with `{"mode":"down"}` /
  `{"mode":"unreachable"}` walks the badge's danger / honest-"unmeasured" states;
  `POST <stub-gatus>/_stub/reset` restores the healthy default. The harness sets
  `UPTIME_BADGE_TTL_MS=0` so a flip is visible on the next reload.
- **Stub Tautulli** (ADR-088 / PLAN-068 S3; `TAUTULLI_URL`, `TAUTULLI_K8PLEX_URL` and
  `TAUTULLI_HAYNESTOWER_URL` all point at one server, told apart by their keys) serves each
  instance's `get_history` — the owner's rows (plex.tv id 12874060) plus a household member's and a
  friend's, honoring `user_id` / `after` / `start` / `length` / `order_dir`, plus a playing session
  with no row id unless `include_activity=0` — and `get_metadata` (HTTP 400 for a deleted item, like
  current Tautulli). It deliberately does not serve `get_libraries_table`, so the Home play scoreboard
  stays hidden, as before the stub was wired.
- **Stub Plex watch state** (same PLAN-068 stage): the owner's movies on HaynesOps and movies + TV on
  HaynesTower carry watch fields; `allLeaves`, `/library/all?guid=`, the section filters and the
  plex.tv watchlist (`PLEX_DISCOVER_URL` points at the stub) are served; a watch item answers only to its
  own server's token. `/:/scrobble` and `/:/unscrobble` are recorded at `/_stub/calls` and flip an
  in-memory watch map every read overlays; `POST /_stub/reset` restores the seed.
  PLAN-068 S8 widened the owner's local history: Breaking Prod in progress (its special unwatched),
  Stub Expanse fully watched, Stub Big Brother a Taster (1 of 12), Stub Toons a children's show, Stub
  Runner a movie in progress, and a watchlist of Stub Severance (unwatched, on stub HaynesTower), Stub Dune
  (not on Plex) and Stub Runner.
- **Watch Companion MCP** (ADR-087 / DESIGN-049; PLAN-068 S8). After the stack is up, `dev:local` (not the
  e2e harness) runs a one-row demo seed (`e2e/support/seed-watch-demo.ts`: Stub Severance's Sonarr ledger
  row + Plex match, so `recommend` has an on-Plex pick) and then the real `--mode=watch` sync once against
  stub Plex + stub Tautulli. `POST /api/mcp` answers with the local consumer token
  `local-dev-mcp-hop-token` (`HNET_MCP_HOP_TOKEN` in the stack env; the banner prints it):

  ```bash
  U=http://localhost:3000/api/mcp
  H=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -H 'authorization: Bearer local-dev-mcp-hop-token')
  curl -si "${H[@]}" $U -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
  curl -s "${H[@]}" $U -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | wc -c
  call() { curl -s "${H[@]}" $U -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":${2:-{\}}}}"; }
  call unfinished; call recommend; call watch_status '{"title":"stub expanse"}'
  call mark_watched '{"title":"stub severance"}'; call undo_last_change
  ```

  Expect: no `Mcp-Session-Id` header on initialize; `tools/list` 2,712 bytes; "One unfinished show.
  Breaking Prod: 4 of 5 watched, next is season 2 episode 2, …"; "One pick on Plex. Stub Severance, a 2022
  show, on your watchlist. Not on Plex yet: Stub Dune, …"; the mark answers "Marked Stub Severance (2022) as
  watched in Plex, all 3 episodes." and `GET <stub-plex>/_stub/calls` records `/:/scrobble` key 506 on
  haynestower, the undo `/:/unscrobble` key 506. GET / DELETE on `/api/mcp` answer 405; a missing or wrong
  bearer 401 with `WWW-Authenticate: Bearer`. Every call logs one `[mcp] tool_called` line (no arguments,
  no results). To re-run the sync against the running stack: `DATABASE_URL=<the stack's>` plus the stack's
  `PLEX_*` / `TAUTULLI_*` env, then `pnpm --filter @hnet/sync sync -- --mode=watch` (the banner prints the
  database URL). Nothing here ever reaches a real Plex server.
- **Public MCP connectors** (ADR-091 / DESIGN-050; PLAN-069). `POST /mcp` takes only delegated OAuth
  tokens; a local client can walk the whole flow against the stub OIDC with curl alone (verified 2026-09-23,
  port 3200 — substitute yours). Type `plex-linked-owner-id` at the `dev:local` terminal first (or `POST
  <stub-oidc>/_control/user {"persona":"plex-linked-owner-id"}`): its `plex_user_id` claim maps it to the
  tracked owner account on sign-in, so the tools answer from the seeded history. Any other persona connects
  too and every tool answers "Watch history isn't set up for your account yet."

  ```bash
  APP=http://localhost:3000; J=jar.txt; rm -f $J
  curl -si $APP/.well-known/oauth-protected-resource        # 200, CORS *, public max-age=3600
  curl -si $APP/.well-known/oauth-authorization-server      # 200
  CID=$(curl -s -X POST $APP/oauth/register -H 'content-type: application/json' \
    -d '{"client_name":"Local client","redirect_uris":["http://127.0.0.1:8765/callback"]}' | jq -r .client_id)   # 201
  VER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | cut -c1-64)
  CH=$(printf %s "$VER" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')
  AUTHZ="$APP/oauth/authorize?response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback&state=s1&code_challenge=$CH&code_challenge_method=S256"
  NEXT=$(curl -s -o /dev/null -w '%{redirect_url}' "$AUTHZ" | sed 's/.*next=//' | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))')
  # Sign in (Better Auth → stub OIDC → callback), landing back on NEXT:
  URL=$(curl -s -c $J -b $J -X POST $APP/api/auth/sign-in/oauth2 -H 'content-type: application/json' \
    -H "origin: $APP" -d "{\"providerId\":\"authentik\",\"callbackURL\":\"$NEXT\"}" | jq -r .url)
  curl -s -c $J -b $J -o /dev/null "$(curl -s -o /dev/null -w '%{redirect_url}' "$URL")"
  CONSENT=$(curl -s -b $J -o /dev/null -w '%{redirect_url}' "$AUTHZ")      # → /oauth/consent?txn=…
  curl -s -b $J "$CONSENT" > consent.html                                   # "Connect Local client", the host
  ```

  Approve without JavaScript: the consent form is progressively enhanced, so POST the Approve button's
  hidden fields (`$ACTION_REF_n`, `$ACTION_n:0` with the action id, `$ACTION_n:1` = `["approve","<txn>"]`,
  read from `consent.html`) as multipart to `$CONSENT` with `-H "origin: $APP"`; the answer is a 303 to
  `http://127.0.0.1:8765/callback?code=…&state=s1`. Then exchange the code at `/oauth/token`
  (`grant_type=authorization_code`, `code`, `code_verifier=$VER`, `client_id=$CID`) and call
  `POST $APP/mcp` with `Authorization: Bearer <access_token>`. Expect: `tools/list` 2,712 bytes; `unfinished`
  "One unfinished show. Breaking Prod: 4 of 5 watched, …"; `/mcp` without a token 401 with
  `WWW-Authenticate: Bearer resource_metadata="<app>/.well-known/oauth-protected-resource"` (a presented but refused
  token adds `error="invalid_token"`); GET `/mcp` 405; the OAuth token at `/api/mcp` 401 (`WWW-Authenticate:
  Bearer`) and the hop token at `/mcp` 401; an authorize request with a parameter error (say
  `code_challenge_method=plain`) goes to `/login?next=` when signed out and renders the bad-request page when signed
  in — never a redirect to the client; a refresh
  narrowed to `watch:read offline_access` lists four tools and a `mark_watched` call answers 403
  `insufficient_scope` with `scope="watch:write"`; replaying the spent refresh token is `invalid_grant` and kills the family (the newest
  access token turns 401); the eleventh registration from one IP in an hour is 429 with `Retry-After` and
  `{"error":"rate_limited"}`. The dev server logs one `[auth] <event> {…}` line per step and never a token,
  code or verifier. Connected apps is at `/settings/connections` (sign in through the browser to Disconnect).
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
