import { pgTable, uuid, integer, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { roles } from './roles';
import { users } from './users';

/**
 * ADR-045 C-05 / DESIGN-023 (PLAN-026) — the PENDING role assignment: when an admin assigns an app Role
 * to an Authentik identity that has no app user row yet (someone who has only ever logged into Open WebUI
 * / Kavita / etc.), the Authentik group membership is written immediately, but the app-role intent is
 * PARKED here and consumed LAZILY on that identity's first haynesnetwork login (the Better Auth
 * session.create.after hook → consumePendingRoleOnSignin → assignRole in the same tx, then mark consumed).
 *
 * Keying (ADR-045 C-04): the haynesnetwork OIDC provider uses `sub_mode = hashed_user_id`, so the app
 * CANNOT pre-compute a user's `sub`; the practical join is EMAIL (case-insensitive) — the same email-match
 * precedent ADR-017 C-06 uses for Plex accounts. The Authentik `pk` (+ username, uid) is stored for
 * identity/audit/idempotency and is the upsert key (one live pending row per identity). Written ONLY by
 * the @hnet/domain single-writers (guard-listed): the create co-writes a permission_audit
 * `assign_pending_role` row in the same tx; the consume co-writes the user_role_transitions row (via
 * assignRole) and stamps consumed_at in the same tx.
 */
export const pendingRoleAssignments = pgTable(
  'pending_role_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The Authentik user `pk` — the upsert key (one live pending row per identity). */
    authentikUserPk: integer('authentik_user_pk').notNull(),
    authentikUsername: text('authentik_username').notNull(),
    /** Normalized (lowercased) email — the login-time consume lookup key. */
    email: text('email').notNull(),
    /** The goauthentik.io uid hash (reference/audit). */
    authentikUid: text('authentik_uid'),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    /** The admin who assigned it (SET NULL keeps the row if the admin is later deleted). */
    assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** NULL until the identity first logs in and the intent is applied. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** The app user row created on first login that received the role (SET NULL on delete). */
    consumedUserId: uuid('consumed_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    // One live (unconsumed) pending row per Authentik identity — re-assigning overwrites it.
    uniqueIndex('pending_role_assignments_live_pk_idx')
      .on(t.authentikUserPk)
      .where(sql`${t.consumedAt} IS NULL`),
    // Login-time consume looks up by lowered email among live rows.
    index('pending_role_assignments_live_email_idx')
      .on(t.email)
      .where(sql`${t.consumedAt} IS NULL`),
  ],
);

export type PendingRoleAssignmentRow = typeof pendingRoleAssignments.$inferSelect;
export type PendingRoleAssignmentInsert = typeof pendingRoleAssignments.$inferInsert;
