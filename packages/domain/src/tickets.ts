import {
  mediaItems,
  notificationPreferences,
  tickets,
  ticketEvents,
  ticketReplies,
  users,
  type CollectionOverridePayload,
  type DbClient,
  type TicketEventRow,
  type TicketReplyRow,
  type TicketRow,
  type TicketCategory,
  type TicketStatus,
  type TicketTargetKind,
} from '@hnet/db';
import { and, desc, eq } from 'drizzle-orm';
import { InvalidTicketTargetError, InvalidTicketTransitionError, NotFoundError } from './errors';
import { inTransaction, resolveDb } from './db-client';
import { enqueueOutbox } from './notify-outbox';
import { computeEarliestSend, getNotifyWindow } from './notify-window';
import { materializeCollection } from './collections-manager';
import type { LibrettoClientBundle } from './libretto-clients';
import type { LibrettoRecipeDraft } from '@hnet/libretto';

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
): Promise<{ arrKind: string }> {
  const [row] = await db
    .select({ id: mediaItems.id, arrKind: mediaItems.arrKind })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId))
    .limit(1);
  if (!row) throw new NotFoundError(`Media item ${mediaItemId} not found`);
  return { arrKind: row.arrKind };
}

/**
 * ADR-061 / DESIGN-032 D-03 (PLAN-038) — the ticket media LOCATOR the compose drill files:
 * which level of the linked title's hierarchy the ticket targets. `label` is the SNAPSHOTTED
 * display string (C-01/C-06). Kind must match the linked item's *arr (validated in createTicket).
 */
export interface TicketTargetInput {
  kind: TicketTargetKind;
  /** sonarr episodeId / lidarr albumId / lidarr trackId; null for a season scope. */
  childId?: number | null;
  season?: number | null;
  episode?: number | null;
  label: string;
}

const TARGET_KIND_ARR: Record<TicketTargetKind, 'sonarr' | 'lidarr'> = {
  season: 'sonarr',
  episode: 'sonarr',
  album: 'lidarr',
  track: 'lidarr',
};

/**
 * ADR-060 C-04 / R-195 (PLAN-035) — the admin mailbox the ticket-created email goes to.
 * Env-configured (`TICKET_ADMIN_EMAIL`), defaulting to the owner's stated address.
 */
export function ticketAdminEmail(env: Record<string, string | undefined> = process.env): string {
  return env.TICKET_ADMIN_EMAIL?.trim() || 'admin@haynesnetwork.com';
}

/**
 * DESIGN-031 D-02 — the ticket AUTHOR's email, ONLY when they opted into ticket-update emails
 * (R-196; `notification_preferences.email_ticket_updates`). Read inside the mutation's tx so the
 * gate is transactionally consistent with the enqueue. Null ⇒ no email row.
 */
async function optedInAuthorEmail(
  tx: { select: DbClient['select'] },
  authorUserId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({
      email: users.email,
      optedIn: notificationPreferences.emailTicketUpdates,
    })
    .from(users)
    .leftJoin(notificationPreferences, eq(notificationPreferences.userId, users.id))
    .where(eq(users.id, authorUserId))
    .limit(1);
  return row?.optedIn === true && row.email ? row.email : null;
}

