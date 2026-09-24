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
 * ADR-091 / DESIGN-050 D-03 / D-06 (PLAN-069, migration 0078) — single-use authorization codes (RFC 6749 +
 * PKCE S256). Issued by the consent Approve (@hnet/domain `grantConsent`, with its audit row), stored ONLY as
 * the SHA-256 hex of the code (a CHECK refuses anything else, so plaintext can never land here), carrying the
 * transaction's bindings (client, user, redirect URI, scopes, resource, PKCE challenge). `/oauth/token`
 * consumes a code exactly once with a conditional UPDATE of `consumed_at` (race-safe across replicas); a
 * replay is detected by the stamp. Codes live 60 seconds; the inline pruner deletes expired rows. Written ONLY by
 * the @hnet/domain oauth single-writers (`grantConsent`, `exchangeCode`, `disconnectClient`, `pruneExpired`).
 */
export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeHash: text('code_hash').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    scopes: jsonb('scopes').$type<OAuthScope[]>().notNull(),
    resource: text('resource').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').$type<OAuthCodeChallengeMethod>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('oauth_authorization_codes_hash_format', sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'oauth_authorization_codes_scopes_subset',
      sql`jsonb_typeof(${t.scopes}) = 'array' AND jsonb_array_length(${t.scopes}) >= 1 AND ${t.scopes} <@ ${sql.raw(`'${SCOPES_JSON}'::jsonb`)}`,
    ),
    check(
      'oauth_authorization_codes_challenge_method_enum',
      sql`${t.codeChallengeMethod} = ANY (ARRAY[${sql.raw(METHODS_SQL_LIST)}])`,
    ),
    index('oauth_authorization_codes_expires_idx').on(t.expiresAt),
    index('oauth_authorization_codes_client_user_idx').on(t.clientId, t.userId),
  ],
);

export type OAuthAuthorizationCodeRow = typeof oauthAuthorizationCodes.$inferSelect;
export type OAuthAuthorizationCodeInsert = typeof oauthAuthorizationCodes.$inferInsert;
