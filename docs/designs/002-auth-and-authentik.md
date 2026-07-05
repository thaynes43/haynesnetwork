# DESIGN-002: Auth wiring — Better Auth + Authentik OIDC; Authentik provisioning

- **Status:** Accepted
- **Last updated:** 2026-07-05
- **Satisfies:** PRD-001 R-01, R-02, R-03, R-04 (role-audit path); AC-01, AC-02, AC-03;
  governed by ADR-002 (Authentik OIDC via Better Auth), ADR-003 (Postgres 16 + Drizzle), and
  **ADR-012 (unified Role model)**. Depends on DESIGN-001
  (users/session/account/verification, `roles`, `user_role_transitions`, `assignRole`).

> **Amended by ADR-012 (2026-07-05):** role is no longer a Better Auth `additionalField`
> enum. `users.role_id` is a FK (DB-defaulted to the seeded Default role), so `config.ts`
> declares **no `role` additionalField** and `mapProfileToUser` sets no role. The session
> extension grafts `role = { id, name, isAdmin }` (`users ⋈ roles`) — no `isFamily`. Bootstrap
> promotes an allowlisted email to the **Admin role** via `assignRole` (not `transitionRole`).
> D-02, D-05, D-06 below carry the amendments.

## Overview

Two parts:

- **Part A — Better Auth wiring** (`packages/auth`): the Better Auth instance configured with
  the `genericOAuth` plugin as the **sole** sign-in method (providerId `authentik`), the
  drizzle adapter over DESIGN-001's tables, the 7-day session, and the
  `BOOTSTRAP_ADMIN_EMAILS` promotion hook (R-02/AC-03). No `emailAndPassword`, no invite
  tokens — R-01/CLAUDE.md rule 5.
