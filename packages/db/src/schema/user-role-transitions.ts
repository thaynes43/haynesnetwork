import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { roles } from './roles';
import { ROLE_INITIATOR_KINDS, type RoleInitiatorKind } from './enums';

const INITIATOR_KINDS_SQL_LIST = ROLE_INITIATOR_KINDS.map((k) => `'${k}'`).join(',');

/**
 * DESIGN-001 D-04 / ADR-012 — role-assignment audit (R-02, R-04). Append-only by
 * convention; rows are written exclusively by `assignRole` in packages/domain (D-12).
 * `from_role_id` is null on a user's first assignment. `initiator_kind` has no 'user'
 * value — users never change their own role. Role FKs are ON DELETE SET NULL so audit
 * history outlives a deleted role.
 */
export const userRoleTransitions = pgTable(
  'user_role_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fromRoleId: uuid('from_role_id').references(() => roles.id, { onDelete: 'set null' }),
    toRoleId: uuid('to_role_id').references(() => roles.id, { onDelete: 'set null' }),
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
