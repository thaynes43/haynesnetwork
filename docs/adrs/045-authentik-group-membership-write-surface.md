# ADR-045: Authentik group-membership write surface — haynesnetwork as the role portal

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Tom Haynes (owner, PLAN-026) · ratified by Fable 5

## Context and problem statement

Every app in the Haynes ecosystem now authenticates through **Authentik** (ADR-002), and the
non-media apps — **Open WebUI** today, **Kavita** and **Audiobookshelf** next — read their
authorization from **Authentik group membership** delivered over the OIDC `groups` claim. Until now
"who is in which tier" was edited by hand in the Authentik admin UI, one app's entitlements at a time,
with no attribution and no single place a household admin could see the whole directory. haynesnetwork
already owns the **Role** (ADR-012) — the app's single admin-managed permission primitive — but a Role
lived only inside this app; it did not project anywhere.

PLAN-026's owner ruling makes haynesnetwork the **role portal**: assigning a Role on
`/admin/users` writes the corresponding **Authentik group membership**, which then propagates to every
Authentik-backed app automatically. This is the promised BC-02 "follow-on push of app permissions into
Authentik (R-30)" — and it is structurally the **BC-04 (Plex Sharing) pattern applied to identity**:
this app decides (the Role), and an import-confined write client *applies* the decision to an external
system of record it does not own.

The design questions this ADR settles: what may the app write (and, more importantly, what may it
**never** touch); how a haynesnetwork Role maps to an Authentik group; how a role is assigned to an
Authentik identity that has **never logged into this app**; how external group writes are audited when
they cannot co-commit with a local DB row; and which credential the app uses. The Authentik and Open
WebUI wire shapes were captured **live** 2026-07-10 (Authentik 2026.5.3 `GET /api/v3/core/users/`,
`.../groups/`; OWUI 0.7.2 `GET /api/v1/groups/`).

## Decision drivers

- **The Role is already the one permission primitive** (ADR-012 C-08) — a role change should be the
  single lever, not one more thing to also do by hand in Authentik.
- **Group membership is the cross-app role currency** — Authentik groups drive OWUI (and will drive
  Kavita/ABS) via the OIDC `groups` claim, so writing membership is what makes a tier real everywhere.
- **Blast radius must be bounded by construction** — the app holds a privileged Authentik credential;
  a bug must be incapable of touching flows, stages, policies, providers, brands, or the admin/MFA
  groups that gate login itself. A positive owned-groups allowlist, checked before any call, is the
  BC-04 "enforcement, never decision" discipline (ADR-017 C-08).
- **The mutating surface must be import-confined** exactly like `@hnet/arr/write` (ADR-011) and
  `@hnet/plex/write` (ADR-017) — no code path outside `packages/domain` may create a group or flip a
  membership.
- **Authentik config-as-code is the record for login objects** (ADR-042 / OPS-009) — this app writes
  *membership and tier groups only*; it must not become a second, competing owner of flow/stage/brand
  config that the blueprints own.
- **Secrets never land in git** (CLAUDE.md rule 7) — the portal credential is a dedicated
  service-account token, never the shared homepage admin token.
- **Honest audit** — a role/permission mutation must leave a trail (CLAUDE.md rule 6), but an external
  REST side-effect cannot join a local transaction, so the trail must acknowledge that seam rather than
  pretend co-commit (the `plex_share_audit` precedent, ADR-017 C-12 / DDD-002 BC-04).

## Considered options

1. **haynesnetwork writes Authentik group membership through two import-confined write surfaces
   (`@hnet/authentik/write`, `@hnet/openwebui/write`), gated by a positive owned-groups allowlist,
   with an external-write audit ledger and email-keyed pending assignments.** (Chosen.)
2. **Keep editing membership by hand in the Authentik admin UI.** Rejected: no single pane, no
   attribution, and the very drift-by-hand-edit problem ADR-042 set out to eliminate for login config.
3. **Express tier membership as Authentik blueprints in `haynes-ops`** (the ADR-042 mechanism).
   Rejected for *per-user membership*: blueprints are the right home for durable *structural* login
   config (flows/stages/brand/MFA), but per-identity tier assignment is operational data an admin flips
   from a phone — a GitOps PR per role change is the wrong ergonomics. Tier **groups** are still created
   by the app; the blueprints keep owning flows/stages/brand.
4. **Write app permissions into Authentik as OIDC scope/property mappings instead of groups.** Rejected:
   groups are what OWUI/Kavita/ABS already consume; mappings would be a parallel, app-specific primitive
   the other apps don't read.
5. **A shared privileged admin token (the homepage token) for the writes.** Rejected: over-scoped,
   unattributable, and a secret-hygiene regression — the app gets its own service account (C-08).