- **Part B — Authentik provisioning**: how the agent creates the OAuth2 provider +
  application in Authentik via its admin API (kickoff decision #4), where the credentials
  land, and the runbook outline (full runbook ships in `docs/ops/` with the implementation).

The wiring mirrors todos-for-dues `packages/auth/src/config.ts` (the proven donor) with the
Google-Workspace-specific parts (HD restriction, email/password, invite tokens) removed and
the provider swapped to Authentik.

**Definition of success:** an implementation agent can produce a working auth subsystem where
(a) an unauthenticated visit offers exactly one "Sign in" action that round-trips through
Authentik and establishes a 7-day session cookie (AC-01), (b) first login creates a Member
row with displayName/email from OIDC claims (AC-02), (c) first login by an allowlisted email
is idempotently promoted to Admin with a system-initiated `user_role_transitions` row (AC-03);
and an operator can run Part B's steps top-to-bottom to provision Authentik and obtain
`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`.

---

## Part A — Better Auth wiring

### D-01 Package layout

```
packages/auth/
  src/
    index.ts                  ← exports auth, oidcEnabled, getServerSession, SessionUser, getSessionExtension, SessionRole, bootstrapAdminOnSignin, env helpers
                                (ADR-012: getSessionRole removed — the session carries the role object)
    config.ts                 ← Better Auth instance (D-02)
    env.ts                    ← D-08 env contract: authEnv()/assertAuthEnv()/parseBootstrapAdminEmails
    hooks/
      bootstrap-admin.ts      ← BOOTSTRAP_ADMIN_EMAILS promotion (D-05)
      session-extension.ts    ← getSessionExtension (+ SessionRole/SessionExtension types) (D-06; ADR-012: getSessionRole removed)
apps/web/
  app/api/auth/[...all]/route.ts   ← Better Auth catch-all handler (D-07)
```

(Donor's `hd-restriction.ts` and `invite-tokens/` have no haynesnetwork equivalent — anyone
Authentik authenticates is a Member, R-03.)

### D-02 `packages/auth/src/config.ts`

> **Amended by ADR-012 (shipped):** two deletions from the block below. `mapProfileToUser`
> **no longer sets `role`** (the `role: 'Member'` line is gone) — `users.role_id` DB-defaults
> to the seeded Default role (R-03, DESIGN-001 D-02). And `user.additionalFields` **no longer
> declares `role`** — the role rides the session via `getSessionExtension` (D-06,
> `users ⋈ roles`), not as a Better Auth field. Everything else (provider, sessions, rate
> limiting, bootstrap hook) is unchanged.

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { eq } from 'drizzle-orm';
import { db, users, session, account, verification } from '@app/db';
import { bootstrapAdminOnSignin } from './hooks/bootstrap-admin';

const DEFAULT_OIDC_DISCOVERY_URL =
  'https://authentik.haynesnetwork.com/application/o/haynesnetwork/.well-known/openid-configuration';
const OIDC_PROVIDER_ID = 'authentik';

const oidcClientId = process.env.OIDC_CLIENT_ID;
const oidcClientSecret = process.env.OIDC_CLIENT_SECRET;

// App still boots without OIDC creds (CI builds, unit tests); the login page
// renders a config-error state instead of a sign-in button when disabled.
export const oidcEnabled = Boolean(oidcClientId && oidcClientSecret);

const oidcPlugins = oidcEnabled
  ? [
      genericOAuth({
        config: [
          {
            providerId: OIDC_PROVIDER_ID,
            clientId: oidcClientId!,
            clientSecret: oidcClientSecret!,
            discoveryUrl: process.env.OIDC_DISCOVERY_URL ?? DEFAULT_OIDC_DISCOVERY_URL,
            scopes: ['openid', 'profile', 'email'],
            mapProfileToUser: (profile) => ({
              email: profile.email,
              // Better Auth model field `name` → users.display_name via user.fields below.
              // Authentik's profile scope emits `name` (user's display name) and
              // `preferred_username`; fall back in that order, then email (Q-03).
              name:
                (typeof profile.name === 'string' && profile.name.trim()) ||
                (typeof profile.preferred_username === 'string' && profile.preferred_username) ||
                profile.email,
              // Authentik authenticated this email; no separate verification loop (R-01).
              emailVerified: true,
              role: 'Member',                        // R-03 — explicit, matches DB default
            }),
          },
        ],
      }),
    ]
  : [];

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-not-for-prod-not-for-prod',
  advanced: {
    // UUID id columns (DESIGN-001 D-01) — Postgres generates via gen_random_uuid().
    database: { generateId: 'uuid' },
  },
  database: drizzleAdapter(db, {
    provider: 'pg',
    // Keyed by modelName so the adapter's getSchema(model) lookup resolves:
    // user model → `users` Drizzle table (matches options.user.modelName).
    schema: { users, session, account, verification },
  }),
  user: {
    modelName: 'users',
    fields: { name: 'displayName' },                  // `name` → display_name column
    additionalFields: {
      role: { type: 'string', required: false, defaultValue: 'Member' },
    },
  },
  // NO emailAndPassword block — Authentik OIDC is the only credential (R-01).
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: [OIDC_PROVIDER_ID],
      // Donor repo also needed requireLocalEmailVerified: false to link OIDC onto
      // unverified credential users. haynesnetwork has no credential users (every row
      // is created by this provider with emailVerified: true), so the default stands.
    },
  },
  // nextCookies MUST be the last plugin — it forwards Better Auth's Set-Cookie
  // headers through Next.js's cookies() API (donor repo PLAN-006 lesson).
  plugins: [...oidcPlugins, nextCookies()],
  session: {
    expiresIn: 60 * 60 * 24 * 7,                      // 7 days (AC-01)
    updateAge: 60 * 60 * 24,                          // refresh at most daily
  },
  databaseHooks: {
    session: {
      create: {
        after: async (sessionRow) => {
          // Fires on every sign-in (session create) — idempotent (D-05).
          const userId = sessionRow.userId as string;
          const [row] = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, userId));
          if (!row) return;
          await bootstrapAdminOnSignin({ id: userId, email: row.email });
        },
      },
    },
  },
});

