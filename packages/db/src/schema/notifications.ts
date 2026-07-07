import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { NOTIFICATION_SOURCES, type NotificationSource } from './enums';
import { mediaItems } from './media-items';
import { users } from './users';

const NOTIFICATION_SOURCES_SQL_LIST = NOTIFICATION_SOURCES.map((s) => `'${s}'`).join(',');

/**
 * ADR-023 / DESIGN-010 (addendum c) — the generic in-app notification store. PLAN-006 shipped
 * this as the MINIMAL receiver; ADR-026 / DESIGN-012 (PLAN-009 Bulletin) WIDENS it (migration
 * 0018) into the durable Feed store: a `POST /api/webhooks/<source>` receiver persists a
 * normalized event here, Trash's "Activity" tab reads it filtered to `source='maintainerr'`, and
 * the Bulletin Feed browses the whole set keyset-paginated. Written only by the @hnet/domain
 * `recordNotification` single-writer (guard-listed).
 *
 * Column-name stability (ADR-026): the shipped `type`/`title`/`body` columns are KEPT (not renamed
 * to event_type/subject/message) — `type` IS the source event type, `title`/`body` the display
 * subject/message. The widening only ADDS columns + a dedupe index + the source CHECK rebuild.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').$type<NotificationSource>().notNull(),
    /** Source-specific event type (e.g. Seerr's `notification_type`, Maintainerr's — free text). */
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /**
     * ADR-026 — best-effort link to the ledger Media Item the event is about (nullable FK, like
     * `ledger_events.media_item_id`); resolved from `tmdb_id`/`tvdb_id` at ingest. ON DELETE SET
     * NULL so tombstoning a Media Item never drops the notification.
     */
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    /** External ids carried in the payload — the backfill/match keys for `media_item_id`. */
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    /**
     * ADR-026 — the attributed app user (the Seerr requester / Tautulli viewer), resolved from the
     * payload email via the SAME case-insensitive match Seerr ledger attribution uses (ADR-008
     * C-05). Nullable — an unmatched email stays "unattributed". ON DELETE SET NULL.
     */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Source event timestamp (when the event happened upstream); defaults to created_at at ingest. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The source's stable event id (Seerr `request_id`, a Tautulli composite) — the dedupe key.
     * A partial unique index on `(source, source_event_id) WHERE source_event_id IS NOT NULL` makes
     * re-delivery idempotent (recordNotification inserts ON CONFLICT DO NOTHING). Null ⇒ always
     * insert (Maintainerr events carry no stable id — unchanged from PLAN-006).
     */
    sourceEventId: text('source_event_id'),
    /** The raw source payload, sanitized to a bounded plain object (audit / future reprocessing). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'notifications_source_enum',
      sql`${t.source} = ANY (ARRAY[${sql.raw(NOTIFICATION_SOURCES_SQL_LIST)}])`,
    ),
    // Idempotent re-delivery: at most one row per (source, source_event_id) when the id is present.
    uniqueIndex('notifications_source_event_uidx')
      .on(t.source, t.sourceEventId)
      .where(sql`${t.sourceEventId} IS NOT NULL`),
    // The Trash Activity feed reads newest-first, scoped by source (unchanged from PLAN-006).
    index('notifications_source_created_idx').on(t.source, t.createdAt.desc()),
    // The Bulletin Feed browses newest-first by source event time (the keyset sort column).
    index('notifications_occurred_idx').on(t.occurredAt.desc()),
    // Feed filter: "has a linked media item".
    index('notifications_media_item_idx').on(t.mediaItemId),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationInsert = typeof notifications.$inferInsert;
