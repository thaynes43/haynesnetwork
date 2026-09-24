import { pgTable, uuid, text, jsonb, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { OAUTH_AUDIT_EVENTS, type OAuthAuditEvent } from './enums';

const EVENTS_SQL_LIST = OAUTH_AUDIT_EVENTS.map((e) => `'${e}'`).join(',');

/**
 * ADR-091 C-06 / DESIGN-050 D-03 (PLAN-069, migration 0078) — the connector audit trail (hard rule 6). APPEND-ONLY:
 * one row per audited transition, inserted by its @hnet/domain oauth single-writer in the SAME transaction as the
 * state change — `consent_granted` (grantConsent), `consent_denied` (denyConsent), `client_disconnected`
 * (disconnectClient) and `family_revoked_on_reuse` (revokeFamilyOnReuse). `user_id` is the subject — the user
 * whose delegation changed — and is SET NULL when the user is deleted (the repo's audit-table convention:
 * permission_audit does the same), so the trail outlives both the user and the client. `client_id` is the public handle
 * as TEXT with NO foreign key, deliberately: the inline pruner deletes dormant DCR clients, and the audit trail
 * must outlive the client it describes. `details` carries a denormalized snapshot (client name, redirect host,
 * scopes, the acting user when it differs, revocation counts) — never a token, code or secret.
 *
 * Written ONLY by @hnet/domain (guard-listed in the INSERT / UPDATE / DELETE families: nothing may rewrite or
 * drop the history).
 */
export const oauthAudit = pgTable(
  'oauth_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    event: text('event').$type<OAuthAuditEvent>().notNull(),
    /** The subject — whose delegation changed. SET NULL on user delete: the audit trail outlives the user. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    clientId: text('client_id').notNull(),
    familyId: uuid('family_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('oauth_audit_event_enum', sql`${t.event} = ANY (ARRAY[${sql.raw(EVENTS_SQL_LIST)}])`),
    index('oauth_audit_user_at_idx').on(t.userId, t.at.desc()),
    index('oauth_audit_client_idx').on(t.clientId),
  ],
);

export type OAuthAuditRow = typeof oauthAudit.$inferSelect;
export type OAuthAuditInsert = typeof oauthAudit.$inferInsert;
