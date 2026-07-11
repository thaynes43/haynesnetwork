import {
  mediaItems,
  tickets,
  ticketEvents,
  ticketReplies,
  users,
  type DbClient,
  type TicketEventRow,
  type TicketReplyRow,
  type TicketRow,
  type TicketCategory,
  type TicketStatus,
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import { InvalidTicketTransitionError, NotFoundError } from './errors';
import { inTransaction, resolveDb } from './db-client';
import { enqueueOutbox } from './notify-outbox';
import { computeEarliestSend, getNotifyWindow } from './notify-window';

/**
 * ADR-050 / DESIGN-012 D-10..D-13 (PLAN-034 Helpdesk) — the ticket single-writers. A Ticket is a
 * household media-issue report with a STATE MACHINE, an append-only event history and a flat reply
 * thread; it replaces the ADR-026 Messages board. A ticket never mutates media/*arr state (the
 * structured Fix flow is unchanged — the linked media item is a reference, never a write).
 * Guard-listed: `tickets` / `ticket_events` / `ticket_replies` are written only through this module
 * (defence in depth beneath the API permission gates).
 */

/**
 * ADR-050 — THE transition matrix (requirement 5). `open ⇄ in_progress` moves freely (staff pick a
 * ticket up / put it back); either may close to `complete` or `rejected` (a duplicate/GitHub-bound
 * report needn't fake triage first). `complete` is TERMINAL — a recurrence is a new ticket, the
 * history stays honest. `rejected` RE-OPENS to `open` (the analog of the old hide/restore).
 * Self-transitions are absent by construction. `transitionTicket` enforces exactly this map; the
 * domain test proves the full 4×4 matrix.
 */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ['in_progress', 'complete', 'rejected'],
  in_progress: ['open', 'complete', 'rejected'],
  complete: [],
  rejected: ['open'],
};

/** Whether `from → to` is a legal ticket transition (ADR-050 state machine). */
export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

async function assertMediaItemExists(
  db: ReturnType<typeof resolveDb>,
  mediaItemId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId))
    .limit(1);
  if (!row) throw new NotFoundError(`Media item ${mediaItemId} not found`);
}

export interface CreateTicketInput {
  db?: DbClient;
  authorId: string;
  title: string;
  body: string;
  category: TicketCategory;
  mediaItemId?: string | null;
  now?: Date;
}

/**
 * File a new ticket (the `post` grant). In ONE transaction: insert the ticket, append its CREATION
 * event (`from_status` null → open, actor = author — the detail timeline's "Filed" entry), and
 * enqueue the admins' `ticket_created` Pushover ping (ADR-034 C-01 — the outbox row commits with
 * the ticket or not at all; Q-04). The notify window is read BEFORE the transaction opens (the
 * batch-writer pattern — a stale-by-seconds window read is harmless; the write stays atomic).
 */
export async function createTicket(input: CreateTicketInput): Promise<TicketRow> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  if (input.mediaItemId) await assertMediaItemExists(db, input.mediaItemId);
  const window = await getNotifyWindow(input.db);
  const earliestSendAt = computeEarliestSend(now, window);

  return inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .insert(tickets)
      .values({
        authorUserId: input.authorId,
        title: input.title,
        body: input.body,
        category: input.category,
        mediaItemId: input.mediaItemId ?? null,
        status: 'open',
        createdAt: now,
        lastActivityAt: now,
      })
      .returning();
    if (!row) throw new Error('ticket insert returned no row');

    await tx.insert(ticketEvents).values({
      ticketId: row.id,
      actorUserId: input.authorId,
      fromStatus: null,
      toStatus: 'open',
      note: null,
      createdAt: now,
    });

    // The ping's display facts, resolved inside the tx (reads are fine; the writes stay atomic).
    const [author] = await tx
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, input.authorId))
      .limit(1);
    let mediaTitle: string | null = null;
    if (row.mediaItemId !== null) {
      const [media] = await tx
        .select({ title: mediaItems.title })
        .from(mediaItems)
        .where(eq(mediaItems.id, row.mediaItemId))
        .limit(1);
      mediaTitle = media?.title ?? null;
    }
    await enqueueOutbox(tx, {
      eventType: 'ticket_created',
      payload: {
        ticketId: row.id,
        title: row.title,
        category: row.category,
        authorName: author?.displayName ?? null,
        mediaTitle,
      },
      earliestSendAt,
    });

    return row;
  });
}

export interface TransitionTicketInput {
  db?: DbClient;
  ticketId: string;
  actorId: string;
  toStatus: TicketStatus;
  /** The optional household-visible reason/comment EVERY transition may carry (requirement 5). */
  note?: string | null;
  now?: Date;
}

export interface TransitionTicketResult {
  ticket: TicketRow;
  event: TicketEventRow;
}

/**
 * Drive a ticket's state (the `moderate` grant — staff only, Q-02). Validates the edge against
 * TICKET_TRANSITIONS under a row lock (an illegal edge — incl. self-transitions and anything out
 * of `complete` — throws InvalidTicketTransitionError BEFORE any write), then updates the status,
 * bumps `last_activity_at`, and appends the ticket_events history row — all in one transaction.
 */
export async function transitionTicket(
  input: TransitionTicketInput,
): Promise<TransitionTicketResult> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select({ id: tickets.id, status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, input.ticketId))
      .for('update');
    if (!existing) throw new NotFoundError(`Ticket ${input.ticketId} not found`);
    if (!canTransitionTicket(existing.status, input.toStatus)) {
      throw new InvalidTicketTransitionError(
        `A ticket cannot move ${existing.status} → ${input.toStatus}.`,
      );
    }
    const [ticket] = await tx
      .update(tickets)
      .set({ status: input.toStatus, lastActivityAt: now })
      .where(eq(tickets.id, input.ticketId))
      .returning();
    if (!ticket) throw new Error('ticket transition returned no row');
    const [event] = await tx
      .insert(ticketEvents)
      .values({
        ticketId: ticket.id,
        actorUserId: input.actorId,
        fromStatus: existing.status,
        toStatus: input.toStatus,
        note: input.note ?? null,
        createdAt: now,
      })
      .returning();
    if (!event) throw new Error('ticket event insert returned no row');
    return { ticket, event };
  });
}

export interface AddTicketReplyInput {
  db?: DbClient;
  ticketId: string;
  authorId: string;
  body: string;
  now?: Date;
}

/**
 * Reply on a ticket's thread — open to ANY member with the Bulletin `messages` sub-view grant
 * (Q-02; NOT gated on `post`/`moderate` — staff ask for info, the reporter answers, anyone may
 * chime in). Closed tickets stay open for conversation (GitHub-issue style). Inserts the reply and
 * bumps the ticket's `last_activity_at` in one transaction so the wall surfaces live threads.
 */
export async function addTicketReply(input: AddTicketReplyInput): Promise<TicketReplyRow> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.id, input.ticketId))
      .for('update');
    if (!existing) throw new NotFoundError(`Ticket ${input.ticketId} not found`);
    const [reply] = await tx
      .insert(ticketReplies)
      .values({
        ticketId: input.ticketId,
        authorUserId: input.authorId,
        body: input.body,
        createdAt: now,
      })
      .returning();
    if (!reply) throw new Error('ticket reply insert returned no row');
    await tx
      .update(tickets)
      .set({ lastActivityAt: now })
      .where(eq(tickets.id, input.ticketId));
    return reply;
  });
}
