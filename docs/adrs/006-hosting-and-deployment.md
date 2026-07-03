# ADR-006: Hosting and deployment — single GHCR image via haynes-ops Flux, staged ingress rollout

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

haynesnetwork must run in the owner's self-hosted Kubernetes cluster (managed by the
haynes-ops Flux repo) and eventually serve the public root domain `haynesnetwork.com`
(PRD-001 R-63, R-64). The cluster already provides every platform piece the app needs: CNPG
Postgres 16 at `postgres16-rw.database.svc.cluster.local`, External Secrets Operator with the
1Password ClusterSecretStore `onepassword-connect` (vault `HaynesKube`), `traefik-internal`
serving LAN-only `*.haynesops.com`, `traefik-external` serving public `*.haynesnetwork.com`
through the Cloudflare Tunnel (cert secret `certificate-haynesnetwork`, external-dns target
`ingress-ext.haynesnetwork.com`), and Kyverno admission control (registry allowlist plus an
audit-mode cosign policy covering `ghcr.io/thaynes43/*`). The sibling app todos-for-dues
already deploys through this exact pipeline from
`haynes-ops/kubernetes/main/apps/frontend/todos-for-dues/`. We must decide how haynesnetwork
is packaged, deployed, and exposed — and in what order its hostnames are claimed.

## Decision drivers

1. Reuse the haynes-ops platform components and conventions; no new infrastructure (R-63).
2. One artifact per release: the same image runs the app and its DB migrations (R-62).
3. Migrations must complete before the app rolls — CNPG is the only database (R-62).
4. Secrets never land in git; ESO + 1Password is the proven path (CLAUDE.md rule 7).
5. Do not expose the app publicly before Phase 1 e2e proves it (R-64); never leak
   `*.haynesops.com` links to users (R-14).
6. Stay compatible with the cluster's Kyverno policies as they tighten.

## Considered options

- **Option A** — Clone the todos-for-dues pattern: one GHCR image, bjw-s app-template
  HelmRelease in haynes-ops, postgres-init + migrator initContainers, ExternalSecret,
  staged internal-then-external ingress.
- **Option B** — Separate GitOps repo (or manual `kubectl`) for this app.
- **Option C** — Two images (app + dedicated migrator) or migrations at app startup.
- **Option D** — Claim `haynesnetwork.com` publicly from the first deploy.

## Decision outcome

Chosen option: **Option A** — the pattern is battle-tested one directory over, and every
driver is satisfied by copying it rather than inventing anything.

- **Image:** a single `ghcr.io/thaynes43/haynesnetwork` image, multi-stage `node:22-alpine`
  Dockerfile per the todos-for-dues pattern: pnpm workspace install → Next.js standalone
  build → `pnpm --filter @app/db deploy` flattening a self-contained migrator subtree into
  `/migrator` → minimal runtime with `tini` as PID 1, non-root user, default command
  `node apps/web/server.js`. CI publishes it on `v*` tags (ADR-009).
- **Manifests:** Flux Kustomization + HelmRelease under
  `haynes-ops/kubernetes/main/apps/frontend/haynesnetwork/` (namespace `frontend`), using
  bjw-s **app-template 5.0.1**, with `dependsOn` external-secrets-stores and
  cloudnative-pg-cluster, mirroring the todos-for-dues `ks.yaml`/`app/` layout.
- **Init containers:** (1) `ghcr.io/home-operations/postgres-init` idempotently creates the
  app database + role in CNPG; (2) the app image itself runs
  `tsx /migrator/src/scripts/migrate.ts` to apply Drizzle migrations before the app starts.
- **Secrets:** one ExternalSecret sourcing a **new 1Password item `haynesnetwork`** (plus
  `cloudnative-pg` for superuser creds) via ClusterSecretStore `onepassword-connect`,
  templating `DATABASE_URL` against `postgres16-rw.database.svc.cluster.local:5432`.
- **Staged rollout (R-64):** first deploy exposes only the internal ingress
  `haynesnetwork.haynesops.com` on `traefik-internal` for in-cluster validation (this host
  is operator-facing only — it must never appear in the app catalog, R-14). After Phase 1
  e2e passes against staging, claim `haynesnetwork.com` + `www.haynesnetwork.com` on
  `traefik-external` with `certificate-haynesnetwork` and external-dns pointing at the
  Cloudflare Tunnel target `ingress-ext.haynesnetwork.com`.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: zero new infrastructure — CNPG, ESO/1Password, Traefik, external-dns, Cloudflare Tunnel, and Flux conventions are all reused as-is. |
| C-02 | Good: migrations gate the rollout; a failed migration blocks the new pod instead of serving against a stale schema. |
| C-03 | Good: the staged rollout keeps the app off the public internet until e2e proves it, and the root domain claim is a pure manifest change. |
| C-04 | Bad: the Kyverno cosign policy for `ghcr.io/thaynes43/*` is audit-mode today; the release workflow must plan cosign signing **before** that policy flips to enforce, or deploys will be rejected. Tracked into ADR-009's release workflow. |
| C-05 | Bad: single self-hosted cluster is a SPOF for the app; accepted, consistent with everything else it hosts. |
| C-06 | Bad: one shared CNPG cluster means noisy-neighbor risk; accepted at this scale. |
| C-07 | Neutral: app-template is pinned at 5.0.1; chart upgrades are deliberate haynes-ops changes, not surprises. |

## More information

- PRD-001 R-14, R-62, R-63, R-64; phasing table ("root-domain cutover gates on Phase 1 e2e").
- ADR-009 (CI publishes the image on `v*` tags), ADR-010 (staging validation feeding the
  external cutover gate).
- Deploy analog: `haynes-ops/kubernetes/main/apps/frontend/todos-for-dues/` (`ks.yaml`,
  `app/helmrelease.yaml`, `app/externalsecret.yaml`); Dockerfile donor:
  `todos-for-dues/Dockerfile`.
- Runbooks for the 1Password item and the external cutover live in `docs/ops/`.
