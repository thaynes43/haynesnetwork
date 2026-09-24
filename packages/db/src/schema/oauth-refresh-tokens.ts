import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  check,
  index,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { oauthClients } from './oauth-clients';
import { OAUTH_SCOPES, type OAuthScope } from './enums';

const SCOPES_JSON = JSON.stringify(OAUTH_SCOPES);

/**
 * ADR-091 / DESIGN-050 D-03 / D-06 (PLAN-069, migration 0078) — rotating refresh tokens (issued only when
 * `offline_access` was granted), stored ONLY as SHA-256 hex (a CHECK refuses anything else). One rotation
 * chain is a Refresh family (T-257): every token of a chain shares `family_id`, `parent_id` points at the
 * token it replaced. `rotated_at` marks a spent token and `revoked_at` a killed one; presenting either again
 * is reuse, which revokes the WHOLE family (refresh and access rows) with an audit row (@hnet/domain
 * `revokeFamilyOnReuse`). `expires_at` is always set — 60 days, re-issued on each rotation — so no refresh
 * token lives forever (ADR-091 option 5). The inline pruner deletes rows expired or revoked more than 30
 * days ago; a rotated token is kept until then so a late replay is still recognised as reuse. Written ONLY by
 * the @hnet/domain oauth single-writers (guard-listed).
 */
export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: uuid('family_id').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => oauthRefreshTokens.id, {
      onDelete: 'set null',
    }),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<OAuthScope[]>().notNull(),
    resource: text('resource').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('oauth_refresh_tokens_hash_format', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'oauth_refresh_tokens_scopes_subset',
      sql`jsonb_typeof(${t.scopes}) = 'array' AND jsonb_array_length(${t.scopes}) >= 1 AND ${t.scopes} <@ ${sql.raw(`'${SCOPES_JSON}'::jsonb`)}`,
    ),
    index('oauth_refresh_tokens_family_idx').on(t.familyId),
    index('oauth_refresh_tokens_client_user_idx').on(t.clientId, t.userId),
    index('oauth_refresh_tokens_expires_idx').on(t.expiresAt),
  ],
);

export type OAuthRefreshTokenRow = typeof oauthRefreshTokens.$inferSelect;
export type OAuthRefreshTokenInsert = typeof oauthRefreshTokens.$inferInsert;
