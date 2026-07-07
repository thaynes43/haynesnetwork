import { pgTable, uuid, text, timestamp, jsonb, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { NOTIFICATION_SOURCES, type NotificationSource } from './enums';

const NOTIFICATION_SOURCES_SQL_LIST = NOTIFICATION_SOURCES.map((s) => `'${s}'`).join(',');

/**
 * ADR-023 / DESIGN-010 D-07 (addendum c) — the generic in-app notification store. PLAN-006 ships
 * this as the MINIMAL receiver that PLAN-009 (Bulletin) extends: a `POST /api/webhooks/<source>`
 * receiver persists an event here, and Trash's "Activity" tab reads it filtered to
 * `source='maintainerr'`. Deliberately source-agnostic (NOT a Maintainerr-specific table) so 009
 * only adds Seerr/Tautulli adapters. Written only by the @hnet/domain `recordNotification`
 * single-writer (guard-listed). `read_at` is nullable — a future "mark read" flips it.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').$type<NotificationSource>().notNull(),
    /** Source-specific event type (e.g. Maintainerr's notification `type` — free text). */
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** The raw source payload, sanitized to a plain object (audit / future reprocessing). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'notifications_source_enum',
      sql`${t.source} = ANY (ARRAY[${sql.raw(NOTIFICATION_SOURCES_SQL_LIST)}])`,
    ),
    // The Activity feed reads newest-first, scoped by source.
    index('notifications_source_created_idx').on(t.source, t.createdAt.desc()),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
export type NotificationInsert = typeof notifications.$inferInsert;
