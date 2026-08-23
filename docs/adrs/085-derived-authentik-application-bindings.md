# ADR-085: Derived Authentik application bindings — the Role governs access, not just the tile

- **Status:** Proposed
- **Date:** 2026-08-23
- **Deciders:** Tom Haynes (owner) · drafted by Opus 4.8

## Context and problem statement

ADR-045 made haynesnetwork the **role portal**: assigning a Role writes Authentik **group
membership**, and that membership propagates to every Authentik-backed app. It deliberately stopped
there — C-02 forbids the app from touching Authentik **policies**, leaving *which groups may reach
which application* to be set by hand in the Authentik admin UI or by an ADR-042 blueprint.

A 2026-08-23 audit found that half of the estate was never set at all. Eleven applications had **zero
policy bindings**, and in Authentik an application with no bindings admits **any authenticated
identity**. Because `default-source-enrollment` auto-creates an account (prompt → write → login, no
approval step), the admitted set was every Plex user who had ever signed in anywhere in the estate.
Concretely: `paperless` (personal documents, forward-auth, publicly reachable at
`paperless.haynesnetwork.com`) was reachable by five identities holding **no group at all**, and by
anyone whose haynesnetwork Role grants them nothing.

The audit also found the inverse failure. Authentik group membership has **drifted** from the Roles it
is supposed to mirror, because ADR-045's projection is purely **event-driven** — it fires on
`assignRolePortal` and nowhere else. Roles set before synced-tier existed, or through
`bootstrapAdminOnSignin` / `consumePendingRoleForUser`, never projected. At time of writing five users
hold a Role whose granted apps they would **lose** the moment bindings are enforced:
`miaellen25@gmail.com` (Family, absent from `family`), `jbadessa@gmail.com` and `seeaych@gmail.com`
(Friends, absent from `friends`), and `aringan0323@gmail.com` and `danweaver8@gmail.com` (Default,
which projects to no group at all because `synced_tier=false`).

So the estate has two half-connected control planes. haynesnetwork's `role_app_grants` decides which
**tiles** a user sees on the Portal; Authentik's policy bindings decide what a user may actually
**open** — and nothing keeps them agreeing. The owner's requirement (2026-08-23) is explicit: *"when I
change a user's group in haynesnetwork admin settings the Portal links exposed to their group are what
they have access to. I do not want to manage two sets of apps."*

The questions this ADR settles: how far the ADR-045 write surface may extend into policy without
becoming a second owner of login config; how a catalog entry names its Authentik application; which
applications the reconciler may **never** touch; what happens when the derived binding set is empty;
how the membership drift is repaired without locking anyone out; and how LAN-only infrastructure apps
— which are deliberately **not** in the catalog — stay gated.

## Decision drivers

- **One source of truth, or it is not a fix.** A hand-applied binding table satisfies the letter of the
  owner requirement for exactly one day. Only a derivation from `role_app_grants` keeps Portal tiles and
  real access in agreement as roles change.
- **ADR-045 C-02 drew the policy boundary for a reason** — the app holds a privileged Authentik
  credential, and a bug must remain incapable of touching flows, stages, providers, brands, or the
  groups that gate login itself. Extending into policy must be a *narrow, named* carve-out with its own
  positive allowlist, not a relaxation of the guardrail.
- **Zero bindings means open, so a deletion bug fails OPEN.** This inverts the usual safety posture and
  is the single most dangerous property of the mechanism. The design must make an empty derived set
  impossible to apply.
- **The drift is pre-existing and must be repaired first.** Enforcing bindings against today's stale
  groups would lock out five real household members. Repair precedes enforcement, and enforcement is
  gated on a pre-flight that proves nobody is dropped.
- **Census-first is this repo's pattern for risky automation** (ADR-083, the *arr queue janitor): observe,
  log the diff, prove the contract, then enforce by ladder. Access control deserves at least that.
- **LAN-only infra apps are a different class.** dev-env, headlamp, grafana and omni are operator tools
  on `*.haynesops.com`, never in the household catalog. Owner ruling 2026-08-23: they stay out of the
  catalog and are gated to `authentik Admins` in the `haynes-ops` blueprint. The reconciler must not be
  able to see them, let alone rebind them.
- **Blueprints and the reconciler must not fight.** ADR-042 makes blueprints the record for login
  objects; a blueprint that also declares bindings for a catalog-mapped app would revert reconciler
  state on every re-apply.

## Considered options

1. **Derive Authentik application policy bindings from `role_app_grants`, through a third
   import-confined write surface guarded by a positive owned-applications allowlist, with a
   census-first rollout and a membership reconcile pass.** (Chosen.)
