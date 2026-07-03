# HANDOFF — current build state

> The single resume point for agents. Update this in the same change as any milestone.

- **Last updated:** 2026-07-03
- **Phase:** Bootstrap (docs complete, scaffold next)
- **Workflow mode:** direct pushes to `main` (pre-GATE A)

## Where things stand

- Repo initialized against git@github.com:thaynes43/haynesnetwork.git (`main`).
- **Docs suite complete and Accepted**: PRD-001, ADR-001..010, DDD 001-002 (glossary +
  bounded contexts), DESIGN-001..004 (schema, auth/Authentik, tRPC surface, UI shell).
  These are now the source of truth; `.agents/context/2026-07-03-kickoff.md` is historical.
- Verified: Authentik API token works (in-cluster `homepage-secret`, ns `frontend`); Better
  Auth generic OAuth callback = `{BETTER_AUTH_URL}/api/auth/oauth2/callback/authentik`
  (verified against better-auth 1.6.11 source — see DESIGN-002); embedded-postgres
  16.14.0-beta.17 is the Docker-less test DB pin (ADR-010).

## Next steps (task order)

4. Monorepo scaffold (Next.js + ported demo-console theme).
5. CI + GATE A PR cutover.
6. Authentik OIDC provisioning + Better Auth + roles.
7. Phase 1 features (catalog, dashboard, admin permissions, tags).
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
