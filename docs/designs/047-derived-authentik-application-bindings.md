# DESIGN-047: Derived Authentik application bindings + membership reconcile

- **Status:** Draft
- **ADR:** ADR-085 (Proposed) — amends ADR-045 C-02 narrowly to permit application **bindings**
- **Depends on:** ADR-012 (unified Role), ADR-045 (group-membership write surface), ADR-042 (blueprints
  own login config), ADR-083 (census-first rollout)

## Overview

Today haynesnetwork decides *which tiles a user sees* (`role_app_grants` → Portal) while Authentik
decides *what a user may actually open* (application policy bindings), and nothing keeps the two
agreeing. The audit of 2026-08-23 found the consequence: five household apps
(`paperless`, `immich`, `kavita`, `audiobookshelf`, `open-webui`) had **zero bindings**, which in
Authentik admits any authenticated identity.

This design makes the second a **derivation** of the first, so a Role edit in `/admin/roles` is the
single lever, per the owner requirement: *"I do not want to manage two sets of apps."*

It also repairs the reason we cannot simply switch enforcement on today: Authentik group membership has
**drifted** from the Roles it mirrors, because ADR-045's projection is event-driven only. Five real
users hold a Role whose apps they would lose the instant bindings are enforced. Membership reconcile
therefore ships **first** and enforcement is gated behind a pre-flight that proves nobody is dropped.

Two invariants govern everything below:

1. **Zero bindings means OPEN in Authentik.** A deletion bug therefore fails *open*. Every write path
   is built so an empty derived set is unreachable.
2. **The blueprint and the reconciler must never own the same application.** Whoever owns it, owns it
   alone.

## Detailed design

### D-01 — schema (migration, additive)

```sql
ALTER TABLE app_catalog ADD COLUMN authentik_app_slug text;              -- NULL = not gated, never touch
CREATE UNIQUE INDEX app_catalog_authentik_app_slug_key
  ON app_catalog (authentik_app_slug) WHERE authentik_app_slug IS NOT NULL;
-- CHECK relaxations
--   authentik_group_audit.action += 'bind_application', 'unbind_application'
--   app_settings.key            += 'authentik_owned_apps'
-- backfill: roles.synced_tier = true WHERE name = 'Default'   (ADR-085 C-06)
```

`authentik_app_slug` is **NULL by default**. A catalog row only becomes managed when an admin names its
Authentik application explicitly. `seerr` stays NULL forever — Overseerr authenticates against Plex and
has no Authentik application. Slug-convention matching is rejected (ADR-085 C-04): catalog URLs are
arbitrary (ADR-013) and a coincidental match must never silently enroll an application.

The partial unique index prevents two catalog rows claiming the same Authentik application, which would
make the derivation ambiguous.

### D-02 — `@hnet/authentik/write` gains three binding methods

```ts
listApplicationBindings(appPk: string): Promise<AuthentikBinding[]>   // GET  /api/v3/policies/bindings/?target=<pk>
createApplicationBinding(input: {target, group, order}): Promise<...> // POST /api/v3/policies/bindings/
deleteApplicationBinding(bindingPk: string): Promise<void>            // DELETE /api/v3/policies/bindings/<pk>/
```

Import-confined to `packages/domain` by the existing `arr-write-import-guard` test — its pattern already
covers `@hnet/authentik/write`, so no guard change is needed, only new cases asserting no route/app
imports them. `@hnet/authentik/read` gains `findApplicationBySlug`.

### D-03 — the derivation (pure, unit-testable, no I/O)

```ts
// packages/domain/src/derive-app-bindings.ts
export function deriveBindings(
  catalog: { id: string; authentikAppSlug: string | null }[],
  roles:   { id: string; isAdmin: boolean; grantsAll: boolean; syncedTier: boolean; groupName: string | null }[],
  grants:  { roleId: string; appId: string }[],
): Map</* authentikAppSlug */ string, /* group names, ordered */ string[]>
```

Rules:
- Only catalog rows with a non-null `authentikAppSlug` appear in the result.
- `authentik Admins` is emitted **first (order 0) for every managed app, unconditionally** — the
  admins-only floor of ADR-085 C-03.
- A Role contributes its group when it grants the app, or when `isAdmin`/`grantsAll` (which grant
  everything implicitly and hold no `role_app_grants` rows).
- Only `syncedTier` roles contribute a group; a **non-synced role that grants a managed app is a
  contract violation** and is returned separately as `violations`, never silently dropped (ADR-085 C-06).

Being pure makes the risky part cheap to test exhaustively without a live Authentik.

### D-04 — the guardrail (`assertApplicationOwned`)

Mirrors ADR-045's `assertGroupOwned`, checked **before any external call**:

```ts
if (!ownedApps.includes(slug)) throw new AuthentikApplicationNotOwnedError(slug)
```

`authentik_owned_apps` is an `app_settings` positive allowlist. It **ships empty** — every application
is opt-in. `dev-env`, `headlamp`, `grafana`, `omni`, `tautulli-k8plex`, `tautulli-plexops` must never be
added: they are blueprint-owned and LAN-only (`80-infra-admin-gate.yaml`). A unit test asserts those six
slugs are rejected even if someone puts them in the allowlist.