2. **Hand-maintain bindings in the Authentik admin UI.** Rejected: exactly the drift-by-hand-edit
   problem ADR-042 eliminated for login config and ADR-045 eliminated for membership, and it fails the
   owner's "one set" requirement outright.
3. **Express every binding as an ADR-042 blueprint in `haynes-ops`.** Rejected for catalog apps: the
   binding set is a function of `role_app_grants`, which changes whenever an admin edits a Role in the
   app. Encoding it in git means a cluster PR for every household permission change — two sets again,
   with a slower loop. **Accepted for LAN-only infra apps**, whose gate is static and admin-only.
4. **Gate everything at the haynesnetwork Portal instead** (hide tiles, leave Authentik open).
   Rejected: the Portal is not in the request path. Every one of these apps has a public hostname a
   user can reach directly; hiding a tile hides nothing.

## Decision outcome

Chosen option: **1**. haynesnetwork derives each Authentik-gated application's policy bindings from the
Roles that grant it, through a narrow third write surface. The ADR-045 C-02 policy prohibition is
**amended, not lifted**: the app may write **policy bindings on allowlisted applications only**, and
still may never create or modify a policy *object*, a flow, a stage, a provider, or a brand. The
rulings:

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: **A third import-confined write surface.** `@hnet/authentik/write` grows `listApplicationBindings` / `createApplicationBinding` / `deleteApplicationBinding` (`/api/v3/policies/bindings/`), import-confined to `packages/domain` by the existing arr-write-import-guard test. The reconciler is a domain single-writer; no tRPC route applies a binding directly. |
| C-02 | Good (safety-critical): **THE GUARDRAIL — a positive owned-applications allowlist, and the C-02 amendment is narrow.** The app writes bindings ONLY for an Authentik application named by a catalog row's new `authentik_app_slug` AND present in `app_settings` key `authentik_owned_apps`. `assertApplicationOwned` throws before any external call. The app **NEVER** touches: `dev-env`, `headlamp`, `grafana`, `omni`, `tautulli-k8plex`, `tautulli-plexops` (blueprint-owned, LAN-only), nor any policy object, flow, stage, provider, or brand. ADR-045 C-02's prohibition on flows/stages/providers/brands and on the `authentik Admins` / `mfa-exempt` groups stands unchanged. |
| C-03 | Good (safety-critical): **An empty derived set is never applied — the mechanism fails CLOSED.** Because zero bindings admits everyone in Authentik, the reconciler treats a computed-empty set as a bug, not an instruction: it refuses the apply, logs, and alerts. Every derived set additionally includes `authentik Admins` at `order 0` **unconditionally**, so the floor for any managed application is admins-only, never open. |
| C-04 | Good: **The catalog names its Authentik application explicitly.** `app_catalog` gains a nullable `authentik_app_slug`. **NULL means "not Authentik-gated — never touch"**, which is the correct and default state for entries like `seerr` (Overseerr authenticates against Plex directly and has no Authentik application). Slug-convention matching is rejected: catalog URLs are arbitrary (ADR-013) and a coincidental slug match must not silently enroll an application into the managed set. |
| C-05 | Good: **The derivation rule.** For each managed application: bind `authentik Admins` (order 0), then one binding per **synced-tier group** whose Role grants that catalog entry, ascending order. `is_admin` and `grants_all` Roles count as granting every entry. The result is a pure function of `role_app_grants` + `roles` + the group map, so a Role edit in `/admin/roles` is the single lever, exactly as ADR-012 C-08 intends. |
| C-06 | Good: **Every Role that gates access must project — including Default.** A Role granting an Authentik-gated app while `synced_tier=false` is unrepresentable as a binding and would silently drop its users. The reconciler therefore treats non-synced-but-granting Roles as a **contract violation**, surfaces them, and the rollout enables `synced_tier` on the seeded **Default** role (which today grants audiobookshelf, kavita, open-webui, seerr to three users). |
| C-07 | Good: **A membership reconcile closes the ADR-045 event-driven gap — inline AND scheduled** (owner ruling 2026-08-23). ADR-045's projection fires only on `assignRolePortal`, so roles set by `bootstrapAdminOnSignin`, `consumePendingRoleForUser`, or before synced-tier existed never projected — five users are adrift at time of writing. Two layers: **inline**, so a Role write applies membership immediately and admin settings never disagree with reality; and a **scheduled** `@hnet/sync` reconcile mode that repairs drift from *any* source, including future write paths that forget to project — which is precisely how today's drift arose. Both reuse `assignRolePortal`'s exclusive-diff logic (ADR-045 C-07) and its `authentik_group_audit` trail, and both are idempotent. The scheduled pass runs before any binding is enforced. |
| C-08 | Good (safety-critical): **A pre-flight that proves nobody is dropped, then census-first rollout.** Following ADR-083, the reconciler ships **observe-only**: it computes and logs the binding diff and the membership diff without applying. Enforcement is gated on a pre-flight asserting that for every managed application, every user whose Role grants it is already in a bound group. A failing pre-flight blocks the apply and names the users. The ladder and its current level are tracked in `.agents/HANDOFF.md`, per the ADR-083 precedent. |
| C-09 | Good: **Blueprints stop declaring bindings for catalog-mapped apps.** `60-tautulli-frontdoor.yaml` currently binds `tautulli` to `authentik Admins` + `family`; once `tautulli` is managed, that blueprint's two `policybinding` entries are removed (provider, application and outpost stay) so a blueprint re-apply cannot revert reconciler state. The inverse also holds: `80-infra-admin-gate.yaml` keeps sole ownership of the LAN-only infra bindings, and those applications are excluded from `authentik_owned_apps` by C-02. |
| C-10 | Note: **haynesnetwork itself stays unbound, deliberately.** The Portal is the front door that renders each user only their own Role's tiles; gating the `haynesnetwork` application on a group would break the Default-role landing experience and the enrollment path that creates it. Its access control is the Role model itself, in-app. |
| C-11 | Note: **Audit follows the ADR-045 C-06 split.** A binding create/delete is an external REST side-effect that cannot co-commit, so each successful apply appends one `authentik_group_audit` row (`action` grows `bind_application` / `unbind_application`). Local changes — the `authentik_app_slug` edit, the owned-apps allowlist — ride `setAppSetting` / the catalog single-writer into `permission_audit` in-transaction, per CLAUDE.md rule 6. |
| C-12 | Note: **Migration is additive.** Adds `app_catalog.authentik_app_slug` (nullable, default NULL), relaxes the `authentik_group_audit.action` CHECK (`+= bind_application, unbind_application`) and the `app_settings.key` CHECK (`+= authentik_owned_apps`), and backfills `synced_tier=true` on Default. No column changes type or drops. |
| C-13 | Bad (accepted): **The blast radius of the portal credential grows.** The `hnet-portal` service account needs `add_policybinding` / `delete_policybinding` / `view_policybinding` on top of its five existing permissions (OPS-011). A compromised token could rebind a managed application. Bounded by C-02's allowlist, by C-03's admins-only floor, and by the credential remaining a dedicated least-privilege service account — but the exposure is real and is the price of the owner's one-set requirement. |

