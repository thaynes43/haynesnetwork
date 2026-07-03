import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mediaItems } from './media-items';
import { users } from './users';
import {
  LEDGER_EVENT_TYPES,
  LEDGER_EVENT_SOURCES,
  type LedgerEventType,
  type LedgerEventSource,
} from './enums';

const EVENT_TYPES_SQL_LIST = LEDGER_EVENT_TYPES.map((t) => `'${t}'`).join(',');
const EVENT_SOURCES_SQL_LIST = LEDGER_EVENT_SOURCES.map((s) => `'${s}'`).join(',');

/**
 * DESIGN-005 D-07 — the append-only media event ledger (R-40/R-41): normalized *arr
 * history, Seerr request attribution, Fix lifecycle markers, and Restore write-backs.
 * Written only by the packages/domain writers (D-12).
 *
 * - `media_item_id` is nullable: a Seerr request can precede the *arr add; sync
 *   backfills the FK when the item appears (matched by tmdb/tvdb id kept in payload).
 * - The partial unique index on (source, source_event_id) makes re-ingestion of
 *   overlapping history polls idempotent (ON CONFLICT DO NOTHING).
 * - Item-level removals are not *arr history events; the tombstone pass writes a
 *   'deleted' event with payload.kind = 'item_removed' (vs 'file_deleted').
 */
export const ledgerEvents = pgTable(
  'ledger_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'cascade' }),
    eventType: text('event_type').$type<LedgerEventType>().notNull(),
    source: text('source').$type<LedgerEventSource>().notNull(),
    sourceEventId: text('source_event_id'), // *arr history id / Seerr request id — dedupe key
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(), // source timestamp
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }), // resolved app user for 'requested' events (D-14); null = unattributed (ADR-008 C-05)
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    // sanitized source record + normalized bits: rawEventType, sourceTitle, quality,
    // indexer, releaseGroup, downloadId, child target {episodeId|albumId, label},
    // external ids, Seerr requestedBy {plexUsername, email}, fixRequestId, …
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'ledger_events_event_type_enum',
      sql`${t.eventType} = ANY (ARRAY[${sql.raw(EVENT_TYPES_SQL_LIST)}])`,
    ),
    check(
      'ledger_events_source_enum',
      sql`${t.source} = ANY (ARRAY[${sql.raw(EVENT_SOURCES_SQL_LIST)}])`,
    ),
    // idempotent re-ingestion: overlapping history polls upsert-skip on conflict
    uniqueIndex('ledger_events_source_event_unique')
      .on(t.source, t.sourceEventId)
      .where(sql`${t.sourceEventId} IS NOT NULL`),
    index('ledger_events_item_occurred_idx').on(t.mediaItemId, t.occurredAt.desc()),
    index('ledger_events_type_occurred_idx').on(t.eventType, t.occurredAt.desc()),
  ],
);

export type LedgerEventRow = typeof ledgerEvents.$inferSelect;
export type LedgerEventInsert = typeof ledgerEvents.$inferInsert;
