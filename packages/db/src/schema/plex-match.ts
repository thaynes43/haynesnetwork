import { pgTable, uuid, text, timestamp, check, unique, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mediaItems } from './media-items';
import { plexLibraries } from './plex-libraries';
import { PLEX_MATCH_GUID_SOURCES, type PlexMatchGuidSource } from './enums';

const MATCH_VIA_SQL_LIST = PLEX_MATCH_GUID_SOURCES.map((s) => `'${s}'`).join(',');

/**
 * ADR-047 / DESIGN-025 (PLAN-028 — "Watch/Listen/Read here" deep links) — the *arr → Plex match:
 * one row per media_items entry that a GUID match resolved to an exact Plex title. It carries the
 * two things a "Watch on Plex" deep link + the ACCESS gate need that media_items lacks:
 *   • `plex_library_id` — the Plex library (section) this title actually lives in. This is the
 *     authoritative per-item access key: the availability resolver hides an item whose
 *     `plex_library_id` is not in the caller's effective allowed set (ADR-024 role-library grants).
 *   • `rating_key` — the Plex metadata ratingKey, used to build the app.plex.tv deep link
 *     (`…/details?key=/library/metadata/<ratingKey>` — the machineIdentifier comes off the joined
 *     plex_servers row, single source of truth, never denormalized here).
 *
 * A title can live in MULTIPLE Plex libraries at once (e.g. a movie mirrored in both "HNet Movies" and
 * "HOps Movies" across two servers) — so there is ONE ROW PER (media_item, plex_library) pair, not one
 * per item. The detail view renders one "Watch on Plex — <library>" button per library the caller's role
 * can access, gated independently (owner UX ruling 2026-07-11).
 *
 * WHY A DEDICATED TABLE, not columns on media_items (ADR-047): the match is a rebuildable derived
 * cache (the *arrs + Plex are the sources of truth), keyed by a GUID resolution that is absent for
 * items Plex has not imported yet — a NULLABLE, one-to-many side-table models "no match yet" and
 * "in several libraries" honestly and keeps media_items a pure *arr mirror. Rebuildable READ-MODEL
 * (the ai_usage_chats / books_items class): written ONLY by the @hnet/domain `syncPlexMatches`
 * single-writer (guard-listed) which the `plex-match` sync mode drives; no per-row audit event
 * (synced/derived data, the documented no-ledger-row exemption). Unmatched items are gated by their
 * (arr_kind, arr_instance) HOME library — hidden ONLY by access, never by match state (THE INVARIANT).
 */
export const mediaPlexMatches = pgTable(
  'media_plex_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The matched Library item (media_items.id). Many rows per item — one per Plex library it lives in. */
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    /** The Plex library (section) the matched title lives in — the per-item access key. */
    plexLibraryId: uuid('plex_library_id')
      .notNull()
      .references(() => plexLibraries.id, { onDelete: 'cascade' }),
    /** The Plex metadata ratingKey (decimal id, kept as text) — the deep-link target. */
    ratingKey: text('rating_key').notNull(),
    /** Which shared GUID matched: 'tmdb' | 'imdb' | 'tvdb' | 'musicbrainz'. */
    matchedVia: text('matched_via').$type<PlexMatchGuidSource>().notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'media_plex_matches_via_enum',
      sql`${t.matchedVia} = ANY (ARRAY[${sql.raw(MATCH_VIA_SQL_LIST)}])`,
    ),
    // One row per (item, library) — the sync upserts on this key (a title can be in several libraries).
    unique('media_plex_matches_item_library_unique').on(t.mediaItemId, t.plexLibraryId),
    // The access resolver filters/groups by the Plex library (per-item gate + home-library derive).
    index('media_plex_matches_library_idx').on(t.plexLibraryId),
    // The detail view + per-item gate look up all rows for one item.
    index('media_plex_matches_item_idx').on(t.mediaItemId),
  ],
);

export type MediaPlexMatchRow = typeof mediaPlexMatches.$inferSelect;
export type MediaPlexMatchInsert = typeof mediaPlexMatches.$inferInsert;
