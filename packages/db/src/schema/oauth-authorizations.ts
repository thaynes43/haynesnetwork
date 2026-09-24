import { pgTable, uuid, text, jsonb, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { oauthClients } from './oauth-clients';
import {
  OAUTH_CODE_CHALLENGE_METHODS,
  OAUTH_SCOPES,
  type OAuthCodeChallengeMethod,
  type OAuthScope,
} from './enums';

const SCOPES_JSON = JSON.stringify(OAUTH_SCOPES);
const METHODS_SQL_LIST = OAUTH_CODE_CHALLENGE_METHODS.map((m) => `'${m}'`).join(',');

/**
 * ADR-091 / DESIGN-050 D-03 / D-05 (PLAN-069, migration 0078) — the Authorization transaction (T-256): a
 * validated authorization request from a SIGNED-IN user, waiting on the consent page. `/oauth/authorize`
 * inserts it only after the session gate — `user_id` is the session's user, never a request parameter — and
 * redirects to `/oauth/consent?txn=<id>`. Approve or Deny deletes it in the same transaction as the code or
 * the audit row (@hnet/domain `grantConsent` / `denyConsent`); an abandoned one expires after 10 minutes and
 * the inline pruner removes it. `state` is REQUIRED (stricter than the cigar-journal port: D-05 step 2);
 * `scopes` is a subset of the three advertised scopes (a CHECK) and never empty (a missing `scope` means all
 * three). Consent is never remembered, so nothing here outlives one decision. Written ONLY by the @hnet/domain
 * oauth single-writers (`startAuthorization`, the two consent writers, `disconnectClient`, `pruneExpired`).
 */
export const oauthAuthorizations = pgTable(
  'oauth_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    scopes: jsonb('scopes').$type<OAuthScope[]>().notNull(),
    resource: text('resource').notNull(),
    state: text('state').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').$type<OAuthCodeChallengeMethod>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'oauth_authorizations_scopes_subset',
      sql`jsonb_typeof(${t.scopes}) = 'array' AND jsonb_array_length(${t.scopes}) >= 1 AND ${t.scopes} <@ ${sql.raw(`'${SCOPES_JSON}'::jsonb`)}`,
    ),
    check(
      'oauth_authorizations_challenge_method_enum',
      sql`${t.codeChallengeMethod} = ANY (ARRAY[${sql.raw(METHODS_SQL_LIST)}])`,
    ),
    index('oauth_authorizations_expires_idx').on(t.expiresAt),
    index('oauth_authorizations_client_user_idx').on(t.clientId, t.userId),
  ],
);

export type OAuthAuthorizationRow = typeof oauthAuthorizations.$inferSelect;
export type OAuthAuthorizationInsert = typeof oauthAuthorizations.$inferInsert;
