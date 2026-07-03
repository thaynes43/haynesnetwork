// DESIGN-005 D-17 — the ledger router (R-42/R-43: browse/search is a Member feature).
// Reads project media_items/ledger_events/wanted_items directly (reads are unguarded);
// `children` is the D-06 LIVE proxy through the @hnet/domain arr bundle. Cursor
// pagination throughout (the documented D-17 deviation from DESIGN-003 D-03).
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { ARR_KINDS, fixRequests, ledgerEvents, mediaItems, users, wantedItems } from '@hnet/db';
import { listMediaChildren } from '@hnet/domain';
import { authedProcedure, mapDomainErrors, resolveArrBundle, router } from '../trpc';
import { decodeCursor, encodeCursor } from '../cursor';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());

/** Escape LIKE wildcards in user-typed search text. */
const escapeLike = (q: string) => q.replace(/[\\%_]/g, '\\$&');

const ON_DISK_FILTERS = ['any', 'complete', 'partial', 'none'] as const;

export const ledgerRouter = router({
  /** R-43 — search/browse with filters; keyset-paginated by (sort_title, id). */
  search: authedProcedure
    .input(
      z.object({
        query: z.string().trim().max(200).optional(),
        arrKind: z.enum(ARR_KINDS).optional(),
        onDisk: z.enum(ON_DISK_FILTERS).default('any'),
        /** true ⇒ narrow to the D-08 wanted view semantics (monitored, nothing on disk). */
        wanted: z.boolean().optional(),
        includeTombstoned: z.boolean().default(false),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: SQL[] = [];
      if (input.query) {
        const escaped = escapeLike(input.query);
        where.push(
          or(ilike(mediaItems.title, `%${escaped}%`), ilike(mediaItems.sortTitle, `${escaped}%`))!,
        );
      }
      if (input.arrKind) where.push(eq(mediaItems.arrKind, input.arrKind));
      if (input.onDisk === 'complete') {
        where.push(
          sql`${mediaItems.onDiskFileCount} > 0 AND ${mediaItems.onDiskFileCount} >= ${mediaItems.expectedFileCount}`,
        );
      } else if (input.onDisk === 'partial') {
        where.push(
          sql`${mediaItems.onDiskFileCount} > 0 AND ${mediaItems.onDiskFileCount} < ${mediaItems.expectedFileCount}`,
        );
      } else if (input.onDisk === 'none') {
        where.push(eq(mediaItems.onDiskFileCount, 0));
      }
      if (input.wanted === true) {
        where.push(eq(mediaItems.monitored, true), eq(mediaItems.onDiskFileCount, 0));
        where.push(isNull(mediaItems.deletedFromArrAt));
      }
      if (!input.includeTombstoned) where.push(isNull(mediaItems.deletedFromArrAt));
      if (input.cursor !== undefined) {
        const [sortTitle, id] = decodeCursor(input.cursor, ['string', 'string']);
        where.push(
          sql`(${mediaItems.sortTitle}, ${mediaItems.id}) > (${sortTitle}, ${String(id)}::uuid)`,
        );
      }

      const rows = await ctx.db
        .select({
          id: mediaItems.id,
          arrKind: mediaItems.arrKind,
          title: mediaItems.title,
          sortTitle: mediaItems.sortTitle,
          year: mediaItems.year,
          monitored: mediaItems.monitored,
          onDiskFileCount: mediaItems.onDiskFileCount,
          expectedFileCount: mediaItems.expectedFileCount,
          sizeOnDisk: mediaItems.sizeOnDisk,
          qualityProfileName: mediaItems.qualityProfileName,
          deletedFromArrAt: mediaItems.deletedFromArrAt,
        })
        .from(mediaItems)
        .where(and(...where))
        .orderBy(asc(mediaItems.sortTitle), asc(mediaItems.id))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({
          id: row.id,
          arrKind: row.arrKind,
          title: row.title,
          year: row.year,
          monitored: row.monitored,
          onDiskFileCount: row.onDiskFileCount,
          expectedFileCount: row.expectedFileCount,
          sizeOnDisk: row.sizeOnDisk,
          qualityProfileName: row.qualityProfileName,
          tombstoned: row.deletedFromArrAt !== null,
        })),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeCursor([last.sortTitle, last.id])
            : null,
      };
    }),

  /** Full item + latest event page + open/recent fixes (the /library/[id] payload). */
  detail: authedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const [item] = await ctx.db.select().from(mediaItems).where(eq(mediaItems.id, input.id));
    if (!item) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `Media item ${input.id} not found` });
    }

    const events = await ctx.db
      .select({
        id: ledgerEvents.id,
        eventType: ledgerEvents.eventType,
        source: ledgerEvents.source,
        occurredAt: ledgerEvents.occurredAt,
        payload: ledgerEvents.payload,
        requestedByDisplayName: users.displayName,
      })
      .from(ledgerEvents)
      .leftJoin(users, eq(users.id, ledgerEvents.requestedByUserId))
      .where(eq(ledgerEvents.mediaItemId, input.id))
      .orderBy(desc(ledgerEvents.occurredAt), desc(ledgerEvents.id))
      .limit(20);

    const fixes = await ctx.db
      .select({
        id: fixRequests.id,
        status: fixRequests.status,
        reason: fixRequests.reason,
        reasonText: fixRequests.reasonText,
        targetLabel: fixRequests.targetLabel,
        pathTaken: fixRequests.pathTaken,
        createdAt: fixRequests.createdAt,
        requesterDisplayName: users.displayName,
      })
      .from(fixRequests)
      .leftJoin(users, eq(users.id, fixRequests.requesterId))
      .where(eq(fixRequests.mediaItemId, input.id))
      .orderBy(desc(fixRequests.createdAt))
      .limit(10);

    return {
      item: {
        id: item.id,
        arrKind: item.arrKind,
        arrInstanceId: item.arrInstanceId,
        title: item.title,
        year: item.year,
        monitored: item.monitored,
        qualityProfileName: item.qualityProfileName,
        metadataProfileName: item.metadataProfileName,
        rootFolder: item.rootFolder,
        arrTags: item.arrTags,
        onDiskFileCount: item.onDiskFileCount,
        expectedFileCount: item.expectedFileCount,
        sizeOnDisk: item.sizeOnDisk,
        tvdbId: item.tvdbId,
        tmdbId: item.tmdbId,
        imdbId: item.imdbId,
        musicbrainzArtistId: item.musicbrainzArtistId,
        firstSeenAt: iso(item.firstSeenAt),
        lastSeenAt: iso(item.lastSeenAt),
        tombstonedAt: isoOrNull(item.deletedFromArrAt),
      },
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        source: e.source,
        occurredAt: iso(e.occurredAt),
        payload: e.payload,
        requestedByDisplayName: e.requestedByDisplayName,
      })),
      fixes: fixes.map((f) => ({
        id: f.id,
        status: f.status,
        reason: f.reason,
        reasonText: f.reasonText,
        targetLabel: f.targetLabel,
        pathTaken: f.pathTaken,
        createdAt: iso(f.createdAt),
        requesterDisplayName: f.requesterDisplayName,
      })),
    };
  }),

  /** Event page for the detail view's history tab — keyset on (occurred_at, id) desc. */
  events: authedProcedure
    .input(
      z.object({
        mediaItemId: z.uuid(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: SQL[] = [eq(ledgerEvents.mediaItemId, input.mediaItemId)];
      if (input.cursor !== undefined) {
        const [millis, id] = decodeCursor(input.cursor, ['number', 'string']);
        where.push(
          sql`(${ledgerEvents.occurredAt}, ${ledgerEvents.id}) < (${new Date(Number(millis))}, ${String(id)}::uuid)`,
        );
      }
      const rows = await ctx.db
        .select({
          id: ledgerEvents.id,
          eventType: ledgerEvents.eventType,
          source: ledgerEvents.source,
          occurredAt: ledgerEvents.occurredAt,
          payload: ledgerEvents.payload,
          requestedByDisplayName: users.displayName,
        })
        .from(ledgerEvents)
        .leftJoin(users, eq(users.id, ledgerEvents.requestedByUserId))
        .where(and(...where))
        .orderBy(desc(ledgerEvents.occurredAt), desc(ledgerEvents.id))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        events: page.map((e) => ({
          id: e.id,
          eventType: e.eventType,
          source: e.source,
          occurredAt: iso(e.occurredAt),
          payload: e.payload,
          requestedByDisplayName: e.requestedByDisplayName,
        })),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeCursor([last.occurredAt.getTime(), last.id])
            : null,
      };
    }),

  /**
   * D-06 LIVE proxy: sonarr episodes / lidarr albums / [] for radarr — the fix
   * target picker. Never synced; always fresher than a mirror.
   */
  children: authedProcedure
    .input(z.object({ mediaItemId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const children = await listMediaChildren({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          mediaItemId: input.mediaItemId,
        });
        return children.map(({ arrChildId, label, hasFile, monitored }) => ({
          arrChildId,
          label,
          hasFile,
          monitored,
        }));
      });
    }),

  /** R-42 — the wanted_items view (D-08), ordered by sort_title. */
  wanted: authedProcedure
    .input(
      z.object({
        arrKind: z.enum(ARR_KINDS).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: SQL[] = [];
      if (input.arrKind) where.push(eq(wantedItems.arrKind, input.arrKind));
      if (input.cursor !== undefined) {
        const [sortTitle, id] = decodeCursor(input.cursor, ['string', 'string']);
        where.push(
          sql`(${wantedItems.sortTitle}, ${wantedItems.mediaItemId}) > (${sortTitle}, ${String(id)}::uuid)`,
        );
      }
      const rows = await ctx.db
        .select({
          mediaItemId: wantedItems.mediaItemId,
          arrKind: wantedItems.arrKind,
          title: wantedItems.title,
          sortTitle: wantedItems.sortTitle,
          year: wantedItems.year,
          expectedFileCount: wantedItems.expectedFileCount,
          lastSeenAt: wantedItems.lastSeenAt,
        })
        .from(wantedItems)
        .where(where.length > 0 ? and(...where) : undefined)
        .orderBy(asc(wantedItems.sortTitle), asc(wantedItems.mediaItemId))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({
          mediaItemId: row.mediaItemId,
          arrKind: row.arrKind,
          title: row.title,
          year: row.year,
          expectedFileCount: row.expectedFileCount,
          lastSeenAt: iso(row.lastSeenAt),
        })),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeCursor([last.sortTitle, last.mediaItemId])
            : null,
      };
    }),
});
