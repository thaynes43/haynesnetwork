# HANDOFF — current build state

> The single resume point for agents. Update this in the same change as any milestone.

- **Last updated:** 2026-07-03 (wave 5)
- **Phase:** Phase 1 UI complete (login, dashboard, admin area); Playwright e2e next
- **Workflow mode:** PR flow (GATE A executed — see .agents/plans/001-gate-a-pr-cutover.md)

## Where things stand

- Repo initialized against git@github.com:thaynes43/haynesnetwork.git (`main`).
- **Docs suite complete and Accepted**: PRD-001, ADR-001..010, DDD 001-002 (glossary +
  bounded contexts), DESIGN-001..004 (schema, auth/Authentik, tRPC surface, UI shell).
  These are now the source of truth; `.agents/context/2026-07-03-kickoff.md` is historical.
- Verified: Authentik API token works (in-cluster `homepage-secret`, ns `frontend`); Better
  Auth generic OAuth callback = `{BETTER_AUTH_URL}/api/auth/oauth2/callback/authentik`
  (verified against better-auth 1.6.11 source — see DESIGN-002); embedded-postgres
  16.14.0-beta.17 is the Docker-less test DB pin (ADR-010).

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

## Next steps (task order)

8. Playwright e2e (incl. phone/tablet resize matrix + stubbed OIDC login).
9. Docker image + haynes-ops staged deployment (internal hostname first, then root domain).
10. Phase 2: *arr ledger + fix + failsafe restore.

## Gotchas discovered so far

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
