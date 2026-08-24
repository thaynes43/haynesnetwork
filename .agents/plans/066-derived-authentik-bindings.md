# PLAN-066: Derived Authentik application bindings — build, census, promotion ladder

- **ADR:** ADR-085 (Proposed) · **Design:** DESIGN-047
- **Owner:** whoever holds the session — this plan is the tracked owner, so it cannot sit unassigned
- **Current ladder level:** **L0 (census only)** — see the ladder log at the bottom

## The problem (audit, 2026-08-23)

Five household applications — `paperless`, `immich`, `kavita`, `audiobookshelf`, `open-webui` — have
**zero Authentik policy bindings**, which admits any authenticated identity. `paperless` is the sharpest:
personal documents, publicly reachable, forward-auth, so Authentik is the only gate. Enrollment
auto-creates accounts with no approval step.

It cannot simply be switched on. Authentik group membership has **drifted** from the Roles it mirrors
(ADR-045's projection is event-driven only), so enforcing today locks out five real users:
`miaellen25@gmail.com` (Family, not in `family`), `jbadessa@gmail.com` + `seeaych@gmail.com` (Friends,
not in `friends`), `aringan0323@gmail.com` + `danweaver8@gmail.com` (Default, which projects to no group).

**"Pending the reconciler" is only a plan while the reconciler has an owner. This file is that owner.**

## Build stages

| # | Stage | Deliverable | Gate |
|---|---|---|---|
| S1 | Schema | migration: `app_catalog.authentik_app_slug` (+ partial unique index), CHECK relaxations, `Default.synced_tier=true` backfill | `pnpm --filter @hnet/db migrate` clean, up+down |
| S2 | Derivation | `deriveBindings` pure function (DESIGN-047 D-03) | unit truth-table green, zero I/O |
| S3 | Write surface | 3 binding methods on `@hnet/authentik/write` + `findApplicationBySlug` | import-guard test extended and green |
| S4 | Guardrail | `assertApplicationOwned`, empty-set refusal, admins-floor refusal | tests assert **zero client calls** on rejection |
| S5 | Membership reconcile | `projectMembershipForUser` extracted + called from every role-setting path; `--mode=authentik-membership` | idempotency test: 2nd run = 0 writes |
| S6 | Pre-flight | lockout check (D-07) | fails on the 5-user fixture, passes post-reconcile |
| S7 | Census | compute + log both diffs, write nothing | **L0 contract below** |
| S8 | Reconciler | `reconcileApplicationBindings`, create-before-delete | ordering + idempotency tests |
| S9 | Admin UX | catalog Authentik-app field, per-app derived-groups preview, census panel | e2e via extended `stub-authentik.ts` |

Hard rule: **S5 and S6 land before S8 is ever enabled.** The reconciler may be built earlier; it may not
be switched on until the pre-flight is green.

## The promotion ladder — criteria and obligations

| Level | Behaviour | Promotion criteria |
|---|---|---|
| **L0** | Census only. Both diffs logged, nothing written. | One clean census run whose binding diff matches the hand-derived expectation for all 5 managed apps. |
| **L1** | Membership reconcile applies. Bindings still observe-only. | Pre-flight (D-07) goes **green** — all five drifted users repaired, zero `expected \ actual`. |
| **L2** | Bindings enforced for `kavita` only (canary). | A Family, a Friends and a Default user each verified still able to reach kavita after enforcement. |
| **L3** | All managed apps enforced. | L2 stable with no access complaints; census shows a steady empty diff. |

**Standing obligation** (same contract as PLAN-065): a session that touches this plan advances the ladder
or records why it could not. Census stagnation is the failure mode, not premature action. Do not leave it
parked at L0 while calling the gap "deliberate".

## Verification contract (S7 / census)

A census run passes when:

1. It names every managed app (non-null `authentik_app_slug` ∩ `authentik_owned_apps`) and no others.
2. The six blueprint-owned slugs (`dev-env`, `headlamp`, `grafana`, `omni`, `tautulli-k8plex`,
   `tautulli-plexops`) appear **nowhere** in the output.
3. Every derived set is non-empty and contains `authentik Admins`.
4. Any non-synced Role granting a managed app is reported as a **violation**, not silently dropped.
5. The membership diff reproduces the five known drifted users on first run.

## Ladder log

| Date | Level | Note |
|---|---|---|
| 2026-08-23 | **L0** | Plan opened. ADR-085 merged (#530); `80-infra-admin-gate.yaml` merged (haynes-ops #2587) gating the LAN-only infra apps, which are explicitly **out** of this plan's scope. Build not yet started — S1 is next. |
