import { pgTable, uuid, integer, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { roles } from './roles';

/**
 * ADR-080 C-02 (PLAN-041 Gap B — per-role media-action budgets) — a role's hourly media-action
 * budget. ONE number per role (`fix_per_hour`), applied INDEPENDENTLY to each existing pool: the
 * arr pool (Fix + Force Search share one counter, DESIGN-005 D-17) and the books pool (book Fix +
 * the book-item Force Search, DESIGN-033). Row identity is the role (`role_id` PK, FK → roles ON
 * DELETE CASCADE) — at most one budget per role, cleaned up when the role is deleted.
 *
 * Effective-limit resolution (ADR-080 C-03, `effectiveMediaActionBudget`): an is_admin role
 * BYPASSES entirely (no row is ever written for it), else this row's value, else the code fallback
 * 25 (today's constant) — so NO seed rows ⇒ zero behavior change on deploy. Written ONLY by the
 * @hnet/domain `setRoleMediaActionBudget` single-writer, which co-writes an `update_media_action_budget`
 * permission_audit row (before/after) in the SAME transaction (CLAUDE.md hard rule 6); guard-listed
 * in `no-direct-state-writes`. Setting 0 blocks that role's non-admin media actions (the documented
 * emergency lever, C-05).
 */
export const roleMediaActionBudgets = pgTable(
  'role_media_action_budgets',
  {
    roleId: uuid('role_id')
      .primaryKey()
      .references(() => roles.id, { onDelete: 'cascade' }),
    // ADR-080 C-02 — the per-hour allowance; CHECK 0 <= fix_per_hour <= 1000 (0 = blocked).
    fixPerHour: integer('fix_per_hour').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('role_media_action_budgets_range', sql`${t.fixPerHour} >= 0 AND ${t.fixPerHour} <= 1000`),
  ],
);

export type RoleMediaActionBudgetRow = typeof roleMediaActionBudgets.$inferSelect;
export type RoleMediaActionBudgetInsert = typeof roleMediaActionBudgets.$inferInsert;
