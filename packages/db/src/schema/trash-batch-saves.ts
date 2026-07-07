import { pgTable, uuid, text, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { trashBatchItems } from './trash-batch-items';
import { TRASH_SAVE_ACTIONS, type TrashSaveAction } from './enums';

const TRASH_SAVE_ACTIONS_SQL_LIST = TRASH_SAVE_ACTIONS.map((a) => `'${a}'`).join(',');

/**
 * ADR-025 C-07 / DESIGN-011 — the durable save/unsave event log: one append-only row per flip (the
 * item row carries only the CURRENT holder; this is the full history). This is the rules-tuning
 * DATASET PLAN-014 reads (which items get rescued, by whom, in which phase) — a first-class record,
 * not incidental UI state. Every save also records the protective `trash_excluded` ledger event +
 * the Maintainerr exclusion (Q-03 permanent protection); this table is the analytics-shaped mirror.
 * Written ONLY by the @hnet/domain `setBatchItemSaved` single-writer (no-direct-state-writes guard).
 */
export const trashBatchSaves = pgTable(
  'trash_batch_saves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchItemId: uuid('batch_item_id')
      .notNull()
      .references(() => trashBatchItems.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').$type<TrashSaveAction>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'trash_batch_saves_action_enum',
      sql`${t.action} = ANY (ARRAY[${sql.raw(TRASH_SAVE_ACTIONS_SQL_LIST)}])`,
    ),
    index('trash_batch_saves_item_idx').on(t.batchItemId, t.createdAt.desc()),
  ],
);

export type TrashBatchSaveRow = typeof trashBatchSaves.$inferSelect;
export type TrashBatchSaveInsert = typeof trashBatchSaves.$inferInsert;
