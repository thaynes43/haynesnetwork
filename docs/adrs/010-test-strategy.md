# ADR-010: Test strategy — Vitest with embedded Postgres, Playwright with stub OIDC, contract guards

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

PRD-001 demands tests that prove real behavior: Postgres 16 semantics with no engine
substitution (R-62), a responsive UI proven across phone/tablet/PC viewports (R-60,
AC-10), the OIDC login flow (R-66), and hard invariants like tokenized theming (R-61) and
transactional audit writes (R-04). One environment fact forces a divergence from the donor
repo: **this WSL distro has no Docker daemon**, so Testcontainers — todos-for-dues'
integration-test backbone — is unavailable locally. We need a test stack that keeps real
Postgres without Docker, and we must decide what each layer of the pyramid proves.

## Decision drivers

1. Real Postgres 16 everywhere tests touch a database — never SQLite/MySQL substitution
   (CLAUDE.md hard rule 1, R-62).
2. Must run identically on this Docker-less WSL machine and in GitHub Actions CI.
3. e2e must prove the actual user journeys: login via OIDC, per-role dashboards, and the
   viewport matrix (R-60, R-66, AC-10) — deterministically in CI.
4. Structural invariants (theming tokens, audited permission writes) should be enforced by
   tests, not code review.
5. Stay close to the sibling repos' tooling (Vitest, Playwright) so patterns port.

## Considered options

- **Option A** — Vitest for unit/integration with real Postgres 16 via an **embedded
  postgres binary** npm package (e.g. `embedded-postgres`); Playwright for e2e with a
  local stub OIDC provider in CI; contract/guard tests in CI.
- **Option B** — Testcontainers Postgres (the todos-for-dues pattern).
- **Option C** — In-memory/substitute engines (SQLite, PGlite) for speed.
- **Option D** — e2e against live Authentik only; no stub provider.

## Decision outcome

Chosen option: **Option A** — the only option that is real-Postgres, Docker-free, and
CI-deterministic. **This deliberately diverges from todos-for-dues** (its ADR-006 chose
Testcontainers): no Docker daemon exists in this WSL distro, so its test-utils cannot be
copied verbatim — the Postgres lifecycle wrapper is rewritten around the embedded binary.

The testing pyramid and what each layer proves:

- **Unit (Vitest, no DB):** pure domain logic — permission-union math (R-22), catalog URL
  validation rejecting `*.haynesops.com` (R-14), fix-reason taxonomy rules (R-45).
- **Integration (Vitest + embedded Postgres 16):** each run starts a real PG16 server from
  the embedded binary, applies the actual Drizzle migrations, and exercises tRPC
  procedures end-to-end at the API boundary — proving schema, transactions (role changes
  and their audit rows commit or roll back together, R-04/AC-03), and sync/ledger queries
  (ADR-008) against genuine Postgres semantics.
- **e2e (Playwright, advisory in CI until hardening — ADR-009):**
  - **Resize matrix (AC-10):** 375×667, 390×844, 412×915, 768×1024, 820×1180, 1280×800,
    1920×1080, 2560×1440 — no page-level scrollbars, no off-screen controls, panes scroll
    internally (demo-console pattern).
  - **OIDC login flow (R-66, AC-01):** in CI the app points at a **local stub OIDC
    provider** (discovery + authorize + token + JWKS) so sign-in → callback → session is
    tested deterministically; live Authentik is optional locally, and the staged rollout
    (ADR-006) validates the real integration at `haynesnetwork.haynesops.com`.
  - **Per-role visibility:** default Member tiles vs admin-granted tiles (AC-04, AC-05).
- **Contract/guard tests (run in CI's `test` job):**
  - **Token contract (R-61):** both themes (`data-theme` light/dark) define every entry in
    `REQUIRED_TOKENS` — the demo-console `tokenContract` pattern — plus the hex-lint
    guard keeping raw colors out of everything but `tokens.css`.
  - **Domain guard (R-04):** a CI test forbids direct role/permission table writes outside
    `packages/domain`, so the audited-transaction path is the only path.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: integration tests run the same Postgres 16 engine and migrations as production, with no Docker dependency locally or in CI. |
| C-02 | Good: the OIDC journey is tested on every PR without network dependence on Authentik; stub and live configs differ only by issuer env vars. |
| C-03 | Good: hard rules become executable — theme drift and un-audited permission writes fail CI instead of relying on review. |
| C-04 | Bad: divergence from todos-for-dues — its Testcontainers-based test-utils and CI assumptions do not port; the embedded-binary lifecycle (download, port allocation, teardown) is ours to own and document. |
| C-05 | Bad: the embedded binary is a per-platform download — first runs are slow and CI must cache it; version must be pinned to match CNPG's PG16. |
| C-06 | Bad: a stub provider cannot prove real Authentik behavior (claim shapes, logout). Mitigated by the staged rollout gate: Phase 1 e2e runs against staging with live Authentik before the public cutover (R-64). |
| C-07 | Neutral: e2e remains advisory until hardening (ADR-009 C-06); the resize matrix and login flow must still pass before the GATE-A-to-hardening window closes. |

## More information

- PRD-001 R-04, R-14, R-60..R-62, R-66, AC-01..AC-05, AC-10.
- ADR-006 (staging environment used for live-Authentik validation), ADR-008 (sync logic
  under integration test), ADR-009 (which CI jobs run which layers).
- Donors: demo-console `apps/shell/src/shell/theme/tokenContract.ts` and its Playwright
  resize matrix; todos-for-dues Vitest/Playwright layout (minus Testcontainers).
- Embedded Postgres candidates evaluated at scaffold time (`embedded-postgres` et al.);
  the pick is recorded in the scaffold plan, not here — the decision is *embedded real
  PG16 binary*, not a specific wrapper package.
