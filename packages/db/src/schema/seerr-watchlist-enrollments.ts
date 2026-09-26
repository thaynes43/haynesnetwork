import { pgTable, integer, text, boolean, timestamp } from 'drizzle-orm/pg-core';

/**
 * ADR-093 C-11 / DESIGN-052 D-05 / D-17 (PLAN-072, migration 0081) — SEERR WATCHLIST ENROLLMENT (T-266): one row per
 * Seerr user whose watchlist sync (movies and TV) the app turned on, or found already on (`already_on`). A row means
 * "enrolled once": the app never turns a user's sync back on after `optout_observed_at` is set (Q-08, driver
 * decision). Written ONLY by the @hnet/domain enrollment single-writer, after the Seerr settings write succeeded.
 */
export const seerrWatchlistEnrollments = pgTable('seerr_watchlist_enrollments', {
  seerrUserId: integer('seerr_user_id').primaryKey(),
  plexAccountId: text('plex_account_id'),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
  alreadyOn: boolean('already_on').notNull().default(false),
  optoutObservedAt: timestamp('optout_observed_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SeerrWatchlistEnrollmentRow = typeof seerrWatchlistEnrollments.$inferSelect;
