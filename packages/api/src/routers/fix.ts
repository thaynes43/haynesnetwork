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

// media-hierarchy actions: the roll-up scopes a Fix / Force Search may target. The wire
// accepts the full set for both; the DOMAIN writers do the authoritative per-kind
// validation (Fix rejects whole-show/artist as Force-Search-only, D-15 → FIX_TARGET_
// REQUIRED) — these zod checks are only a light front-line shape guard.
const ACTION_SCOPES = ['item', 'show', 'season', 'episode', 'artist', 'album'] as const;

/** season ⇒ seasonNumber required + no child; episode/album ⇒ child required. */
function refineScopeShape(v: {
  scope?: string;
  targetChildId?: number;
  seasonNumber?: number;
}): boolean {
  if (v.scope === 'season') return v.seasonNumber !== undefined && v.targetChildId === undefined;
  if (v.seasonNumber !== undefined) return false; // seasonNumber rides only on 'season'
  if (v.scope === 'episode' || v.scope === 'album') return v.targetChildId !== undefined;
  return true;
}

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
          /**
           * The roll-up scope (media-hierarchy actions). Omitted ⇒ legacy default
           * (radarr item / sonarr episode / lidarr album). 'season' repairs a whole
           * sonarr season; whole-show/artist are Force-Search-only (use forceSearch).
           */
          scope: z.enum(ACTION_SCOPES).optional(),
          /** Episode id (sonarr) / album id (lidarr); required iff kind needs it (domain-validated). */
          targetChildId: z.number().int().positive().optional(),
          /** Sonarr season number — for scope 'season'. */
          seasonNumber: z.number().int().min(0).optional(),
          reason: z.enum(FIX_REASONS),
          reasonText: z.string().trim().min(1).max(500).optional(),
        })
        .refine((v) => (v.reason === 'other') === (v.reasonText !== undefined), {
          error: 'reasonText is required exactly when reason is "other"',
        })
        .refine(refineScopeShape, { error: 'scope/target/season combination is invalid' }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const result = await runFixRequest({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          requesterId: ctx.user.id,
          requesterIsAdmin: ctx.user.role === 'Admin',
          mediaItemId: input.mediaItemId,
          scope: input.scope,
          targetChildId: input.targetChildId,
          seasonNumber: input.seasonNumber,
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
      z
        .object({
          mediaItemId: z.uuid(),
          /**
           * The roll-up scope (media-hierarchy actions). Omitted ⇒ legacy default
           * (radarr movie / sonarr whole-series when no child; else episode). 'season'
           * / 'show' / 'artist' add the roll-up searches above the child level.
           */
          scope: z.enum(ACTION_SCOPES).optional(),
          /** Episode id (sonarr) / album id (lidarr); for scope episode/album. */
          targetChildId: z.number().int().positive().optional(),
          /** Sonarr season number — for scope 'season'. */
          seasonNumber: z.number().int().min(0).optional(),
        })
        .refine(refineScopeShape, { error: 'scope/target/season combination is invalid' }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const result = await runForceSearch({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          requesterId: ctx.user.id,
          requesterIsAdmin: ctx.user.role === 'Admin',
          mediaItemId: input.mediaItemId,
          scope: input.scope,
          targetChildId: input.targetChildId,
          seasonNumber: input.seasonNumber,
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
