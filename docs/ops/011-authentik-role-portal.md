# OPS-011: Authentik user/role portal — service account, credential, and acceptance log

- **Status:** Executed 2026-07-10 (Fable 5 autonomous run, PLAN-026). Live-verified.
- **Decision:** [ADR-045](../adrs/045-authentik-group-membership-write-surface.md) (the group-membership
  write surface); [DESIGN-023](../designs/023-authentik-role-portal.md) (the vertical).
- **Sibling of:** [OPS-009](009-authentik-blueprints-and-mfa.md) (the blueprinted login estate) and
  [OPS-001](001-authentik-provisioning.md) (the API-provisioned OIDC provider).

This is the as-executed record for PLAN-026: the dedicated Authentik service account the app writes group
membership with, its least-privilege scope, the cluster secret, and the acceptance-scenario evidence.

## The `hnet-portal` service account (as-executed)

Created via the Authentik API with the bootstrap admin token (the 1Password `homepage` item /
`homepage-secret` `HOMEPAGE_VAR_AUTHENTIK_API_TOKEN` — used ONLY for this one-time bootstrap; **the app
never uses it**).

| Object | Value |
|---|---|
| Service-account user | `hnet-portal` — user pk **246**, uid `0e15b3eff876a2bfb3ed8cba9f2cb865e725080342dd96802952a1054f96d9c1`, `type: internal_service_account` |
| Scope group | `hnet-portal` — group pk `7fc8bdbd-1a98-4984-9206-9adba69e1f70`, `is_superuser: false` (created by `service_account?create_group=true`; the SA is its only member) |
| RBAC role | `hnet-portal` — role pk `37bd8504-5f9d-4f1c-b8d9-519e6bd17ea4`, bound to the scope group |
| API token | `hnet-portal-api` — `intent: api`, non-expiring (delivered as the cluster secret below) |

### Least-privilege scope (achieved)

The RBAC role `hnet-portal` holds exactly these five global permissions
(`POST /api/v3/rbac/permissions/assigned_by_roles/{role_pk}/assign/`):

- `authentik_core.view_user` — list the directory (incl. external / never-logged-in identities)
- `authentik_core.view_group`
- `authentik_core.add_group` — create a synced-tier group
- `authentik_core.add_user_to_group` — join an owned tier group
- `authentik_core.remove_user_from_group` — leave an owned tier group

**Verified live 2026-07-10** with the SA token: `GET /core/users/` → **200**, `GET /core/groups/` → **200**,
`GET /providers/oauth2/` → **403**, `GET /flows/instances/` → **403** (cannot read/modify providers or
flows). The full write path was self-tested end-to-end (create a throwaway group → add/remove the SA →
admin-delete the throwaway): create **201**, add_user **204**, remove_user **204**. So Authentik RBAC
**does** scope the token to least-privilege — the app can read the directory and manage membership of the
groups it owns, and nothing else. (This satisfies ADR-045 C-08's least-privilege option; the full-token
fallback was not needed.)

### Token-intent gotcha (hard-won)

The `POST /core/users/service_account/` endpoint returns an **`app_password`-intent** token. That intent
authenticates but resolves the API request to an **anonymous** user (`/core/users/me/` → `user: null`,
every read → 403) — it is NOT an API token. The fix: mint a second token with **`intent: api`**
(`POST /core/tokens/ {identifier, user: 246, intent: "api", expiring: false}`) — that one carries the
SA's permissions. The `app_password` token was deleted. **Use `intent: api` for service-account API
access.**

## The cluster secret (cluster-created, like `haynesnetwork-webhook`)

```
kubectl -n frontend create secret generic haynesnetwork-authentik-token \
  --from-literal=AUTHENTIK_API_TOKEN=<hnet-portal-api token>
```

