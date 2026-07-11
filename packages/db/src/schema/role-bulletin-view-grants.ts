import { pgTable, uuid, text, timestamp, check, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { roles } from './roles';
import { BULLETIN_VIEWS, type BulletinView } from './enums';

const BULLETIN_VIEWS_SQL_LIST = BULLETIN_VIEWS.map((v) => `'${v}'`).join(',');

/**
 * ADR-049 / DESIGN-012 amend (PLAN-027) — a role's SUB-VIEW visibility grants for the Bulletin
 * section (Feed vs Messages), layered on top of the coarse `role_section_permissions` `bulletin`
 * level (which shows/hides the section as a whole). A ROW MEANS THAT VIEW IS GRANTED (no `enabled`
 * boolean — presence is the grant; mirrors role_message_action_grants in shape). One row per
 * (role, view): `feed` unlocks the aggregated third-party Feed, `messages` unlocks the board.
 *
 * RESOLUTION differs from role_message_action_grants (which default-deny): a role with NO rows
 * resolves to BOTH views (BULLETIN_VIEW_DEFAULTS — ADR-026 C-02 "Bulletin is for everyone"); any
 * present rows are the exact narrowing allowlist (so the owner's Default role, seeded to a single
 * `messages` row, has the Feed FORBIDDEN). An `is_admin` role stores NO rows and implies BOTH views.
 * Written only by the @hnet/domain `setRoleBulletinViews` single-writer, which co-writes an
 * `update_bulletin_views` permission_audit row in the SAME transaction (CLAUDE.md hard rule 6).
 * Composite PK dedupes; the FK cascades so deleting a role removes its view rows.
 */
export const roleBulletinViewGrants = pgTable(
  'role_bulletin_view_grants',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    view: text('view').$type<BulletinView>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.view] }),
    check(
      'role_bulletin_view_grants_view_enum',
      sql`${t.view} = ANY (ARRAY[${sql.raw(BULLETIN_VIEWS_SQL_LIST)}])`,
    ),
  ],
);

export type RoleBulletinViewGrantRow = typeof roleBulletinViewGrants.$inferSelect;
export type RoleBulletinViewGrantInsert = typeof roleBulletinViewGrants.$inferInsert;
