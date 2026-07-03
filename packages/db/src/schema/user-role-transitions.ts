import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { ROLE_INITIATOR_KINDS, type Role, type RoleInitiatorKind } from './enums';

const INITIATOR_KINDS_SQL_LIST = ROLE_INITIATOR_KINDS.map((k) => `'${k}'`).join(',');

/**
 * DESIGN-001 D-04 — role-change audit (R-02, R-04). Append-only by convention; rows are
 * written exclusively by `transitionRole` in packages/domain (D-12). `initiator_kind`
 * has no 'user' value — users never change their own role.
 */
export const userRoleTransitions = pgTable(
  'user_role_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fromRole: text('from_role').$type<Role>(),
    toRole: text('to_role').$type<Role>().notNull(),
    initiatorId: uuid('initiator_id').references(() => users.id),
    initiatorKind: text('initiator_kind').$type<RoleInitiatorKind>().notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'user_role_transitions_initiator_kind_enum',
      sql`${table.initiatorKind} = ANY (ARRAY[${sql.raw(INITIATOR_KINDS_SQL_LIST)}])`,
    ),
    index('user_role_transitions_user_created_idx').on(table.userId, table.createdAt.desc()),
  ],
);

export type UserRoleTransitionRow = typeof userRoleTransitions.$inferSelect;
export type UserRoleTransitionInsert = typeof userRoleTransitions.$inferInsert;
