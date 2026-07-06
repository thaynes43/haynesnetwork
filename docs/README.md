# docs — navigation index

haynesnetwork is **documentation-first**: every feature travels
`PRD → ADR → DDD → design → plan → code → tests`. Read
[`PROCESS.md`](PROCESS.md) before adding or changing anything here.

This file is a map, not a summary — open the doc for the detail.

## Where things actually live

- **Executable plans live in [`.agents/plans/`](../.agents/plans/)**, not `docs/plans/`.
  `.agents/HANDOFF.md` is the resume point; dated coordination notes in `.agents/context/`.
- **`docs/plans/`, `docs/flows/`, `docs/releases/` are template scaffolding only** — no
  numbered docs land there. Flows fold into the relevant design doc; release scoping is
  handled by release-please + conventional commits (see ADR-009), not release docs.
- **ADRs are MADR 3.0 and immutable once Accepted** — never edit an Accepted ADR; supersede
  it with a new one and record a `Superseded/Amended by ADR-NNN` status link on the old one.
- **Designs and the DDD glossary are amended in place** as behavior changes, in the same PR.
- Copy a folder's `000-template.md` to start a new numbered doc. IDs (`R-`/`US-`/`AC-`/`Q-`
  in PRDs, `C-` in ADRs, `D-` in designs) are stable forever — never renumber or reuse.

## Code-level entry points

For the implementation (not the decisions), start at the per-package READMEs:
[`packages/db`](../packages/db/README.md), [`packages/domain`](../packages/domain/README.md),
[`packages/arr`](../packages/arr/README.md), [`packages/sync`](../packages/sync/README.md),
[`packages/api`](../packages/api/README.md), [`packages/ui`](../packages/ui/README.md),
and the app itself at [`apps/web`](../apps/web/README.md).

## PRDs — [`prds/`](prds/)

| ID | Title | Read when |
|----|-------|-----------|
| PRD-001 | [haynesnetwork — SSO front door and media service hub](prds/001-haynesnetwork.md) | You need the what/why: requirements (`R-NN`), user stories, acceptance criteria, open questions. The root of every ID reference. |

## ADRs — [`adrs/`](adrs/)

MADR 3.0, one decision each, immutable once Accepted.

