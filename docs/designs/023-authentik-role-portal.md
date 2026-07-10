# DESIGN-023: Authentik role portal — group-membership write surface

- **Status:** Accepted
- **Last updated:** 2026-07-10
- **Satisfies:** PRD-001 R-144..R-150; governed by ADR-045 (the group-membership write surface).
  Builds on ADR-017 / DESIGN-007 (the write-confinement + email-match template), ADR-012 (the Role
  model this projects), ADR-042 / OPS-009 (Authentik config-as-code — the blueprints this must not
  fight), ADR-015 (reflow-free interaction), ADR-021 (admin gating).

## Overview

haynesnetwork becomes the **role portal**: an admin assigns a **Role** on `/admin/users` and the app
writes the matching **Authentik group membership**, which propagates to every Authentik-backed app
(Open WebUI today, Kavita/Audiobookshelf next) over the OIDC `groups` claim. The vertical is the
BC-04 (Plex Sharing) slice applied to identity, end-to-end: `@hnet/db` tables (+ CHECK enums) →
`@hnet/domain` single-writers/orchestrators (local audit in the same tx; external writes audited
after) → two injected, read/write-split, **import-confined** clients (`@hnet/authentik`,
`@hnet/openwebui`) → a tRPC `authentikPortal` router → an admin `/admin/users` page. The decision
authority stays the Role (BC-02); the write client only *applies* what the admin chose, and only to
groups on a positive owned-groups allowlist checked before any external call.

**Live wire shapes of record** (captured 2026-07-10):

| System | Version | Read | Write |
|--------|---------|------|-------|
| Authentik | 2026.5.3 | `GET /api/v3/core/users/`, `.../groups/`, `.../users/{pk}/` (DRF paginated; `pagination.next` is 0 at the end) | `POST /api/v3/core/groups/`, `.../groups/{pk}/add_user/`, `.../groups/{pk}/remove_user/` |
| Open WebUI | 0.7.2 | `GET /api/v1/groups/` (bare array) | `POST /api/v1/groups/create` |

## Detailed design

### D-01 — the schema (migration 0036, additive)

`0036_authentik_role_portal.sql` is additive-only (down-migration drops the three tables + the column
and reverts three CHECKs):

| Object | Shape / purpose |
|--------|-----------------|
| `roles.synced_tier` | `boolean NOT NULL DEFAULT false`. When true the Role **projects** to an Authentik group (the cross-app role primitive). Backfilled `true` for the seeded **Family** role (it already projects to the pre-existing `family` group); Admin/Default stay `false`. |
| `authentik_users` | The synced **directory mirror** (one row per Authentik identity, incl. external Plex-source + never-logged-in), PK = the Authentik user `pk`. Columns `username`, `name`, `email` (nullable), `user_type` (CHECK `external\|internal\|internal_service_account`), `sources` (jsonb), `groups` (jsonb of names), `is_active`, `uid`, `synced_at`. Index on `lower(email)`. A rebuildable read-model (the `ai_usage_chats` / `trash_candidates` class) — no per-row audit. |
| `pending_role_assignments` | The parked role intent for an Authentik-only identity: `authentik_user_pk`, `authentik_username`, `email`, `authentik_uid`, `role_id` FK, `assigned_by`, `created_at`, `consumed_at`, `consumed_user_id`. A **partial unique** index on `authentik_user_pk WHERE consumed_at IS NULL` (one live intent per identity) + a partial index on `email` (the first-login lookup). |
| `authentik_group_audit` | The append-only **external-write ledger** (the `plex_share_audit` class): `action` (CHECK `add_member\|remove_member\|create_group\|ensure_owui_group`), `group_name`, `authentik_user_pk`, `role_id`, `subject_email`, `actor_id`, `detail` (jsonb), `created_at`. Indexed by `created_at DESC` and `(authentik_user_pk, created_at DESC)`. Guard-listed INSERT-only. |
| `app_settings` keys | Two new keys pass the CHECK: `authentik_owned_groups` (the guardrail allowlist; default `['family']`) and `authentik_group_map` (role-id → group-name overrides; default `{}`). Both mutate through `setAppSetting` (same-tx `permission_audit` `update_app_setting`). |
| CHECK relaxes | `sync_runs.run_kind += authentik-users`; `permission_audit.action += assign_pending_role`. |

