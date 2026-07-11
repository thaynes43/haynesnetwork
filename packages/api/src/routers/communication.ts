// ADR-026 / ADR-050 / DESIGN-012 — the Communication hub tRPC surface. The Feed is a keyset-
// paginated read over the widened `notifications` store (the webhook receiver is a Next.js route
// handler, NOT tRPC); the HELPDESK (PLAN-034 — it replaced the Messages board) is the household
// media-issue ticket system over `tickets`/`ticket_events`/`ticket_replies`. Access is layered:
// the coarse `bulletin` section level gates READ, the `messages` sub-view grant gates the Helpdesk
// surface as a whole (browse/detail/REPLY — any member with the view may chime in, Q-02), and the
// fine-grained action grants gate create (`post`) and state transitions (`moderate` — staff only).
// All ticket mutations go through @hnet/domain single-writers wrapped in mapDomainErrors.
import { z } from 'zod';
import {
  fixRequests,
  mediaItems,
  mediaMetadata,
  notifications,
  tickets,
  ticketEvents,
  ticketReplies,
  users,
  NOTIFICATION_SOURCES,
  TICKET_CATEGORIES,
  TICKET_STATUSES,
} from '@hnet/db';
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { addTicketReply, createTicket, transitionTicket, OPEN_FIX_STATUSES } from '@hnet/domain';
import { mapDomainErrors, router } from '../trpc';
import { posterUrlFor } from '../ledger-query';
import { bulletinViewProcedure, messageActionProcedure } from '../middleware/role';
import { decodeKeysetCursor, encodeKeysetCursor, keysetAfter, keysetOrderBy } from '../keyset';

const iso = (d: Date) => d.toISOString();

