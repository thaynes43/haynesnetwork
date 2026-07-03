# ADR-001: Next.js App Router in a pnpm monorepo, cloning todos-for-dues

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

haynesnetwork is a responsive web app (PRD-001 R-60) whose server side talks to Postgres,
Authentik, three Plex servers, and the *arr stack, and which deploys as a single container
image into the haynes-ops Flux cluster (R-63). We must pick the web framework, repository
layout, and TypeScript configuration as one coherent set.

Two sibling repos constrain the choice. `../todos-for-dues` implements exactly the target
architecture — pnpm monorepo, Next.js App Router, Better Auth, Drizzle + Postgres, tRPC —
and is **already deployed and running in the target cluster** (haynes-ops
`kubernetes/main/apps/frontend/todos-for-dues/`). `../demo-console` donates the
theming/layout system (ADR-005), which is plain React + CSS and ports into any React app.

## Decision drivers

1. **Proven deploy path.** The image → bjw-s app-template → Flux pipeline exists and works
   for todos-for-dues in this exact cluster; haynesnetwork should ride it, not re-derive it.
2. **Agent productivity.** Subagents copy working patterns (auth, db, tRPC, CI, Dockerfile)
   from the donor repo instead of inventing them (kickoff decision 1, 12).
3. **One build target.** A single Node runtime and Dockerfile, one thing to version and ship.
4. **End-to-end strict TypeScript** so auth/db/api types flow into the UI unbroken.

## Considered options

- **Option A** — Clone todos-for-dues: pnpm monorepo, Next.js App Router in `apps/web`
  (`output: 'standalone'`), internal workspace packages exporting raw TS.
- **Option B** — Vite SPA + separate API server (Fastify/Hono), matching demo-console's
  frontend build.

## Decision outcome

Chosen option: **Option A — pnpm monorepo + Next.js App Router, cloning todos-for-dues** —
because it reuses an architecture already proven in the target cluster, maximizes pattern
reuse for agent authors, and ships one build target.

Concretely:

- **Toolchain:** pnpm 11.9, `engines.node >= 22` (matches verified local tooling).
- **App:** `apps/web`, Next.js App Router with `output: 'standalone'`; Next.js major pinned
  to match todos-for-dues' `apps/web` (currently Next 16) so fixes port both ways.
- **Packages:** `packages/auth`, `packages/db`, `packages/api`, `packages/domain`,
  `packages/ui`, `packages/test-utils` — each exports raw TS source (no per-package build
  step; Next transpiles workspace packages).
- **TS config:** strict mode, `NodeNext` module/moduleResolution, ESM throughout.

Option B was rejected: two build targets and two deploy artifacts with **no proven deploy
pattern in haynes-ops**, and its main appeal — demo-console is Vite — is moot because
demo-console's theming and layout primitives port into any React app anyway (ADR-005).

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: Dockerfile, CI workflows, release-please, and deploy manifests copy nearly verbatim from todos-for-dues (R-63, R-65). |
| C-02 | Good: raw-TS workspace packages mean no build orchestration or watch-mode staleness inside the monorepo. |
| C-03 | Good: one strict-TS graph — Drizzle schema types (ADR-003) and tRPC router types (ADR-004) reach client components without codegen. |
| C-04 | Bad: App Router rough edges (RSC boundaries, per-major caching changes) are inherited from the donor's known trade-offs. |
| C-05 | Bad → action: todos-for-dues carries version splits — better-auth `^1.4.0` in `apps/web` vs `^1.6.11` in `packages/auth`, and zod v3 in `packages/api`/`packages/db` vs v4 in `apps/web`/`packages/auth`. haynesnetwork unifies from day one: **one better-auth version workspace-wide and zod v4 everywhere**, enforced by a single pinned entry (pnpm catalog or equivalent CI check). |
| C-06 | Neutral: intentional divergence from the donor's UI toolkit — no Tailwind/shadcn in the UI shell; theming comes from demo-console tokens instead (ADR-005). |
| C-07 | Neutral: Server Actions exist in the framework but are restricted to auth redirect helpers; the API surface is tRPC (ADR-004). |

## More information

- PRD-001: R-60, R-62, R-63, R-65.
- Kickoff decisions of record: `.agents/context/2026-07-03-kickoff.md` (decisions 1, 10, 12).
- Donor rationale: `../todos-for-dues/docs/adrs/001-web-framework.md`.
- Sibling ADRs: ADR-002 (auth), ADR-003 (database/ORM), ADR-004 (API contract),
  ADR-005 (theming/layout).
