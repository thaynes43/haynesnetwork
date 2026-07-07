import { pgTable, uuid, text, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { mediaItems } from './media-items';
import { MESSAGE_STATUSES, type MessageStatus } from './enums';

const MESSAGE_STATUSES_SQL_LIST = MESSAGE_STATUSES.map((s) => `'${s}'`).join(',');

/**
 * ADR-026 / DESIGN-012 D-01 — the Bulletin Messages board: user-posted durable board entries
 * (broken media / requests / general issues), optionally linked to a Media Item. Flat v1 — no
 * threads (`parent_message_id`), no reactions (deferred, Open Decision Q-02). COMPLEMENTS the
 * structured Fix flow; a Message never mutates media/*arr state (discussion only).
 *
 * Moderation is soft: `status` transitions between visible/hidden/deleted PRESERVE the row and its
 * content (the audit trail) — a status change never physically removes the body. The author may
 * edit their OWN visible message any time (`edited_at` set); a moderator may hide/delete/restore
 * ANY message (`moderated_by`/`moderated_at`/`moderation_note`). Written only by the @hnet/domain
 * message single-writers (guard-listed).
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    subject: text('subject'),
    body: text('body').notNull(),
    /** Optional best-effort link to a ledger Media Item (ON DELETE SET NULL — like the ledger). */
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    status: text('status').$type<MessageStatus>().notNull().default('visible'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the AUTHOR edits their own message (distinct from moderation). */
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /** Moderation trail: who last hid/deleted/restored this, when, and why. */
    moderatedBy: uuid('moderated_by').references(() => users.id, { onDelete: 'set null' }),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    moderationNote: text('moderation_note'),
  },
  (t) => [
    check(
      'messages_status_enum',
      sql`${t.status} = ANY (ARRAY[${sql.raw(MESSAGE_STATUSES_SQL_LIST)}])`,
    ),
    // The board reads newest-first (the keyset sort column); status filtered in the query.
    index('messages_created_idx').on(t.createdAt.desc()),
    // An author's own messages; a media item's discussion (the Fix cross-link surface).
    index('messages_author_idx').on(t.authorUserId),
    index('messages_media_item_idx').on(t.mediaItemId),
  ],
);

export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;