### D-02 — `@hnet/authentik` (read + confined write)

A new package, read/write-split like `@hnet/plex`. `src/read.ts` (`AuthentikReadClient`, safe to
import anywhere) pages `listUsers()` / `listGroups()` (200/page, bounded to 50 pages), `getUser(pk)`,
`findGroupByName(name)`. `src/write.ts` (`AuthentikWriteClient`, **`@hnet/authentik/write`** — import-
confined) does exactly `createGroup(name)`, `addUserToGroup(groupPk, userPk)`,
`removeUserFromGroup(groupPk, userPk)` — **no policy** (the guardrail + diff + audit are the domain's
job; the client issues the single computed mutation it is given). `src/config.ts`
(`assertAuthentikEnv`: `AUTHENTIK_URL` default = `http://authentik-server.network.svc.cluster.local`,
`AUTHENTIK_API_TOKEN` required, no default), `src/errors.ts` (a typed taxonomy —
`AuthentikConfigError`/`HttpError`/`NetworkError`/`TimeoutError`/`ParseError`; the token is
header-only, never echoed), `src/schemas.ts` (the zod anti-corruption boundary; `sourcesOf(user)`
pulls the Plex-source marker out of `attributes["goauthentik.io/user/sources"]`), `src/http.ts`
(fetch wrapper; explicit `User-Agent: curl/8.5.0` for the Cloudflare-1010 fallback — ADR-045 C-10).

### D-03 — `@hnet/openwebui` (read + confined write)

The parallel package for OWUI **group** management (distinct from the PLAN-021 `@hnet/sync` usage
client — ADR-045 C-11). `OwuiGroupReadClient.listGroups()` (`GET /api/v1/groups/`, bare array) and
`OwuiWriteClient.createGroup(name, description?)` (`POST /api/v1/groups/create`, **`@hnet/openwebui/write`** —
import-confined). `assertOwuiEnv` reuses `OPENWEBUI_URL` (default = `http://open-webui.ai.svc.cluster.local`)
+ `OPENWEBUI_API_KEY` (required) — **no new secret**. Same config/errors/schemas/http shape as D-02.

### D-04 — the client bundle + import confinement (`packages/domain/authentik-clients.ts`)

`AuthentikPortalBundle = { authentik:{read,write}, owui:{read,write} }`. `buildAuthentikPortalBundle`
(explicit options; tests inject `fetchImpl` stubs) and `authentikPortalBundleFromEnv` (production).
This is the **only** module that imports `@hnet/authentik/write` + `@hnet/openwebui/write`; `packages/api`
receives the bundle as an opaque type and injects stubbed clients in tests (mirrors `plex-clients.ts`).
The confinement is executable: `arr-write-import-guard.test.ts` extends its pattern to
`/@hnet\/(arr\|plex\|authentik\|openwebui)\/write/` and its allowed dirs to `packages/authentik` +
`packages/openwebui` — sync, api, and web can only reach the write clients through the domain bundle.

### D-05 — the guardrail (`assertGroupOwned`, `groupNameForRole`)

`groupNameForRole(roleId, roleName, map)` = `map[roleId] ?? roleName.toLowerCase()`.
`assertGroupOwned(groupName, ownedGroups)` throws `AuthentikGroupNotOwnedError` (→ FORBIDDEN) unless
`groupName` is in the owned allowlist (case-insensitive). Every membership write in D-08 is preceded by
`assertGroupOwned` — the app is structurally incapable of touching `authentik Admins`, `mfa-exempt`,
or any admin-managed group. The local owned-allowlist/map changes (via `setAppSetting`) run **before**
any external membership write, so a group is recognized as owned before it can be a write target.

