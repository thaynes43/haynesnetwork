import { pgTable, uuid, text, timestamp, check, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { roles } from './roles';
import { BOOK_ACTIONS, type BookAction } from './enums';

const BOOK_ACTIONS_SQL_LIST = BOOK_ACTIONS.map((a) => `'${a}'`).join(',');

/**
 * ADR-062 / DESIGN-033 D-03 (PLAN-041 — books Fix) — a role's FINE-GRAINED books action grants,
 * the exact `role_trash_action_grants` / `role_activity_action_grants` idiom (ADR-023/059): a ROW
 * MEANS THE ACTION IS GRANTED; an `is_admin` role stores NO rows and implies every action. Ships
 * with NO rows ⇒ `fix_book` is Admin-only for the owner's test window — the Q-01 ruling then FLIPS
 * it to ALL roles (a tracked post-validation step). Written only by the @hnet/domain
 * `setRoleBookActions` single-writer, which co-writes an `update_book_actions` permission_audit
 * row in the SAME transaction (hard rule 6). The grant gates ACTIONS only; the books section level
 * (ADR-021, read_only floor) gates visibility.
 */
export const roleBooksActionGrants = pgTable(
  'role_books_action_grants',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    action: text('action').$type<BookAction>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.action] }),
    check(
      'role_books_action_grants_action_enum',
      sql`${t.action} = ANY (ARRAY[${sql.raw(BOOK_ACTIONS_SQL_LIST)}])`,
    ),
  ],
);

export type RoleBooksActionGrantRow = typeof roleBooksActionGrants.$inferSelect;
export type RoleBooksActionGrantInsert = typeof roleBooksActionGrants.$inferInsert;
