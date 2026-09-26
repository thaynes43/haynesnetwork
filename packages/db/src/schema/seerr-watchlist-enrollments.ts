import { pgTable, integer, text, boolean, timestamp } from 'drizzle-orm/pg-core';

/**
 * ADR-093 C-11 / DESIGN-052 D-05 / D-17 (PLAN-072, migration 0081) — SEERR WATCHLIST ENROLLMENT (T-266): one row per
 * Seerr user whose watchlist sync (movies and TV) the app turned on, or found already on (`already_on`). A row means
 * "enrolled once": the app never turns a user's sync back on after `optout_observed_at` is set (Q-08, driver
 * decision). Written ONLY by the @hnet/domain enrollment single-writer: a pending row (`confirmed_at` null) before the
 * app's Seerr settings write, confirmed once both flags are seen on (D-25bs).
 */
export const seerrWatchlistEnrollments = pgTable('seerr_watchlist_enrollments', {
  seerrUserId: integer('seerr_user_id').primaryKey(),
  plexAccountId: text('plex_account_id'),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
  alreadyOn: boolean('already_on').notNull().default(false),
  optoutObservedAt: timestamp('optout_observed_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
  /** DESIGN-052 D-25bs — when the enrollment was confirmed (both flags seen on). Null = PENDING: the app is about to
   *  write, or wrote and never saw the answer (a timeout, a failed insert after the write). The row is inserted BEFORE
   *  the write, so a lost answer can never turn the app's own enrollment into `already_on` on the next run. */
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
});

export type SeerrWatchlistEnrollmentRow = typeof seerrWatchlistEnrollments.$inferSelect;
