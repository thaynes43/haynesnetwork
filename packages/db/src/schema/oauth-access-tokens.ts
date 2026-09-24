import { pgTable, uuid, text, jsonb, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { oauthClients } from './oauth-clients';
import { OAUTH_SCOPES, type OAuthScope } from './enums';

const SCOPES_JSON = JSON.stringify(OAUTH_SCOPES);

/**
 * ADR-091 / DESIGN-050 D-03 / D-07 (PLAN-069, migration 0078) — Delegated tokens (T-259): short-lived (1 h)
 * opaque access tokens bound to the canonical resource (`<issuer>/mcp`, RFC 8707), stored ONLY as SHA-256 hex
 * (a CHECK refuses anything else). Any replica validates a bearer with one indexed hash lookup joined to
 * `users` — the MCP server stays stateless. `family_id` links a token to its refresh chain, so revoking the
 * family (reuse detection, `/oauth/revoke` of the refresh token, the Connected apps Disconnect) kills the
 * outstanding access tokens too; rotation itself does not revoke them — they expire. `expires_at` is always
 * set (no never-expiring token: ADR-091 option 5). `last_used_at` is stamped at most once a minute by the
 * public `/mcp` (through `touchLastUsed`). The inline pruner deletes rows expired or revoked more than 30 days
 * ago. Written ONLY by the @hnet/domain oauth single-writers (guard-listed).
 */
export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: uuid('family_id'),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<OAuthScope[]>().notNull(),
    resource: text('resource').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('oauth_access_tokens_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'oauth_access_tokens_scopes_subset',
      sql`jsonb_typeof(${t.scopes}) = 'array' AND jsonb_array_length(${t.scopes}) >= 1 AND ${t.scopes} <@ ${sql.raw(`'${SCOPES_JSON}'::jsonb`)}`,
    ),
    index('oauth_access_tokens_family_idx').on(t.familyId),
    index('oauth_access_tokens_client_user_idx').on(t.clientId, t.userId),
    index('oauth_access_tokens_expires_idx').on(t.expiresAt),
  ],
);

export type OAuthAccessTokenRow = typeof oauthAccessTokens.$inferSelect;
export type OAuthAccessTokenInsert = typeof oauthAccessTokens.$inferInsert;
