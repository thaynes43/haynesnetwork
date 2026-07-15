import { pgTable, uuid, text, integer, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { mediaItems } from './media-items';
import {
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  TICKET_TARGET_KINDS,
  type TicketCategory,
  type TicketStatus,
  type TicketTargetKind,
} from './enums';

const TICKET_STATUSES_SQL_LIST = TICKET_STATUSES.map((s) => `'${s}'`).join(',');
const TICKET_CATEGORIES_SQL_LIST = TICKET_CATEGORIES.map((c) => `'${c}'`).join(',');
const TICKET_TARGET_KINDS_SQL_LIST = TICKET_TARGET_KINDS.map((k) => `'${k}'`).join(',');

/**
 * ADR-050 / DESIGN-012 D-10 (PLAN-034 Helpdesk) — a household media-issue TICKET. Replaces the
 * ADR-026 Messages board (`messages` was dropped in migration 0040 — owner ruling Q-03: its rows
 * were test data). A ticket has a required title + intake category, an optional linked Media Item
 * (the poster-wall tile), a STATE MACHINE (`open → in_progress → complete | rejected`, rejected
 * re-openable — the matrix lives in @hnet/domain `TICKET_TRANSITIONS`), an append-only event
 * history (`ticket_events`) and a flat reply thread (`ticket_replies`). Tickets are
 * HOUSEHOLD-VISIBLE (Q-01): everyone with the Bulletin `messages` sub-view grant sees all of them.
 * A ticket never mutates media/*arr state — the structured Fix flow is unchanged and reachable
 * from the linked item. Written only by the @hnet/domain ticket single-writers (guard-listed).
 */
export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The issue summary — required (it is the wall tile's headline). */
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** The intake taxonomy (ADR-050 option D) — drives the icon tile for non-media tickets. */
    category: text('category').$type<TicketCategory>().notNull(),
    /** Optional link to a ledger Media Item (ON DELETE SET NULL — like the ledger/messages). */
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    /**
     * ADR-061 (PLAN-038) — the media LOCATOR: which level of the linked title's hierarchy this
     * ticket targets. NULL target_kind = the whole title (exactly the pre-locator meaning). The
     * *arr child id + human season/episode numbers ride along, and `target_label` SNAPSHOTS the
     * display label ("S06E02 · Rich") so the ticket renders forever without a live child read
     * (C-01/C-06). Consistency (kind ⇔ arr_kind) is enforced by the createTicket single-writer.
     */
    targetKind: text('target_kind').$type<TicketTargetKind>(),
    targetChildId: integer('target_child_id'),
    targetSeason: integer('target_season'),
    targetEpisode: integer('target_episode'),
    targetLabel: text('target_label'),
    status: text('status').$type<TicketStatus>().notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The wall's sort key — bumped (same tx) by every reply and transition, so the board surfaces
     * live conversations first. Equal to created_at until the first activity.
     */
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'tickets_status_enum',
      sql`${t.status} = ANY (ARRAY[${sql.raw(TICKET_STATUSES_SQL_LIST)}])`,
    ),
    check(
      'tickets_category_enum',
      sql`${t.category} = ANY (ARRAY[${sql.raw(TICKET_CATEGORIES_SQL_LIST)}])`,
    ),
    // ADR-061 — the locator kind (NULL = whole title).
    check(
      'tickets_target_kind_enum',
      sql`${t.targetKind} IS NULL OR ${t.targetKind} = ANY (ARRAY[${sql.raw(TICKET_TARGET_KINDS_SQL_LIST)}])`,
    ),
    // The wall reads most-recent-activity-first (the keyset sort column); status filters ride it.
    index('tickets_activity_idx').on(t.lastActivityAt.desc()),
    index('tickets_status_idx').on(t.status),
    index('tickets_author_idx').on(t.authorUserId),
    index('tickets_media_item_idx').on(t.mediaItemId),
  ],
);

/**
 * ADR-050 option F — the APPEND-ONLY ticket event history (the aggregate's own audit record, the
 * BC-03/BC-04 pattern). Creation writes the first row (`from_status` NULL → 'open') in the same tx
 * as the ticket insert, so the detail timeline always starts at "Filed"; every state transition
 * appends one row with the optional household-visible reason (`note`). Rows are never updated or
 * deleted. `actor_user_id` is SET NULL on account deletion — the history outlives the account.
 */
export const ticketEvents = pgTable(
  'ticket_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Null marks the CREATION event; otherwise the state the ticket left. */
    fromStatus: text('from_status').$type<TicketStatus>(),
    toStatus: text('to_status').$type<TicketStatus>().notNull(),
    /** The optional reason/comment carried by EVERY transition (requirement 5) — household-visible. */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'ticket_events_to_status_enum',
      sql`${t.toStatus} = ANY (ARRAY[${sql.raw(TICKET_STATUSES_SQL_LIST)}])`,
    ),
    check(
      'ticket_events_from_status_enum',
      sql`${t.fromStatus} IS NULL OR ${t.fromStatus} = ANY (ARRAY[${sql.raw(TICKET_STATUSES_SQL_LIST)}])`,
    ),
    // The detail timeline reads a ticket's events oldest-first.
    index('ticket_events_ticket_idx').on(t.ticketId, t.createdAt),
  ],
);

/**
 * ADR-050 — the flat reply THREAD on a ticket (GitHub-issue style; one level — "threaded replies"
 * per the owner means a conversation ON the ticket, not nesting). Open to ANY member with the
 * Bulletin `messages` sub-view grant (Q-02 — staff ask for info, the reporter answers, anyone may
 * chime in). Immutable v1 (no edit/delete — ADR-050 C-08). Bumps the ticket's last_activity_at in
 * the same tx.
 */
export const ticketReplies = pgTable(
  'ticket_replies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The detail thread reads a ticket's replies oldest-first.
    index('ticket_replies_ticket_idx').on(t.ticketId, t.createdAt),
  ],
);

export type TicketRow = typeof tickets.$inferSelect;
export type TicketInsert = typeof tickets.$inferInsert;
export type TicketEventRow = typeof ticketEvents.$inferSelect;
export type TicketEventInsert = typeof ticketEvents.$inferInsert;
export type TicketReplyRow = typeof ticketReplies.$inferSelect;
export type TicketReplyInsert = typeof ticketReplies.$inferInsert;
