// DESIGN-005 D-17 — the ledger router (R-42/R-43: browse/search is a Member feature).
// Reads project media_items/ledger_events/wanted_items directly (reads are unguarded);
// `children` is the D-06 LIVE proxy through the @hnet/domain arr bundle. Cursor
// pagination throughout (the documented D-17 deviation from DESIGN-003 D-03).
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  ARR_KINDS,
  RESOLUTIONS,
  fixRequests,
  ledgerEvents,
  mediaItems,
  mediaMetadata,
  users,
  wantedItems,
} from '@hnet/db';
import { isMediaItemAccessible, listMediaChildren } from '@hnet/domain';
import { authedProcedure, mapDomainErrors, resolveArrBundle, resolvePlexBundle, router } from '../trpc';
// ADR-047 / DESIGN-025 (PLAN-028) — THE INVARIANT: every media_items read here is gated to the caller's
// accessible Plex libraries SERVER-SIDE (never UI filtering). The gate + predicates live in library-access.
import {
  itemAccessById,
  libraryAccessConditionRaw,
  libraryAccessWhere,
  matchLibraryIdsForItem,
  resolveArtMatchForItem,
  resolveLibraryAccessGate,
  resolvePlexPlayTargets,
} from '../library-access';
// ADR-048 / DESIGN-005 D-22 (PLAN-030) — TV season/episode art from the matched Plex title, served via the
// signed, item-scoped transcode proxy (buildPlexArtUrl). THE INVARIANT holds: the thumb is READ only after
// itemAccessById passes, and the minted URL is bound to this accessible item.
import { buildPlexArtUrl } from '../library-plex-art';
import { decodeCursor, encodeCursor } from '../cursor';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetAfter,
  keysetOrderBy,
  type KeysetValue,
} from '../keyset';
// ADR-022 / DESIGN-009 D-04 — the shared library query DSL (extracted so ledgerAdmin.browse
// + the Ledger export route reuse the EXACT same WHERE / sort / metadata assembly).
import {
  LIBRARY_FILTER_SHAPE,
  LIBRARY_SORT_FIELDS,
  METADATA_SELECT,
  SORT_SPECS,
  buildLibraryWhere,
  librarySortShape,
  metadataBlock,
  posterUrlFor,
} from '../ledger-query';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());

export { LIBRARY_SORT_FIELDS };

// ADR-048 / DESIGN-005 D-22 (PLAN-030) — the TV season-poster + episode-thumb wire shapes. Both are
// SOURCED FROM PLEX via the *arr→Plex match (ADR-047), keyed by season/episode NUMBER so the client merges
// them onto the existing *arr-driven season groups / episode rows. `available:false` = no Plex match (or
// the caller can access none of the item's libraries) ⇒ the client shows no icons (the pre-030 layout).
export interface LedgerPlexSeason {
  /** The Plex season index = the *arr season number (the merge key with groupBySeason). */
  seasonNumber: number;
  /** The signed season-poster proxy URL (`grid` variant), or null when the season has no Plex art. */
  posterUrl: string | null;
}
export interface LedgerPlexSeasonsResult {
  available: boolean;
  seasons: LedgerPlexSeason[];
}
export interface LedgerPlexEpisodeArt {
  /** The Plex episode index = the *arr episode number (the merge key within a season). */
  episodeNumber: number;
  /** The signed episode-still proxy URL (`still` variant), or null when the episode has no Plex art. */
  stillUrl: string | null;
}
export interface LedgerPlexEpisodeArtResult {
  available: boolean;
  episodes: LedgerPlexEpisodeArt[];
}

