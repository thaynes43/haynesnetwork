import { pgTable, uuid, text, timestamp, check, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  LIBRARY_WALLS,
  LIBRARY_VIEW_SHAPES,
  SORT_DIRECTIONS,
  type LibraryWall,
  type LibraryViewShape,
  type SortDirection,
} from './enums';
import { users } from './users';

const LIBRARY_WALLS_SQL_LIST = LIBRARY_WALLS.map((w) => `'${w}'`).join(',');
const LIBRARY_VIEW_SHAPES_SQL_LIST = LIBRARY_VIEW_SHAPES.map((v) => `'${v}'`).join(',');
const SORT_DIRECTIONS_SQL_LIST = SORT_DIRECTIONS.map((d) => `'${d}'`).join(',');

/**
 * ADR-052 / DESIGN-026 D-06 (PLAN-029 — Library views + S&F) — the per-user, per-wall Library
 * PREFERENCE: the last `view` shape, `group_by` dimension (grouped views only), and last-used
 * `sort_field` + `sort_dir` the wall reopens with. Server-side (R1) so the same account gets the
 * same default on any device; the URL is the shareable override (D-10 precedence) and always WINS
 * over a stored row (a shared link is never written back).
 *
 * FIRST per-user store in the schema (live-verified none existed). Bounded: at most ONE row per
 * (user_id, wall) — an upsert on change, cascade on user delete. Written ONLY by the @hnet/domain
 * `setLibraryPreference` single-writer (guard-listed). NO audit row: this is descriptive UI state
 * (a sort choice), not a role/permission/ledger mutation — CLAUDE.md hard rule 6 does not apply
 * (ADR-052 C-04). `sort_field` is free text (the three engines advertise DIFFERENT sort keys —
 * ledger `added_at`/`released_at`/…, books `author`/`released`/…, live-Plex air/upload dates — so
 * a single enum would be wrong); the CHECKed dimensions are `wall`, `view`, and `sort_dir`.
 */
export const libraryPreferences = pgTable(
  'library_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Which Library wall this preference is for (LIBRARY_WALLS). */
    wall: text('wall').$type<LibraryWall>().notNull(),
    /** The last-selected view shape (flat / grouped / hierarchy). */
    view: text('view').$type<LibraryViewShape>().notNull(),
    /** The grouping dimension key for a grouped view (author / series / channel / discipline). Null
     *  for flat / hierarchy views (they have no group-by). Free text — the key set is per-wall. */
    groupBy: text('group_by'),
    /** The last-used sort field key (per-engine; free text — see the class comment). */
    sortField: text('sort_field').notNull(),
    /** The last-used sort direction (SORT_DIRECTIONS). */
    sortDir: text('sort_dir').$type<SortDirection>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('library_preferences_user_wall_unique').on(t.userId, t.wall),
    check(
      'library_preferences_wall_enum',
      sql`${t.wall} = ANY (ARRAY[${sql.raw(LIBRARY_WALLS_SQL_LIST)}])`,
    ),
    check(
      'library_preferences_view_enum',
      sql`${t.view} = ANY (ARRAY[${sql.raw(LIBRARY_VIEW_SHAPES_SQL_LIST)}])`,
    ),
    check(
      'library_preferences_sort_dir_enum',
      sql`${t.sortDir} = ANY (ARRAY[${sql.raw(SORT_DIRECTIONS_SQL_LIST)}])`,
    ),
  ],
);

export type LibraryPreferenceRow = typeof libraryPreferences.$inferSelect;
export type LibraryPreferenceInsert = typeof libraryPreferences.$inferInsert;