export interface CreateTicketInput {
  db?: DbClient;
  authorId: string;
  title: string;
  body: string;
  category: TicketCategory;
  mediaItemId?: string | null;
  /** ADR-061 — the optional locator; requires mediaItemId and a kind legal for its *arr. */
  target?: TicketTargetInput | null;
  now?: Date;
  /** R-195 — the admin recipient override (tests); defaults to `ticketAdminEmail()`. */
  adminEmail?: string;
  /**
   * ADR-072 / DESIGN-043 D-11 — the over-cap collection request's full definition (only for a
   * `collection_override` ticket; null otherwise). Stored on the ticket so Approve can materialize it.
   */
  collectionOverridePayload?: CollectionOverridePayload | null;
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
  let arrKind: string | null = null;
  if (input.mediaItemId) arrKind = (await assertMediaItemExists(db, input.mediaItemId)).arrKind;
  // ADR-061 D-03 — locator consistency: requires a media link; kind must match the item's *arr;
  // an episode locator needs its numbers; a leaf locator needs its child id. Season scope is
  // (kind='season', season=N, no child id). Whole-title = no target at all (unchanged).
  if (input.target) {
    if (!input.mediaItemId || arrKind === null)
      throw new InvalidTicketTargetError('a ticket target requires a linked media item');
    if (TARGET_KIND_ARR[input.target.kind] !== arrKind)
      throw new InvalidTicketTargetError(
        `target kind '${input.target.kind}' is not valid for a ${arrKind} item`,
      );
    if (input.target.kind === 'season' && input.target.season == null)
      throw new InvalidTicketTargetError('a season target needs its season number');
    if (input.target.kind !== 'season' && input.target.childId == null)
      throw new InvalidTicketTargetError(`a ${input.target.kind} target needs its child id`);
    if (input.target.label.trim() === '')
      throw new InvalidTicketTargetError('a target needs its display label');
  }
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
        targetKind: input.target?.kind ?? null,
        targetChildId: input.target?.childId ?? null,
        targetSeason: input.target?.season ?? null,
        targetEpisode: input.target?.episode ?? null,
        targetLabel: input.target?.label ?? null,
        status: 'open',
        collectionOverridePayload: input.collectionOverridePayload ?? null,
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
        targetLabel: input.target?.label ?? null,
      },
      earliestSendAt,
    });

    // R-195 (ADR-060 / DESIGN-031 D-02) — the UNCONDITIONAL admin email, same tx, same facts. The
    // recipient rides payload.to (resolved here, at enqueue time — ADR-060 C-02).
    await enqueueOutbox(tx, {
      channel: 'email',
      eventType: 'ticket_created',
      payload: {
        to: input.adminEmail ?? ticketAdminEmail(),
        ticketId: row.id,
        title: row.title,
        category: row.category,
        authorName: author?.displayName ?? null,
        mediaTitle,
        targetLabel: input.target?.label ?? null,
      },
      earliestSendAt,
    });

    return row;
  });
}

/** ADR-072 / DESIGN-043 D-11 — the structured facts an over-cap collection override request carries. */
export interface CollectionOverrideTicketInput {
  db?: DbClient;
  /** The requesting user — the ticket author. */
  authorId: string;
  /** The live cap the size breached. */
  cap: number;
  /**
   * The FULL requested collection definition (builder + ref + target + variables + size + provider +
   * media type). Stored on the ticket (`collection_override_payload`) so an admin Approve materializes it.
   */
  payload: CollectionOverridePayload;
  now?: Date;
  /** R-195 — the admin recipient override (tests). */
  adminEmail?: string;
}

/**
 * ADR-072 / DESIGN-043 D-11 — file an over-cap `collection_override` request that CARRIES the full requested
 * collection definition. A thin wrapper over `createTicket` (category `collection_override`) so the request
 * rides the SAME ADR-050 helpdesk board + its atomic `ticket_created` outbox ping + admin email — no second
 * queue (Q-05: it is an ordinary ticket, visible in both the Helpdesk and the /collections Tickets lens).
 * The definition rides `collection_override_payload` (not just the prose body) so an admin's one-click
 * Approve can materialize it unbounded (approveCollectionOverride). The ticket + its creation event + the
 * outbox rows commit in ONE tx (the createTicket single-writer; hard rule 6).
 */
