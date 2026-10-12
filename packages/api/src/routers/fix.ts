// DESIGN-005 D-17 — the fix router (ADR-007, R-43..R-47). `create` runs the full
// D-15 orchestration server-side through @hnet/domain's runFixRequest (pending row +
// event first, then blocklist-or-delete + search against the owning *arr); the rate
// limit (25/user/hour, R-47 — owner ruling 2026-07-15 raised 5 → 25) and open-fix dedupe
// live inside createFixRequest and surface here as TOO_MANY_REQUESTS / CONFLICT appCodes.
import { z } from 'zod';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  FIX_REASONS,
  FIX_STATUSES,
  REPAIR_GUIDE_REMEDIES,
  fixRequests,
  mediaItems,
  plexServers,
  users,
} from '@hnet/db';
import {
  anyRemedyOn,
  closeFixManually,
  computeFixProgress,
  computeSearchProgress,
  getKnownIssueServers,
  getRepairGuideRemedies,
  previewFix,
  readFileAudio,
  readPlaybackEvidence,
  readSeasonChoices,
  runFixRequest,
  runForceSearch,
  setKnownIssueServers,
  setRepairGuideRemedies,
} from '@hnet/domain';
import {
  authedProcedure,
  mapDomainErrors,
  resolveArrBundle,
  resolvePlaybackHistoryReaders,
  router,
} from '../trpc';
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

/**
 * ADR-109 / DESIGN-055 D-09 (PLAN-077 P1) — the Repair Guide's choices, carried by `preview` and `create`. Each is read
 * only while its remedy is on; the domain ignores the rest.
 */
const guideChoices = {
  /** Season guard: the episodes the person marked wrong. */
  episodeIds: z.array(z.number().int().positive()).min(1).max(500).optional(),
  /** Season guard: replace just this episode's file instead of blocking its pack. */
  replaceFile: z.boolean().optional(),
};

const languageCode = z
  .string()
  .trim()
  .regex(/^[a-zA-Z]{2,3}$/, { error: 'a two- or three-letter language code' });