export type Auth = typeof auth;
```

Deltas from the donor config, all deliberate:

| Donor (todos-for-dues) | haynesnetwork | Why |
|---|---|---|
| providerId `google-workspace`, Google discovery URL | `authentik`, Authentik discovery URL (D-04 fixes the callback path) | ADR-002 |
| `authorizationUrlParams: { hd }` + HD-restriction hook | removed | No hosted-domain concept; anyone Authentik admits is a Member (R-03) |
| `emailAndPassword.enabled: true` | omitted entirely | R-01: no local passwords |
| `requireLocalEmailVerified: false` | omitted | No credential users exist to be unverified |
| `mapProfileToUser` role `'Alumni'` | `'Member'` + `preferred_username` fallback for name | PRD roles; Authentik claim shape (Q-03) |
| `BOOTSTRAP_ADMIN_EMAIL` (singular) | `BOOTSTRAP_ADMIN_EMAILS` comma-list (D-05) | Kickoff default A: owner has two candidate emails (PRD Q-01) |

### D-03 Version pin

`packages/auth/package.json` declares `better-auth: ^1.6.11`; the workspace `pnpm-lock.yaml`
**resolves it to `better-auth@1.6.23`** (verified in the lockfile 2026-07-04), and
`config.ts`'s rate-limit/IP comments reference the 1.6.23 source. The D-04 callback-path
convention below was originally verified against the 1.6.11 line and **still holds at
1.6.23** (the generic-oauth `/oauth2/callback/:providerId` route is unchanged); a further
version bump re-runs D-04's verification.

### D-04 Callback path convention — VERIFIED against better-auth source

The redirect URIs registered in Authentik (Part B) must match what the `genericOAuth` plugin
actually sends. Verified against the generic-oauth plugin source (originally on
`better-auth@1.6.11`; re-confirmed unchanged at the installed **`better-auth@1.6.23`**):

- `package/dist/plugins/generic-oauth/routes.mjs` line 116 registers the callback endpoint:
  `createAuthEndpoint("/oauth2/callback/:providerId", { method: "GET", ... })`.
- The same file builds the `redirect_uri` it sends to the IdP as
  `` `${ctx.context.baseURL}/oauth2/callback/${providerId}` `` (lines 97, 181, 191, 365, 371).
- `package/dist/auth/base.mjs` line 13: `const basePath = ctx.options.basePath || "/api/auth"`
  — `ctx.context.baseURL` = origin + basePath, and we don't override `basePath`.
- Sign-in initiation is `POST {basePath}/sign-in/oauth2` (`routes.mjs` line 42), body
  `{ providerId, callbackURL }`, returning `{ url, redirect }` for the client to navigate to.

Therefore the callback URL convention is:

```
{BETTER_AUTH_URL}/api/auth/oauth2/callback/{providerId}
→ https://haynesnetwork.com/api/auth/oauth2/callback/authentik
```

This is **not** the `/api/auth/callback/:providerId` path used by Better Auth's *built-in*
social providers — the generic-oauth plugin has its own `/oauth2/` namespace. The four
concrete redirect URIs are listed in D-11.

### D-05 `hooks/bootstrap-admin.ts` — `BOOTSTRAP_ADMIN_EMAILS` (R-02, AC-03)

> **Amended by ADR-012 (shipped):** the promotion now routes through **`assignRole`** to the
> **Admin role**, not `transitionRole` to a `'Admin'` enum:
> ```ts
> const adminRoleId = await getAdminRoleId(dbc);
> await assignRole({ db: dbc, userId: user.id, toRoleId: adminRoleId,
>                    initiator: { id: null, kind: 'system' }, note: 'BOOTSTRAP_ADMIN_EMAILS promotion' });
> ```
> `assignRole` is idempotent (already-Admin → no-op, no audit row, AC-03), writes the
> `user_role_transitions` row in-tx, and its last-admin guard cannot fire on a promotion
> *into* Admin. The pre-read + `expectedFromRole` guard is unnecessary (assignRole reads the
> current role itself). The allowlist parse / never-throw-into-auth / retry-next-sign-in
> behaviour below is unchanged. Original `transitionRole` version retained for history.

Donor's `bootstrapAdminOnSignin` generalized from one email to a comma-separated,
case-insensitive allowlist:

```ts
import { eq } from 'drizzle-orm';
import { db, users, type Database, type DbClient } from '@hnet/db';
import { transitionRole } from '@hnet/domain';
import { parseBootstrapAdminEmails } from '../env';

/**
 * Promote any user whose email is on the BOOTSTRAP_ADMIN_EMAILS allowlist to Admin
 * on every sign-in. Idempotent — no-op when already Admin. Routes through
 * transitionRole (DESIGN-001 D-12 single-writer invariant) so the promotion and its
 * user_role_transitions audit row commit in one transaction (R-02, R-04, AC-03).
 * Initiator is system (kind: 'system', id: null). Never throws into the auth flow —
 * the session already exists, so failures are caught + logged and the next sign-in
 * retries the promotion. `dbc` lets the integration tests inject the embedded-PG client.
 */