### D-06 — `provisionSyncedTier` (make a role a managed tier)

Order: (1) set `roles.synced_tier` (idempotent); (2) `setAppSetting` append the group to
`authentik_owned_groups` + set the `authentik_group_map` entry (both same-tx audited); (3)
ensure-exists the **Authentik** group (`listGroups` → `createGroup` if absent) and append a
`create_group` audit row after; (4) ensure-exists the **same-named OWUI** group (OWUI does not
auto-create from claims — D-14/ADR-045 C-03) and append an `ensure_owui_group` audit row after. Fully
idempotent (safe to re-run). Returns `{ groupName, authentikCreated, owuiCreated }`. The tier's
**existence** propagates; per-app **entitlements** stay per-app config.

### D-07 — `deactivateSyncedTier` (stop managing — non-destructive)

Flip `synced_tier` off and **remove** the group from `authentik_owned_groups` (so future membership
writes for it are refused). **Non-destructive**: the Authentik + OWUI groups and every existing
membership are left intact (group deletion is out of scope — ADR-045 C-02); the `authentik_group_map`
entry is kept so a later re-activation resolves the same group.

### D-08 — `assignRolePortal` (the assignment orchestrator)

Assign a Role to an Authentik identity and propagate it to the owned groups, **exclusive** across tier
groups (ADR-045 C-07). Order:

1. **Resolve** the role + its desired owned group (`null` when the role is not a synced tier). If the
   role is a synced tier but its group is not in the allowlist → `SyncedTierInvalidError`
   (→ UNPROCESSABLE_CONTENT): provision the tier first.
2. **Live read** the subject (`getUser(pk)`) + `listGroups()` (abort cleanly if Authentik is
   unreachable — nothing mutated). Compute `currentOwned = subject's groups ∩ ownedGroups`;
   `toRemove = currentOwned ∖ {desired}`; `toAdd = {desired} ∖ current`.
3. **Local role state**, one audited tx: an app user → `assignRole` (`user_role_transitions`); an
   Authentik-only identity → supersede any prior live pending row, insert `pending_role_assignments` +
   `permission_audit` `assign_pending_role`.
4. **External membership flips** — each guarded by `assertGroupOwned`, applied, then an `add_member` /
   `remove_member` audit row after (the detail carries `previous_owned_groups` / the exclusive-tier
   reason).
5. **Refresh** the subject's mirror row (`upsertAuthentikUser`) so `/admin/users` reflects it
   immediately (non-fatal — a transient read failure just means one sync-tick stale).

A step-4 failure leaves the local role set + a partial group change; a re-run reconciles (add/remove
are idempotent against the live set). Returns `{ groupName, added[], removed[], pending }`.

### D-09 — `consumePendingRoleForUser` + the auth hook (first-login materialization)

`consumePendingRoleForUser({ userId, email })` looks up the newest live `pending_role_assignments` row
for `lower(email)`; if present, `assignRole` (as `system`) + stamp the row `consumed_at`/`consumed_user_id`
in **one tx**; returns the applied role id (or null). The membership was already written at admin-assign
time — this only materializes the **app** role now the user row exists. The Better Auth
`session.create.after` hook `consumePendingRoleOnSignin` (in `@hnet/auth/hooks`, after
`bootstrapAdminOnSignin`) calls it; it never throws into the auth flow (logs + retries next login) — the
same thin-hook / guarded-writer split as bootstrap-admin. Email is the join key because
`sub_mode=hashed_user_id` makes the OIDC `sub` un-pre-computable (ADR-045 C-04).

### D-10 — the directory mirror + read model (`authentik-users.ts`)

