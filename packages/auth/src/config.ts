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
              role: 'Member', // R-03 — explicit, matches DB default
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