- Cluster-created (no ExternalSecret), the `haynesnetwork-webhook` precedent (ADR-045 C-08). The app +
  the `sync-authentik-users` CronJob consume it via an `envFrom: secretRef … optional: true`; Stakater
  Reloader restarts the app pod when it lands. `AUTHENTIK_URL` is NOT set — the app defaults it in code to
  the in-cluster Service DNS `http://authentik-server.network.svc.cluster.local` (bypasses the Cloudflare
  edge that bans Python's default UA — error 1010, OPS-001).
- **Owner nicety TODO (open):** migrate `AUTHENTIK_API_TOKEN` into 1Password (the `haynesnetwork` item)
  + the ExternalSecret template, so it is GitOps-managed like the rest of `haynesnetwork-secret`. Until
  then it is a hand-created cluster secret (documented here, recoverable by re-minting the token).

## Guardrail (unchanged existing objects)

The SA setup added ONLY the `hnet-portal` group (non-superuser) + user + RBAC role. Verified live: the
`family` (5 members), `mfa-exempt` (2), and `authentik Admins` (2, superuser) groups were **untouched**;
no flow / stage / policy / provider / brand was created or modified.

## Acceptance scenario (owner-fixed) — evidence

Executed 2026-07-10 against the deployed **v0.38.0** (rollout healthy, `/api/health` 200). The hermetic
admin persona drove the shipped UX first (the `authentik-portal.spec.ts` e2e — create Friends → `friends`
pre-created in the stub Authentik AND OWUI → assign a Plex identity → moved `family`→`friends`, all green).
The same mutations were then **replayed against PROD via the @hnet/domain path** (the shipped
`createRole` + `provisionSyncedTier` + `assignRolePortal` single-writers, run from the branch worktree with
the PROD `DATABASE_URL` port-forwarded + the PROD Authentik/OWUI public APIs). What ran where:

- **(a) Friends synced tier — PASS.** `createRole({synced_tier:true})` + `provisionSyncedTier` → roleId
  `ed01c175-…`, `roles.synced_tier=true`; `provisionSyncedTier` returned `{groupName:'friends',
  authentikCreated:true, owuiCreated:true}`. Verified via the live APIs: Authentik group `friends` exists,
  OWUI group `friends` exists; owned-groups allowlist grew to `['family','friends']`. Audit:
  `create_role` + two `update_app_setting` (allowlist + map) in `permission_audit`; `create_group` +
  `ensure_owui_group` in `authentik_group_audit`.
- **(b) assign mikebi12 (Authentik pk 109) Friends — PASS.** `assignRolePortal` (appUserId null →
  Authentik-only) returned `{groupName:'friends', added:['friends'], removed:['family'], pending:true}`.
  Verified: mikebi12's Authentik groups `['family']` → `['friends']` (exclusive across owned tiers);
  a `pending_role_assignments` row exists (email `mikesbikester@gmail.com`, role Friends, `consumed_at`
  null — applies on his first haynesnetwork login); audit: `assign_pending_role` (`permission_audit`) +
  `add_member`/`remove_member` (`authentik_group_audit`).
- **(c) headless OIDC login for hnet-e2e (temp in `friends`) — PASS.** `hnet-e2e` (pk 243) was temporarily
  added to `friends` (via the SA token — the owned-group write path). The full OIDC login to Open WebUI
  was driven headlessly (cookie-jar: `GET /oauth/oidc/login` → the Authentik flow executor
  `ak-stage-identification`→`ak-stage-password`→`xak-flow-redirect`, each POST with `-L` so the 302
  between stages preserves the OIDC authorize `next`; follow `to` → OWUI callback **200**; no MFA challenge
  — hnet-e2e ∈ mfa-exempt). OWUI logs confirmed the claim sync: `Oauth Groups claim: groups` →
  `User oauth groups: [… 'friends' …]` → **`Adding user to group friends as it was found in their oauth
  groups`**. Cleaned up: hnet-e2e removed from `friends` (now `mfa-exempt` only); `friends` membership is
  `['mikebi12']`.
- **(d) guardrail — PASS.** Proven by unit test (`assertGroupOwned` refuses a non-owned group;
  `AuthentikGroupNotOwnedError`) AND a live spot-check against the PROD owned-groups allowlist:
  `assertGroupOwned('mfa-exempt', ['family','friends'])` threw `AuthentikGroupNotOwnedError`.

The in-cluster `sync-authentik-users` CronJob was also triggered once on v0.38.0 and completed clean
(`fetched:13, upserted:13`) — proving the deployed sync mode + the cluster `haynesnetwork-authentik-token`
secret against the in-cluster Authentik URL.

### Headless OIDC → Open WebUI login technique (part c)

Cookie-jar, no browser (mirrors the OPS-009 flow-executor rehearsal):
1. `GET https://ai.haynesnetwork.com/oauth/oidc/login`, follow redirects (`-L -c jar -b jar`) to the
   Authentik `/if/flow/<slug>/?<qs>` interface; extract `<slug>` + `<qs>`.
2. Drive `POST /api/v3/flows/executor/<slug>/?query=<qs>` with the JSON components in order:
   `ak-stage-identification` `{uid_field, [password if password_fields]}` → `ak-stage-password`
   `{password}` → `xak-flow-redirect` (follow its `to`) → the OWUI OIDC callback returns **200**.
3. `hnet-e2e` is in `mfa-exempt`, so no `ak-stage-authenticator-validation` challenge appears.
4. Confirm via OWUI logs (`kubectl -n ai logs deploy/open-webui`): `Adding user to group friends`.
5. Clean up: remove `hnet-e2e` from `friends` (it stays out of every tier group).