export async function bootstrapAdminOnSignin(
  user: { id: string; email: string },
  dbc?: DbClient,
): Promise<void> {
  try {
    const allowlist = parseBootstrapAdminEmails(process.env.BOOTSTRAP_ADMIN_EMAILS);
    if (!allowlist.includes(user.email.toLowerCase())) return;

    const q = (dbc ?? db) as Database;
    const [row] = await q.select({ role: users.role }).from(users).where(eq(users.id, user.id));
    if (!row || row.role === 'Admin') return;        // idempotent (AC-03 "repeat logins are no-ops")

    await transitionRole({
      db: dbc,                                        // executor (Database | Transaction); defaults to the lazy @hnet/db client
      userId: user.id,                                // NOT `targetUserId` — the real TransitionRoleInput field
      expectedFromRole: row.role,                     // 'Member' — optimistic-concurrency guard
      toRole: 'Admin',
      initiator: { id: null, kind: 'system' },
      note: 'BOOTSTRAP_ADMIN_EMAILS promotion',
    });
  } catch (error) {
    console.error('[@hnet/auth] bootstrapAdminOnSignin failed (retries on next sign-in):', error);
  }
}
```

`transitionRole`'s input (DESIGN-001 `packages/domain/src/user-role-transitions.ts`) is
`{ db?, userId, toRole, initiator, note?, expectedFromRole? }` — it keys the target user by
`userId`, and `db` is the optional executor. The allowlist parse is factored into
`parseBootstrapAdminEmails` in `packages/auth/src/env.ts` (shared with the D-08 env reader).

Ordering note (why this is safe on *first* login): the hook fires
`databaseHooks.session.create.after`, i.e. after Better Auth has committed the new `users`
row (as `Member`, R-03) and the `session` row — so the promotion is a plain
Member→Admin transition, never a race with user creation. Failure mode: if `transitionRole`
throws, the sign-in itself has already succeeded (session exists); the user lands as Member
and the next sign-in retries the promotion.

### D-06 `hooks/session-extension.ts` — session hydration for server-rendered gates

The **primary** server-side entry point is `getServerSession(headers)` (exported from
`packages/auth/src/index.ts`): it calls Better Auth's `auth.api.getSession({ headers })` to
resolve the DB-backed session, then grafts on a one-lookup **session extension** via
`getSessionExtension(userId)`.

> **Amended by ADR-012 (shipped):** `getSessionExtension` returns
> `{ role: { id, name, isAdmin }, displayName }` — the user's **single role**, joined
> `users ⋈ roles` in one query. There is **no `isFamily`** (the family flag is gone) and
> the old `getSessionRole` helper is **removed** — the session always carries the role
> object, and admin gating switches on `role.isAdmin` (DESIGN-003 D-01, `adminProcedure`),
> never a string literal. `SessionUser` is `{ id, email, displayName, role: { id, name, isAdmin } }`.

`getSessionExtension` returns `null` when the user row has vanished between sign-in and read,
and `getServerSession` propagates that as `null` (fail closed). It accepts an optional `dbc`
executor for tests. DESIGN-003's tRPC context is the primary consumer.

### D-07 Catch-all route

```ts
// apps/web/app/api/auth/[...all]/route.ts
import { auth } from '@app/auth';
import { toNextJsHandler } from 'better-auth/next-js';

export const { GET, POST } = toNextJsHandler(auth.handler);
```

Surface actually used (all under `/api/auth`, per D-04 verification):
`POST /sign-in/oauth2` (initiation), `GET /oauth2/callback/authentik` (callback),
`GET /get-session`, `POST /sign-out`.

### D-08 Environment contract

| Variable | Required | Default | Purpose | Where it lives |
|----------|----------|---------|---------|----------------|
| `BETTER_AUTH_SECRET` | prod: yes | dev-only fallback constant | Session-cookie signing/encryption. Generate: `openssl rand -base64 32` | 1Password `haynesnetwork` item → External Secrets; `.env.local` for dev |
| `BETTER_AUTH_URL` | yes | `http://localhost:3000` | Canonical origin; the redirect URI is derived from it (D-04) — must match one of D-11's registered URIs per environment | Deployment env (haynes-ops manifest); `.env.local` |
| `OIDC_CLIENT_ID` | yes (for sign-in) | — (OIDC disabled when unset) | Authentik provider client id (Part B output) | 1Password `haynesnetwork` → External Secrets; `.env.local` |
| `OIDC_CLIENT_SECRET` | yes (for sign-in) | — (OIDC disabled when unset) | Authentik provider client secret (Part B output) | 1Password `haynesnetwork` → External Secrets; `.env.local` |
| `OIDC_DISCOVERY_URL` | no | `https://authentik.haynesnetwork.com/application/o/haynesnetwork/.well-known/openid-configuration` | Override for the e2e OIDC stub (R-66) or future IdP moves | Deployment env / `.env.local` |
| `BOOTSTRAP_ADMIN_EMAILS` | yes | — (hook no-ops when unset) | Comma-separated, case-insensitive Admin allowlist (R-02). Initial value: `manofoz@gmail.com,t.haynes43@gmail.com` (kickoff default A / PRD Q-01) | Deployment env; `.env.local` |
| `DATABASE_URL` | yes | — | Postgres 16 connection string (consumed by `@app/db`; CNPG `postgres16-rw.database.svc.cluster.local:5432` in-cluster) | External Secrets (`cloudnative-pg`-derived app creds); `.env.local` |

