import { pgTable, uuid, text, integer, bigint, index } from 'drizzle-orm/pg-core';

/**
 * DESIGN-002 D-14 (amended 2026-07-28) — Better Auth's rate-limit bucket store, moved
 * off per-replica memory into shared Postgres so N replicas enforce ONE combined limit
 * (saga haynesnetwork-ha plan 05). Wired by `rateLimit.storage: 'database'` in
 * `@hnet/auth` config.ts.
 *
 * Shape is better-auth 1.6.23's `get-tables` default for the `rateLimit` model
 * (@better-auth/core/db/get-tables.ts): field property keys MUST be `key` / `count` /
 * `lastRequest` — the drizzle adapter indexes the table by the better-auth FIELD name
 * (getFieldName → schemaModel[field]), not the SQL column name — and the drizzle adapter
 * schema map MUST key this table under the model name `rateLimit` (config.ts). `id` is a
 * uuid to match the other Better Auth tables under `advanced.database.generateId: 'uuid'`.
 * `lastRequest` is an epoch-millisecond stamp (better-auth `bigint: true`, `Date.now()`);
 * the runtime reads it back as a number and the pruner scans it, hence the index.
 */
export const rateLimit = pgTable(
  'rate_limit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull().unique(),
    count: integer('count').notNull(),
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (table) => [index('rate_limit_last_request_idx').on(table.lastRequest)],
);

export type RateLimitRow = typeof rateLimit.$inferSelect;
export type RateLimitInsert = typeof rateLimit.$inferInsert;
