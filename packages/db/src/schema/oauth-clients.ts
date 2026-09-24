import { pgTable, uuid, text, jsonb, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  OAUTH_GRANT_TYPES,
  OAUTH_RESPONSE_TYPES,
  OAUTH_TOKEN_ENDPOINT_AUTH_METHODS,
  type OAuthGrantType,
  type OAuthResponseType,
  type OAuthTokenEndpointAuthMethod,
} from './enums';

const AUTH_METHODS_SQL_LIST = OAUTH_TOKEN_ENDPOINT_AUTH_METHODS.map((m) => `'${m}'`).join(',');
const GRANT_TYPES_JSON = JSON.stringify(OAUTH_GRANT_TYPES);
const RESPONSE_TYPES_JSON = JSON.stringify(OAUTH_RESPONSE_TYPES);

/**
 * ADR-091 / DESIGN-050 D-03 / D-04 (PLAN-069, migration 0078) — the dynamically registered OAuth clients
 * (RFC 7591). ChatGPT registers one client per connector, Claude Code and Codex one per install; nothing is
 * pre-registered. `client_id` is the public 32-hex handle the client presents (and the MCP consumer name is
 * `oauth:<client_id>`); `client_secret_hash` exists only for a confidential client (SHA-256 hex, never the
 * secret — a CHECK refuses anything but 64 hex characters, so a plaintext secret cannot be stored, and a
 * second CHECK ties "has a secret" to "is confidential"). Bounded inputs are schema invariants too:
 * `client_name` 1–80 characters, 1–5 redirect URIs, grant types ⊆ {authorization_code, refresh_token},
 * response types ⊆ {code}. `registered_ip` is the registering client IP (abuse forensics, D-10) and
 * `last_used_at` is stamped at most once a minute by the public `/mcp` (the Connected apps page and the
 * dormant-client pruner read it).
 *
 * Written ONLY by the @hnet/domain oauth single-writers (`registerClient`, the `touchLastUsed` stamp) and
 * deleted only by the domain's inline pruner (`pruneExpired`: a DCR client older than 30 days that owns no token
 * and no transaction) — guard-listed. Deleting a client cascades to every transaction, code and token it owns.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull().unique(),
    clientSecretHash: text('client_secret_hash'),
    clientName: text('client_name').notNull(),
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    grantTypes: jsonb('grant_types').$type<OAuthGrantType[]>().notNull(),
    responseTypes: jsonb('response_types').$type<OAuthResponseType[]>().notNull(),
    /** The registration's `scope` string as sent (RFC 7591), when it sent one. */
    scope: text('scope'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method')
      .$type<OAuthTokenEndpointAuthMethod>()
      .notNull()
      .default('none'),
    registeredIp: text('registered_ip'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('oauth_clients_client_id_format', sql`${t.clientId} ~ '^[0-9a-f]{32}$'`),
    check(
      'oauth_clients_secret_hash_format',
      sql`${t.clientSecretHash} IS NULL OR ${t.clientSecretHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'oauth_clients_secret_matches_method',
      sql`(${t.tokenEndpointAuthMethod} = 'none') = (${t.clientSecretHash} IS NULL)`,
    ),
    check('oauth_clients_name_length', sql`char_length(${t.clientName}) BETWEEN 1 AND 80`),
    check(
      'oauth_clients_redirect_uris_shape',
      sql`jsonb_typeof(${t.redirectUris}) = 'array' AND jsonb_array_length(${t.redirectUris}) BETWEEN 1 AND 5`,
    ),
    check(
      'oauth_clients_grant_types_subset',
      sql`jsonb_typeof(${t.grantTypes}) = 'array' AND jsonb_array_length(${t.grantTypes}) >= 1 AND ${t.grantTypes} <@ ${sql.raw(`'${GRANT_TYPES_JSON}'::jsonb`)}`,
    ),
    check(
      'oauth_clients_response_types_subset',
      sql`jsonb_typeof(${t.responseTypes}) = 'array' AND jsonb_array_length(${t.responseTypes}) >= 1 AND ${t.responseTypes} <@ ${sql.raw(`'${RESPONSE_TYPES_JSON}'::jsonb`)}`,
    ),
    check(
      'oauth_clients_auth_method_enum',
      sql`${t.tokenEndpointAuthMethod} = ANY (ARRAY[${sql.raw(AUTH_METHODS_SQL_LIST)}])`,
    ),
  ],
);

export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type OAuthClientInsert = typeof oauthClients.$inferInsert;
