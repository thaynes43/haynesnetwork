import { pgTable, uuid, timestamp } from 'drizzle-orm/pg-core';
import { mediaItems } from './media-items';
import { restoreRuns } from './restore-runs';
import { users } from './users';

/** ADR-121 / DESIGN-052 D-32 — a deliberate admin Restore, kept until admin revocation.
 * Written only by the restore-run and Restore Keep domain writers. The run is the durable
 * intent audit; revocation co-writes its ledger event in the same transaction. */
export const trashRestoreKeeps = pgTable('trash_restore_keeps', {
  mediaItemId: uuid('media_item_id')
    .primaryKey()
    .references(() => mediaItems.id, { onDelete: 'cascade' }),
  restoreRunId: uuid('restore_run_id')
    .notNull()
    .references(() => restoreRuns.id),
  restoredBy: uuid('restored_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
});
