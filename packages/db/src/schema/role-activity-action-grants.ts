import { pgTable, uuid, text, timestamp, check, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { roles } from './roles';
import { ACTIVITY_ACTIONS, type ActivityAction } from './enums';

const ACTIVITY_ACTIONS_SQL_LIST = ACTIVITY_ACTIONS.map((a) => `'${a}'`).join(',');

/**
 * ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — a role's FINE-GRAINED Activity action grants,
 * the exact `role_trash_action_grants` idiom (ADR-023): a ROW MEANS THE ACTION IS GRANTED (no `enabled`
 * boolean — presence is the grant, absence is deny). Import-failure actions (retry-import / force-research,
 * owner ruling R2) ship Admin-only; an `is_admin` role stores NO rows and implies EVERY action; a role row
 * here OPENS one action to that role later (the "openable to roles later" seam). Written only by the
 * @hnet/domain `setRoleActivityActions` single-writer, which co-writes an `update_activity_actions`
 * permission_audit row in the SAME transaction (CLAUDE.md hard rule 6). Composite PK dedupes; the FK
 * cascades so deleting a role removes its action rows.
 *
 * NOTE: unlike Trash there is no coarse `activity` section level — the Activity tab rides the (universal,
 * ungated) Library section, and per-item VIEW gating is done on the LIST resolver by each item's own
 * `section` (a book item needs `books ≥ read_only`). These grants gate only the ACTIONS.
 */
export const roleActivityActionGrants = pgTable(
  'role_activity_action_grants',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    action: text('action').$type<ActivityAction>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.action] }),
    check(
      'role_activity_action_grants_action_enum',
      sql`${t.action} = ANY (ARRAY[${sql.raw(ACTIVITY_ACTIONS_SQL_LIST)}])`,
    ),
  ],
);

export type RoleActivityActionGrantRow = typeof roleActivityActionGrants.$inferSelect;
export type RoleActivityActionGrantInsert = typeof roleActivityActionGrants.$inferInsert;
