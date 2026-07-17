import { pgTable, uuid, text, timestamp, check, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { roles } from './roles';
import { COLLECTION_ACTIONS, type CollectionAction } from './enums';

const COLLECTION_ACTIONS_SQL_LIST = COLLECTION_ACTIONS.map((a) => `'${a}'`).join(',');

/**
 * ADR-069 / DESIGN-042 D-01 (PLAN-052 — collection manager) — a role's FINE-GRAINED collection-manager
 * action grants, the exact `role_books_action_grants` / `role_activity_action_grants` idiom
 * (ADR-023/059/062): a ROW MEANS THE ACTION IS GRANTED (presence is the grant; no `enabled` boolean —
 * absence is deny); an `is_admin` role stores NO rows and implies EVERY action. Ships with NO rows ⇒
 * Admin-only until the owner opens each per role (the books-Fix precedent). Written ONLY by the
 * @hnet/domain `setRoleCollectionActions` single-writer, which co-writes an `update_collection_actions`
 * permission_audit row in the SAME transaction (hard rule 6). `acquire` (the content-pulling knob) is a
 * DISTINCT grant a `manage` role does not automatically hold and is re-checked server-side at the call.
 */
export const roleCollectionActionGrants = pgTable(
  'role_collection_action_grants',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    action: text('action').$type<CollectionAction>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.action] }),
    check(
      'role_collection_action_grants_action_enum',
      sql`${t.action} = ANY (ARRAY[${sql.raw(COLLECTION_ACTIONS_SQL_LIST)}])`,
    ),
  ],
);

export type RoleCollectionActionGrantRow = typeof roleCollectionActionGrants.$inferSelect;
export type RoleCollectionActionGrantInsert = typeof roleCollectionActionGrants.$inferInsert;
