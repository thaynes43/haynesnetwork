// ADR-026 / DESIGN-012 (PLAN-009 Bulletin) — the Communication hub tRPC surface. The Feed is a
// keyset-paginated read over the widened `notifications` store (the webhook receiver is a Next.js
// route handler, NOT tRPC); Messages is user-driven CRUD + moderation over the `messages` board.
// Access is layered: the coarse `bulletin` section level gates READ (Feed + Messages browse), the
// fine-grained post/moderate grants gate the write actions (messageActionProcedure). All message
// mutations go through @hnet/domain single-writers wrapped in mapDomainErrors.
import { z } from 'zod';
import {
  mediaItems,
  messages,
  notifications,
  users,
  MESSAGE_STATUSES,
  NOTIFICATION_SOURCES,
} from '@hnet/db';
import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { editMessage, moderateMessage, postMessage } from '@hnet/domain';
import { mapDomainErrors, router } from '../trpc';
import { hasMessageAction, messageActionProcedure, sectionProcedure } from '../middleware/role';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetAfter,
  keysetOrderBy,
  type KeysetValue,
} from '../keyset';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());

export const communicationRouter = router({
  /**
   * ADR-026 D-05 — the Bulletin Feed: newest-first (by source event time) keyset browse over the
   * widened notification store, joined to the attributed user + linked Media Item. Simple param
   * filters (source, event type, media-link presence) — no full filter-engine port needed
   * backend-side (Open Decision Q-05). Read-Only and above (Disabled never reaches here).
   */
  feed: sectionProcedure('bulletin', 'read_only')
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
        where.push(keysetAfter({ expr: sortExpr, idCol, kind: 'date', dir: 'desc', value: sortValue, id }));
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

  messages: router({
    /**
     * ADR-026 D-06 — the Messages board browse (newest-first keyset). Everyone with Read-Only sees
     * `visible` messages; a caller with the `moderate` grant additionally sees hidden/deleted rows
     * (for triage/audit) and may filter by status. Content of soft-hidden/deleted rows is preserved.
     */
    list: sectionProcedure('bulletin', 'read_only')
      .input(
        z.object({
          status: z.enum(MESSAGE_STATUSES).optional(),
          mediaItemId: z.uuid().optional(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(200).default(50),
        }),
      )
      .query(async ({ ctx, input }) => {
        const canModerate = hasMessageAction(ctx.user.role, 'moderate');
        const where: SQL[] = [];
        if (canModerate) {
          if (input.status) where.push(eq(messages.status, input.status));
        } else {
          // Non-moderators only ever see visible messages (status filter ignored — never leaks).
          where.push(eq(messages.status, 'visible'));
        }
        if (input.mediaItemId) where.push(eq(messages.mediaItemId, input.mediaItemId));

        const sortExpr = sql`${messages.createdAt}`;
        const idCol = sql`${messages.id}`;
        if (input.cursor !== undefined) {
          const { sortValue, id } = decodeKeysetCursor(input.cursor);
          where.push(keysetAfter({ expr: sortExpr, idCol, kind: 'date', dir: 'desc', value: sortValue, id }));
        }

        const rows = await ctx.db
          .select({
            id: messages.id,
            authorUserId: messages.authorUserId,
            authorName: users.displayName,
            subject: messages.subject,
            body: messages.body,
            mediaItemId: messages.mediaItemId,
            mediaTitle: mediaItems.title,
            mediaArrKind: mediaItems.arrKind,
            status: messages.status,
            createdAt: messages.createdAt,
            editedAt: messages.editedAt,
            moderatedBy: messages.moderatedBy,
            moderatedAt: messages.moderatedAt,
            moderationNote: messages.moderationNote,
          })
          .from(messages)
          .leftJoin(users, eq(users.id, messages.authorUserId))
          .leftJoin(mediaItems, eq(mediaItems.id, messages.mediaItemId))
          .where(where.length ? and(...where) : undefined)
          .orderBy(keysetOrderBy(sortExpr, 'desc', idCol))
          .limit(input.limit + 1);

        const page = rows.slice(0, input.limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => ({
            id: r.id,
            authorUserId: r.authorUserId,
            authorName: r.authorName,
            subject: r.subject,
            body: r.body,
            mediaItemId: r.mediaItemId,
            mediaTitle: r.mediaTitle,
            mediaArrKind: r.mediaArrKind,
            status: r.status,
            createdAt: iso(r.createdAt),
            editedAt: isoOrNull(r.editedAt),
            // Moderation trail exposed only to moderators (never leak who hid/deleted to members).
            moderatedBy: canModerate ? r.moderatedBy : null,
            moderatedAt: canModerate ? isoOrNull(r.moderatedAt) : null,
            moderationNote: canModerate ? r.moderationNote : null,
          })),
          nextCursor:
            rows.length > input.limit && last !== undefined
              ? encodeKeysetCursor(iso(last.createdAt), last.id)
              : null,
        };
      }),

    /** ADR-026 D-06 — post a new Message (the `post` grant). Optional subject + media-item link. */
    post: messageActionProcedure('post')
      .input(
        z.object({
          subject: z.string().trim().max(200).optional(),
          body: z.string().trim().min(1).max(8_000),
          mediaItemId: z.uuid().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(async () => {
          const row = await postMessage({
            db: ctx.db,
            authorId: ctx.user.id,
            subject: input.subject ?? null,
            body: input.body,
            mediaItemId: input.mediaItemId ?? null,
          });
          return { id: row.id, status: row.status };
        });
      }),

    /** ADR-026 D-06 — edit one's OWN Message (the `post` grant; domain enforces ownership). */
    edit: messageActionProcedure('post')
      .input(
        z.object({
          messageId: z.uuid(),
          subject: z.string().trim().max(200).optional(),
          body: z.string().trim().min(1).max(8_000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(async () => {
          const row = await editMessage({
            db: ctx.db,
            messageId: input.messageId,
            editorId: ctx.user.id,
            subject: input.subject ?? null,
            body: input.body,
          });
          return { id: row.id, editedAt: isoOrNull(row.editedAt) };
        });
      }),

    /**
     * ADR-026 D-06 — moderate ANY Message (the `moderate` grant): hide / delete (soft — content
     * preserved) / restore (→ visible). Records the moderation trail in the same tx. The UX uses a
     * ConfirmButton for destructive transitions (ADR-014); this is the server-authoritative gate.
     */
    moderate: messageActionProcedure('moderate')
      .input(
        z.object({
          messageId: z.uuid(),
          status: z.enum(MESSAGE_STATUSES),
          note: z.string().trim().max(500).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        return mapDomainErrors(async () => {
          const row = await moderateMessage({
            db: ctx.db,
            messageId: input.messageId,
            moderatorId: ctx.user.id,
            status: input.status,
            note: input.note ?? null,
          });
          return { id: row.id, status: row.status, moderatedAt: isoOrNull(row.moderatedAt) };
        });
      }),
  }),
});
