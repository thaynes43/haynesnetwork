import { pgTable, uuid, boolean, timestamp, unique } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * ADR-060 C-05 / DESIGN-031 D-01 (PLAN-035 — ticket email notifications) — a user's OWN
 * notification opt-ins. First (and so far only) field: `email_ticket_updates` — email me when a
 * ticket I authored gets a reply or a status change (never for my own action; R-196). Default OFF.
 *
 * Bounded: at most ONE row per user (upsert on toggle, cascade on user delete). Written ONLY by
 * the @hnet/domain `setNotificationPreference` single-writer (guard-listed). NO audit row:
 * descriptive per-user state, not a role/permission/ledger mutation — CLAUDE.md hard rule 6 does
 * not apply (the `library_preferences` precedent, ADR-052 C-04). Room for sibling boolean columns
 * if DESIGN-031 Q-01 granularity is ever revisited.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** R-196 — opt-in to email on replies/status changes of tickets the user authored. */
    emailTicketUpdates: boolean('email_ticket_updates').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('notification_preferences_user_unique').on(t.userId)],
);

export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
export type NotificationPreferenceInsert = typeof notificationPreferences.$inferInsert;
