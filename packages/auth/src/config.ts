import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { genericOAuth } from 'better-auth/plugins/generic-oauth';
import { eq } from 'drizzle-orm';
import { db, users, session, account, verification } from '@hnet/db';
import { authEnv, OIDC_PROVIDER_ID } from './env';
import { bootstrapAdminOnSignin } from './hooks/bootstrap-admin';

/**
 * DESIGN-002 D-02 — the Better Auth instance. Authentik OIDC via genericOAuth is the
 * SOLE sign-in method (ADR-002 / CLAUDE.md hard rule 5): no emailAndPassword, no
 * invite tokens. Donor: todos-for-dues packages/auth/src/config.ts with the
 * Google-Workspace parts (HD restriction, credentials, invites) removed.
 */

const env = authEnv();

// App still boots without OIDC creds (CI builds, unit tests); the login page renders
// a config-error state instead of a sign-in button when disabled (DESIGN-002 D-02).
export const oidcEnabled = env.oidcEnabled;

const oidcPlugins = oidcEnabled
  ? [
      genericOAuth({
        config: [
          {
            providerId: OIDC_PROVIDER_ID,
            clientId: env.oidcClientId!,
            clientSecret: env.oidcClientSecret!,
            discoveryUrl: env.oidcDiscoveryUrl,
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
              // ADR-012: role is not a Better Auth field — users.role_id defaults to the
              // seeded Default role at the DB level (R-03), and bootstrap promotes to Admin.
            }),
          },
        ],
      }),
    ]
  : [];

export const auth = betterAuth({
  baseURL: env.baseUrl,
  secret: env.secret,
  advanced: {
    // UUID id columns (DESIGN-001 D-01) — Postgres generates via gen_random_uuid().
    database: { generateId: 'uuid' },
    // Rate limiting buckets by client IP. In-cluster the app sits behind Traefik
    // (traefik-internal), which sets x-forwarded-for AND x-real-ip. better-auth
    // 1.6.23 only trusts a SINGLE-value x-forwarded-for unless trustedProxies is
    // configured (@better-auth/core src/utils/ip.ts getIPFromHeader): a multi-hop
    // chain resolves to null, and in production every client then collapses into
    // ONE shared per-path bucket (rate-limiter NO_TRUSTED_IP_KEY) — the observed
    // outage where a couple of sign-in clicks 429'd the whole household. Walk
    // x-forwarded-for first (honest single-hop case), then fall back to x-real-ip,
    // which Traefik sets to the connecting client and is single-value by
    // construction, so it resolves even when the XFF chain has extra hops.
    ipAddress: {
      ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'],
    },
  },
  rateLimit: {
    // Mirror better-auth's default (enabled ?? isProduction) explicitly: prod-only.
    // `next dev` (local + the Playwright/stub-OIDC suite) must never rate limit.
    enabled: process.env.NODE_ENV === 'production',
    // Overall per-client-IP, per-path budget: 100 requests/minute (window seconds).
    window: 60,
    max: 100,
    customRules: {
      // Paths are relative to basePath (/api/auth); exact match unless the key
      // contains '*'. better-auth ships a built-in special rule of 3 requests per
      // 10s for every /sign-in* path — far too tight for an OAuth initiation
      // click that users retry. customRules resolve LAST, so this overrides it:
      // ~10 sign-in attempts per minute per client.
      '/sign-in/oauth2': { window: 60, max: 10 },
    },
  },
  // Observability (kubectl logs): strip ANSI colors from better-auth's internal
  // logger so pod logs stay grep-able. OAuth CALLBACK failures never reach
  // onAPIError.onError — they redirect (status FOUND, filtered in the router's
  // onError) — but better-auth logger.error()s them first (state parse failures,
  // token-exchange failures, missing claims), and the default 'warn' level
  // already emits those to console.
  logger: { disableColors: true },
  onAPIError: {
    // Non-redirect API failures (sign-in initiation, adapter errors). Plain 429s
    // never land here: the rate limiter short-circuits in onRequest with a raw
    // Response, so a rate-limit storm stays quiet in the logs.
    onError: (error) => {
      console.error('[auth] API error', error);
    },
    // Callback failures that cannot recover errorCallbackURL from OAuth state
    // (expired/mismatched state) redirect here instead of better-auth's bare
    // /api/auth/error page. better-auth appends its machine-readable code as a
    // SECOND `error` query param (redirectOnError); /login renders the first and
    // the code stays in the URL for debugging.
    errorURL: '/login?error=callback_failed',
  },
  database: drizzleAdapter(db, {
    provider: 'pg',
    // Keyed by modelName so the adapter's getSchema(model) lookup resolves:
    // user model → `users` Drizzle table (matches options.user.modelName below);
    // session/account/verification keep Better Auth's default model names, which
    // match the Drizzle export names.
    schema: { users, session, account, verification },
  }),
  user: {
    modelName: 'users',
    fields: { name: 'displayName' }, // `name` → display_name column
    // ADR-012: no `role` additionalField — a user's role is the users.role_id FK
    // (DB-defaulted to the Default role), hydrated onto the session by getSessionExtension.
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
    expiresIn: 60 * 60 * 24 * 7, // 7 days (AC-01)
    updateAge: 60 * 60 * 24, // refresh at most daily
  },
  databaseHooks: {
    session: {
      create: {
        after: async (sessionRow) => {
          // Fires on every sign-in (session create) — idempotent (DESIGN-002 D-05).
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