Secrets never land in git (CLAUDE.md rule 7): local dev uses gitignored `.env.local`; cluster
uses External Secrets + 1Password (`HaynesKube` vault), wiring documented in `docs/ops/` with
the deployment design.

### D-09 Login flow — sequence (AC-01, AC-02, AC-03)

```
 Browser                        haynesnetwork (Next.js + Better Auth)         Authentik
    |                                        |                                    |
    |-- GET / (no session cookie) ---------->|                                    |
    |<-- redirect /login --------------------|                                    |
    |-- click the single "Sign in" --------->|                                    |
    |   POST /api/auth/sign-in/oauth2        |                                    |
    |   { providerId: "authentik",           |                                    |
    |     callbackURL: "/" }                 |                                    |
    |                                        |-- GET OIDC discovery (cached) ---->|
    |                                        |<-- authorization/token endpoints --|
    |<-- { url: <authorize URL>, redirect } -|                                    |
    |                                        |                                    |
    |-- 302 → https://authentik.haynesnetwork.com/application/o/authorize/ ------>|
    |      ?client_id=...&response_type=code&state=...                            |
    |      &redirect_uri={BETTER_AUTH_URL}/api/auth/oauth2/callback/authentik     |
    |      &scope=openid profile email                                            |
    |<-- Authentik login UI (user authenticates with Plex source) ----------------|
    |-- credentials / Plex OAuth ------------------------------------------------>|
    |<-- 302 → redirect_uri?code=...&state=... -----------------------------------|
    |                                        |                                    |
    |-- GET /api/auth/oauth2/callback/       |                                    |
    |       authentik?code=...&state=... --->|                                    |
    |                                        |-- POST token endpoint ------------>|
    |                                        |   (code + client_id + secret)      |
    |                                        |<-- id_token + access_token --------|
    |                                        | mapProfileToUser:                  |
    |                                        |   find-or-create users row         |
    |                                        |   (Member, display_name, email,    |
    |                                        |    email_verified) [AC-02]         |
    |                                        | insert session row (7d) [AC-01]    |
    |                                        | hook session.create.after:         |
    |                                        |   bootstrapAdminOnSignin(email)    |
    |                                        |   → Member→Admin + audit row       |
    |                                        |     iff allowlisted [AC-03]        |
    |<-- Set-Cookie (session, 7d);           |                                    |
    |    302 → / ----------------------------|                                    |
    |-- GET / (session cookie) ------------->|                                    |
    |<-- permissioned dashboard -------------|                                    |
```

> **ADR-012 note:** in the diagram above, "find-or-create users row (Member, …)" is now the
> **Default role** (`users.role_id` DB default, R-03), and the bootstrap step's "Member→Admin"
> is `assignRole` to the **Admin role** with a `user_role_transitions` audit row (AC-03).

PKCE note: generic-oauth's `pkce` option defaults to off in 1.6.23 (`codeVerifier` only sent
when `pkce: true`); the confidential client + `state` parameter is the baseline. Enabling
PKCE on both sides is a hardening follow-up (Q-04).

### D-14 Rate limiting & error surfaces (added 2026-07-03)

Production incident: better-auth's built-in rate limiter (enabled by default when
`NODE_ENV=production`) ships a special rule of **3 requests / 10 s for every `/sign-in*`
path**, and behind traefik-internal the client IP resolved to `null` — better-auth 1.6.23
only trusts a *single-value* `x-forwarded-for` unless `trustedProxies` is configured, so a
multi-hop chain fails closed and **all clients collapse into one shared per-path bucket**
(`no-trusted-ip`). A couple of sign-in clicks 429'd the whole household, and the login
button mapped the 429 to the generic `sso_unavailable` copy. All option names below
verified against the installed `better-auth@1.6.23` source (the version D-03 resolves to;
the D-04 callback-path verification still holds at 1.6.23).

Decided configuration (`packages/auth/src/config.ts`):