## Decision outcome

Chosen option: **1** — haynesnetwork becomes the role portal. A role change writes Authentik group
membership through two import-confined write surfaces, guarded by a positive owned-groups allowlist
checked **before** any external call, audited by an append-only external-write ledger, and joined to
Authentik-only identities by email. The rulings:

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: **Two new import-confined write surfaces + a synced-tier opt-in.** `@hnet/authentik/write` (group create + add/remove membership) and `@hnet/openwebui/write` (tier-group pre-create) mirror `@hnet/plex/write` (ADR-017): both are import-confined to `packages/domain` by extending the arr-write-import-guard test's pattern to `/@hnet\/(arr\|plex\|authentik\|openwebui)\/write/` (allowed dirs grow `packages/authentik`, `packages/openwebui`). A Role opts into projecting to a group via a new `roles.synced_tier` boolean (default false; the seeded **Family** role is backfilled true — it already projects to the pre-existing `family` group). A non-synced role stays app-local and writes nothing to Authentik. |
| C-02 | Good (safety-critical): **THE GUARDRAIL — a positive owned-groups allowlist.** The app writes membership ONLY for a group in an owned-groups allowlist (`app_settings` key `authentik_owned_groups`, ships `['family']` + every auto-created tier). `assertGroupOwned` throws `AuthentikGroupNotOwnedError` (→ FORBIDDEN) **before any external call**. The app **NEVER** creates, modifies, or deletes Authentik flows, stages, policies, providers, brands, or the `authentik Admins` / `mfa-exempt` groups — those stay owned by the ADR-042 blueprints and the admin. **Group DELETION is out of scope**: deactivating a tier just removes its group from the allowlist (the app stops managing it) — non-destructive, the group and its memberships are left intact. |
| C-03 | Good: **Synced-tier auto-creation — existence propagates, entitlements don't.** Creating (or flipping on) a role with `synced_tier=true` auto-creates the Authentik group (name = role name lowercased, unless a `authentik_group_map` override) AND ensures the same-named **Open WebUI** group exists (OWUI deliberately does NOT auto-create groups from OIDC claims, so the portal pre-creates the claim's target — C-11). Both creates are idempotent (ensure-exists). The tier's **existence** propagates automatically to every Authentik-backed app; per-app **entitlements** (which OWUI models the group may use, which Kavita libraries) remain that app's own config — the creation UX states this explicitly so nobody expects model access to follow the group across the wire. |
| C-04 | Good: **Identity keying is email (the ADR-017 C-06 precedent).** The haynesnetwork OIDC provider uses `sub_mode=hashed_user_id`, so the app **cannot pre-compute** a user's OIDC `sub` — it can only observe it after that user logs in. The practical join for a pending assignment is therefore **email (case-insensitive)** — the same email-match precedent BC-04 uses to map a haynesnetwork user to a Plex account. The Authentik user **pk** (plus `username`, `uid`) is the stable subject for the membership write itself and is stored for identity, audit, and idempotency; email is the app-row join key. |
| C-05 | Good: **Pending assignment for Authentik-only identities.** Assigning a role to an identity that has no app `users` row (someone who only ever logged into OWUI/Kavita) writes the group membership **immediately** and **parks** a `pending_role_assignments` row. It is consumed **lazily on that identity's first haynesnetwork login**: the Better Auth `session.create.after` hook (`consumePendingRoleOnSignin`, after `bootstrapAdminOnSignin`) calls the `consumePendingRoleForUser` domain single-writer, which `assignRole` + stamps the pending row consumed in **one transaction** — the same thin-hook / guarded-writer split as bootstrap-admin. Never throws into the auth flow (the session already exists; the next login retries). |
| C-06 | Good (honest boundary): **Audit split.** Membership flips and group creates are **external side-effects** (Authentik/OWUI REST) that cannot co-commit with a local DB row — so, exactly like `plex_share_audit` (DDD-002 BC-04, ADR-017 C-12), each **successful** external write appends one `authentik_group_audit` row **after** the apply (`add_member` / `remove_member` / `create_group` / `ensure_owui_group`). **Local** changes ARE same-transaction audited: the owned-allowlist and role→group map edits go through `setAppSetting` (`permission_audit` `update_app_setting`); a parked pending assignment writes `permission_audit` `assign_pending_role`; a synced-tier flag flip rides the role write (`update_role`). Consuming a pending row writes `user_role_transitions` via `assignRole`. |
| C-07 | Good: **Exclusive membership across owned tier groups.** Role assignment is exclusive: assigning a tier role **joins** its group and **leaves every other owned group** the subject is in (e.g. moving `mikebi12` Friends → in `friends`, removed from `family`). The diff is computed against the subject's live Authentik groups, intersected with the owned allowlist, so non-owned groups the user holds (admin-managed) are **never** touched. Un-joining is always the safe direction; a re-run reconciles idempotently against the live set. |
| C-08 | Good: **A dedicated service-account credential — never the homepage token.** The app authenticates as a dedicated Authentik **service account** (`hnet-portal`) with its own API token, delivered as a **cluster-created** secret `haynesnetwork-authentik-token` (the `haynesnetwork-webhook` precedent — cluster-created is acceptable; a 1Password/External-Secrets migration is an owner-nicety TODO). The app **never** uses the shared homepage admin token. RBAC scope: if Authentik role-based access control can scope the token to (user read, group read, membership write) that minimal scope is used; otherwise the documented full token is used. The **actual** scope as executed is recorded in OPS-011. The token travels only in the `Authorization: Bearer` header — never in URLs or error strings (the `assertArrEnv` / `assertPlexEnv` discipline). |
| C-09 | Good: **Sync-in — a one-way `authentik-users` read mirror.** A standalone `@hnet/sync` mode (`--mode=authentik-users`) pages the whole live Authentik directory — including external Plex-source and never-logged-in identities — and upserts an `authentik_users` mirror via the `syncAuthentikUsers` single-writer (the *arr-ledger read pattern). Like `ai-usage-sync` / `smart-alerts` it writes **no `sync_runs` row** — the mirror IS its trail (it joins `SYNC_RUN_KINDS` for CLI `--mode` parity only). The `/admin/users` portal reads this mirror; the portal **also** re-reads the subject live after a membership write, so the roster reflects a change immediately rather than waiting for the next sync tick. |
| C-10 | Note: **In-cluster URL + the Cloudflare gotcha.** The app reaches Authentik at `http://authentik-server.network.svc.cluster.local` (namespace `network`), which **bypasses the Cloudflare edge** that bans requests carrying Python's default User-Agent (error 1010, OPS-001). The client additionally sends an explicit `User-Agent: curl/8.5.0` so a fallback to the public `authentik.haynesnetwork.com` host would also work. Same posture for OWUI (`http://open-webui.ai.svc.cluster.local`, reusing the PLAN-021 env). |
| C-11 | Note: **A deliberate small duplication.** `@hnet/openwebui` (a group read/write client) is a *separate* package from the PLAN-021 `@hnet/sync` OWUI **usage** client — different concerns (group management vs chat-usage ingestion), low risk, and both reuse the same `OPENWEBUI_URL`/`OPENWEBUI_API_KEY` env (no new secret). Collapsing them would couple metrics ingestion to entitlement writes for no benefit; the duplication is accepted. |
| C-12 | Note: **Migration 0036 is additive.** It adds `roles.synced_tier` (+ the Family backfill), three new tables (`authentik_users` mirror, `pending_role_assignments`, `authentik_group_audit`), and relaxes three CHECK enums (`sync_runs.run_kind += authentik-users`; `permission_audit.action += assign_pending_role`; `app_settings.key += authentik_owned_groups, authentik_group_map`). No existing column changes type or drops; a down-migration drops the three tables + the column and reverts the three CHECKs. |

