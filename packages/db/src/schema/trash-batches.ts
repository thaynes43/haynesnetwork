import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  check,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import {
  TRASH_MEDIA_KINDS,
  TRASH_BATCH_STATES,
  TRASH_BATCH_OPEN_STATES,
  type TrashMediaKind,
  type TrashBatchState,
} from './enums';

const TRASH_MEDIA_KINDS_SQL_LIST = TRASH_MEDIA_KINDS.map((k) => `'${k}'`).join(',');
const TRASH_BATCH_STATES_SQL_LIST = TRASH_BATCH_STATES.map((s) => `'${s}'`).join(',');
const TRASH_BATCH_OPEN_STATES_SQL_LIST = TRASH_BATCH_OPEN_STATES.map((s) => `'${s}'`).join(',');

/**
 * ADR-025 / DESIGN-011 — a curation BATCH: the deletion unit. A snapshot of the current pending set
 * for one media kind (never mixed) that an admin curates (poster review), green-lights into a Plex
 * "Leaving Soon" collection, and a windowed sweep then deletes one item at a time (every ADR-023
 * safety layer re-applied at sweep time). Written ONLY by the @hnet/domain trash-batches
 * single-writers (the no-direct-state-writes guard covers it); every status change appends a
 * `trash_batch_transition` ledger event in the same transaction.
 *
 * INVARIANT (C-01): only `leaving_soon` expires, and it is reached ONLY by `greenlightBatch` OR the
 * audited skip-gate path (`gate_skipped = true`) — so a batch never deletes without the admin gate.
 * At most one OPEN (non-terminal) batch per media kind (the partial unique index below).
 */
export const trashBatches = pgTable(
  'trash_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mediaKind: text('media_kind').$type<TrashMediaKind>().notNull(),
    state: text('state').$type<TrashBatchState>().notNull().default('draft'),
    /** The save-window length copied from `trash_default_window_days` at green-light (Q-10). */
    windowDays: integer('window_days').notNull().default(21),
    /** true ⇒ the audited skip-gate promoted this batch straight to `leaving_soon` (draft→leaving_soon),
     *  distinguishing it from a human green-light in the audit trail (C-01). */
    gateSkipped: boolean('gate_skipped').notNull().default(false),
    greenlitAt: timestamp('greenlit_at', { withTimezone: true }),
    greenlitBy: uuid('greenlit_by').references(() => users.id, { onDelete: 'set null' }),
    /** now() + window_days, set at green-light; the sweep acts only on batches past this. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** The Maintainerr "Leaving Soon" collection id this batch drives (Q-05/Q-09); null until green-light. */
    maintainerrCollectionId: integer('maintainerr_collection_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'trash_batches_media_kind_enum',
      sql`${t.mediaKind} = ANY (ARRAY[${sql.raw(TRASH_MEDIA_KINDS_SQL_LIST)}])`,
    ),
    check(
      'trash_batches_state_enum',
      sql`${t.state} = ANY (ARRAY[${sql.raw(TRASH_BATCH_STATES_SQL_LIST)}])`,
    ),
    // At most one OPEN (draft|admin_review|leaving_soon) batch per media kind (Q-01) — enforced at
    // the DB so a race can never open a second live batch for a kind.
    uniqueIndex('trash_batches_one_open_per_kind')
      .on(t.mediaKind)
      .where(sql`${t.state} = ANY (ARRAY[${sql.raw(TRASH_BATCH_OPEN_STATES_SQL_LIST)}])`),
    index('trash_batches_state_idx').on(t.state, t.createdAt.desc()),
  ],
);

export type TrashBatchRow = typeof trashBatches.$inferSelect;
export type TrashBatchInsert = typeof trashBatches.$inferInsert;
