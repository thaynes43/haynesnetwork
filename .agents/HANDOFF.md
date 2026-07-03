# HANDOFF — current build state

> The single resume point for agents. Update this in the same change as any milestone.

- **Last updated:** 2026-07-03 (wave 4)
- **Phase:** Scaffold + theme + db + auth + tRPC API surface complete; Phase 1 UI next
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

## Next steps (task order)

7. Phase 1 features (catalog, dashboard, admin permissions, tags) + sign-in UI.
8. Playwright e2e (incl. phone/tablet resize matrix).
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