### D-05 — `reconcileApplicationBindings` (the writer, fails CLOSED)

For each managed app, diff desired (D-03) against live (`listApplicationBindings`), then:

```
if desired.length === 0            -> REFUSE, log, alert. Never apply.       (ADR-085 C-03)
if desired lacks 'authentik Admins'-> REFUSE. The floor is not optional.
apply order: CREATE missing bindings FIRST, then DELETE extras.
```

Create-before-delete matters: it guarantees the application is never momentarily unbound, which would
briefly open it to everyone. Each successful call appends one `authentik_group_audit` row
(`bind_application` / `unbind_application`). Idempotent: a second run is a no-op.

> **Known Authentik behaviour** (observed 2026-08-23 landing `80-infra-admin-gate.yaml`): the three
> `authentik-worker` replicas race on a *first* blueprint apply and can create duplicate identical
> bindings. Harmless under `policy_engine_mode=any` but untidy. The reconciler is a single writer and
> additionally treats "more than one binding for the same (order, group)" as an extra to delete, so it
> converges the duplicates blueprints can leave behind.

### D-06 — membership reconcile, inline **and** scheduled (ADR-085 C-07)

The projection gap that caused the drift: `assignRolePortal` is the only path that writes membership, so
`bootstrapAdminOnSignin` and `consumePendingRoleForUser` silently skipped it.

- **Inline** — extract `projectMembershipForUser(userId)` from `assignRolePortal` and call it from every
  path that sets a role. Keeps admin settings and reality in agreement immediately.
- **Scheduled** — `@hnet/sync --mode=authentik-membership` walks every user, computes the exclusive
  owned-group diff (ADR-045 C-07 semantics, untouched), applies it, and reports. Catches drift from any
  future path that forgets.

Both reuse the existing exclusive-diff logic and audit trail. Neither ever touches a non-owned group.

### D-07 — the pre-flight (the lockout guard, ADR-085 C-08)

Refuses to enable enforcement while anyone would be dropped:

```
for each managed app:
  expected := users whose Role grants it
  actual   := users in any group bound to it
  if expected \ actual is non-empty -> FAIL, naming every user and the app
```

At time of writing this fails with five names (`miaellen25@`, `jbadessa@`, `seeaych@`, `aringan0323@`,
`danweaver8@`). It passes only after D-06 has run. **Enforcement is unreachable until it passes.**

### D-08 — the census ladder (ADR-083 pattern)

| Level | Behaviour |
|---|---|
| **L0** | Census only. Compute and log the binding diff and the membership diff. Write nothing. |
| **L1** | Membership reconcile applies (D-06). Bindings still observe-only. Pre-flight must go green here. |
| **L2** | Bindings applied for **one** low-risk app (`kavita`) as a canary. Verify a Family, Friends and Default user can each still reach it. |
| **L3** | All managed apps enforced. |

Current level lives in `.agents/HANDOFF.md`; advancing it is a standing obligation, not optional — same
contract as PLAN-065's janitor.

### D-09 — surfacing it in `/admin`

The catalog editor gains an **Authentik app** field (nullable, free text + a picker populated from
`findApplicationBySlug`), and the roles page shows, per app, which groups will be bound — so the derived
consequence of a Role edit is visible *before* saving. A `/admin` panel renders the latest census diff
and the pre-flight result, including violations from D-03.

## Alternatives considered

- **Hand-maintain bindings in the Authentik UI** — rejected by ADR-085; it is the drift problem itself.
- **Blueprints for every binding** — rejected for catalog apps (a cluster PR per household permission
  change); retained for the LAN-only infra apps, where the gate is static.
- **Gate at the Portal only** — rejected: the Portal is not in the request path, every app has a public
  hostname, and hiding a tile hides nothing.
- **Delete-then-create ordering** — rejected: it opens a window where the app has zero bindings and is
  therefore open to everyone.

## Test strategy

- **Unit (no I/O)** — `deriveBindings` truth table: admin/grantsAll implicit-all; non-synced granting
  role surfaces as a violation; NULL `authentik_app_slug` excluded; `authentik Admins` always present.
- **Guardrail** — `assertApplicationOwned` rejects each of the six blueprint-owned slugs, and rejects an
  app absent from the allowlist, **before** any client call (assert the stub records zero requests).
- **Fails-closed** — an empty derived set and a set missing `authentik Admins` both refuse and write
  nothing.
- **Ordering** — assert creates precede deletes, so the app is never transiently unbound.
- **Idempotency** — a second reconcile issues zero writes; duplicate live bindings converge to one.
- **Pre-flight** — a fixture reproducing today's five drifted users fails and names them; passes after
  the membership reconcile fixture runs.
- **Import confinement** — extend the write-guard test to the three new binding methods.
- **e2e** — extend `stub-authentik.ts` with the bindings endpoints; assert the census panel renders a
  diff and that enforcement is refused while the pre-flight is red.

## Open questions

None. ADR-085's three questions were ruled on 2026-08-23 (paperless stays on Family; reconcile runs both
inline and scheduled; the "Role-less identities" question was void — all 11 Authentik humans hold a
Role).