export const fixRouter = router({
  /**
   * ADR-109 / DESIGN-055 D-01 — which Repair Guide remedies are on, for the Fix button to open the guide or today's
   * dialog. Read by every member (no secret in it).
   */
  guideConfig: authedProcedure.query(async ({ ctx }) => {
    const remedies = await getRepairGuideRemedies(ctx.db);
    return { remedies, guideOn: anyRemedyOn(remedies), knownIssueServers: await getKnownIssueServers(ctx.db) };
  }),

  /** DESIGN-055 D-01 — the admin read of the guide's settings, with every Plex server to choose from. */
  guideSettings: adminProcedure.query(async ({ ctx }) => {
    const servers = await ctx.db
      .select({ slug: plexServers.slug, name: plexServers.name })
      .from(plexServers)
      .orderBy(plexServers.name);
    return {
      remedies: await getRepairGuideRemedies(ctx.db),
      knownIssueServers: await getKnownIssueServers(ctx.db),
      servers,
    };
  }),

  /**
   * DESIGN-055 D-01 — turn remedies on or off, and name the Known-Issue Servers (T-314). Audited (`update_app_setting`,
   * the row and its audit in one transaction).
   */
  setGuideSettings: adminProcedure
    .input(
      z.object({
        remedies: z.partialRecord(z.enum(REPAIR_GUIDE_REMEDIES), z.boolean()).optional(),
        knownIssueServers: z.array(z.string().min(1).max(64)).max(10).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        if (input.remedies) {
          await setRepairGuideRemedies({ db: ctx.db, remedies: input.remedies, actorId: ctx.user.id });
        }
        if (input.knownIssueServers) {
          await setKnownIssueServers({ db: ctx.db, servers: input.knownIssueServers, actorId: ctx.user.id });
        }
        return {
          remedies: await getRepairGuideRemedies(ctx.db),
          knownIssueServers: await getKnownIssueServers(ctx.db),
        };
      });
    }),

  /**
   * ADR-109 C-03 / DESIGN-055 D-09 — the guarded Fix's plan, read-only: what it will mark, delete and search, the
   * Replacement Preview (a live release search when a file would be deleted), the pack it would cost. `plan: null` when
   * no planning remedy is on or the kind has none (Lidarr). The digest goes back with `create`.
   */
  preview: authedProcedure
    .input(
      z
        .object({
          mediaItemId: z.uuid(),
          scope: z.enum(ACTION_SCOPES).optional(),
          targetChildId: z.number().int().positive().optional(),
          seasonNumber: z.number().int().min(0).optional(),
          ...guideChoices,
        })
        .refine(refineScopeShape, { error: 'scope/target/season combination is invalid' }),
    )
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const plan = await previewFix({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          mediaItemId: input.mediaItemId,
          scope: input.scope,
          targetChildId: input.targetChildId,
          seasonNumber: input.seasonNumber,
          episodeIds: input.episodeIds,
          replaceFile: input.replaceFile,
          remedies: await getRepairGuideRemedies(ctx.db),
          requesterId: ctx.user.id,
          requesterIsAdmin: ctx.user.role.isAdmin,
        });
        return { plan };
      });
    }),

  /** DESIGN-055 D-09 — the season guard's list: each on-disk episode with the download behind it (no release search). */
  seasonChoices: authedProcedure
    .input(z.object({ mediaItemId: z.uuid(), seasonNumber: z.number().int().min(0) }))
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        readSeasonChoices({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          mediaItemId: input.mediaItemId,
          seasonNumber: input.seasonNumber,
        }),
      );
    }),

  /** DESIGN-055 D-08 rules 1-2 — the audio languages of the file(s) a Wrong language Fix would touch. */
  audioLanguages: authedProcedure
    .input(
      z
        .object({
          mediaItemId: z.uuid(),
          scope: z.enum(ACTION_SCOPES).optional(),
          targetChildId: z.number().int().positive().optional(),
          seasonNumber: z.number().int().min(0).optional(),
        })
        .refine(refineScopeShape, { error: 'scope/target/season combination is invalid' }),
    )
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        readFileAudio({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          mediaItemId: input.mediaItemId,
          scope: input.scope,
          targetChildId: input.targetChildId,
          seasonNumber: input.seasonNumber,
        }),
      );
    }),

  /**
   * DESIGN-055 D-09 / T-309 — Playback Evidence for the CALLER and this title over the last 48 hours: the stored
   * Tautulli play and stop webhooks plus each Tautulli instance's history. Only ever about the caller's own plays.
   */
  playbackEvidence: authedProcedure
    .input(z.object({ mediaItemId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        readPlaybackEvidence({
          db: ctx.db,
          mediaItemId: input.mediaItemId,
          requesterId: ctx.user.id,
          plexIdentity: ctx.user.plexIdentity,
          tautulli: resolvePlaybackHistoryReaders(ctx),
        }),
      );
    }),

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
          // ADR-109 / DESIGN-055 D-08, D-09 — the Repair Guide's choices (read only while their remedy is on).
          ...guideChoices,
          /** Season guard: block the whole pack, having seen the other episodes it costs. */
          blockWholePack: z.boolean().optional(),
          /** Language check: the audio language the person wanted. */
          wantedLanguage: languageCode.optional(),
          /** The digest of the plan the person confirmed (`preview`). */
          planDigest: z.string().regex(/^[0-9a-f]{8,64}$/).optional(),
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
          requesterIsAdmin: ctx.user.role.isAdmin,
          mediaItemId: input.mediaItemId,
          scope: input.scope,
          targetChildId: input.targetChildId,
          seasonNumber: input.seasonNumber,
          reason: input.reason,
          reasonText: input.reasonText,
          episodeIds: input.episodeIds,
          replaceFile: input.replaceFile,
          blockWholePack: input.blockWholePack,
          wantedLanguage: input.wantedLanguage,
          planDigest: input.planDigest,
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
          requesterIsAdmin: ctx.user.role.isAdmin,
          mediaItemId: input.mediaItemId,
          scope: input.scope,
          targetChildId: input.targetChildId,
          seasonNumber: input.seasonNumber,
        });
        return result; // {eventId, targetLabel, commandName}
      });
    }),

  /**
   * PLAN-015 / ADR-028 (R-106/R-107) — the LIVE Action Progress Phase for a Fix. A read-only
   * query the client polls (`refetchInterval` while a progress surface is mounted and the phase
   * is non-terminal). Derives the phase on demand from the fix row + a live *arr queue read + the
   * sync-ingested ledger milestones (no new state). Own-fix or admin only (else NOT_FOUND — the
   * domain enforces it, no leak). Errors via mapDomainErrors (ARR_UPSTREAM_UNAVAILABLE on a queue
   * read failure; the underlying Fix is unaffected — fail-closed to a transient phase, never a
   * false terminal).
   */
  progress: authedProcedure
    .input(z.object({ fixRequestId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        computeFixProgress({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          fixRequestId: input.fixRequestId,
          requesterId: ctx.user.id,
          requesterIsAdmin: ctx.user.role.isAdmin,
        }),
      );
    }),

  /**
   * PLAN-015 / ADR-028 — the LIVE Action Progress Phase for a Force Search. Force Search leaves
   * no fix_requests row, so this keys off the most recent `search_requested` ledger event for the
   * grain (reuse `refineScopeShape`). Same poll/derivation contract as `progress`; own-search or
   * admin only. Kept on the fix router (which already owns `forceSearch`) rather than a new
   * `search.*` router — one action surface, documented in DESIGN-005 D-20.
   */
  searchProgress: authedProcedure
    .input(
      z
        .object({
          mediaItemId: z.uuid(),
          scope: z.enum(ACTION_SCOPES).optional(),
          targetChildId: z.number().int().positive().optional(),
          seasonNumber: z.number().int().min(0).optional(),
        })
        .refine(refineScopeShape, { error: 'scope/target/season combination is invalid' }),
    )
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        computeSearchProgress({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          mediaItemId: input.mediaItemId,
          scope: input.scope,
          targetChildId: input.targetChildId,
          seasonNumber: input.seasonNumber,
          requesterId: ctx.user.id,
          requesterIsAdmin: ctx.user.role.isAdmin,
        }),
      );
    }),

  /**
   * Manual unblock — close a stuck OPEN fix to the terminal 'closed_manually' so it stops tripping
   * FixAlreadyOpenError on that target. Own-fix or admin (the domain enforces it: a non-owner sees
   * NOT_FOUND); an already-terminal fix surfaces as a CONFLICT/precondition error via mapDomainErrors.
   */
  close: authedProcedure
    .input(z.object({ fixRequestId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () =>
        closeFixManually({
          db: ctx.db,
          fixRequestId: input.fixRequestId,
          actorId: ctx.user.id,
          actorIsAdmin: ctx.user.role.isAdmin,
        }),
      );
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