`upsertAuthentikUsers` — the guarded single-writer for `authentik_users` (INSERT … ON CONFLICT (pk) DO
UPDATE, chunked 200; a synced read-model → no audit row). `syncAuthentikUsers({ authentik })` reads the
whole live directory and upserts (the `authentik-users` sync body + the on-demand admin refresh + the
D-08 post-write re-read all call it; never hard-deletes a vanished identity — Authentik deactivation
flips `is_active`, which the next sync captures). `listAuthentikDirectory()` — the `/admin/users` read
model: every mirror row LEFT-joined to its app user (by `lower(email)`), that user's role, and any live
pending assignment; service accounts included but flagged by `user_type` so the UI can badge + disable
them.

### D-11 — the tRPC portal router (`authentikPortal`, admin-only)

`authentikPortal.listIdentities` (query → `listAuthentikDirectory`), `.refresh`
(mutation → `syncAuthentikUsers` with the injected read client — the on-demand "Refresh" button),
`.assignRole` (mutation, input `{ authentikUserPk, roleId }` → resolves the mirror row + its app user,
rejects `internal_service_account` and email-less identities, then delegates to `assignRolePortal`).
All `adminProcedure`. `mapDomainErrors` maps `AuthentikGroupNotOwnedError → FORBIDDEN`,
`SyncedTierInvalidError → UNPROCESSABLE_CONTENT`, `AuthentikUnavailableError`/`OwuiUnavailableError →
BAD_GATEWAY`, `NotFoundError → NOT_FOUND`. The router only resolves the identity + injects the bundle
(`resolveAuthentikPortalBundle`); every write goes through a domain single-writer.

### D-12 — `roles.setSyncedTier` + `roles.create` synced-tier

`roles.setSyncedTier` (`{ roleId, syncedTier }`, admin) → `provisionSyncedTier` on, `deactivateSyncedTier`
off. `roles.create` (`RoleInput` grows `syncedTier: boolean = false`) sets the local flag via
`createRole`, then, when `syncedTier`, runs `provisionSyncedTier` right after (external group pre-create
+ owned-allowlist append) and returns `{ roleId, tier }`. Both reach Authentik/OWUI ⇒ BAD_GATEWAY on an
upstream outage.

### D-13 — the `/admin/users` UX (the portal)

A roster of every Authentik identity (`listIdentities`), each row carrying:

- **A source badge** derived from `user_type` + `sources`: **Plex-external** (external + a Plex
  source), **native** (internal), **service-account** (internal_service_account — role assignment
  disabled), and an **app-known** marker when the identity has a matching haynesnetwork user row
  (shows the current app role) vs an **Authentik-only** identity (shows any parked pending role,
  "applied on first login").
- **A role selector** — assign a Role; a synced-tier role shows what group it will write. Submitting
  calls `assignRole`; a non-owned-group write is refused (FORBIDDEN) and surfaced as an inline error.
- **A "Refresh directory" button** (`refresh`) — re-reads the live directory into the mirror.

Reflow-free (ADR-015): the badges and the role selector recolor/label on interaction; rows never
reflow. The page reads the synced mirror for the roster and re-reads live after a write for immediacy
(ADR-045 C-09).

### D-14 — the `/admin/roles` synced-tier toggle

The role editor grows a **"Synced tier"** toggle (`setSyncedTier`) and a create-time checkbox. Turning
it on shows the note: **"A cross-app group has been created (Authentik + Open WebUI). Configure each
app's entitlements — OWUI model access, Kavita libraries — in that app; the tier's existence propagates
automatically, its entitlements do not."** Turning it off states it **stops managing** the group
(non-destructive — the group and memberships remain). Same reflow-free discipline.

### D-15 — the `authentik-users` sync CronJob (`@hnet/sync`)

A standalone mode (`--mode=authentik-users`): not a per-source loop, writes **no `sync_runs` row**
(mirror is the trail), pages the read-only `AuthentikReadClient` and hands the snapshot to
`syncAuthentikUsers`. A persistently unreachable Authentik sets `totalFailure` (nonzero exit) so it is
visible in the CronJob status. Runs as a haynes-ops CronJob on a bounded cadence (mirrors
`sync-ai-usage` / `sync-smart-alerts`). The CLI wires `AUTHENTIK_URL`/`AUTHENTIK_API_TOKEN` via
`assertAuthentikEnv`.