## More information

- **Amends:** ADR-045 C-02 (the policy prohibition) — narrowly, for application **bindings** only, with a
  new positive allowlist. ADR-045 is otherwise unchanged and remains Accepted.
- **Depends on:** ADR-012 (the unified Role model — the single permission primitive being projected),
  ADR-013 (arbitrary catalog URLs — why C-04 rejects slug-convention matching), ADR-042 (blueprints own
  login config — the C-09 boundary), ADR-002 (Authentik OIDC as the sole sign-in method).
- **Pattern precedent:** ADR-083 (census-first rollout for risky automation), ADR-017 C-08 (enforcement
  never decision), ADR-011 (import-confined write surfaces).
- **Ops:** OPS-011 records the `hnet-portal` service account and will record the C-13 RBAC extension as
  executed. `haynes-ops` PR #2587 lands `80-infra-admin-gate.yaml` (the LAN-only infra gate) and is a
  prerequisite for C-09's ownership split.
- **Owner rulings (2026-08-23)** — all open questions are closed; no decisions remain parked:
  - **Q-01 — `paperless` stays granted to the whole Family role. RULED: keep.** The household genuinely
    shares documents, so the inherited grant is the intended state, not drift. Recorded because the
    question was raised: paperless is publicly reachable and gated solely by Authentik forward-auth, so
    its binding set is the one most worth re-reading whenever the Family role changes.
  - **Q-02 — the membership reconcile runs BOTH inline and scheduled. RULED: both** — folded into C-07.
    Inline keeps admin settings and real access in agreement immediately; the schedule is the safety net
    for drift arriving from any other path.
  - **Q-03 — VOID, premise was wrong.** The draft claimed five Authentik identities hold no Role and
    would lose all access once bindings are enforced. Verified false on 2026-08-23 by diffing all live
    Authentik human identities against `users.email`: **all 11 have a haynesnetwork user row and
    therefore a Role**; the only rows without a live Authentik identity are the two `hnet-e2e*` test
    accounts. The error was conflating "holds no Authentik **group**" (the five genuine drift cases in
    C-07, every one of which *does* have a Role) with "holds no **Role**". No user is dropped by
    construction, so the C-08 pre-flight remains the only lockout guard needed.
