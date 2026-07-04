# 2026-07-04 — Archived wave-by-wave build log (waves 1–11, up to v0.3.1)

Historical record moved out of `.agents/HANDOFF.md` when it was compacted into a clean
single resume point. This is the verbatim per-wave narrative + the historical gotcha list
covering bootstrap through v0.3.1 (Phase 1 + Phase 2 complete and deployed). Preserved for
provenance; current state lives at the top of `.agents/HANDOFF.md`.

---

> **Wave 11 (fix/action-consistency):** Owner UX-consistency ruling (2026-07-04, after testing v0.3.0). **Uniform availability rule** now applied at every repairable grain (movie item / episode / season / album): **on disk → BOTH Fix and Force Search; missing → Force Search only**; whole-show / whole-artist roll-ups stay **Force-Search-only**. This ADDED Force Search to on-disk movies/episodes/albums (the header/child rows previously exposed only Fix on disk). **No backend change** — `resolveSearchTarget` already allows every scope and `runForceSearch` has no on-disk gate, so force-search of an on-disk item/episode/album was always accepted server-side (verified against action-scope.ts + fix.test.ts). **Library LIST tiles + wanted rows are now action-free** (owner screenshot: buttons made tiles irregular / misclick-prone) — badges kept, whole tile is a click-through to `/library/[id]` where all actions live. Touched: `apps/web/app/(app)/library/page.tsx` (removed listAction + dialogs), `library/[id]/item-detail.tsx` (radarr header + child rows now render the Fix+Force-Search pair), `app.css` (dropped `.media-row*`, added `.child-row__actions`, `.detail-head__actions` flex-wrap, `.child-row` wraps; tokens-only). e2e `library.spec.ts`: asserts the list has no buttons, on-disk episode shows both actions, + new spec drives Force Search on the on-disk movie "The Fixture" (MoviesSearch, no blocklist/delete). DESIGN-005 D-15 amendment note added.