### D-16 — the e2e Authentik stub

A stub Authentik directory API (mirroring the PLAN-021 OWUI stub + the *arr stubs): serves
`/api/v3/core/users/`, `.../groups/`, `.../users/{pk}/` and accepts the group create + add/remove
membership writes so a Playwright run can assign a role, observe the (stubbed) membership flip, and see
the roster refresh — no live Authentik. Same `PLEX_TV_URL`-style override seam (`AUTHENTIK_URL` points
at the stub).

### D-17 — env vars

`AUTHENTIK_URL` (non-secret; default = the in-cluster Service DNS) + `AUTHENTIK_API_TOKEN` (the
`hnet-portal` service-account token; cluster-created secret `haynesnetwork-authentik-token`). OWUI reuses
the existing `OPENWEBUI_URL` / `OPENWEBUI_API_KEY` (PLAN-021) — no new OWUI secret. See `.env.example`.

## Alternatives considered

- **Membership as GitOps blueprints** (ADR-042 mechanism) — right for durable login *structure*, wrong
  for per-user operational assignment (a PR per phone-flip). Rejected for membership; tier groups are
  still created by the app.
- **Keying pending assignments by OIDC `sub`** — impossible: `sub_mode=hashed_user_id` means the app
  can't pre-compute a sub for someone who hasn't logged in. Email (case-insensitive) is the join, the
  ADR-017 C-06 precedent.
- **A single shared OWUI client for usage + groups** — collapses two unrelated concerns; kept separate
  (ADR-045 C-11).
- **The homepage admin token** — over-scoped, unattributable; a dedicated `hnet-portal` service account
  is used (ADR-045 C-08).

## Test strategy

- **Unit (authentik/openwebui clients)** — pagination follow + termination; the zod schemas against
  the live-captured shapes; `sourcesOf`; config-missing error names only the absent var; token never in
  a URL/error string.
- **Unit (domain)** — `assertGroupOwned` (case-insensitive; throws for a non-owned group);
  `provisionSyncedTier` idempotency (ensure-exists, no duplicate create; allowlist/map append audited);
  `deactivateSyncedTier` non-destructive (allowlist removal only); `assignRolePortal` exclusive diff
  (join desired, leave other owned; never touch non-owned), the app-user vs pending branch, and
  audit-after; `consumePendingRoleForUser` one-tx assign + stamp; `listAuthentikDirectory` email join +
  pending resolution.
- **Import guard** — `arr-write-import-guard.test.ts` proves no `@hnet/{authentik,openwebui}/write`
  reference outside the allowed dirs.
- **tRPC** — `authentikPortal.assignRole` maps a non-owned group to FORBIDDEN, an unreachable upstream
  to BAD_GATEWAY, a service-account/email-less identity to NOT_FOUND; `refresh` upserts the mirror;
  `roles.setSyncedTier`/`roles.create` provision idempotently.
- **Migration** — 0036 columns/indexes/CHECK relaxes + the Family backfill.
- **e2e** — the D-16 stub: an admin assigns a role on `/admin/users`, the membership flips (stubbed),
  the roster refreshes; a synced-tier toggle on `/admin/roles` shows the entitlements note; screenshots
  at desktop + 390px.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Migrate the `haynesnetwork-authentik-token` secret to 1Password / External Secrets? | Deferred — cluster-created is acceptable (the `haynesnetwork-webhook` precedent); an owner-nicety TODO (ADR-045 C-08). |
| Q-02 | Can Authentik RBAC scope the `hnet-portal` token to (user read, group read, membership write)? | If yes, the minimal scope is used; otherwise the documented full token. The as-executed scope is recorded in OPS-011 (ADR-045 C-08). |
| Q-03 | Should a deactivated tier ever delete its Authentik/OWUI group? | No — group deletion is out of scope; deactivation only stops managing (non-destructive, ADR-045 C-02). |
