# ADR-004: tRPC v11 as the API contract, with a role-gated procedure ladder

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

The app's mutations are permission-sensitive throughout: admin-only catalog edits (PRD-001
R-11, R-15), member-scoped fix requests (R-43..R-46), self-service library changes within
admin-set bounds (R-25..R-27). The client needs typed calls with caching and optimistic
updates (AC-05 expects grants to appear on the next dashboard query or live refresh). We
must pick the client↔server contract and where role enforcement lives. todos-for-dues'
`packages/api` already implements the target shape; Next.js' native pull toward Server
Actions is the alternative to rule on explicitly.

## Decision drivers

1. Role gating must be structural — a procedure's required role visible at its definition,
   not scattered `if` checks (R-15, R-04).
2. End-to-end types from Drizzle schema (ADR-003) through procedures to React components
   without codegen (ADR-001 C-03).
3. Typed domain errors must reach the client as stable wire codes, not stringly-typed throws.
4. Proven donor implementation to clone (kickoff decisions 1, 12).

## Considered options

- **Option A** — tRPC v11 + `@tanstack/react-query` v5, cloning todos-for-dues `packages/api`.
- **Option B** — Next.js Server Actions as the primary mutation surface.
- **Option C** — REST + zod-validated route handlers.

## Decision outcome

Chosen option: **Option A — tRPC v11 with `@tanstack/react-query` v5** — because it gives
compile-time-typed procedures with a composable middleware ladder for roles, reuses the
donor's working `packages/api` pattern, and pairs with react-query for the caching/refresh
behavior the dashboard needs. Server Actions lack a typed, composable authorization ladder
and an error contract; REST hand-rolls everything tRPC provides.

Shape of record (todos-for-dues `packages/api` pattern):

- **Context:** built per-request from Better Auth — derives the session and the **typed
  role** from the user's `additionalField` (ADR-002 C-04); no extra role query.
- **Procedure ladder:** `publicProcedure` → `authedProcedure` (session required; `ctx.user`
  non-null) → `adminProcedure` (role `'Admin'`), built from composable role middleware so
  further rungs (e.g. permission-attribute checks like Family, R-26) compose the same way.
- **Errors:** a domain-error formatter maps typed errors thrown by `packages/domain`
  helpers (ADR-003) to stable tRPC wire codes; clients switch on code, never on message.
- **Inputs/outputs:** zod v4 schemas (single zod version per ADR-001 C-05), shared with
  Drizzle-derived types where applicable.
- **Server Actions:** allowed **only** for auth redirect helpers (sign-in/sign-out
  round-trips to Authentik); every domain read/mutation goes through tRPC.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: a procedure's authorization requirement is legible at its definition site; adding an admin endpoint without gating requires deliberately choosing the wrong rung. |
| C-02 | Good: react-query cache invalidation delivers AC-05's "next dashboard query or live refresh" semantics without bespoke state code. |
| C-03 | Good: router type is the contract — client call sites break at compile time when a procedure changes (no codegen, no drift). |
| C-04 | Good: the domain-error formatter keeps `packages/domain` free of transport concerns while the UI gets stable, testable error codes. |
| C-05 | Bad: tRPC couples client and server to one TypeScript graph; any future non-TS consumer would need a separate surface. Accepted — no such consumer is planned. |
| C-06 | Bad: the "Server Actions only for auth redirects" rule is convention; guarded by review and, if drift appears, a lint rule. |
| C-07 | Note: long-running flows (ledger sync, restore execution, R-50..R-52) may need job-style endpoints (mutation enqueues, query polls); the pattern rides the same ladder and is a design-doc concern. |

## More information

- PRD-001: R-04, R-10, R-11, R-15, R-25..R-27, R-43..R-46; AC-05.
- Versions: tRPC `^11`, `@tanstack/react-query` `^5`, matching todos-for-dues `apps/web`.
- Donor pattern: `../todos-for-dues/packages/api/` (context, ladder, error formatter);
  Server-Actions caution recorded in `../todos-for-dues/docs/adrs/001-web-framework.md` C-07.
- Sibling ADRs: ADR-001 (monorepo, zod v4 unification), ADR-002 (session + typed role),
  ADR-003 (domain helpers and typed errors).
