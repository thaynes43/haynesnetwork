import { pgTable, uuid, timestamp,
  text,
  integer,
  unique,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mediaItems } from './media-items';
import { restoreRuns } from './restore-runs';
import { users } from './users';

/** ADR-121 / D-32: the external title owns its keep; the ledger link is disposable. */
export const trashRestoreKeeps = pgTable('trash_restore_keeps', {
    id: uuid('id').primaryKey().defaultRandom(),
    arrKind: text('arr_kind').$type<'radarr' | 'sonarr'>().notNull(),
    externalId: integer('external_id').notNull(),
    title: text('title').notNull(),
    mediaItemId: uuid('media_item_id')
    .references(() => mediaItems.id, { onDelete: 'set null' }),
  restoreRunId: uuid('restore_run_id')
    .notNull()
    .references(() => restoreRuns.id),
  restoredBy: uuid('restored_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
},
  (t) => [
    unique('trash_restore_keep_identity').on(t.arrKind, t.externalId),
    check('trash_restore_keep_kind', sql`${t.arrKind} IN ('radarr', 'sonarr')`),
    check('trash_restore_keep_external', sql`${t.externalId} > 0`),
  ],
);

/** Durable deletion intent, committed before the handle. An uncertain call remains held. */
export const trashTitleDeleteClaims = pgTable(
  'trash_title_delete_claims',
  {
    arrKind: text('arr_kind').$type<'radarr' | 'sonarr'>().notNull(),
    externalId: integer('external_id').notNull(),
    claimId: uuid('claim_id').notNull().defaultRandom(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.arrKind, t.externalId] }),
    check('trash_delete_claim_kind', sql`${t.arrKind} IN ('radarr', 'sonarr')`),
    check('trash_delete_claim_external', sql`${t.externalId} > 0`),
  ],
);
