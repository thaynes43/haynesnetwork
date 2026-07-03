import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { appCatalog } from './app-catalog';
import { tags } from './tags';
import { PERMISSION_AUDIT_ACTIONS, type PermissionAuditAction } from './enums';

const ACTIONS_SQL_LIST = PERMISSION_AUDIT_ACTIONS.map((a) => `'${a}'`).join(',');

/**
 * DESIGN-001 D-10 — generic permission audit log (R-04). Append-only; referential
 * columns are ON DELETE SET NULL so audit history outlives the subject, and `detail`
 * jsonb always carries a denormalized human-readable snapshot. Rows are written only by
 * the packages/domain single-writer helpers, in the same transaction as the mutation
 * they record (D-12). Role changes are NOT in this table — see user_role_transitions.
 */
export const permissionAudit = pgTable(
  'permission_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').$type<PermissionAuditAction>().notNull(),
    subjectUserId: uuid('subject_user_id').references(() => users.id, { onDelete: 'set null' }),
    appId: uuid('app_id').references(() => appCatalog.id, { onDelete: 'set null' }),
    tagId: uuid('tag_id').references(() => tags.id, { onDelete: 'set null' }),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'permission_audit_action_enum',
      sql`${table.action} = ANY (ARRAY[${sql.raw(ACTIONS_SQL_LIST)}])`,
    ),
    index('permission_audit_created_idx').on(table.createdAt.desc()),
    index('permission_audit_subject_created_idx').on(table.subjectUserId, table.createdAt.desc()),
  ],
);

export type PermissionAuditRow = typeof permissionAudit.$inferSelect;
export type PermissionAuditInsert = typeof permissionAudit.$inferInsert;