export async function createCollectionOverrideTicket(
  input: CollectionOverrideTicketInput,
): Promise<TicketRow> {
  const p = input.payload;
  const body = [
    `A collection exceeds the size cap and needs an admin to approve a larger bound.`,
    ``,
    `- Collection: ${p.name}`,
    `- Media: ${p.mediaType}`,
    `- Provider: ${p.provider}`,
    `- Builder: ${p.builderType} (${p.builderRef})`,
    `- Requested membership: ${p.size} items`,
    `- Current cap: ${input.cap} items`,
    ``,
    `Approve to create this collection at its full size, or decline with a reason.`,
  ].join('\n');
  return createTicket({
    db: input.db,
    authorId: input.authorId,
    title: `Collection request: ${p.name}`,
    body,
    category: 'collection_override',
    collectionOverridePayload: p,
    now: input.now,
    adminEmail: input.adminEmail,
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
  // R-196 — the (possible) author email rides the same window discipline as every outbox row:
  // window read BEFORE the tx opens (the batch-writer pattern).
  const window = await getNotifyWindow(input.db);
  const earliestSendAt = computeEarliestSend(now, window);
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select({ id: tickets.id, status: tickets.status, authorUserId: tickets.authorUserId })
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

    // R-196 (ADR-060 / DESIGN-031 D-02) — email the ticket AUTHOR on a status change, only when
    // opted in and NOT for their own action. Same tx as the transition (ADR-034 C-01).
    if (existing.authorUserId !== null && existing.authorUserId !== input.actorId) {
      const to = await optedInAuthorEmail(tx, existing.authorUserId);
      if (to !== null) {
        const [actor] = await tx
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, input.actorId))
          .limit(1);
        await enqueueOutbox(tx, {
          channel: 'email',
          eventType: 'ticket_status_changed',
          payload: {
            to,
            ticketId: ticket.id,
            title: ticket.title,
            fromStatus: existing.status,
            toStatus: input.toStatus,
            actorName: actor?.displayName ?? null,
            note: input.note ?? null,
          },
          earliestSendAt,
        });
      }
    }
    return { ticket, event };
  });
}

/** An over-cap ticket action hit a ticket that is not an open/in_progress `collection_override`. */
export class CollectionOverrideNotActionableError extends Error {
  readonly code = 'COLLECTION_OVERRIDE_NOT_ACTIONABLE' as const;
  constructor(message: string) {
    super(message);
  }
}

/** Reconstruct the confined-writer draft from a stored over-cap payload (acquisition forced OFF — D-11). */
function draftFromOverridePayload(payload: CollectionOverridePayload): LibrettoRecipeDraft {
  return {
    id: payload.recipeId,
    ...(payload.name ? { name: payload.name } : {}),
    builder: { type: payload.builderType, ref: payload.builderRef },
    ...(payload.targetLibrary ? { targetLibrary: payload.targetLibrary } : {}),
    variables: {
      ...(payload.syncMode ? { syncMode: payload.syncMode } : {}),
      ...(payload.ordered !== undefined ? { ordered: payload.ordered } : {}),
      acquisitionEnabled: false,
    },
    enabled: true,
  };
}

/** Read a ticket by id (null when absent) — the over-cap approve/decline reads its payload + status. */
async function getTicketById(db?: DbClient, ticketId?: string): Promise<TicketRow | null> {
  const [row] = await resolveDb(db)
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId!))
    .limit(1);
  return row ?? null;
}

/**
 * ADR-072 / DESIGN-043 D-11 — an admin's one-click APPROVE of an over-cap `collection_override` ticket:
 * materialize the collection UNBOUNDED (the confined writer, cap-bypassed) straight from the ticket's
 * stored payload, THEN transition the ticket to `complete` with a household-visible note. The external
 * materialization lands BEFORE the same-tx transition (the crash-safe idempotent-PUT idiom: a crash between
 * them re-PUTs the recipe cleanly on retry, and the ticket is still open to retry). The transition +
 * ticket_events history row commit in ONE tx (transitionTicket — hard rule 6). Only a Libretto (books /
 * audiobooks) payload materializes directly in PR4a; a Kometa payload is the PR4b human-merged path.
 */
export async function approveCollectionOverride(input: {
  db?: DbClient;
  libretto: LibrettoClientBundle;
  ticketId: string;
  actorId: string;
  now?: Date;
}): Promise<TransitionTicketResult> {
  const ticket = await getTicketById(input.db, input.ticketId);
  if (!ticket) throw new NotFoundError(`Ticket ${input.ticketId} not found`);
  const payload = ticket.collectionOverridePayload;
  if (ticket.category !== 'collection_override' || !payload) {
    throw new CollectionOverrideNotActionableError('This ticket does not carry a collection request.');
  }
  if (ticket.status === 'complete' || ticket.status === 'rejected') {
    throw new CollectionOverrideNotActionableError('This request has already been decided.');
  }
  // Materialize (external, unbounded) BEFORE the same-tx completion. Kometa (movies/TV) is PR4b's
  // human-merged path — PR4a only files Libretto payloads, so nothing else can reach here.
  await materializeCollection({ libretto: input.libretto, draft: draftFromOverridePayload(payload) });
  return transitionTicket({
    db: input.db,
    ticketId: input.ticketId,
    actorId: input.actorId,
    toStatus: 'complete',
    note: `Collection approved and created at ${payload.size} items.`,
    now: input.now,
  });
}

