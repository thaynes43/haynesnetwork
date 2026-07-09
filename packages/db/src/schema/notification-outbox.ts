import { pgTable, uuid, text, integer, timestamp, jsonb, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  NOTIFY_OUTBOX_CHANNELS,
  NOTIFY_OUTBOX_EVENT_TYPES,
  type NotifyOutboxChannel,
  type NotifyOutboxEventType,
} from './enums';

const NOTIFY_OUTBOX_CHANNELS_SQL_LIST = NOTIFY_OUTBOX_CHANNELS.map((c) => `'${c}'`).join(',');
const NOTIFY_OUTBOX_EVENT_TYPES_SQL_LIST = NOTIFY_OUTBOX_EVENT_TYPES.map((e) => `'${e}'`).join(',');

/**
 * ADR-034 / DESIGN-015 (PLAN-016) — the TRANSACTIONAL OUTBOX for Pushover batch-lifecycle pushes
 * (migration 0024). A batch writer enqueues a row here in the SAME transaction as its state
 * transition (`enqueueOutbox`, guard-listed single-writer), so a push can neither be lost (mutation
 * committed, ping dropped) nor phantom (ping sent, mutation rolled back). The `notify-outbox` sync
 * mode drains DUE rows — `sent_at IS NULL AND attempts < 5 AND earliest_send_at <= now()` — to
 * `api.pushover.net`, setting `sent_at` on success or incrementing `attempts` + recording
 * `last_error` + pushing `earliest_send_at` out on a backoff (parked at 5). `earliest_send_at` is
 * computed at ENQUEUE against the owner's `notify_window` (T-101), so "quiet hours" are DATA, not a
 * resident timer. DISTINCT from the `notifications` store (ADR-026 — that is the inbound in-app feed;
 * this is the outbound push queue).
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Delivery channel — 'pushover' today; the column leaves room for a future channel. */
    channel: text('channel').$type<NotifyOutboxChannel>().notNull().default('pushover'),
    /** The batch-lifecycle moment (the sender renders title/message/url per type). */
    eventType: text('event_type').$type<NotifyOutboxEventType>().notNull(),
    /** The structured facts the sender renders from: { batchId, mediaKind, itemCount, … }. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The earliest instant this row may be delivered — the delivery window applied at enqueue. */
    earliestSendAt: timestamp('earliest_send_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null ⇒ undelivered; set to now() on a successful Pushover POST. */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** Delivery attempts; a row is PARKED (excluded from the due scan) once this reaches 5. */
    attempts: integer('attempts').notNull().default(0),
    /** The last delivery failure message (for diagnosis); null while never-failed. */
    lastError: text('last_error'),
  },
  (t) => [
    check(
      'notification_outbox_channel_enum',
      sql`${t.channel} = ANY (ARRAY[${sql.raw(NOTIFY_OUTBOX_CHANNELS_SQL_LIST)}])`,
    ),
    check(
      'notification_outbox_event_type_enum',
      sql`${t.eventType} = ANY (ARRAY[${sql.raw(NOTIFY_OUTBOX_EVENT_TYPES_SQL_LIST)}])`,
    ),
    // The drainer's scan: due, not-yet-sent rows oldest-first (partial — sent rows drop out).
    index('notification_outbox_due_idx')
      .on(t.earliestSendAt)
      .where(sql`${t.sentAt} IS NULL`),
  ],
);

export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type NotificationOutboxInsert = typeof notificationOutbox.$inferInsert;
