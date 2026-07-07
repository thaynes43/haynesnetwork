import { pgTable, uuid, text, timestamp, check, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { roles } from './roles';
import { MESSAGE_ACTIONS, type MessageAction } from './enums';

const MESSAGE_ACTIONS_SQL_LIST = MESSAGE_ACTIONS.map((a) => `'${a}'`).join(',');

/**
 * ADR-026 / DESIGN-012 D-04 — a role's FINE-GRAINED Bulletin message action grants, layered on top
 * of the coarse `role_section_permissions` `bulletin` level (which gates READ of the Feed +
 * Messages). A ROW MEANS THE ACTION IS GRANTED (no `enabled` boolean — presence is the grant,
 * absence is deny; mirrors role_trash_action_grants). One row per (role, action): `post` unlocks
 * creating/editing one's OWN messages, `moderate` unlocks hide/delete/restore of ANY message. An
 * `is_admin` role stores NO rows and implies EVERY action (superuser). Written only by the
 * @hnet/domain `setRoleMessageActions` single-writer, which co-writes an `update_message_actions`
 * permission_audit row in the SAME transaction (CLAUDE.md hard rule 6). Composite PK dedupes; the
 * FK cascades so deleting a role removes its action rows.
 */
export const roleMessageActionGrants = pgTable(
  'role_message_action_grants',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    action: text('action').$type<MessageAction>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.action] }),
    check(
      'role_message_action_grants_action_enum',
      sql`${t.action} = ANY (ARRAY[${sql.raw(MESSAGE_ACTIONS_SQL_LIST)}])`,
    ),
  ],
);

export type RoleMessageActionGrantRow = typeof roleMessageActionGrants.$inferSelect;
export type RoleMessageActionGrantInsert = typeof roleMessageActionGrants.$inferInsert;
