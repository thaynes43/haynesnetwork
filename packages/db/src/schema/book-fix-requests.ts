import { pgTable, uuid, text, integer, jsonb, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { booksItems } from './books-items';
import { bookRequests } from './book-requests';
import {
  BOOK_FIX_REASONS,
  BOOK_FIX_ROUTES,
  BOOK_FIX_STATUSES,
  BOOK_STALE_FILE_ACTIONS,
  type BookFixReason,
  type BookFixRoute,
  type BookFixStatus,
  type BookStaleFileAction,
} from './enums';

const REASONS_SQL = BOOK_FIX_REASONS.map((r) => `'${r}'`).join(',');
const ROUTES_SQL = BOOK_FIX_ROUTES.map((r) => `'${r}'`).join(',');
const STATUSES_SQL = BOOK_FIX_STATUSES.map((s) => `'${s}'`).join(',');
const STALE_SQL = BOOK_STALE_FILE_ACTIONS.map((s) => `'${s}'`).join(',');

/**
 * ADR-062 / DESIGN-033 D-01 (PLAN-041) — a books/audiobooks/comics FIX request: the first-class
 * audit aggregate for a landed-bad-copy remediation. NOT a `fix_requests` overload (that table is
 * *arr-shaped — ADR-062 C-04). The row + its `request_book_fix` permission_audit entry commit in
 * ONE tx BEFORE any external call (fix-flow crash-safety); every LL/Kapowarr step's raw response
 * is appended to `actions_taken` (`[0]` = the requester snapshot). The identity columns SNAPSHOT
 * the book (durable if the mirror row is later tombstoned); `books_item_id` is RESTRICT so fix
 * history never vanishes. Written only by the @hnet/domain book-fix single-writers (guard-listed).
 */
export const bookFixRequests = pgTable(
  'book_fix_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterId: uuid('requester_id').references(() => users.id, { onDelete: 'set null' }),
    booksItemId: uuid('books_item_id')
      .notNull()
      .references(() => booksItems.id, { onDelete: 'restrict' }),
    /** Identity snapshot — source server + its id + kind + title at fix time. */
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    mediaKind: text('media_kind').notNull(),
    titleSnapshot: text('title_snapshot').notNull(),
    /** The acquisition route (derived from media_kind — ADR-062 C-01). */
    route: text('route').$type<BookFixRoute>().notNull(),
    reason: text('reason').$type<BookFixReason>().notNull(),
    /** Required IFF reason='other' (CHECK, both directions — the DESIGN-005 D-09 shape). */
    reasonText: text('reason_text'),
    /** Set when reason='wrong_language' (advisory — v1 rides the global REJECT_WORDS guard, Q-03). */
    languagePref: text('language_pref'),
    /** ADR-062 C-03 — the honest stale-file seam for the deferred Mode-2 quarantine assist. */
    staleFileAction: text('stale_file_action').$type<BookStaleFileAction>().notNull().default('none'),
    status: text('status').$type<BookFixStatus>().notNull().default('pending'),
    /** Ordered external steps + RAW (sanitized) responses; [0] = requester snapshot. */
    actionsTaken: jsonb('actions_taken').$type<Record<string, unknown>[]>().notNull().default([]),
    /** The LL book id (GB volume id) the fix resolved — the reconcile key for books/audiobooks. */
    llBookId: text('ll_book_id'),
    /** The Kapowarr volume id — the reconcile key for comics. */
    kapowarrVolumeId: integer('kapowarr_volume_id'),
    /** Optional link when the book also has a request row (a Matilda-class fix has none). */
    bookRequestId: uuid('book_request_id').references(() => bookRequests.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('book_fix_requests_requester_idx').on(t.requesterId, t.createdAt),
    index('book_fix_requests_item_idx').on(t.booksItemId),
    index('book_fix_requests_status_idx').on(t.status),
    check('book_fix_requests_reason_enum', sql`${t.reason} = ANY (ARRAY[${sql.raw(REASONS_SQL)}])`),
    check('book_fix_requests_route_enum', sql`${t.route} = ANY (ARRAY[${sql.raw(ROUTES_SQL)}])`),
    check('book_fix_requests_status_enum', sql`${t.status} = ANY (ARRAY[${sql.raw(STATUSES_SQL)}])`),
    check('book_fix_requests_stale_enum', sql`${t.staleFileAction} = ANY (ARRAY[${sql.raw(STALE_SQL)}])`),
    check(
      'book_fix_requests_reason_text_iff_other',
      sql`(${t.reason} = 'other') = (${t.reasonText} IS NOT NULL)`,
    ),
  ],
);

export type BookFixRequestRow = typeof bookFixRequests.$inferSelect;
export type BookFixRequestInsert = typeof bookFixRequests.$inferInsert;
