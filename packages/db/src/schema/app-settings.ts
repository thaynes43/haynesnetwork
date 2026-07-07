import { pgTable, text, jsonb, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuid } from 'drizzle-orm/pg-core';
import { users } from './users';
import { APP_SETTING_KEYS, type AppSettingKey } from './enums';

const APP_SETTING_KEYS_SQL_LIST = APP_SETTING_KEYS.map((k) => `'${k}'`).join(',');

/**
 * ADR-025 C-06 — the generic, audited app-settings store (Q-06). One row per known key
 * (`key` is the PK, CHECK-constrained to APP_SETTING_KEYS); `value` is jsonb so a key can hold a
 * bool / int / object. Written ONLY by the @hnet/domain `setAppSetting` single-writer, which
 * co-writes an `update_app_setting` permission_audit row in the SAME transaction (CLAUDE.md hard
 * rule 6) — so `updated_by`/`updated_at` here plus that audit row are the durable trail. Absent key
 * ⇒ the caller's documented default (APP_SETTING_DEFAULTS in @hnet/domain). First consumers: the
 * Trash skip-gate + the default save-window; PLAN-010/013/014 reuse the same table.
 */
export const appSettings = pgTable(
  'app_settings',
  {
    key: text('key').$type<AppSettingKey>().primaryKey(),
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    check(
      'app_settings_key_enum',
      sql`${t.key} = ANY (ARRAY[${sql.raw(APP_SETTING_KEYS_SQL_LIST)}])`,
    ),
  ],
);

export type AppSettingRow = typeof appSettings.$inferSelect;
export type AppSettingInsert = typeof appSettings.$inferInsert;
