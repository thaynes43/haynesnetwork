import { pgTable, uuid, integer, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { roles } from './roles';
import { AUTHENTIK_GROUP_AUDIT_ACTIONS, type AuthentikGroupAuditAction } from './enums';

const ACTIONS_SQL_LIST = AUTHENTIK_GROUP_AUDIT_ACTIONS.map((a) => `'${a}'`).join(',');

/**
 * ADR-045 C-06 / DESIGN-023 (PLAN-026) — the Authentik group-portal write ledger. Exactly like
 * `plex_share_audit` (BC-04): the app writes group MEMBERSHIP + pre-creates tier groups against EXTERNAL
 * systems (Authentik / Open WebUI REST), so the audit row cannot co-commit with the side-effect — each
 * successful external write appends ONE row here AFTER the apply. Append-only; the guard test lists it in
 * the INSERT patterns only. Referential columns SET NULL on delete so the ledger outlives the subject;
 * `detail` jsonb carries the read-merge proof (previous/desired owned-group set, the API status, the
 * role name, whether the subject was an app user or an Authentik-only identity).
 *
 * The GUARDRAIL invariant this ledger records: a membership write is ever attempted ONLY for a group in
 * the owned-groups allowlist — the domain writer throws `AuthentikGroupNotOwnedError` BEFORE any external
 * call for a non-owned group, so no row here ever names authentik-admin-managed groups (authentik Admins,
 * mfa-exempt, …).
 */
export const authentikGroupAudit = pgTable(
  'authentik_group_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** add_member | remove_member | create_group | ensure_owui_group. */
    action: text('action').$type<AuthentikGroupAuditAction>().notNull(),
    /** The Authentik (or OWUI) group NAME the write targeted — always an owned group. */
    groupName: text('group_name').notNull(),
    /** The Authentik user `pk` the membership flip targeted; NULL for create_group / ensure_owui_group. */
    authentikUserPk: integer('authentik_user_pk'),
    /** The app Role that drove the write (SET NULL keeps the row if the role is later deleted). */
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
    /** The subject identity's email (denormalized — the subject may have no app row). */
    subjectEmail: text('subject_email'),
    /** The admin who initiated it; NULL for a system/sync actor. SET NULL keeps the row. */
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'authentik_group_audit_action_enum',
      sql`${t.action} = ANY (ARRAY[${sql.raw(ACTIONS_SQL_LIST)}])`,
    ),
    index('authentik_group_audit_created_idx').on(t.createdAt.desc()),
    index('authentik_group_audit_user_created_idx').on(t.authentikUserPk, t.createdAt.desc()),
  ],
);

export type AuthentikGroupAuditRow = typeof authentikGroupAudit.$inferSelect;
export type AuthentikGroupAuditInsert = typeof authentikGroupAudit.$inferInsert;
