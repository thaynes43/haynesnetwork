import { pgView, uuid, text, integer, bigint, timestamp } from 'drizzle-orm/pg-core';
import type { ArrKind } from './enums';

/**
 * DESIGN-005 D-08 — Wanted = a view, not a table (DDD-001 T-27: a Wanted Item is
 * DERIVED — "a Monitored Media Item with nothing on disk"). Claims the DESIGN-001
 * D-15 reserved name `wanted_items`.
 *
 * Declared `.existing()`: the view DDL lives in migrations/0003_media_ledger.sql
 * (same resolution as effective_app_grants — DESIGN-001 Q-04 applies here too):
 *
 *   CREATE VIEW wanted_items AS
 *     SELECT id AS media_item_id, arr_kind, title, sort_title, year,
 *            expected_file_count, on_disk_file_count, size_on_disk, last_seen_at
 *       FROM media_items
 *      WHERE monitored
 *        AND deleted_from_arr_at IS NULL
 *        AND on_disk_file_count = 0;
 *
 * Partially-missing items (0 < on_disk < expected) are a ledger.search filter, not
 * this view; episode-level wanted browsing proxies the live *arr if ever needed (Q-05).
 */
export const wantedItems = pgView('wanted_items', {
  mediaItemId: uuid('media_item_id').notNull(),
  arrKind: text('arr_kind').$type<ArrKind>().notNull(),
  title: text('title').notNull(),
  sortTitle: text('sort_title').notNull(),
  year: integer('year'),
  expectedFileCount: integer('expected_file_count').notNull(),
  onDiskFileCount: integer('on_disk_file_count').notNull(),
  sizeOnDisk: bigint('size_on_disk', { mode: 'number' }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
}).existing();

// drizzle-orm 0.36 has no $inferSelect on views — keep the row shape by hand.
export interface WantedItemRow {
  mediaItemId: string;
  arrKind: ArrKind;
  title: string;
  sortTitle: string;
  year: number | null;
  expectedFileCount: number;
  onDiskFileCount: number;
  sizeOnDisk: number;
  lastSeenAt: Date;
}
