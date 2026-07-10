# ADR-042: Authentik configuration-as-code via GitOps blueprints in haynes-ops

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Tom Haynes (owner ruling 2026-07-08 — blueprints over API; agent execution PLAN-011)

## Context and problem statement

Every Authentik change haynesnetwork depends on — the OIDC provider/application (OPS-001), the
RP-initiated-logout invalidation flow + logout redirect URIs, the `plex_user_id` scope mapping,
and the option-C login rebrand (`docs/ops/authentik-apply-seed/`) — was made the same way: an
**API `PATCH`/`POST` against live, hand-logged with a rollback payload** in an OPS doc. That was
the kickoff decision (#4: "admin token + runbook") and DESIGN-002 Part B's alternatives explicitly
**rejected blueprints "for now"** because they "couple provisioning to the Helm deployment."

Round 2 of PLAN-011 needed two things that the API-log approach serves poorly:

1. **Native-account MFA** (owner requirement) — an authenticator-validation stage + exemption
   group + skip policy bound into the password flow. This is durable security configuration that
   must be **reviewable, diff-able, and revertible**, not a one-shot API mutation whose only
   record is a prose runbook.
2. **A drift-free record of the whole login estate** so a rebuild or an accidental UI edit is
   recoverable from git, not from memory.

The owner ruling on 2026-07-08 reversed the kickoff default: **migrate Authentik to
config-as-code (blueprints / GitOps) first, then layer MFA on top of it.** This ADR records that
decision and its conventions, and thereby **resolves the original Q-01** (API-applied vs
blueprints — `authentik-apply-seed/APPLY.md` §8 / DESIGN-002 Part B) in favor of blueprints.

## Decision drivers

1. **GitOps is already the deploy mechanism.** `haynes-ops` + Flux reconciles the whole cluster;
   Authentik config living anywhere else is the odd one out. Review, rollback, and history come
   free from the same PR flow as every other change.
2. **Drift-zero reproducibility.** The live estate must be reproducible from git with *no*
   observable change on apply — proving the blueprints are a faithful mirror before any behavior
   change rides on top.
3. **MFA needs a durable declarative home.** Lockout safety (PLAN-011 requirement #4) is far
   easier to reason about, dry-run, and revert as a versioned file than as a live API edit.
4. **Authentik ships a first-class blueprint engine** (declarative YAML, server-applied,
   reconciled on an interval) — no third-party provider or state file to maintain.
5. **Secrets stay out of git.** Provider `client_secret`, `plex_token`, and brand assets must not
   be committed; the mechanism must express non-secret config only and leave secrets to External
   Secrets / 1Password.

## Considered options

- **Option A — Authentik blueprints delivered as a ConfigMap mounted onto the worker**, authored
  one-file-per-concern in `haynes-ops`, discovered + reconciled by Authentik's blueprint engine.
- **Option B — Keep API-applied + OPS-log** (the OPS-001 / apply-seed precedent), extended to MFA.
- **Option C — A Terraform/OpenTofu Authentik provider** with remote state.

## Decision outcome

Chosen option: **Option A — Authentik blueprints as config-as-code in `haynes-ops`.** It reuses
the Flux/GitOps PR flow the whole cluster already runs on, is native to Authentik (no extra state
store like Option C), and turns durable security config into reviewable, revertible files — which
Option B cannot. Option B stays the documented fallback for the objects **not** yet blueprinted
(the provider/application — Q-11) and for the fast live-rollback path.

Configuration of record (as executed 2026-07-10, live-verified — see OPS-009):

- **Layout — one blueprint per concern**, numbered by apply order, under
  `haynes-ops/kubernetes/main/apps/network/authentik/app/blueprints/`:
  `10-hnet-brand.yaml` (brand + ~70 KB custom CSS), `20-hnet-flows.yaml` (the four login-surface
  flows + stages + bindings + flow policies), `30-hnet-sources.yaml` (the `HaynesTower` Plex OAuth
  source, non-secret fields only), `40-hnet-mfa.yaml` (native-account MFA).
- **Delivery mechanism.** `app/kustomization.yaml` `configMapGenerator`
  (`disableNameSuffixHash: true`) bundles the discovered files into ConfigMap
  `authentik-hnet-blueprints`; `app/helmrelease.yaml` lists it under
  `values.blueprints.configMaps`, so the goauthentik chart mounts it onto the **worker** at
  `/blueprints/mounted/cm-authentik-hnet-blueprints`, where the engine discovers every `*.yaml`
  key and reconciles it on an interval.
- **Drift-zero baseline first.** The `10`/`20`/`30` files were merged from the live
  `…/export/` output and prove drift-zero on apply (zero `model_updated` events; login title
  unchanged) — established as a faithful mirror **before** the MFA behavior change.
- **Ownership rule (no flip-flop).** When a behavior blueprint takes over an object that the
  baseline also reproduces, the baseline's copy is **removed** so two files never fight on
  reconcile. Concretely: `40-hnet-mfa.yaml` **owns** the order-30 authenticator-validation stage
  and its flow-stage-binding; those two entries are **absent** from `20-hnet-flows.yaml`.
- **Conventions (blueprint-authoring, hard-won 2026-07-10):**
  - **`!Find` over `!KeyOf`** for cross-entry references that may resolve against a *partially
    committed* prior apply. `!KeyOf` failed when the first apply committed the group + policy but
    errored before the reference resolved; `!Find [model, [field, value]]` by a stable natural key
    is robust to partial state.
  - **pk-pinning for pre-existing objects.** A `PolicyBinding` cannot be matched by
    `(target, policy, order)` because `PolicyBinding.target` is the internal `pbm_uuid`, **not**
    the `FlowStageBinding` pk — so a re-apply hit the `(policy, target, order)` unique constraint
    and tried to create a duplicate. Pin the **existing** object's `pk` in `identifiers`
    (baseline style) so the blueprint updates in place rather than inserting.
  - **Validate before commit.** Every change was dry-run in-process via
    `kubectl exec … -- ak shell` → `Importer(yaml).validate()`, asserting **`VALID=True`** before
    the commit that Flux would apply live. This is the supported dry-run for this image (there is
    no offline `ak` validator binary) and it caught both defects above.
- **Deferred (Q-11).** The `Provider for haynesnetwork` (pk 109) OIDC provider + its application
  are **not** blueprinted — whether to adopt them into GitOps is left open; provider secrets stay
  in 1Password regardless. Until then OPS-001 remains the record for provider changes.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the login estate (brand, flows, sources, MFA) is reproducible from git with a drift-zero apply — a rebuild or an accidental UI edit is recoverable by reconcile, and every change is a reviewable diff with history. |
| C-02 | Good: native-account MFA lives as a versioned file (`40-hnet-mfa.yaml`) — enabling, tuning device classes, or reverting is a PR, and the fast live-rollback (`not_configured_action → skip` via `ak` shell) is documented (OPS-009), satisfying PLAN-011's lockout-safety requirement. |
| C-03 | Good: config lands through the same Flux PR flow as the rest of the cluster — no bespoke tooling, no separate state store (vs Option C), no secret ever committed (secrets stay in External Secrets / 1Password). |
| C-04 | Bad: the blueprint engine reconciles asynchronously and can **partially commit** a multi-entry apply on error — mitigated by the `!Find`-over-`!KeyOf` + pk-pinning conventions and the mandatory `Importer.validate()` dry-run before each commit (both defects on 2026-07-10 were caught this way). |
| C-05 | Note: config is split across two mechanisms until Q-11 — the provider/application stay API-managed (OPS-001) while brand/flows/sources/MFA are blueprinted (OPS-009). A reader must check both docs for the full Authentik picture. |
| C-06 | Note: a transient apply error can occur during a multi-worker Helm rollout (observed: the initial brand apply errored once mid-rollout, a re-apply succeeded). A single blueprint error is not itself a failure signal; confirm final status via the managed-blueprints API (all four report `successful`). |
| C-07 | Note: object pks are pinned in the files (baseline style). They are Authentik identifiers, not secrets, but a from-scratch rebuild onto a *fresh* Authentik with different pks would need the pk identifiers regenerated from that instance's export. |

## More information

- **Resolves:** the original Q-01 (API vs blueprints) — `docs/ops/authentik-apply-seed/APPLY.md`
  §8 and DESIGN-002 Part B "Alternatives" ("Authentik blueprints … rejected for now"). Owner
  ruling 2026-07-08.
- **PRD:** R-133..R-136 (native-account MFA; Plex-source pass-through; MFA exemption group;
  config-as-code).
- **Glossary:** DDD-001 T-121 (Blueprint Baseline / Config-as-Code), T-122 (MFA Exemption Group),
  T-123 (Native-Account MFA).
- **Ops:** OPS-009 (the executed log — objects, pks, apply/verify/rollback), OPS-001 (the
  API-provisioned provider this ADR deliberately leaves in place, Q-11), and
  `docs/ops/authentik-apply-seed/` (the branding-era API seed this migration formalizes).
- **Sibling repo:** `haynes-ops/kubernetes/main/apps/network/authentik/app/blueprints/` — the
  shipped blueprints + their `README.md` (delivery + drift-zero) and `pending/README.md`
  (superseded by promotion). Delivered by PR #2014 (baseline) + commits `a8bd665b` (MFA promotion),
  `42347d80` (binding-pin fix), `58355768` (friendly names).
- **Sibling ADRs:** ADR-002 (Authentik OIDC as the sole sign-in method — unchanged; MFA guards the
  *password* path only), DESIGN-002 (auth wiring + Authentik provisioning outline).