> **Wave 10 (feat/hierarchy-actions):** Media-hierarchy actions — Fix / Force Search gained a **scope** (packages/domain `action-scope.ts`, one shared `resolveFixTarget`/`resolveSearchTarget`). Force Search now rolls up to whole **show** (SeriesSearch), **season** (SeasonSearch), **artist** (ArtistSearch) on top of episode/album/movie; Fix rolls up to a whole sonarr **season** (`runSeasonFix`: blocklist every distinct backing grab of the season's on-disk episodes → SeasonSearch, AC-08 delete fallback; reuses the per-target grab lookup so it inherits the integer-eventType fix from the hotfix below). Whole-show/artist Fix is deliberately Force-Search-ONLY (blocklisting a whole series/discography is too broad — judgment call). Migration `0006` adds `fix_requests.target_scope` (`item|season|episode|album`) + `target_season`; open-fix dedupe now keys on scope+season. `ledger.children` returns `seasonNumber`; the sonarr detail view groups episodes into collapsible season sections (phone-width touch targets) with per-season Force Search + Fix; lidarr adds a whole-artist Force Search. New glossary term T-45 Action Scope. Owner discrepancy flagged: "per Song" → implemented at album grain (D-06 fixed Lidarr at the album). Rebased onto the hotfix below; full suite green (361 unit/integration + 45 e2e).

> **Hotfix (fix/history-eventtype-enum):** Paged `GET /history` grab lookups were sending
> `eventType=grabbed` (string) — Sonarr/Lidarr bind that param to the INTEGER
> `*HistoryEventType` enum and 400'd live (`grabbed`=1). Fix: `@hnet/arr` now sends the
> integer (`SONARR_GRABBED_EVENT_TYPE`/`LIDARR_GRABBED_EVENT_TYPE` = enum index) for
> `getEpisodeGrabHistory`/`getAlbumGrabHistory`; Radarr's tolerant `/history/movie` path is
> unchanged (proven live 200). The *arr stubs (e2e `stub-arr.ts` + api `arr-stubs.ts`) are
> now STRICT — a non-integer `eventType` on paged `/history` returns the real 400
> ValidationProblemDetails so this class of bug fails CI forever. Response-side zod keeps
> the string form. Verified read-only 2026-07-03: `?eventType=1` → 200 `records[0].eventType
> === 'grabbed'` on Sonarr/Radarr/Lidarr, and the fixed client hits HTTP 200 for the owner's
> failing episode 49130. DESIGN-005 D-02/D-03/D-15 updated. Also fixed the Fix dialog
> error-space UX: Modal now pins head + a dedicated aria-live alert `banner` slot and
> scrolls ONLY the body (`.modal__body`), so an error no longer squeezes the reason list
> into a cut-off scrollbox (tokens-only CSS).

> **Wave 9 (fix/fix-flow-ux):** Fix-flow UX pass — Modal focus-steal fixed (focus effect keyed on `open` only, not the unstable `onClose`); Fix is now per-episode/per-album on `/library/[id]` (live `ledger.children` list, no show-level nuke); missing content gets **Force Search** (search-only: `fix.forceSearch` → `runForceSearch`/`recordSearchRequest`, new `search_requested` ledger event, migration `0004`, shares the Fix hourly budget). UI rule everywhere: on disk → Fix, not on disk → Force Search. New glossary term T-44.

## Where things stand (wave 8 — fix & ledger UI)

- Phase 2 (feat/fix-and-ledger-ui): the user-facing surface over the ledger — DESIGN-005
  D-17 routers `ledger`/`fix`/`restore` in @hnet/api (cursor pagination, six new
  appCodes wired through mapDomainErrors + errorFormatter), the D-15 fix orchestration
  and D-16 restore diff/execute as @hnet/domain orchestrators (`runFixRequest`,
  `computeRestoreDiff`/`executeRestore` — the mutating *arr entrypoint stays
  domain-only, now ENFORCED by `packages/domain/__tests__/arr-write-import-guard.test.ts`),
  read-surface additions in @hnet/arr (episode/album lists, per-target grab history,
  trackfiles, lidarr metadataprofile).
- apps/web: /library (search + kind/on-disk/wanted filters, horizontal media cards),
  /library/[id] (metadata, event timeline via ledger.events, FIX dialog w/ live
  episode/album picker + R-45 reason taxonomy), /my-fixes, /admin/fixes (status filter,
  raw actions_taken disclosure), /admin/restore (kind → diff preview → checkbox select →
  confirm 'no auto-search' → per-item report + recent runs). TopBar gained a primary nav
  (Home/Library, hidden <600px) + Library/My fixes user-menu items; admin nav gained
  Fixes/Restore (and now flex-wraps on phones).
- e2e: stub *arr server (apps/web/e2e/support/stub-arr.ts — fixture-shaped reads,
  records history/failed + command + delete writes, /_stub/calls control) boots in the
  harness next to stub OIDC; ledger seeded via a tsx subprocess through the D-12 writers
  (e2e/support/seed-ledger.ts). New library.spec.ts drives US-06: member fix w/
  wrong_language → stub recorded blocklist+EpisodeSearch with the right ids → admin
  queue shows it. Suite: 41/41 in ~39s. `pnpm dev:local` now boots the stub *arr too, so
  the fix flow is hands-on testable.
- Fix rate limit lives in the domain writer (5/user/hour, advisory-locked; admins
  bypass) and surfaces as TOO_MANY_REQUESTS/FIX_RATE_LIMIT_EXCEEDED — trip-at-6th
  covered in `packages/api/__tests__/fix.test.ts`.
- DESIGN-003 updated in place (reservation note: ledger/fix claimed, restore recorded,
  plex still reserved; D-13 table extended with the six Phase 2 codes). DESIGN-005 Q-08
  got a partial stubbed-only finding (grab-less albums delete every trackfile — full
  dislodge by construction); the live-probe half stays open. One documented deviation
  from the D-09 letter: the fix flow does ONE read-only live child lookup
  (label/validation) before the pending row commits — no MUTATING call ever precedes
  the row (see packages/domain/src/fix-flow.ts comment).
- Next: owner sign-off on DESIGN-006 identity (Q-01) still pending; remaining Phase 2
  ops work: haynes-ops sync CronJobs + ExternalSecret keys (D-14/D-18).

## Where things stand

- Repo initialized against git@github.com:thaynes43/haynesnetwork.git (`main`).
- **Docs suite complete and Accepted**: PRD-001, ADR-001..010, DDD 001-002 (glossary +
  bounded contexts), DESIGN-001..004 (schema, auth/Authentik, tRPC surface, UI shell).
  These are now the source of truth; `.agents/context/2026-07-03-kickoff.md` is historical.
- Verified: Authentik API token works (in-cluster `homepage-secret`, ns `frontend`); Better
  Auth generic OAuth callback = `{BETTER_AUTH_URL}/api/auth/oauth2/callback/authentik`
  (verified against better-auth 1.6.11 source — see DESIGN-002); embedded-postgres
  16.14.0-beta.17 is the Docker-less test DB pin (ADR-010).

## Where things stand (wave 7)

- Phase 2 (feat/sync-runner): @hnet/sync landed — DESIGN-005 D-14 *arr→ledger sync runner (full/incremental orchestrator over the domain writers, per-source sync_runs + isolated failures, tombstone guard + --force-tombstones, Seerr email attribution + FK backfill, CLI `src/scripts/sync.ts`, Dockerfile sync-deploy subtree; Q-07 verified: `pnpm deploy --legacy` flattens the @hnet/sync→arr/domain→db chain).
- Phase 2 (feat/arr-clients): @hnet/arr landed — typed Sonarr/Radarr/Lidarr/Seerr clients
  (DESIGN-005 D-18 read/write entrypoint split, D-02 zod subsets, sanitized fixtures from
  the 2026-07-03 live GET probes); sync CLI + domain writers are the next slices.
- Waves 3-6 merged via PRs #2-#6: @hnet/auth (Better Auth + bootstrap), @hnet/api (tRPC),
  Phase 1 web UI, Dockerfile + CI image validation, Playwright e2e (38 tests incl. stub
  OIDC + resize matrix).
- Wave 7 (this PR): e2e orchestration extracted into Playwright-free modules
  (e2e/support/harness.ts startStack() + env.ts, replacing runtime-env.ts);
  `pnpm dev:local` interactive test environment built on startStack() (personas
  switched by typing admin|member|fresh-member), /api/health for the k8s probes,
  tile description 2-line clamp, OPS-001 exact 1Password field list (Connect token
  verified read-only -> owner-manual item).
- Orchestration lesson recorded: never resume a completed agent for new scope in the
  shared working tree — its revival did a reset --hard under a concurrent manual
  branch (recovered from the amend commit; no work lost). Fresh agent + worktree
  isolation next time.
- Visual vetting pass done at 390x844 / 820x1180 / 1920x1080 (screenshots shared with
  owner 2026-07-03).
- Staging live at haynesnetwork.haynesops.com (2026-07-03); DESIGN-005 drafted (this PR).
- Visual identity pass (feat/visual-identity, DESIGN-006 Draft): owner rejected the
  demo-console-clone look ("colors good, squares too copy-like") → new hub-and-spoke
  brand mark (apps/web/components/brand-mark.tsx, used by TopBar + /login), Outfit
  variable font self-hosted via next/font/local (apps/web/fonts/, OFL), shape language
  in tokens.css (--radius 16/--radius-sm 10, --font → --font-outfit) + app.css
  (horizontal tile cards w/ tinted icon wells + display:contents bridge, ghost topbar
  buttons, pill buttons, 2–3% accent gradients, restyled login card). Token NAMES and
  palette VALUES unchanged; mechanism (ADR-005) untouched; e2e 38/38 survived without
  test edits. PR blocks on owner screenshot approval (identity-screenshots/, gitignored).
- Phase 2 DB layer landed on feat/ledger-schema: migration 0003 (media_items,
  ledger_events, fix_requests, restore_runs, sync_runs, sync_state, wanted_items view)
  - @hnet/domain single-writers per DESIGN-005 D-05..D-13.

## Where things stand (wave 2 additions)

- Monorepo scaffold green (Next 16.2.6, react 19.2.4, @hnet/* packages).
- Theme system ported per DESIGN-004: packages/ui (tokens hnet-dark/hnet-light,
  ThemeProvider w/ localStorage + prefers-color-scheme, layout primitives, token-contract
  test), apps/web wired with pre-hydration script; real hex-lint guard active.
- DB layer per DESIGN-001: @hnet/db (schema, migrations 0001+0002, lazy pool),
  @hnet/test-utils (embedded PG16 — `allowBuilds` for @embedded-postgres/linux-x64 is
  REQUIRED or binaries are non-functional), @hnet/domain (single-writer audit helpers,
  typed errors, effectiveAppsForUser, no-direct-writes guard test). 49 tests green.
- CI live on GitHub (lint-and-typecheck/test/build + guarded build-image), release-please
  (pre-1.0 bumps; needs owner's RELEASE_PLEASE_PAT for auto image builds).
- Authentik OIDC provisioned via API (docs/ops/001) — creds in .env.local; owner must
  create the 1Password `haynesnetwork` item before cluster deploy.

## Where things stand (wave 3 additions)

- @hnet/auth implemented per DESIGN-002 (PR feat/auth-package): Better Auth 1.6.x with
  genericOAuth→Authentik as the sole provider, drizzle adapter over DESIGN-001 tables,
  7d/1d sessions, BOOTSTRAP_ADMIN_EMAILS hook via domain transitionRole (never throws
  into sign-in), getServerSession hydrating {role, effective isFamily} for DESIGN-003,
  authEnv/assertAuthEnv env contract, apps/web catch-all route. better-auth resolved to
  1.6.23 — D-04 callback path `/oauth2/callback/:providerId` re-verified against the
  installed package (DESIGN-002 D-03). Sign-in UI pages are a separate task; nothing
  calls assertAuthEnv at startup yet (wire it with the deployment task).

## Where things stand (wave 4 additions)

- @hnet/api implemented per DESIGN-003 (PR feat/api-package): tRPC v11 surface with
  createTRPCContext({headers}) → {db, user: SessionUser|null} via getServerSession
  (fail-closed role check), ladder publicProcedure → authedProcedure → adminProcedure
  (middleware/role.ts), routers profile/catalog/users/tags exactly per D-06, zod v4
  inputs (catalogUrlSchema per D-04), errorFormatter + mapDomainErrors attaching
  appCode (D-13). Every mutation delegates to @hnet/domain (no-direct-writes guard
  stays green); adminList/users.list emit ISO-string timestamps (D-03, no superjson).
- apps/web wired: /api/trpc/[trpc] fetchRequestHandler route (runtime nodejs),
  lib/trpc-server.ts getServerCaller, lib/trpc-client.ts + lib/trpc-provider.tsx
  (@trpc/client + @trpc/react-query 11.18, @tanstack/react-query 5.101), TRPCProvider
  mounted in app/layout.tsx. No UI pages yet (next task).
- ICON_KEYS (D-10) lives at @hnet/ui/icons (packages/ui/src/icons/registry.ts,
  React-free subpath export) — keys only; the SVG components ship with the UI shell.
- Gotcha: zod v4 `.partial()` still APPLIES field `.default()`s when a key is absent —
  catalog.update uses a default-free base schema (CatalogEntryPatchInput) so partial
  patches don't silently reset defaultVisible/icon/description.
- 59 api tests (embedded PG16, createCallerFactory + fake SessionUser contexts): ladder
  rejections, myApps union/dedupe/order + AC-06 tag-removal, R-14 URL table across
  zod + domain layers (DB CHECK covered by packages/db tests), audit co-writes +
  idempotent replays, setFamily effective flips, tags.list D-12 scoping, appCode wire
  shapes via getErrorShape. Workspace total: 130 tests green.

## Where things stand (wave 5 additions)

- Phase 1 UI implemented per DESIGN-004 (PR feat/web-ui). Routes: `/login` (public,
  centered card, single "Sign in with Plex (Authentik)" button via
  authClient.signIn.oauth2 — better-auth react client + genericOAuthClient in
  apps/web/lib/auth-client.ts; `?error=…` alert; config-error state when OIDC creds
  unset), `(app)` route group (server session gate → /login; 56px TopBar chrome +
  scrolling `<main>`), `/` dashboard (catalog.myApps via getServerCaller, client-side
  time-of-day greeting, auto-fill tile grid, new-tab tiles rel noopener noreferrer,
  empty state), `/admin` + `/admin/users/[id]` + `/admin/catalog` + `/admin/tags`
  (admin/layout.tsx re-checks role server-side → redirect('/')). Admin pages are
  client components on trpc react-query with invalidate-refetch (no optimistic infra).
- Gating rules live as pure helpers in apps/web/lib/route-gate.ts (unit-tested);
  layouts call them then `redirect()`. The dashboard page re-checks the session itself
  before using the server caller (a layout redirect doesn't stop the page render).
- Provenance (`default`/`direct`/`tag:<name>` chips) is recomputed client-side from
  users.list + catalog.adminList + tags.list per DESIGN-003 D-09
  (apps/web/lib/provenance.ts, tested). Catalog URL field mirrors R-14 client-side
  (lib/catalog-url.ts, tested); server appCodes surface via lib/app-error.ts (tested).
- @hnet/ui now ships the D-09 SVG components for every ICON_KEY + generic fallback
  (packages/ui/src/icons/components.tsx, `AppIcon`); registry.ts stays React-free for
  @hnet/api. Icon render test proves currentColor/no-hex/self-contained.
- @hnet/auth gained a dependency-free `./env` subpath export so client bundles can
  import OIDC_PROVIDER_ID without pulling server code.
- DESIGN-004 open questions resolved by coordinator defaults: Q-01 brand mark = donor
  four-square placeholder SVG; the wordmark renders from the `--brand-name` token via
  CSS `content` (rebrand stays a tokens.css-only edit). Q-02 avatar = initial-letter
  circle (lib/initials.ts). Theme toggle labels resolve post-mount
  (useSyncExternalStore) so no theme-dependent JSX mismatches the D-03 script.
- Gotcha: the domain no-direct-writes guard walks the repo — `.claude/` (agent
  worktrees hold a full repo copy during parallel work) is now in its IGNORE_DIRS.
- Verified against embedded PG16 + `next dev`: `/` and `/admin/*` 307 → /login when
  anonymous, /login 200 with the sign-in button and `data-theme="hnet-dark"` +
  pre-hydration script; typecheck/lint/lint:css/test (182)/build all green.

## Where things stand (wave 6 additions)

- Playwright e2e suite live per ADR-010 (PR feat/e2e): `pnpm --filter web e2e` (root
  `pnpm e2e`), apps/web/playwright.config.ts + apps/web/e2e/. The orchestration is
  REUSABLE, Playwright-free modules in apps/web/e2e/support/ (owner request — a
  follow-up `pnpm dev:local` command will consume exactly these to boot the same
  environment interactively): `harness.ts` (`startStack()` → embedded PG16 →
  migrations → stub OIDC → `next dev`, `RunningStack.stop()` reverse teardown),
  `stub-oidc.ts` (server + STUB_USERS personas), `env.ts` (`composeRuntimeEnv()`
  D-08 contract, `DEFAULT_APP_PORT` 3100 so a local `pnpm dev` keeps 3000, worker
  env-file handoff). globalSetup/globalTeardown are thin consumers — NOT
  Playwright's webServer block (it starts BEFORE globalSetup and would miss the
  embedded-PG DATABASE_URL; donor lesson, todos-for-dues). Gotchas encoded in the
  harness: @hnet/test-utils/postgres SUBPATH import (the package index pulls
  @hnet/db/migrate whose `import.meta` breaks Playwright's CJS TS transform —
  migrations run as a `pnpm --filter @hnet/db migrate` subprocess); route prewarm
  amortises dev-compile lag.
- Stub OIDC (apps/web/e2e/support/stub-oidc.ts, node http + jose): discovery /
  authorize (302 straight back with code+state+iss) / token (RS256 id_token,
  client_secret_post) / jwks / userinfo, personas admin
  (bootstrap-admin@example.test — the suite's BOOTSTRAP_ADMIN_EMAILS), member,
  fresh-member (never granted anything — AC-04's "exactly the defaults"). Persona
  selection via POST /_control/user, sticky (workers=1 keeps it race-free); stable
  `sub`s so repeat logins hit the same users row. Verified against
  better-auth@1.6.23: discovery re-fetched at initiation AND callback; id_token is
  decodeJwt'd (not JWKS-verified) but signed properly anyway; `iss` on the callback
  redirect must match the discovery issuer.
- Specs (38 tests, ~26s locally): auth (AC-01 round trip incl. 7-day cookie +
  no-password-form, AC-03 admin bootstrap/repeat/member-denied), dashboard (AC-04
  exact seeded tiles + hrefs, AC-05 two-context grant/revoke), admin (catalog CRUD,
  R-14 haynesops rejection UX, family-tag bundle → member gains tile), theme
  (toggle + hnet-theme persistence, prefers-color-scheme seeding), resize-matrix
  (AC-10's 8 sizes × /login, /, /admin — fit helpers ported from demo-console;
  admin persona reused via storageState written in beforeAll). Suite runs SERIAL
  (workers=1): one shared app/DB, specs mutate shared grants/catalog.
- The matrix caught a real bug: card-mode `.admin-table thead` used clip-path-only
  sr-only and kept its intrinsic width → page-level H-scroll at 375px; app.css now
  applies the full sr-only treatment (width/height 1px + overflow hidden).
- CI: .github/workflows/e2e.yml (pull_request + push main) — ADVISORY, not in the
  required contexts (ADR-009/ADR-010 C-07); uploads playwright-report on failure.
  Gotcha: label fields whose hint `<span>` sits inside the `<label>` get the hint
  glued into the accessible name — match with `getByRole('textbox', { name: /^…/ })`
  (tags form) instead of `getByLabel(..., { exact: true })`.

## Gotchas discovered so far (historical)

- Prod sign-in 429 outage (2026-07-03): better-auth's built-in prod-only rate limiter
  (3-per-10s on `/sign-in*`, single shared bucket when the client IP is unresolvable
  behind Traefik) — fixed with per-client rate limiting + error taxonomy; see DESIGN-002
  D-14 (fix/auth-rate-limit-and-errors).
- No Docker in this WSL distro → tests use embedded Postgres, not Testcontainers.
- `overseerr.haynesnetwork.com` currently routes to the legacy Unraid box; in-cluster Seerr
  is LAN-only pending the owner's parallel *arr/Seerr k8s migration. Catalog links are
  DB data — update there when the cutover happens.
- Three Plex servers (k8plex, plexops, legacy haynestower). Tokens in 1Password: `homepage`
  item (`HAYNESKUBE_PLEX_API_KEY`, `HAYNESTOWER_PLEX_API_KEY`) and `plexops` item (field
  also named `HAYNESKUBE_PLEX_API_KEY` — beware the name collision; see the comment in
  haynes-ops `frontend/homepage/app/externalsecret.yaml`).
- `AUTHENTIK_API_TOKEN` exists in the 1Password `homepage` item (readable in-cluster from
  the `homepage-secret` in namespace `frontend`) — used for OIDC provider provisioning.
- Kyverno in-cluster: image registry allowlist + (audit-mode) cosign policy for
  `ghcr.io/thaynes43/*` — plan a cosign signing step when enforcement expands.