## More information

- **PRD:** R-144..R-150 (single-pane Authentik user/role management; write-back on assignment;
  synced-tier opt-in + auto-create; owned-groups guardrail; pending assignment; the `authentik-users`
  read sync; the dedicated service-account credential).
- **Design:** DESIGN-023 (the schema, the two client packages, the domain orchestrators, the portal
  router, the `/admin/users` + `/admin/roles` UX, the sync CronJob, the env contract).
- **Ops:** OPS-011 (the as-executed record — the `hnet-portal` service account + token, its RBAC scope,
  the cluster-created secret, and the CronJob/verify/rollback). Written by the orchestrator, not here.
- **Glossary:** DDD-001 T-129 (Synced Tier), T-130 (Owned-Groups Allowlist), T-131 (Authentik Group
  Portal), T-132 (Pending Role Assignment), T-133 (Authentik Directory Mirror), T-134 (OWUI Group
  Pre-creation), T-135 (`hnet-portal` Service Account).
- **Sibling ADRs:** ADR-017 (`@hnet/plex/write` confinement — the template this ADR mirrors, incl. the
  email-match join C-06 and the after-apply `plex_share_audit` seam C-12); ADR-012 (the unified Role
  model this projects); ADR-042 / OPS-009 (Authentik config-as-code — the blueprints keep owning
  flows/stages/brand/MFA that this ADR must never touch); ADR-011 (`@hnet/arr/write` confinement — the
  original guard). Migration **0036** (`0036_authentik_role_portal.sql`).