/**
 * ADR-072 / DESIGN-043 D-11 — DECLINE an over-cap `collection_override` ticket with a reason. Materializes
 * nothing; transitions the ticket to `rejected` carrying the household-visible reason (transitionTicket —
 * ticket_events + the author's opted-in email, one tx).
 */
export async function declineCollectionOverride(input: {
  db?: DbClient;
  ticketId: string;
  actorId: string;
  reason: string;
  now?: Date;
}): Promise<TransitionTicketResult> {
  const ticket = await getTicketById(input.db, input.ticketId);
  if (!ticket) throw new NotFoundError(`Ticket ${input.ticketId} not found`);
  if (ticket.category !== 'collection_override' || !ticket.collectionOverridePayload) {
    throw new CollectionOverrideNotActionableError('This ticket does not carry a collection request.');
  }
  if (ticket.status === 'complete' || ticket.status === 'rejected') {
    throw new CollectionOverrideNotActionableError('This request has already been decided.');
  }
  return transitionTicket({
    db: input.db,
    ticketId: input.ticketId,
    actorId: input.actorId,
    toStatus: 'rejected',
    note: input.reason,
    now: input.now,
  });
}

/**
 * ADR-072 / DESIGN-043 D-11 — the caller's OWN over-cap requests (the /collections Tickets sub-section,
 * requester lens) or, for an admin, all open ones (the approve lens). Category-filtered to
 * `collection_override`; newest-activity-first. Payload rides along so the admin approve view can show what
 * would be created.
 */
export async function listCollectionOverrideTickets(input: {
  db?: DbClient;
  /** Filter to this author (the requester lens); omit for the admin's all-requests lens. */
  authorId?: string;
  limit?: number;
}): Promise<Array<TicketRow & { authorName: string | null }>> {
  const db = resolveDb(input.db);
  const conds = [eq(tickets.category, 'collection_override' as TicketCategory)];
  if (input.authorId !== undefined) conds.push(eq(tickets.authorUserId, input.authorId));
  // The requester's display name rides along (the admin approve lens shows who asked — the
  // communication.ts authorName idiom); a vanished user degrades to null, never an error.
  const rows = await db
    .select({ ticket: tickets, authorName: users.displayName })
    .from(tickets)
    .leftJoin(users, eq(users.id, tickets.authorUserId))
    .where(conds.length === 1 ? conds[0] : and(...conds))
    .orderBy(desc(tickets.lastActivityAt))
    .limit(input.limit ?? 100);
  return rows.map((r) => ({ ...r.ticket, authorName: r.authorName ?? null }));
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
  // R-196 — window read before the tx (see transitionTicket).
  const window = await getNotifyWindow(input.db);
  const earliestSendAt = computeEarliestSend(now, window);
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select({ id: tickets.id, title: tickets.title, authorUserId: tickets.authorUserId })
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

    // R-196 (ADR-060 / DESIGN-031 D-02) — email the ticket AUTHOR on a reply, only when opted in
    // and the reply is SOMEONE ELSE's. Same tx as the reply insert (ADR-034 C-01).
    if (existing.authorUserId !== null && existing.authorUserId !== input.authorId) {
      const to = await optedInAuthorEmail(tx, existing.authorUserId);
      if (to !== null) {
        const [replyAuthor] = await tx
          .select({ displayName: users.displayName })
          .from(users)
          .where(eq(users.id, input.authorId))
          .limit(1);
        await enqueueOutbox(tx, {
          channel: 'email',
          eventType: 'ticket_replied',
          payload: {
            to,
            ticketId: existing.id,
            title: existing.title,
            replyAuthorName: replyAuthor?.displayName ?? null,
            snippet: input.body.slice(0, 200),
          },
          earliestSendAt,
        });
      }
    }
    return reply;
  });
}