export const ledgerRouter = router({
  /**
   * R-43 / DESIGN-008 D-09 — search/browse with metadata sort + filters; keyset-paginated by
   * (sortValue, id) with NULLS LAST (the generalized cursor — packages/api/keyset.ts). LEFT
   * JOINs media_metadata so unharvested rows still list (their metadata block is empty and they
   * sort last on any metadata field). THIS INPUT IS THE SHARED CONTRACT PLAN-005/006 reuse.
   */
  search: authedProcedure
    .input(
      z.object({
        ...LIBRARY_FILTER_SHAPE,
        ...librarySortShape,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      // ADR-047 THE INVARIANT — filter to the caller's accessible Plex libraries SERVER-SIDE (an item in
      // a library the role can't access never enters the payload). Admin ⇒ unrestricted (no predicate).
      const gate = await resolveLibraryAccessGate(ctx.user.id, ctx.db);
      // The shared WHERE assembly (unaccent search + onDisk grains + metadata facets + rating
      // bounds + tombstone gate) — single-sourced in ledger-query.ts (DESIGN-008 D-09). PLAN-029 adds
      // the Release-Date/Year/Decade facets + the per-user watch-state facet — the latter binds to the
      // SESSION user (never the wire), a facet on content the access gate already filtered (ADR-053 C-07).
      const where: SQL[] = buildLibraryWhere({ ...input, viewerUserId: ctx.user.id });
      const access = libraryAccessWhere(gate);
      if (access !== null) where.push(access);

      const spec = SORT_SPECS[input.sort.field];
      const idCol = sql`${mediaItems.id}`;
      if (input.cursor !== undefined) {
        const { sortValue, id } = decodeKeysetCursor(input.cursor);
        where.push(
          keysetAfter({ expr: spec.col, idCol, kind: spec.kind, dir: input.sort.dir, value: sortValue, id }),
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
          sortValue: spec.col,
          ...METADATA_SELECT,
        })
        .from(mediaItems)
        .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
        .where(and(...where))
        .orderBy(keysetOrderBy(spec.col, input.sort.dir, idCol))
        .limit(input.limit + 1);

      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      const cursorValueOf = (row: (typeof page)[number]): KeysetValue => {
        const raw = row.sortValue as string | number | Date | null;
        if (raw === null) return null;
        if (spec.kind === 'date') return raw instanceof Date ? raw.toISOString() : String(raw);
        if (spec.kind === 'number') return Number(raw);
        return String(raw);
      };
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
          posterUrl: posterUrlFor(row.id, row.posterSource),
          metadata: metadataBlock(row),
        })),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeKeysetCursor(cursorValueOf(last), last.id)
            : null,
      };
    }),

  /**
   * DESIGN-008 D-09 — distinct filter-facet values for the chip bar (genres / resolutions /
   * requesters / source collections). Cheap SELECT DISTINCTs over the harvested jsonb; scoped
   * by arrKind so each media tab offers only its own values. Shared with PLAN-005/006.
   */
  filterFacets: authedProcedure
    .input(z.object({ arrKind: z.enum(ARR_KINDS).optional() }).default({}))
    .query(async ({ ctx, input }) => {
      // ADR-047 THE INVARIANT — facet values are scoped to the caller's accessible items too (a genre /
      // requester name from an inaccessible library must not leak via the chip bar). The predicate reads
      // the `mpx` (media_plex_matches) LEFT JOIN; unrestricted (admin) callers skip both.
      const gate = await resolveLibraryAccessGate(ctx.user.id, ctx.db);
      const accessCond = libraryAccessConditionRaw(gate); // EXISTS over media_plex_matches — no join needed
      const conds: SQL[] = [];
      if (input.arrKind) conds.push(sql`mi.arr_kind = ${input.arrKind}`);
      if (accessCond !== null) conds.push(accessCond);
      const whereOf = (extra?: SQL): SQL => {
        const parts = extra ? [...conds, extra] : conds;
        return parts.length === 0 ? sql`` : sql`WHERE ${sql.join(parts, sql` AND `)}`;
      };
      const distinctText = async (col: 'genres' | 'requesters' | 'source_collections') => {
        const rows = await ctx.db.execute<{ value: string }>(
          sql`SELECT DISTINCT jsonb_array_elements_text(mm.${sql.raw(col)}) AS value
                FROM media_metadata mm JOIN media_items mi ON mi.id = mm.media_item_id
                ${whereOf()}
               ORDER BY value ASC`,
        );
        return (rows.rows ?? (rows as unknown as { value: string }[])).map((r) => r.value);
      };
      const resolutionRows = await ctx.db.execute<{ value: string }>(
        sql`SELECT DISTINCT mm.resolution AS value
              FROM media_metadata mm JOIN media_items mi ON mi.id = mm.media_item_id
             ${whereOf(sql`mm.resolution IS NOT NULL`)}
             ORDER BY value ASC`,
      );
      // Return resolutions in RESOLUTIONS enum order (2160p→sd→unknown), not the DISTINCT's
      // alphabetical order, so the client renders them best-first with no re-sort (fix 2026-07-06).
      const harvestedResolutions = new Set(
        (resolutionRows.rows ?? (resolutionRows as unknown as { value: string }[])).map(
          (r) => r.value,
        ),
      );
      const resolutions = RESOLUTIONS.filter((r) => harvestedResolutions.has(r));
      // DESIGN-026 D-08 (PLAN-029 step 6) — the Decade facet values, derived from the already-synced
      // media_items.year ((year/10)*10 — integer division truncates to the decade start). Same access
      // scoping as every other facet; newest decade first (the exploration order).
      const decadeRows = await ctx.db.execute<{ value: number }>(
        sql`SELECT DISTINCT (mi.year / 10) * 10 AS value
              FROM media_items mi
             ${whereOf(sql`mi.year IS NOT NULL`)}
             ORDER BY value DESC`,
      );
      const decades = (decadeRows.rows ?? (decadeRows as unknown as { value: number }[])).map((r) =>
        Number(r.value),
      );
      return {
        genres: await distinctText('genres'),
        requesters: await distinctText('requesters'),
        sourceCollections: await distinctText('source_collections'),
        resolutions,
        decades,
      };
    }),

  /** Full item + latest event page + open/recent fixes (the /library/[id] payload). */
  detail: authedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const [item] = await ctx.db.select().from(mediaItems).where(eq(mediaItems.id, input.id));
    if (!item) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `Media item ${input.id} not found` });
    }
    // ADR-047 THE INVARIANT — a direct id fetch must re-gate: an item the caller can access NO library of is
    // indistinguishable from "not found" (never reveal its existence + external ids). Admin ⇒ ok.
    const gate = await resolveLibraryAccessGate(ctx.user.id, ctx.db);
    const matchLibraryIds = await matchLibraryIdsForItem(ctx.db, input.id);
    if (
      !isMediaItemAccessible(gate, {
        arrKind: item.arrKind,
        arrInstanceId: item.arrInstanceId,
        matchLibraryIds,
      })
    ) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `Media item ${input.id} not found` });
    }
    // ADR-047 Q-D / owner UX ruling — ONE "Watch on Plex — <library>" deep link per library the caller can
    // access, and ONLY for a PRESENT (on-disk) item (a missing/unfiled item gets none). Empty array otherwise.
    const play = await resolvePlexPlayTargets(ctx.db, gate, input.id, item.onDiskFileCount > 0);
    // DESIGN-008 D-09 — the harvested metadata block + poster URL for the detail view.
    const [meta] = await ctx.db
      .select(METADATA_SELECT)
      .from(mediaMetadata)
      .where(eq(mediaMetadata.mediaItemId, input.id));

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
        // ADR-028 / D-21 — the exact grain an open fix locks (scope + child + season)
        // and whether the caller owns it (own fixes poll fix.progress live; others
        // render a static in-flight chip — the progress query is own-or-admin only).
        targetScope: fixRequests.targetScope,
        targetArrChildId: fixRequests.targetArrChildId,
        targetSeason: fixRequests.targetSeason,
        requesterId: fixRequests.requesterId,
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
        posterUrl: posterUrlFor(item.id, meta?.posterSource ?? null),
        // Always the object shape (all-null when unharvested) — identical to search (fix 2026-07-06).
        metadata: metadataBlock(meta),
        // ADR-047 (PLAN-028) — one "Watch on Plex — <library>" deep link per ACCESSIBLE Plex library the
        // present item lives in (empty when missing/unmatched/inaccessible). Rendered as primary actions.
        play,
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
        targetScope: f.targetScope,
        targetArrChildId: f.targetArrChildId,
        targetSeason: f.targetSeason,
        // fix.progress is own-or-admin; watchable ⇒ this caller may poll it live.
        watchable: f.requesterId === ctx.user.id || ctx.user.role.isAdmin,
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
      // ADR-047 THE INVARIANT — the history of a hidden item must not leak by direct id.
      const gate = await resolveLibraryAccessGate(ctx.user.id, ctx.db);
      if (!(await itemAccessById(ctx.db, gate, input.mediaItemId))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Media item ${input.mediaItemId} not found` });
      }
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
      // ADR-047 THE INVARIANT — the live season/album proxy must not run for a hidden item.
      const gate = await resolveLibraryAccessGate(ctx.user.id, ctx.db);
      if (!(await itemAccessById(ctx.db, gate, input.mediaItemId))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Media item ${input.mediaItemId} not found` });
      }
      return mapDomainErrors(async () => {
        const children = await listMediaChildren({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          mediaItemId: input.mediaItemId,
        });
        return children.map(({ arrChildId, label, hasFile, monitored, seasonNumber, episodeNumber }) => ({
          arrChildId,
          label,
          hasFile,
          monitored,
          seasonNumber,
          // PLAN-030 — the merge key for the Plex episode thumb (ledger.plexEpisodeArt), sonarr only.
          episodeNumber,
        }));
      });
    }),

  /**
   * ADR-048 / DESIGN-005 D-22 (PLAN-030) — the TV show's SEASON POSTERS, read from the matched Plex title
   * (ADR-047 media_plex_matches → the show's ratingKey → its season children). Keyed by season number so the
   * client merges each poster onto its groupBySeason row. THE INVARIANT: the item is re-gated (itemAccessById,
   * NOT_FOUND for a hidden item) and the art source resolves ONLY from libraries the caller can access
   * (resolveArtMatchForItem). Unmatched / inaccessible / Plex-unreachable ⇒ `available:false` (no icons — the
   * pre-030 layout, PLAN-030 Q-01). Read-only; degrades to no-art, never a crash.
   */
  plexSeasons: authedProcedure
    .input(z.object({ mediaItemId: z.uuid() }))
    .query(async ({ ctx, input }): Promise<LedgerPlexSeasonsResult> => {
      const gate = await resolveLibraryAccessGate(ctx.user.id, ctx.db);
      if (!(await itemAccessById(ctx.db, gate, input.mediaItemId))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Media item ${input.mediaItemId} not found` });
      }
      const match = await resolveArtMatchForItem(ctx.db, gate, input.mediaItemId);
      if (match === null) return { available: false, seasons: [] };
      try {
        const read = resolvePlexBundle(ctx).read[match.serverSlug];
        const children = await read.listMetadataChildren(match.ratingKey);
        const seasons: LedgerPlexSeason[] = [];
        for (const c of children.items) {
          if (c.type !== 'season' || c.index === undefined || c.index === null) continue;
          seasons.push({
            seasonNumber: c.index,
            posterUrl: c.thumb
              ? buildPlexArtUrl(input.mediaItemId, match.serverSlug, c.thumb, 'grid')
              : null,
          });
        }
        return { available: true, seasons };
      } catch {
        return { available: false, seasons: [] }; // Plex outage / bad match ⇒ no icons, never a crash
      }
    }),

  /**
   * ADR-048 / DESIGN-005 D-22 (PLAN-030) — one TV season's EPISODE STILLS, lazily fetched when a season
   * expands (mirrors the ytdl-sub drill-in's per-season episode load). Navigates the item's OWN matched
   * Plex show → the season whose index = seasonNumber → its episode children, so the art stays confined to
   * the accessible matched title. Keyed by episode number (merges onto the *arr episode row). Same gate +
   * degrade posture as plexSeasons.
   */
  plexEpisodeArt: authedProcedure
    .input(z.object({ mediaItemId: z.uuid(), seasonNumber: z.number().int().min(0) }))
    .query(async ({ ctx, input }): Promise<LedgerPlexEpisodeArtResult> => {
      const gate = await resolveLibraryAccessGate(ctx.user.id, ctx.db);
      if (!(await itemAccessById(ctx.db, gate, input.mediaItemId))) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Media item ${input.mediaItemId} not found` });
      }
      const match = await resolveArtMatchForItem(ctx.db, gate, input.mediaItemId);
      if (match === null) return { available: false, episodes: [] };
      try {
        const read = resolvePlexBundle(ctx).read[match.serverSlug];
        const showChildren = await read.listMetadataChildren(match.ratingKey);
        const season = showChildren.items.find(
          (c) => c.type === 'season' && c.index === input.seasonNumber,
        );
        if (season === undefined) return { available: true, episodes: [] };
        const epChildren = await read.listMetadataChildren(season.ratingKey);
        const episodes: LedgerPlexEpisodeArt[] = [];
        for (const c of epChildren.items) {
          if (c.type !== 'episode' || c.index === undefined || c.index === null) continue;
          episodes.push({
            episodeNumber: c.index,
            stillUrl: c.thumb
              ? buildPlexArtUrl(input.mediaItemId, match.serverSlug, c.thumb, 'still')
              : null,
          });
        }
        return { available: true, episodes };
      } catch {
        return { available: false, episodes: [] };
      }
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
      // ADR-047 THE INVARIANT — the wanted (missing) view is media_items too; gate it to accessible libs.
      // Missing items are unmatched, so they resolve via their kind's home library (join media_items for
      // arr_kind/instance; the access predicate's EXISTS subqueries need no extra join).
      const gate = await resolveLibraryAccessGate(ctx.user.id, ctx.db);
      const where: SQL[] = [];
      if (input.arrKind) where.push(eq(wantedItems.arrKind, input.arrKind));
      const access = libraryAccessWhere(gate);
      if (access !== null) where.push(access);
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
        .innerJoin(mediaItems, eq(mediaItems.id, wantedItems.mediaItemId))
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
