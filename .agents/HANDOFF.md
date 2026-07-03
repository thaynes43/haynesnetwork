# HANDOFF — current build state

> The single resume point for agents. Update this in the same change as any milestone.

- **Last updated:** 2026-07-03
- **Phase:** Bootstrap (docs skeleton)
- **Workflow mode:** direct pushes to `main` (pre-GATE A)

## Where things stand

- Repo initialized against git@github.com:thaynes43/haynesnetwork.git (`main`).
- Docs skeleton + process conventions landed (this change).
- Requirements were gathered in the 2026-07-03 kickoff conversation and are being encoded
  into PRD-001; decisions into ADR-001..010. Until those land, `.agents/context/2026-07-03-kickoff.md`
  is the interim source of truth for what was decided.

## Next steps (task order)

1. PRD-001 product requirements.
2. ADR-001..010 core decisions.
3. DDD glossary + Phase 1 designs.
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