| ID | Title | Read when |
|----|-------|-----------|
| ADR-001 | [Next.js App Router in a pnpm monorepo](adrs/001-web-framework-and-monorepo.md) | You need the stack/monorepo rationale. (Predates the `@hnet/arr` + `@hnet/sync` packages — there are eight `@hnet/*` packages, not six.) |
| ADR-002 | [Better Auth with Authentik OIDC as the sole sign-in](adrs/002-authentication.md) | Anything auth: why OIDC-only, admin bootstrap by email allowlist. (Role model amended by ADR-012.) |
| ADR-003 | [PostgreSQL 16 (CNPG) + Drizzle, migrator init container, audit-in-transaction](adrs/003-database-and-orm.md) | Why PG16-only, the migrator initContainer, single-writer audit-in-transaction rule. |
| ADR-004 | [tRPC v11 as the API contract, role-gated procedure ladder](adrs/004-api-contract.md) | Adding/altering an API procedure or the role gates. |
| ADR-005 | [Port demo-console's CSS-token theming and viewport-fit layout](adrs/005-theming-and-layout.md) | Touching theming, tokens, or layout primitives (see hard-rule 2 / the hex guard). |
| ADR-006 | [Hosting and deployment — single GHCR image via Flux, staged ingress](adrs/006-hosting-and-deployment.md) | Deploy shape: one multi-stage GHCR image, haynes-ops Flux reconcile, staged ingress rollout. Pairs with OPS-004/005. |
| ADR-007 | [Fix semantics — mark-failed + search with a mandatory reason taxonomy](adrs/007-fix-semantics.md) | Fix behavior. **Amended by ADR-011** (adds Force Search + roll-up scopes). |
| ADR-008 | [Media ledger — *arrs are source of truth, one-way sync, two audited write-backs](adrs/008-media-ledger-and-sync.md) | Ledger/sync model and the write-back rule. **Amended by ADR-011.** |
| ADR-009 | [CI and PR flow — required checks, GATE A cutover, release-please](adrs/009-ci-and-pr-flow.md) | Branch/PR/merge rules, required checks, how versioning + release tagging works. |
| ADR-010 | [Test strategy — Vitest + embedded Postgres, Playwright + stub OIDC, contract guards](adrs/010-test-strategy.md) | Writing tests, or understanding the import/no-direct-write contract guards. |
| ADR-011 | [*arr write-back surface — Force Search + roll-up scopes](adrs/011-arr-write-back-surface.md) | The current write-back decision: Accepted, amends ADR-007/008 to add Force Search and season/series roll-up scopes. |
| ADR-012 | [Unified Role model — one admin-managed Role per user](adrs/012-unified-role-model.md) | The entitlement model: DB-backed `roles` (one per user) replace the Member/Admin enum + tags + per-user grants + family flag + default_visible. **Supersedes ADR-002 C-04** (role-as-enum). |

## DDD — [`domain-driven-design/`](domain-driven-design/)

Normative glossary; code and docs use its terms exactly.

| ID | Title | Read when |
|----|-------|-----------|
| DDD-001 | [Ubiquitous Language](domain-driven-design/001-ubiquitous-language.md) | Any domain term. Add new terms here in the same change. (Plex terms `T-17..T-21` are placeholders — Phase 3 unbuilt.) |
| DDD-002 | [Bounded Contexts](domain-driven-design/002-bounded-contexts.md) | You need the context map / which package owns what. |

## Designs — [`designs/`](designs/)

How, not why. Reference the PRD/ADR IDs they satisfy; amended in place.

| ID | Title | Read when |
|----|-------|-----------|
| DESIGN-001 | [Database schema — Phase 1 (identity, catalog, roles, audit)](designs/001-database-schema.md) | Working on schema, catalog URL normalization (ADR-013: any http(s) URL; scheme-only CHECK), or audit tables. (Entitlement tables re-shaped by ADR-012 — roles/role_app_grants.) |
| DESIGN-002 | [Auth wiring — Better Auth + Authentik OIDC; provisioning](designs/002-auth-and-authentik.md) | Wiring auth or the callback path. Operator steps are in OPS-001. |
| DESIGN-003 | [tRPC surface for Phase 1](designs/003-trpc-surface.md) | The concrete procedure list / router shape. |
| DESIGN-004 | [UI shell and dashboard (Phase 1)](designs/004-ui-shell-and-dashboard.md) | Dashboard/app-catalog UI and component contracts. |
| DESIGN-005 | [*arr media ledger, Fix, and failsafe Restore — Phase 2](designs/005-arr-ledger-and-fix.md) | Ledger sync, Fix / Restore / Force-Search flows. Read alongside ADR-008/011. |
| DESIGN-006 | [Visual identity — mark, type, shape language](designs/006-visual-identity.md) | Anything visual-brand: this app has its own identity, never a clone of a sibling app. |
| DESIGN-007 | [Plex library self-service — Phase 3](designs/007-plex-library-self-service.md) | The `@hnet/plex` client, `plex` router, role→library grants, share read-merge-write, registry refresh. Governed by ADR-017; supersedes DESIGN-001 Appendix A. |

## Ops runbooks — [`ops/`](ops/)

Operator procedures and secret contracts.

| ID | Title | Read when |
|----|-------|-----------|
| OPS-001 | [Authentik OIDC provisioning](ops/001-authentik-provisioning.md) | Creating/repairing the Authentik provider (note the required `grant_types`). |
| OPS-002 | [Plex & Tautulli topology of record](ops/002-plex-topology.md) | Reference for Plex/Tautulli layout (Phase 3 background). |
| OPS-003 | [Local verification runbook](ops/003-local-verification.md) | Before you push: the local merge-gate sequence (`lint` + `lint:css` + `typecheck` + `test` + `build`) on embedded PG16, no Docker. |
| OPS-004 | [Deploy runbook](ops/004-deploy-runbook.md) | Getting a merged PR to live staging: image tag → haynes-ops helmrelease edit → Flux reconcile, plus the 1Password secret contract. |
| OPS-005 | [Root-domain cutover](ops/005-root-domain-cutover.md) | Promoting staging to the public root domain (ingress swap + `BETTER_AUTH_URL` flip), gated on Phase-1 e2e. |
