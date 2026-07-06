# OPS-004: Deploy runbook — merged PR to live staging

- **Status:** Accepted (reflects the pipeline live as of v0.4.0, 2026-07-05; image-publish flow updated per #37)
- **Implements:** ADR-006 (single GHCR image + Flux), ADR-009 (CI + release-please)
- **Sibling repo:** `haynes-ops` at `kubernetes/main/apps/frontend/haynesnetwork/`
  (cluster context `haynes-ops`)

The end-to-end path from a merged PR to the running staging deployment. There is **one
manual step** — bumping the image tag in `haynes-ops` — because this cluster runs **no
Flux image automation**. Everything else is automated. Secret *values* never appear here;
this documents field contracts only (CLAUDE.md rule 7).

## 0. Topology at a glance

| Thing | Where |
|-------|-------|
| Source repo | this repo, `main` (branch-protected, squash-only — PLAN-001) |
| Image | `ghcr.io/thaynes43/haynesnetwork`, pushed in-run by release-please on `release_created` (#37) |
| Deploy manifests | `haynes-ops/kubernetes/main/apps/frontend/haynesnetwork/` |
| Live image tag | `app/helmrelease.yaml` → `controllers.main.initContainers.migrate.image.tag` (anchor `&mainImage`, currently **`v0.4.0`**) |
| Staging URL | `https://haynesnetwork.haynesops.com` (traefik-internal, LAN-only) |
| Namespace | `frontend` |

## 1. Merge → tag (automated, in this repo)

1. **PR merges to `main`.** The three required checks (`lint-and-typecheck`, `test`,
   `build`) must be green; squash-merge only (ADR-009). `e2e` is advisory.
2. **release-please opens/updates a release PR** (`.github/workflows/release-please.yml`)
   by parsing conventional commits since the last tag. It maintains `CHANGELOG.md`, bumps
   the version in `.release-please-manifest.json` (`bump-minor-pre-major` — `feat:` → minor,
   `fix:` → patch pre-1.0), and titles itself `chore(main): release X.Y.Z`.
3. **Merge the release PR.** That squash-merge tags **`vX.Y.Z`** on `main` and publishes a
   GitHub Release. `include-component-in-tag: false`, so the tag is a bare `v*`.
4. **release-please publishes the image IN THAT SAME RUN** (`.github/workflows/release-please.yml`,
   steps gated on `release_created`): it builds + pushes `ghcr.io/thaynes43/haynesnetwork:vX.Y.Z`
   **and** `:latest` with `GITHUB_TOKEN` (`packages:write`) — automatically, no PAT, no re-push
   (#37, commit `4aefdd6`). `ci.yml`'s `build-image` job is **validation/build-only everywhere**
   (`IMAGE_PUSH: 'false'`) and never publishes.

### 1a. Publishing is automatic since #37 (no PAT, no re-push)

The image publishes with **no operator action**. Because the build/push runs INSIDE the
release-please job (not a separate tag/release-triggered workflow), the "Actions don't trigger
Actions" restriction on `GITHUB_TOKEN` doesn't apply, so `GITHUB_TOKEN` (`packages:write`) pushes
to GHCR directly. There is **no `RELEASE_PLEASE_PAT`** and **no tag re-push** — the old re-push
fallback is dead (`ci.yml`'s tag build is `IMAGE_PUSH=false` and will not push).

If the image is somehow missing (e.g. the in-job publish step failed), **re-run the release-please
workflow run** — do NOT re-push the tag:

  ```bash
  gh run rerun <release-please-run-id>   # re-runs the in-job build + push
  ```

Confirm the image exists before touching `haynes-ops`:

```bash
gh api /users/thaynes43/packages/container/haynesnetwork/versions \
  --jq '.[].metadata.container.tags[]' | grep vX.Y.Z
# or: docker manifest inspect ghcr.io/thaynes43/haynesnetwork:vX.Y.Z >/dev/null && echo ok
```

## 2. Roll the release live (the one manual step, in `haynes-ops`)

There is no Flux image-update automation watching GHCR. Rolling a new version = editing the
tag in the HelmRelease and committing to `haynes-ops`.

1. In `haynes-ops`, edit
   `kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`: change the single
   `tag:` under `controllers.main.initContainers.migrate.image` (the `&mainImage` anchor) —
   e.g. `v0.3.1` → `vX.Y.Z`. The `*mainImage` alias reuses it for the `app` container and
   **both** sync CronJobs, so one edit moves the whole deployment.
2. Commit and push to `haynes-ops` `main`.
3. **Flux reconciles** (the `haynesnetwork` Kustomization polls every 30m; force it):

   ```bash
   flux reconcile source git haynes-ops -n flux-system
   flux reconcile kustomization haynesnetwork -n flux-system --with-source
   ```

4. **Rollout order** (Flux + the bjw-s app-template enforce it): `init-db` initContainer
   (idempotent DB + role create via `postgres-init`) → `migrate` initContainer
   (`tsx /migrator/src/scripts/migrate.ts` — Drizzle migrations + idempotent `app_catalog`
   seed) → the `app` container. A failed migration blocks the new pod; the old pod keeps
   serving (ADR-006 C-02).

## 3. Verify

```bash
kubectl -n frontend get pods -l app.kubernetes.io/name=haynesnetwork -w
kubectl -n frontend rollout status deploy/haynesnetwork

# Migrations actually ran (initContainer name is `migrate`):
kubectl -n frontend logs deploy/haynesnetwork -c migrate

# App is healthy — the liveness/readiness/startup probe target:
kubectl -n frontend exec deploy/haynesnetwork -c app -- \
  curl -fsS localhost:3000/api/health
# externally: curl -fsS https://haynesnetwork.haynesops.com/api/health
```

Confirm the running image is the tag you set:

```bash
kubectl -n frontend get deploy/haynesnetwork \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

## 4. Image shape (what you deployed)

One multi-stage `node:22-alpine` image (repo `Dockerfile`) with `tsx` installed globally,
`tini` as PID 1, non-root `app` user, serving three subtrees off the same layers:

| Subtree | Command | Consumer |
|---------|---------|----------|
| `apps/web` (Next.js standalone) | `node apps/web/server.js` (default `CMD`) | the `app` container |
| `/migrator` (flattened `@hnet/db`) | `tsx /migrator/src/scripts/migrate.ts` | `migrate` initContainer |
| `/sync` (flattened `@hnet/sync` + its `@hnet/arr`/`@hnet/domain`/`@hnet/db` chain) | `tsx /sync/src/scripts/sync.ts --mode=…` | the two CronJobs |

**Sync CronJobs (live since v0.2.0, `restartPolicy: Never`, `backoffLimit: 1`,
`concurrencyPolicy: Forbid`):**

- `sync-incremental` — schedule `*/15 * * * *` (every 15 min), `--mode=incremental`
  (*arr history cursors + Seerr requests).
- `sync-full` — schedule `30 4 * * *` (**04:30 daily**), `--mode=full` (full upsert +
  guarded tombstones).

They ship in `helmrelease.yaml` and move with the same `*mainImage` tag — no separate
rollout. Verify:

```bash
kubectl -n frontend get cronjobs
kubectl -n frontend logs -l app.kubernetes.io/name=haynesnetwork --tail=100 \
  --selector=batch.kubernetes.io/job-name  # last sync job's logs
```

## 5. 1Password secret contract

`app/externalsecret.yaml` (ClusterSecretStore `onepassword-connect`, `HaynesKube` vault)
renders the `haynesnetwork-secret` Secret that every container/initContainer mounts via
`envFrom`. It merges **four** 1Password sources. Field **labels must match exactly** —
ESO extracts by label.

| 1Password item | Fields consumed | Feeds |
|----------------|-----------------|-------|
| **`haynesnetwork`** | `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `BOOTSTRAP_ADMIN_EMAILS`, `HAYNESNETWORK_POSTGRESQL__USER`, `HAYNESNETWORK_POSTGRESQL__PASSWORD` | app auth + `DATABASE_URL` + `postgres-init` role creation |
| **`cloudnative-pg`** | `POSTGRES_SUPER_PASS` | `INIT_POSTGRES_SUPER_PASS` (superuser for `postgres-init`) |
| **`media-stack`** | `SONARR_API_KEY`, `RADARR_API_KEY`, `SEERR_API_KEY` | @hnet/arr + sync (Phase 2) |
| **`lidarr`** | `LIDARR_API_KEY` | @hnet/arr + sync (Phase 2) |

Notes:

- `DATABASE_URL`, `BETTER_AUTH_URL`, and the `INIT_POSTGRES_*` vars are **templated** in the
  ExternalSecret, not stored — only the raw fields above live in 1Password. `BETTER_AUTH_URL`
  is hard-coded to `https://haynesnetwork.haynesops.com` for staging (flipped at cutover —
  OPS-005).
- **`LIDARR_API_KEY` key-name collision caveat:** Lidarr pre-dates the shared `media-stack`
  item, so its key lives in its own `lidarr` item and is fetched via an explicit
  `data.remoteRef` (`key: lidarr`, `property: LIDARR_API_KEY`) rather than the
  `dataFrom.extract` merge used for the other three. The three `media-stack` keys have unique
  `<APP>_API_KEY` names, so their `extract` merge is collision-safe; pulling `LIDARR_API_KEY`
  the same way would be fine too, but it simply is not in that item.
- The media keys are **not** in the `haynesnetwork` item — do not add them there.
- Creating/rotating a field is a 1Password action; ESO refreshes on its own interval, and
  `reloader.stakater.com/auto: "true"` restarts the pod when `haynesnetwork-secret` changes.
  The full local-vs-cluster env contract is `.env.example` / DESIGN-002 D-08 and DESIGN-005 D-18.

## 6. Branch-protection recovery (renamed required check)

Required status-check contexts must equal the CI **job keys** exactly
(`lint-and-typecheck`, `test`, `build`). Rename a job in `ci.yml` without updating branch
protection and **every PR deadlocks** — the renamed check never reports under the old name
(ADR-009 C-05).

C-05 claims an "idempotent setup script kept in-repo." **That script does not exist** —
`scripts/` contains only `lint-css-hex.mjs`. Recover manually with the same `gh api` call
PLAN-001 used to apply protection (adjust `contexts` to the current job names):

```bash
gh api -X PUT repos/thaynes43/haynesnetwork/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["lint-and-typecheck", "test", "build"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

`enforce_admins: true` means this applies to the owner too. To break glass (e.g. protection
is wedged and no PR can merge to fix `ci.yml`), temporarily `PATCH` `enforce_admins` off via
API, land the fix, then re-run the `PUT` above. Verify:

```bash
gh api repos/thaynes43/haynesnetwork/branches/main/protection \
  --jq '.required_status_checks.contexts'
```

## Related

- OPS-001 — Authentik provider of record (source of `OIDC_CLIENT_ID/SECRET`).
- OPS-005 — root-domain cutover (staging → public; the manifest swap + `BETTER_AUTH_URL` flip).
- ADR-006 (deployment), ADR-009 (CI/release), PLAN-001 (GATE A branch protection).