| Option (verified) | Value | Why |
|---|---|---|
| `rateLimit.enabled` | `process.env.NODE_ENV === 'production'` | Mirrors better-auth's default (`enabled ?? isProduction`) explicitly; dev + the Playwright stub-OIDC suite run `next dev` and must never rate limit |
| `rateLimit.window` / `rateLimit.max` | `60` s / `100` | Overall per-client-IP, per-path budget |
| `rateLimit.customRules['/sign-in/oauth2']` | `{ window: 60, max: 10 }` | Overrides the built-in 3-per-10s `/sign-in*` special rule — ~10 OAuth initiation attempts/min per client. Keys are relative to basePath (`/api/auth`); exact match unless the key contains `*` |
| `advanced.ipAddress.ipAddressHeaders` | `['x-forwarded-for', 'x-real-ip']` | Traefik sets both. XFF wins in the honest single-hop case; `x-real-ip` is single-value by construction (Traefik sets it to the connecting client) so the key still resolves per-client when the XFF chain has extra hops |
| `logger.disableColors` | `true` | Pod logs (kubectl) stay grep-able; default `warn` level already emits callback failures, which better-auth `logger.error()`s before redirecting |
| `onAPIError.onError` | `console.error('[auth] API error', …)` | Non-redirect API failures. Redirects (status FOUND) — i.e. callback failures — bypass it by design; plain 429s are raw Responses from `onRequest` and never reach it (no log noise under a storm) |
| `onAPIError.errorURL` | `'/login?error=callback_failed'` | Callback failures whose OAuth state can't be parsed (expired/mismatch) can't recover the per-request error URL; this replaces better-auth's bare `/api/auth/error` page |
| `signIn.oauth2` body param `errorCallbackURL` (login button) | `'/login?error=callback_failed'` | Carried through OAuth state; every post-Authentik callback failure redirects here |

Storage stays the default `memory` — fine for the single-replica deployment; revisit
(`rateLimit.storage: 'database'` or secondary storage) if the app ever scales out.

Error taxonomy on `/login?error=…` (`ERROR_COPY` in `apps/web/app/login/page.tsx`;
initiation mapping is the pure helper `apps/web/lib/sign-in-error.ts`, unit-tested):

| Code | Source | Copy |
|---|---|---|
| `rate_limited` | initiation returned 429 | "Too many sign-in attempts — wait a minute and try once." |
| `sso_unavailable` | any other initiation failure (5xx, network) | "Sign-in is temporarily unavailable. Try again in a moment." |
| `callback_failed` | post-Authentik callback failure (`errorCallbackURL` / `onAPIError.errorURL`) | "Sign-in failed after Authentik. Try again; if it persists the admin should check the pod logs." |

Note: better-auth's `redirectOnError` appends its machine-readable code as a **second**
`error` query param (`/login?error=callback_failed&error=state_mismatch`); the login page
renders the first and the raw code stays in the URL for debugging.

---

## Part B — Authentik provisioning (design + runbook outline)

### D-10 Inputs & access

- **API base:** `https://authentik.haynesnetwork.com/api/v3/` (reachable; anonymous
  `GET root/config/` confirmed live 2026-07-03), auth header
  `Authorization: Bearer $AUTHENTIK_API_TOKEN`.
- **Token location:** 1Password `homepage` item, field `AUTHENTIK_API_TOKEN`. In-cluster copy
  in secret `homepage-secret`, namespace `frontend`, **key
  `HOMEPAGE_VAR_AUTHENTIK_API_TOKEN`** (key name verified against the live secret
  2026-07-03). Operator retrieval:

  ```sh
  AUTHENTIK_API_TOKEN=$(kubectl --context haynes-ops -n frontend get secret homepage-secret \
    -o jsonpath='{.data.HOMEPAGE_VAR_AUTHENTIK_API_TOKEN}' | base64 -d)
  ```

- The application **slug must be `haynesnetwork`** — Authentik binds the OIDC discovery
  document to the application slug (`/application/o/<slug>/.well-known/openid-configuration`),
  and D-08's default discovery URL assumes it.

### D-11 Redirect URIs (exact, from D-04's verified convention)

Registered with **strict** matching — one per environment the app runs in (R-64 staged
rollout):

```
http://localhost:3000/api/auth/oauth2/callback/authentik            (local dev)
https://haynesnetwork.haynesops.com/api/auth/oauth2/callback/authentik   (staging — internal ingress; fine here, R-14 governs user-facing links only)
https://haynesnetwork.com/api/auth/oauth2/callback/authentik        (production root)
https://www.haynesnetwork.com/api/auth/oauth2/callback/authentik    (production www)
```

