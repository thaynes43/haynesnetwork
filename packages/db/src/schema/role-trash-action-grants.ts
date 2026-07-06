import { pgTable, uuid, text, timestamp, check, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { roles } from './roles';
import { TRASH_ACTIONS, type TrashAction } from './enums';

const TRASH_ACTIONS_SQL_LIST = TRASH_ACTIONS.map((a) => `'${a}'`).join(',');

/**
 * ADR-023 / DESIGN-010 D-03 — a role's FINE-GRAINED Trash action grants, layered on top of the
 * coarse `role_section_permissions` `trash` level. A ROW MEANS THE ACTION IS GRANTED (there is
 * no `enabled` boolean — presence is the grant, absence is deny; ADR-023 C-03). One row per
 * (role, action); the coarse section level still gates VIEW (read_only ⇒ browse), while these
 * rows unlock the individual write actions (Save, Expedite, Edit rules, Restore). An `is_admin`
 * role stores NO rows and implies EVERY action (superuser, like role_section_permissions /
 * role_library_grants). Written only by the @hnet/domain `setRoleTrashActions` single-writer,
 * which co-writes an `update_trash_actions` permission_audit row in the SAME transaction
 * (CLAUDE.md hard rule 6). Composite PK dedupes; the FK cascades so deleting a role removes its
 * action rows.
 */
export const roleTrashActionGrants = pgTable(
  'role_trash_action_grants',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    action: text('action').$type<TrashAction>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.action] }),
    check(
      'role_trash_action_grants_action_enum',
      sql`${t.action} = ANY (ARRAY[${sql.raw(TRASH_ACTIONS_SQL_LIST)}])`,
    ),
  ],
);

export type RoleTrashActionGrantRow = typeof roleTrashActionGrants.$inferSelect;
export type RoleTrashActionGrantInsert = typeof roleTrashActionGrants.$inferInsert;
