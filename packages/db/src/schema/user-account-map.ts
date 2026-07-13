import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user watch/read-state) — the app-user ↔ media-account
 * MAPPING seam. One row per app `user_id` carrying the per-source handles used to attribute a
 * household's watch/read activity to the signed-in user:
 *   • plex_user_id   — the plex.tv NUMERIC id (as text — matches resolvePlexIdentity.userId), the
 *                      join key to the Tautulli history `user_id`. AUTO-FILLED from the OIDC claim /
 *                      the friend matchers when resolvable (approach A/B), admin-settable otherwise.
 *   • abs_user_id    — the Audiobookshelf user id, the join key for the ABS admin `mediaProgress[]`
 *                      read (approach C). Admin-set.
 *   • kavita_username — the Kavita account username. Admin-set. Kavita per-user READ-STATE is
 *                      DEFERRED (ADR-053 C-05 — no admin per-user progress read); the handle is
 *                      carried now so the deferred work needs no schema change.
 *
 * It mirrors the existing users.plex_email/plex_username OVERRIDE pattern (the codebase already
 * chose manual handles as the reliable fallback). A DOMAIN SEAM: the Feed-attribution backlog item
 * reuses it verbatim (ADR-053 C-01). Written ONLY by the @hnet/domain `upsertUserAccountHandles`
 * single-writer (guard-listed). NO audit row — descriptive attribution config, not a role/permission
 * mutation (the ADR-052 C-04 class); handle entry is admin-only (ADR-053 C-07) and the map never
 * widens access (per-user state is a facet on already-gated content). Cascade on user delete.
 */
export const userAccountMap = pgTable(
  'user_account_map',
  {
    /** One row per app user (the primary key IS the app user id). */
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** plex.tv numeric id (text). The Tautulli history join key. Nullable until resolved/set. */
    plexUserId: text('plex_user_id'),
    /** Audiobookshelf user id. The ABS mediaProgress admin-read join key. Nullable. */
    absUserId: text('abs_user_id'),
    /** Kavita account username (read-state DEFERRED, ADR-053 C-05). Nullable. */
    kavitaUsername: text('kavita_username'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One plex.tv / ABS account maps to at most one app user (NULLs are exempt — many users may be
    // unmapped). A UNIQUE over a nullable column permits multiple NULLs in Postgres.
    unique('user_account_map_plex_user_unique').on(t.plexUserId),
    unique('user_account_map_abs_user_unique').on(t.absUserId),
  ],
);

export type UserAccountMapRow = typeof userAccountMap.$inferSelect;
export type UserAccountMapInsert = typeof userAccountMap.$inferInsert;