### D-12 Provisioning steps (agent-executed via API)

1. **Version check** — `GET admin/version/` (requires the token; anonymous returns 403 —
   probed 2026-07-03). The live cluster runs **Authentik 2026.5.3** (Q-05 resolved via
   OPS-001), so `redirect_uris` is a list of objects `[{ "matching_mode": "strict", "url":
   "..." }]` and `invalidation_flow` is a required field on provider create. (Authentik
   before 2024.2 took a single newline-joined `redirect_uris` string — not applicable here.)
2. **Find the default authorization flow** — `GET flows/instances/?designation=authorization`;
   pick `default-provider-authorization-implicit-consent` (Q-06 resolved: implicit consent, no
   household consent screen). Record `pk`. Also `GET flows/instances/?designation=invalidation`
   → `default-provider-invalidation-flow` `pk` (required on 2026.5.3 provider create).
3. **Find the signing key** — `GET crypto/certificatekeypairs/?name=authentik+Self-signed+Certificate`
   (the built-in keypair) → `pk`. id_tokens must be RS256-signed; discovery advertises the JWKS.
4. **Collect scope mappings** — `GET propertymappings/provider/scope/` filtered to the managed
   mappings `goauthentik.io/providers/oauth2/scope-openid`, `-profile`, `-email` → three `pk`s
   for `property_mappings` (this is what makes Authentik emit `email`, `name`,
   `preferred_username` claims consumed by D-02).
5. **Create the provider** — `POST providers/oauth2/`:

   ```jsonc
   {
     "name": "haynesnetwork",
     "client_type": "confidential",
     "authorization_flow": "<step-2 pk>",
     "invalidation_flow": "<step-2 invalidation pk>",  // required on 2024.x+ (2026.5.3 live)
     // MANDATORY on the API path: omitting grant_types on Authentik 2026.5 saves an
     // EMPTY list, after which every authorize is rejected with
     // `invalid_request: The request is otherwise malformed`. The UI defaults it
     // correctly; the API does not. This cost the first production sign-in (OPS-001).
     "grant_types": ["authorization_code", "refresh_token"],
     "redirect_uris": [                          // shape per step 1; the four URIs from D-11
       { "matching_mode": "strict", "url": "http://localhost:3000/api/auth/oauth2/callback/authentik" },
       { "matching_mode": "strict", "url": "https://haynesnetwork.haynesops.com/api/auth/oauth2/callback/authentik" },
       { "matching_mode": "strict", "url": "https://haynesnetwork.com/api/auth/oauth2/callback/authentik" },
       { "matching_mode": "strict", "url": "https://www.haynesnetwork.com/api/auth/oauth2/callback/authentik" }
     ],
     "signing_key": "<step-3 pk>",
     "property_mappings": ["<step-4 pks>"],
     "sub_mode": "hashed_user_id"               // default; stable sub across email changes
   }
   ```

   The response includes generated `client_id` and `client_secret` (also retrievable later via
   `GET providers/oauth2/<pk>/`). `grant_types` is non-negotiable on the API path — see the
   inline note above and OPS-001 for the empty-list pitfall.
6. **Create the application** — `POST core/applications/`:

   ```jsonc
   {
     "name": "haynesnetwork",
     "slug": "haynesnetwork",                   // binds the discovery URL (D-10)
     "provider": <step-5 pk>,
     "meta_launch_url": "https://haynesnetwork.com"
   }
   ```

7. **Store credentials** — write `client_id`/`client_secret` to:
   - 1Password item **`haynesnetwork`** (HaynesKube vault), fields `OIDC_CLIENT_ID`,
     `OIDC_CLIENT_SECRET` (plus `BETTER_AUTH_SECRET` when generated) — the External Secrets
     source for the cluster;
   - local `.env.local` (gitignored) for dev.
   Never into git or chat logs (CLAUDE.md rule 7).
8. **Verify** —
   `curl -s https://authentik.haynesnetwork.com/application/o/haynesnetwork/.well-known/openid-configuration`
   returns a JSON document whose `authorization_endpoint`/`token_endpoint` are on
   `authentik.haynesnetwork.com` and whose `redirect_uris` accept a test authorize request;
   then run the D-09 flow end-to-end from `localhost:3000`.

Idempotency: each step is preceded by a lookup (`GET providers/oauth2/?name=haynesnetwork`,
`GET core/applications/?slug=haynesnetwork`) — re-running the runbook updates-in-place
(`PATCH`) rather than duplicating.

