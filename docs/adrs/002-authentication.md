# ADR-002: Better Auth with Authentik OIDC as the sole sign-in method

- **Status:** Accepted
- **Date:** 2026-07-03
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

Sign-in is exclusively via Authentik OIDC (`authentik.haynesnetwork.com`), with Plex offered
as the credential inside Authentik — no local passwords, no invite tokens (PRD-001 R-01;
kickoff decision 3). Every successful login must auto-create a Member (R-03), allowlisted
emails must be idempotently promoted to Admin with an audit row (R-02, AC-03), and the app
needs typed roles for tRPC gating (ADR-004). todos-for-dues already integrates Better Auth
with the Drizzle adapter and a bootstrap-admin database hook; the question is how much of
that carries over given the very different sign-in policy.

## Decision drivers

1. Single IdP: Authentik owns credentials; the app must never grow a password surface.
2. DB-backed sessions so role changes and revocations take effect without re-login (R-15).
3. Idempotent, auditable admin bootstrap — no manual DB step (R-02, US-02).
4. Reuse the donor's proven Better Auth + Drizzle integration (ADR-001, ADR-003).

## Considered options

- **Option A** — Better Auth, `genericOAuth` plugin pointed at Authentik as the only provider.
- **Option B** — Auth.js (NextAuth) with an OIDC provider.
- **Option C** — Hand-rolled `openid-client` + custom session table.

## Decision outcome

Chosen option: **Option A — Better Auth with the Drizzle adapter and a single `genericOAuth`
provider for Authentik** — because it carries the donor's working integration (adapter,
session model, database hooks) while the parts todos-for-dues used for local accounts
(email+password, invite tokens) are simply not enabled. Options B/C would discard the
proven bootstrap-hook and adapter patterns for no policy gain.

Configuration of record:

- **Sessions:** DB-backed; `expiresIn` 7 days, `updateAge` 1 day (AC-01's 7-day cookie).
- **Provider:** `genericOAuth` with `providerId: 'authentik'`, configured by OIDC discovery
  URL `https://authentik.haynesnetwork.com/application/o/haynesnetwork/.well-known/openid-configuration`,
  overridable via `OIDC_DISCOVERY_URL`; scopes `openid profile email`.
- **No email+password, no invite tokens** — the corresponding Better Auth features stay off
  (deliberate divergence from todos-for-dues ADR-002).
- **Roles:** `'Member'` (default) | `'Admin'` as a Better Auth `additionalField` on the user,
  so the typed role rides the session into tRPC context (ADR-004). **'Family' is a
  permission attribute, not a role** (R-26/R-27; kickoff permission model).
- **Admin bootstrap:** a `databaseHooks.session.create.after` hook compares the session
  user's email (case-insensitive) against comma-separated `BOOTSTRAP_ADMIN_EMAILS`
  (seeded `manofoz@gmail.com,t.haynes43@gmail.com` — both owner emails, since which one
  Authentik emits is unconfirmed, PRD-001 Q-01). Matches are idempotently promoted to
  Admin with a `user_role_transitions` audit row (system initiator) in the same
  transaction (R-02, R-04, AC-03). This is todos-for-dues' `bootstrap-admin.ts` pattern,
  generalized from a single email to a list.
- **Authentik side:** the OIDC provider/application in Authentik is provisioned via
  Authentik's API (admin token available per kickoff decision 4) and documented as a
  runbook under `docs/ops/`.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: zero password surface — no reset flows, no credential storage, no invite lifecycle to maintain. |
| C-02 | Good: DB sessions make promotion/demotion effective on next request; the 1-day `updateAge` keeps active users signed in without unbounded cookie lifetimes. |
| C-03 | Good: bootstrap is a pure function of (allowlist, email) — safe to re-run on every session create; repeat logins are no-ops (AC-03). |
| C-04 | Good: role as a typed `additionalField` means ADR-004 middleware narrows `ctx.role` without extra queries. |
| C-05 | Bad: total dependence on Authentik availability for sign-in; an Authentik outage locks everyone out (existing sessions survive up to 7 days). Accepted — Authentik already fronts the ecosystem. |
| C-06 | Bad: `genericOAuth` is less exercised than Better Auth's named providers; integration tests must cover the discovery/callback path, and CI stubs OIDC (R-66). |
| C-07 | Note: exact OIDC claim mapping (displayName/avatar from Authentik/Plex) is a design-doc detail (AC-02), not decided here. |
| C-08 | Note: the Authentik provisioning runbook must record redirect URIs for both staging (`haynesnetwork.haynesops.com`) and production hosts (R-64). |

## More information

- PRD-001: R-01..R-04, R-66; AC-01..AC-03; Q-01.
- Kickoff: decisions 3, 4, 11; default A (allowlist seed).
- Donor pattern: `../todos-for-dues/packages/auth/src/hooks/bootstrap-admin.ts` and
  `../todos-for-dues/docs/adrs/002-auth.md`.
- Sibling ADRs: ADR-001 (stack), ADR-003 (Drizzle adapter, audit-in-transaction),
  ADR-004 (role-gated procedures).