export const communicationRouter = router({
  /**
   * ADR-026 D-05 — the Bulletin Feed: newest-first (by source event time) keyset browse over the
   * widened notification store, joined to the attributed user + linked Media Item. Simple param
   * filters (source, event type, media-link presence) — no full filter-engine port needed
   * backend-side (Open Decision Q-05). Read-Only and above (Disabled never reaches here).
   *
   * ADR-049 C-02 (PLAN-027) — additionally gated on the role's `feed` SUB-VIEW grant: a role
   * narrowed to messages-only (e.g. the owner's Default role) gets FORBIDDEN here, not an empty
   * list — server-authoritative, never a client-only hide.
   */
  feed: bulletinViewProcedure('feed')
    .input(
      z.object({
        source: z.enum(NOTIFICATION_SOURCES).optional(),
        eventType: z.string().trim().min(1).max(200).optional(),
        hasMedia: z.boolean().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: SQL[] = [];
      if (input.source) where.push(eq(notifications.source, input.source));
      if (input.eventType) where.push(eq(notifications.type, input.eventType));
      if (input.hasMedia === true) where.push(isNotNull(notifications.mediaItemId));
      if (input.hasMedia === false) where.push(isNull(notifications.mediaItemId));

      const sortExpr = sql`${notifications.occurredAt}`;
      const idCol = sql`${notifications.id}`;
      if (input.cursor !== undefined) {
        const { sortValue, id } = decodeKeysetCursor(input.cursor);
        where.push(
          keysetAfter({ expr: sortExpr, idCol, kind: 'date', dir: 'desc', value: sortValue, id }),
        );
      }

      const rows = await ctx.db
        .select({
          id: notifications.id,
          source: notifications.source,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          occurredAt: notifications.occurredAt,
          createdAt: notifications.createdAt,
          mediaItemId: notifications.mediaItemId,
          tmdbId: notifications.tmdbId,
          tvdbId: notifications.tvdbId,
          mediaTitle: mediaItems.title,
          mediaArrKind: mediaItems.arrKind,
          attributedUserId: notifications.actorUserId,
          attributedUserName: users.displayName,
        })
        .from(notifications)
        .leftJoin(users, eq(users.id, notifications.actorUserId))
        .leftJoin(mediaItems, eq(mediaItems.id, notifications.mediaItemId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(keysetOrderBy(sortExpr, 'desc', idCol))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => ({
          id: r.id,
          source: r.source,
          eventType: r.type,
          title: r.title,
          body: r.body,
          occurredAt: iso(r.occurredAt),
          recordedAt: iso(r.createdAt),
          mediaItemId: r.mediaItemId,
          mediaTitle: r.mediaTitle,
          mediaArrKind: r.mediaArrKind,
          tmdbId: r.tmdbId,
          tvdbId: r.tvdbId,
          attributedUserId: r.attributedUserId,
          attributedUserName: r.attributedUserName,
        })),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeKeysetCursor(iso(last.occurredAt), last.id)
            : null,
      };
    }),

  tickets: router({
    /**
     * ADR-050 / DESIGN-012 D-11 — the Helpdesk wall browse: most-recent-activity-first keyset over
     * ALL tickets (household visibility, Q-01 — no hidden rows; the old status-based moderator
     * filtering went with the board). Optional state/category filters (requirement 7). Every item
     * carries what a wall tile renders: title, category, status, author, the linked-media poster
     * facts, reply count, and the activity timestamps.
     */
    list: bulletinViewProcedure('messages')
      .input(
        z.object({
          status: z.enum(TICKET_STATUSES).optional(),
          category: z.enum(TICKET_CATEGORIES).optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(200).default(60),
        }),
      )
      .query(async ({ ctx, input }) => {
        const where: SQL[] = [];
        if (input.status) where.push(eq(tickets.status, input.status));
        if (input.category) where.push(eq(tickets.category, input.category));

        const sortExpr = sql`${tickets.lastActivityAt}`;
        const idCol = sql`${tickets.id}`;
        if (input.cursor !== undefined) {
          const { sortValue, id } = decodeKeysetCursor(input.cursor);
          where.push(
            keysetAfter({ expr: sortExpr, idCol, kind: 'date', dir: 'desc', value: sortValue, id }),
          );
        }

        const rows = await ctx.db
          .select({
            id: tickets.id,
            title: tickets.title,
            category: tickets.category,
            status: tickets.status,
            authorUserId: tickets.authorUserId,
            authorName: users.displayName,
            mediaItemId: tickets.mediaItemId,
            mediaTitle: mediaItems.title,
            mediaArrKind: mediaItems.arrKind,
            mediaYear: mediaItems.year,
            posterSource: mediaMetadata.posterSource,
            createdAt: tickets.createdAt,
            lastActivityAt: tickets.lastActivityAt,
          })
          .from(tickets)
          .leftJoin(users, eq(users.id, tickets.authorUserId))
          .leftJoin(mediaItems, eq(mediaItems.id, tickets.mediaItemId))
          .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, tickets.mediaItemId))
          .where(where.length ? and(...where) : undefined)
          .orderBy(keysetOrderBy(sortExpr, 'desc', idCol))
          .limit(input.limit + 1);

        const page = rows.slice(0, input.limit);
        const last = page[page.length - 1];

        // Batched reply counts for JUST the page (the fix-hint pattern) — one grouped pass.
        const pageIds = page.map((r) => r.id);
        const replyCounts = new Map<string, number>();
        if (pageIds.length > 0) {
          const countRows = await ctx.db
            .select({
              ticketId: ticketReplies.ticketId,
              n: sql<number>`count(*)::int`,
            })
            .from(ticketReplies)
            .where(inArray(ticketReplies.ticketId, pageIds))
            .groupBy(ticketReplies.ticketId);
          for (const c of countRows) replyCounts.set(c.ticketId, c.n);
        }

        return {
          items: page.map((r) => ({
            id: r.id,
            title: r.title,
            category: r.category,
            status: r.status,
            authorUserId: r.authorUserId,
            authorName: r.authorName,
            mediaItemId: r.mediaItemId,
            mediaTitle: r.mediaTitle,
            mediaArrKind: r.mediaArrKind,
            mediaYear: r.mediaYear,
            // null poster ⇒ the tile renders the CATEGORY icon (never a broken <img>) — same
            // authed-proxy contract as the Library grid (ADR-019 posterUrlFor).
            mediaPosterUrl:
              r.mediaItemId !== null ? posterUrlFor(r.mediaItemId, r.posterSource) : null,
            replyCount: replyCounts.get(r.id) ?? 0,
            createdAt: iso(r.createdAt),
            lastActivityAt: iso(r.lastActivityAt),
          })),
          nextCursor:
            rows.length > input.limit && last !== undefined
              ? encodeKeysetCursor(iso(last.lastActivityAt), last.id)
              : null,
        };
      }),

    /**
     * ADR-050 / DESIGN-012 D-12 — the per-state totals the filter chips bake in ("Open · 3").
     * One grouped pass; absent states are 0.
     */
    counts: bulletinViewProcedure('messages').query(async ({ ctx }) => {
      const rows = await ctx.db
        .select({ status: tickets.status, n: sql<number>`count(*)::int` })
        .from(tickets)
        .groupBy(tickets.status);
      const counts: Record<(typeof TICKET_STATUSES)[number], number> = {
        open: 0,
        in_progress: 0,
        complete: 0,
        rejected: 0,
      };
      for (const r of rows) counts[r.status] = r.n;
      return counts;
    }),

    /**
     * ADR-050 / DESIGN-012 D-12 — the ticket drill-in (the movie-detail idiom): the ticket, its
     * full append-only event timeline (creation + every transition, with actor names and the
     * household-visible notes), the flat reply thread, the linked-media facts, and the static
     * repair cue for the linked title (openFix/fixCount — the item page owns the live phases,
     * ADR-028). Household-visible to every caller with the `messages` sub-view (Q-01); an unknown
     * id is found:false (the ytdlsub.detail contract), never a throw the client must special-case.
     */
    detail: bulletinViewProcedure('messages')
      .input(z.object({ ticketId: z.uuid() }))
      .query(async ({ ctx, input }) => {
        const [row] = await ctx.db
          .select({
            id: tickets.id,
            title: tickets.title,
            body: tickets.body,
            category: tickets.category,
            status: tickets.status,
            authorUserId: tickets.authorUserId,
            authorName: users.displayName,
            mediaItemId: tickets.mediaItemId,
            mediaTitle: mediaItems.title,
            mediaArrKind: mediaItems.arrKind,
            mediaYear: mediaItems.year,
            posterSource: mediaMetadata.posterSource,
            createdAt: tickets.createdAt,
            lastActivityAt: tickets.lastActivityAt,
          })
          .from(tickets)
          .leftJoin(users, eq(users.id, tickets.authorUserId))
          .leftJoin(mediaItems, eq(mediaItems.id, tickets.mediaItemId))
          .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, tickets.mediaItemId))
          .where(eq(tickets.id, input.ticketId))
          .limit(1);
        if (!row) return { found: false as const };

        const events = await ctx.db
          .select({
            id: ticketEvents.id,
            actorUserId: ticketEvents.actorUserId,
            actorName: users.displayName,
            fromStatus: ticketEvents.fromStatus,
            toStatus: ticketEvents.toStatus,
            note: ticketEvents.note,
            createdAt: ticketEvents.createdAt,
          })
          .from(ticketEvents)
          .leftJoin(users, eq(users.id, ticketEvents.actorUserId))
          .where(eq(ticketEvents.ticketId, input.ticketId))
          .orderBy(asc(ticketEvents.createdAt), asc(ticketEvents.id));

        const replies = await ctx.db
          .select({
            id: ticketReplies.id,
            authorUserId: ticketReplies.authorUserId,
            authorName: users.displayName,
            body: ticketReplies.body,
            createdAt: ticketReplies.createdAt,
          })
          .from(ticketReplies)
          .leftJoin(users, eq(users.id, ticketReplies.authorUserId))
          .where(eq(ticketReplies.ticketId, input.ticketId))
          .orderBy(asc(ticketReplies.createdAt), asc(ticketReplies.id));

        // The static repair cue for the linked title (the board's pattern kept: a HINT, not a
        // live view — the item page owns the live fix phases).
        let openFix = false;
        let fixCount = 0;
        if (row.mediaItemId !== null) {
          const [hint] = await ctx.db
            .select({
              fixCount: sql<number>`count(*)::int`,
              openCount: sql<number>`(count(*) filter (where ${inArray(fixRequests.status, [
                ...OPEN_FIX_STATUSES,
              ])}))::int`,
            })
            .from(fixRequests)
            .where(eq(fixRequests.mediaItemId, row.mediaItemId));
          fixCount = hint?.fixCount ?? 0;
          openFix = (hint?.openCount ?? 0) > 0;
        }

        return {
          found: true as const,
          ticket: {
            id: row.id,
            title: row.title,
            body: row.body,
            category: row.category,
            status: row.status,
            authorUserId: row.authorUserId,
            authorName: row.authorName,
            mediaItemId: row.mediaItemId,
            mediaTitle: row.mediaTitle,
            mediaArrKind: row.mediaArrKind,
            mediaYear: row.mediaYear,
            mediaPosterUrl:
              row.mediaItemId !== null ? posterUrlFor(row.mediaItemId, row.posterSource) : null,
            openFix,
            fixCount,
            createdAt: iso(row.createdAt),
            lastActivityAt: iso(row.lastActivityAt),
          },
          events: events.map((e) => ({
            id: e.id,
            actorUserId: e.actorUserId,
            actorName: e.actorName,
            fromStatus: e.fromStatus,
            toStatus: e.toStatus,
            note: e.note,
            createdAt: iso(e.createdAt),
          })),
          replies: replies.map((r) => ({
            id: r.id,
            authorUserId: r.authorUserId,
            authorName: r.authorName,
            body: r.body,
            createdAt: iso(r.createdAt),
          })),
        };
      }),

    /**
     * ADR-050 D-11 — file a ticket (the `post` grant). The domain writer inserts the ticket, its
     * creation event, AND the admins' `ticket_created` Pushover outbox row in ONE tx (Q-04).
     */
    create: messageActionProcedure('post')
      .input(
        z.object({
          title: z.string().trim().min(1).max(200),
          body: z.string().trim().min(1).max(8_000),
          category: z.enum(TICKET_CATEGORIES),
          mediaItemId: z.uuid().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(async () => {
          const row = await createTicket({
            db: ctx.db,
            authorId: ctx.user.id,
            title: input.title,
            body: input.body,
            category: input.category,
            mediaItemId: input.mediaItemId ?? null,
          });
          return { id: row.id, status: row.status };
        });
      }),

    /**
     * ADR-050 D-11 — reply on a ticket's thread. Deliberately the `messages` SUB-VIEW gate, NOT a
     * message action: any household member who can see the board may chime in (owner ruling Q-02).
     */
    reply: bulletinViewProcedure('messages')
      .input(
        z.object({
          ticketId: z.uuid(),
          body: z.string().trim().min(1).max(8_000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(async () => {
          const row = await addTicketReply({
            db: ctx.db,
            ticketId: input.ticketId,
            authorId: ctx.user.id,
            body: input.body,
          });
          return { id: row.id, createdAt: iso(row.createdAt) };
        });
      }),

    /**
     * ADR-050 D-11 — drive a ticket's state (the `moderate` grant — STAFF ONLY, Q-02; members
     * never transition, not even their own tickets). Every transition may carry an optional
     * household-visible note (requirement 5); an illegal edge is a CONFLICT
     * (TICKET_INVALID_TRANSITION), enforced by the domain matrix under a row lock.
     */
    transition: messageActionProcedure('moderate')
      .input(
        z.object({
          ticketId: z.uuid(),
          toStatus: z.enum(TICKET_STATUSES),
          note: z.string().trim().max(1_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(async () => {
          const { ticket, event } = await transitionTicket({
            db: ctx.db,
            ticketId: input.ticketId,
            actorId: ctx.user.id,
            toStatus: input.toStatus,
            note: input.note ?? null,
          });
          return { id: ticket.id, status: ticket.status, eventId: event.id };
        });
      }),
  }),
});