### D-13 Runbook outline (full runbook → `docs/ops/`, lands with implementation)

1. Prereqs: `kubectl` context `haynes-ops` (or 1Password access to `homepage` item); `curl`/`jq`.
2. Export `AUTHENTIK_API_TOKEN` (D-10 command).
3. Steps D-12.1–D-12.6 as concrete `curl` commands with `jq` extraction of `pk`s.
4. Secret storage (D-12.7) — 1Password `op item edit`/UI steps + `.env.local` template.
5. Verification (D-12.8) + the AC-01/AC-03 manual smoke test (owner signs in, lands as Admin).
6. Rollback: delete application then provider (`DELETE core/applications/haynesnetwork/`,
   `DELETE providers/oauth2/<pk>/`); credentials in 1Password marked revoked.

## Alternatives considered

- **Better Auth built-in social providers / SSO plugin** instead of `genericOAuth` — rejected:
  no Authentik-specific provider exists; genericOAuth + discovery URL is the donor-proven path
  and keeps the IdP swappable via `OIDC_DISCOVERY_URL`.
- **Authentik blueprints (YAML applied server-side)** instead of API provisioning — rejected
  for now: kickoff decision #4 says API + runbook; blueprints would couple provisioning to the
  Authentik deployment repo. Revisit if provider config churns.
- **Forward-auth / proxy-provider** in front of the app instead of OIDC — rejected: the app
  needs its own session, role model, and DB identity (R-02..R-04), not just gating.
- **Per-environment Authentik providers** (separate client per redirect URI) — rejected:
  single confidential client with four strict redirect URIs is simpler; staging and prod share
  the user base by design.
- **PKCE now** — deferred (Q-04): confidential client + state is the 1.6.23 default; enabling
  is a two-line config change on each side later.

## Test strategy

- **Unit** (`packages/auth/__tests__/`): `bootstrap-admin.test.ts` — allowlist parsing
  (multi-email, whitespace, case-insensitivity, empty/unset var no-op), promotion happens once
  (idempotent on repeat), non-allowlisted email untouched, audit row shape (system initiator,
  null initiatorId) — AC-03.
- **Integration** (embedded Postgres 16 per R-62; OIDC stubbed with a local discovery/token/
  userinfo server): first sign-in creates Member + `account` row with `provider_id
  'authentik'` (AC-02); allowlisted first sign-in yields Admin + exactly one
  `user_role_transitions` row across N sign-ins (AC-03); `mapProfileToUser` fallback chain
  (`name` absent → `preferred_username` → email).
- **E2E** (Playwright, stub OIDC in CI per R-66): unauthenticated visit shows a single
  "Sign in" and **no password form** (AC-01); full round-trip establishes the session cookie
  with ~7-day expiry; sign-out clears it.
- **Runbook validation:** D-12.8 verification steps; owner performs US-02 (first real login →
  Admin, PRD Q-01 resolves which email Authentik emits).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Which email Authentik emits for the owner (mirror of PRD-001 Q-01) — allowlist carries both candidates. | (open — confirmed on first real login) |
| Q-02 | Does the Plex-source login inside Authentik mark email as verified in all cases (we set `emailVerified: true` unconditionally in D-02 on the strength of R-01 "Authentik is the authority")? | (open — lean yes; revisit only if a non-Plex Authentik source is added) |
| Q-03 | Exact claim set Authentik's Plex-sourced users carry: is `name` always populated, or only `preferred_username`? D-02's fallback chain handles either; confirm at first login and simplify if warranted. | (open) |
| Q-04 | Enable PKCE (`pkce: true` in genericOAuth + Authentik provider setting)? Not required for a confidential client; hardening follow-up. | (open — lean: enable post-Phase-1) |
| Q-05 | Authentik version on the cluster (drives `redirect_uris` payload shape and whether `invalidation_flow` is required, D-12.1) — anonymous version endpoint returns 403; needs the token. | **Resolved (OPS-001, 2026-07-03): Authentik 2026.5.3.** `redirect_uris` is the list-of-objects shape (`{matching_mode, url}`) and `invalidation_flow` is required (bound to `default-provider-invalidation-flow`). This is also where the mandatory `grant_types` API pitfall surfaced. |
| Q-06 | Implicit-consent vs explicit-consent authorization flow for the haynesnetwork application (implicit = no consent screen for household users; explicit = one-time consent). | **Resolved (OPS-001): implicit consent** — bound to `default-provider-authorization-implicit-consent` (mirrors the Grafana provider); no per-user consent screen. |
