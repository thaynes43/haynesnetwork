// DESIGN-005 D-17 — the fix router (ADR-007, R-43..R-47). `create` runs the full
// D-15 orchestration server-side through @hnet/domain's runFixRequest (pending row +
// event first, then blocklist-or-delete + search against the owning *arr); the rate
// limit (5/user/hour, R-47) and open-fix dedupe live inside createFixRequest and
// surface here as TOO_MANY_REQUESTS / CONFLICT appCodes.
import { z } from 'zod';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { FIX_REASONS, FIX_STATUSES, fixRequests, mediaItems, users } from '@hnet/db';
import { runFixRequest, runForceSearch } from '@hnet/domain';
import { authedProcedure, mapDomainErrors, resolveArrBundle, router } from '../trpc';
import { adminProcedure } from '../middleware/role';
import { decodeCursor, encodeCursor } from '../cursor';

const iso = (d: Date) => d.toISOString();

export const fixRouter = router({
  /**
   * R-43/R-44/R-45 — submit a Fix. Reason taxonomy is mandatory; free text rides
   * only on 'other' (zod refine here, D-09 CHECK as the backstop). Returns the
   * terminal-for-this-request state: search_triggered + the path taken.
   */
  create: authedProcedure
    .input(
      z
        .object({
          mediaItemId: z.uuid(),
          /** Episode id (sonarr) / album id (lidarr); required iff kind needs it (domain-validated). */
          targetChildId: z.number().int().positive().optional(),
          reason: z.enum(FIX_REASONS),
          reasonText: z.string().trim().min(1).max(500).optional(),
        })
        .refine((v) => (v.reason === 'other') === (v.reasonText !== undefined), {
          error: 'reasonText is required exactly when reason is "other"',
        }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const result = await runFixRequest({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          requesterId: ctx.user.id,
          requesterIsAdmin: ctx.user.role === 'Admin',
          mediaItemId: input.mediaItemId,
          targetChildId: input.targetChildId,
          reason: input.reason,
          reasonText: input.reasonText,
        });
        return result; // {id, status, pathTaken, targetLabel}
      });
    }),

  /**
   * D-17 — Force Search: the search-only action for MISSING content (not broken, just
   * missing). No reason, no blocklist, no delete — it records an audited
   * 'search_requested' ledger event and triggers ONLY the *arr search command, drawing
   * on the same hourly budget as `create` (rate limit / tombstone guards inside the
   * domain writer). Returns the accepted command + resolved target label.
   */
  forceSearch: authedProcedure
    .input(
      z.object({
        mediaItemId: z.uuid(),
        /** Episode id (sonarr) / album id (lidarr); absent = movie / whole-series search. */
        targetChildId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const result = await runForceSearch({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          requesterId: ctx.user.id,
          requesterIsAdmin: ctx.user.role === 'Admin',
          mediaItemId: input.mediaItemId,
          targetChildId: input.targetChildId,
        });
        return result; // {eventId, targetLabel, commandName}
      });
    }),

  /** R-46 — the caller's own fix history, newest first. */
  myFixes: authedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: fixRequests.id,
        itemTitle: mediaItems.title,
        itemArrKind: mediaItems.arrKind,
        mediaItemId: fixRequests.mediaItemId,
        targetLabel: fixRequests.targetLabel,
        reason: fixRequests.reason,
        reasonText: fixRequests.reasonText,
        status: fixRequests.status,
        pathTaken: fixRequests.pathTaken,
        createdAt: fixRequests.createdAt,
        updatedAt: fixRequests.updatedAt,
      })
      .from(fixRequests)
      .innerJoin(mediaItems, eq(mediaItems.id, fixRequests.mediaItemId))
      .where(eq(fixRequests.requesterId, ctx.user.id))
      .orderBy(desc(fixRequests.createdAt), desc(fixRequests.id))
      .limit(100);
    return rows.map((row) => ({
      id: row.id,
      item: { id: row.mediaItemId, title: row.itemTitle, arrKind: row.itemArrKind },
      targetLabel: row.targetLabel,
      reason: row.reason,
      reasonText: row.reasonText,
      status: row.status,
      pathTaken: row.pathTaken,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    }));
  }),

  /** R-46 — the admin queue: all rows + requester + raw actionsTaken (*arr responses). */
  adminList: adminProcedure
    .input(
      z.object({
        status: z.enum(FIX_STATUSES).optional(),
        requesterId: z.uuid().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: SQL[] = [];
      if (input.status) where.push(eq(fixRequests.status, input.status));
      if (input.requesterId) where.push(eq(fixRequests.requesterId, input.requesterId));
      if (input.cursor !== undefined) {
        const [millis, id] = decodeCursor(input.cursor, ['number', 'string']);
        where.push(
          sql`(${fixRequests.createdAt}, ${fixRequests.id}) < (${new Date(Number(millis))}, ${String(id)}::uuid)`,
        );
      }
      const rows = await ctx.db
        .select({
          id: fixRequests.id,
          requesterId: users.id,
          requesterDisplayName: users.displayName,
          mediaItemId: fixRequests.mediaItemId,
          itemTitle: mediaItems.title,
          itemArrKind: mediaItems.arrKind,
          targetLabel: fixRequests.targetLabel,
          reason: fixRequests.reason,
          reasonText: fixRequests.reasonText,
          status: fixRequests.status,
          pathTaken: fixRequests.pathTaken,
          actionsTaken: fixRequests.actionsTaken,
          createdAt: fixRequests.createdAt,
          updatedAt: fixRequests.updatedAt,
        })
        .from(fixRequests)
        .innerJoin(mediaItems, eq(mediaItems.id, fixRequests.mediaItemId))
        .leftJoin(users, eq(users.id, fixRequests.requesterId))
        .where(where.length > 0 ? and(...where) : undefined)
        .orderBy(desc(fixRequests.createdAt), desc(fixRequests.id))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({
          id: row.id,
          requester:
            row.requesterId === null
              ? null
              : { id: row.requesterId, displayName: row.requesterDisplayName },
          item: { id: row.mediaItemId, title: row.itemTitle, arrKind: row.itemArrKind },
          targetLabel: row.targetLabel,
          reason: row.reason,
          reasonText: row.reasonText,
          status: row.status,
          pathTaken: row.pathTaken,
          actionsTaken: row.actionsTaken,
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        })),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeCursor([last.createdAt.getTime(), last.id])
            : null,
      };
    }),
});
