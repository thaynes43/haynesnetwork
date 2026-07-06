// DESIGN-005 D-17 — the ledger router (R-42/R-43: browse/search is a Member feature).
// Reads project media_items/ledger_events/wanted_items directly (reads are unguarded);
// `children` is the D-06 LIVE proxy through the @hnet/domain arr bundle. Cursor
// pagination throughout (the documented D-17 deviation from DESIGN-003 D-03).
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
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
import { listMediaChildren } from '@hnet/domain';
import { authedProcedure, mapDomainErrors, resolveArrBundle, router } from '../trpc';
import { decodeCursor, encodeCursor } from '../cursor';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetAfter,
  keysetOrderBy,
  type KeysetKind,
  type KeysetValue,
} from '../keyset';

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());

/** Escape LIKE wildcards in user-typed search text. */
const escapeLike = (q: string) => q.replace(/[\\%_]/g, '\\$&');

const ON_DISK_FILTERS = ['any', 'complete', 'partial', 'none'] as const;

// ADR-018 / DESIGN-008 D-09 — the shared sort-field contract (PLAN-005/006 reuse it verbatim).
// Each field maps to its sortable expression + SQL kind (drives the keyset cursor cast).
export const LIBRARY_SORT_FIELDS = [
  'title',
  'imdb_rating',
  'tmdb_rating',
  'rt_tomatometer',
  'added_at',
  'play_count',
  'last_viewed',
  'runtime',
] as const;
export type LibrarySortField = (typeof LIBRARY_SORT_FIELDS)[number];

const SORT_SPECS: Record<LibrarySortField, { col: SQL; kind: KeysetKind }> = {
  title: { col: sql`${mediaItems.sortTitle}`, kind: 'text' },
  imdb_rating: { col: sql`${mediaMetadata.imdbRating}`, kind: 'number' },
  tmdb_rating: { col: sql`${mediaMetadata.tmdbRating}`, kind: 'number' },
  rt_tomatometer: { col: sql`${mediaMetadata.rtTomatometer}`, kind: 'number' },
  added_at: { col: sql`${mediaMetadata.arrAddedAt}`, kind: 'date' },
  play_count: { col: sql`${mediaMetadata.playCount}`, kind: 'number' },
  last_viewed: { col: sql`${mediaMetadata.lastViewedAt}`, kind: 'date' },
  runtime: { col: sql`${mediaMetadata.runtimeMinutes}`, kind: 'number' },
};

/** The metadata block returned per search/detail item (numeric → number; dates → ISO). */
const METADATA_SELECT = {
  imdbRating: mediaMetadata.imdbRating,
  imdbVotes: mediaMetadata.imdbVotes,
  tmdbRating: mediaMetadata.tmdbRating,
  tmdbVotes: mediaMetadata.tmdbVotes,
  rtTomatometer: mediaMetadata.rtTomatometer,
  rtPopcorn: mediaMetadata.rtPopcorn,
  runtimeMinutes: mediaMetadata.runtimeMinutes,
  resolution: mediaMetadata.resolution,
  genres: mediaMetadata.genres,
  arrAddedAt: mediaMetadata.arrAddedAt,
  playCount: mediaMetadata.playCount,
  lastViewedAt: mediaMetadata.lastViewedAt,
  requesters: mediaMetadata.requesters,
  sourceCollections: mediaMetadata.sourceCollections,
  posterSource: mediaMetadata.posterSource,
} as const;

type MetadataRow = {
  imdbRating: string | null;
  imdbVotes: number | null;
  tmdbRating: string | null;
  tmdbVotes: number | null;
  rtTomatometer: number | null;
  rtPopcorn: number | null;
  runtimeMinutes: number | null;
  resolution: string | null;
  genres: string[] | null;
  arrAddedAt: Date | null;
  playCount: number | null;
  lastViewedAt: Date | null;
  requesters: string[] | null;
  sourceCollections: string[] | null;
  posterSource: string | null;
};

const numOrNull = (v: string | null) => (v === null ? null : Number(v));

/** Shape the joined media_metadata columns into the wire metadata block (null when unharvested). */
function metadataBlock(row: MetadataRow) {
  return {
    imdbRating: numOrNull(row.imdbRating),
    imdbVotes: row.imdbVotes,
    tmdbRating: numOrNull(row.tmdbRating),
    tmdbVotes: row.tmdbVotes,
    rtTomatometer: row.rtTomatometer,
    rtPopcorn: row.rtPopcorn,
    runtimeMinutes: row.runtimeMinutes,
    resolution: row.resolution,
    genres: row.genres ?? [],
    addedAt: isoOrNull(row.arrAddedAt),
    playCount: row.playCount,
    lastViewedAt: isoOrNull(row.lastViewedAt),
    requesters: row.requesters ?? [],
    sourceCollections: row.sourceCollections ?? [],
  };
}

/** The authed poster-proxy URL (ADR-019) — null when no poster tier resolved. */
const posterUrlFor = (id: string, posterSource: string | null) =>
  posterSource === null ? null : `/api/posters/${id}`;

/** jsonb-array overlap: true when the column shares ANY value with `values` (same-field OR).
 *  Builds an explicit `ARRAY[$1,$2,…]::text[]` so each value is a safe bound parameter. */
const jsonbOverlap = (col: SQL, values: string[]): SQL =>
  sql`${col} ?| ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

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
        query: z.string().trim().max(200).optional(),
        arrKind: z.enum(ARR_KINDS).optional(),
        onDisk: z.enum(ON_DISK_FILTERS).default('any'),
        /** true ⇒ narrow to the D-08 wanted view semantics (monitored, nothing on disk). */
        wanted: z.boolean().optional(),
        includeTombstoned: z.boolean().default(false),
        // Metadata filters (D-09) — within a facet OR, across facets AND (chip semantics).
        genres: z.array(z.string().min(1)).max(50).optional(),
        resolutions: z.array(z.enum(RESOLUTIONS)).max(RESOLUTIONS.length).optional(),
        requesters: z.array(z.string().min(1)).max(50).optional(),
        sourceCollections: z.array(z.string().min(1)).max(50).optional(),
        ratingMin: z.number().min(0).max(10).optional(),
        ratingMax: z.number().min(0).max(10).optional(),
        // Sort (D-09) — title default; any metadata field, either direction, NULLS LAST.
        sort: z
          .object({
            field: z.enum(LIBRARY_SORT_FIELDS).default('title'),
            dir: z.enum(['asc', 'desc']).default('asc'),
          })
          .default({ field: 'title', dir: 'asc' }),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: SQL[] = [];
      if (input.query) {
        const escaped = escapeLike(input.query);
        // Accent- AND case-insensitive match (migration 0005_unaccent_search): unaccent()
        // both the column and the user's pattern so typing 'pokemon' finds 'Pokémon', while
        // ILIKE keeps it case-insensitive (so 'POKEMON' matches too). unaccent() is STABLE,
        // not IMMUTABLE, so there is no expression index — a seq scan is fine at ~17k rows.
        where.push(
          sql`(unaccent(${mediaItems.title}) ILIKE unaccent(${`%${escaped}%`}) OR unaccent(${mediaItems.sortTitle}) ILIKE unaccent(${`${escaped}%`}))`,
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
      // Metadata facet filters — same-field OR (jsonb overlap / IN), cross-field AND.
      if (input.genres?.length) where.push(jsonbOverlap(sql`${mediaMetadata.genres}`, input.genres));
      if (input.resolutions?.length) {
        where.push(inArray(mediaMetadata.resolution, input.resolutions));
      }
      if (input.requesters?.length) {
        where.push(jsonbOverlap(sql`${mediaMetadata.requesters}`, input.requesters));
      }
      if (input.sourceCollections?.length) {
        where.push(jsonbOverlap(sql`${mediaMetadata.sourceCollections}`, input.sourceCollections));
      }
      if (input.ratingMin !== undefined) {
        where.push(sql`${mediaMetadata.imdbRating} >= ${input.ratingMin}`);
      }
      if (input.ratingMax !== undefined) {
        where.push(sql`${mediaMetadata.imdbRating} <= ${input.ratingMax}`);
      }

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
      const kindFilter = input.arrKind
        ? sql`WHERE mi.arr_kind = ${input.arrKind}`
        : sql``;
      const distinctText = async (col: 'genres' | 'requesters' | 'source_collections') => {
        const rows = await ctx.db.execute<{ value: string }>(
          sql`SELECT DISTINCT jsonb_array_elements_text(mm.${sql.raw(col)}) AS value
                FROM media_metadata mm JOIN media_items mi ON mi.id = mm.media_item_id
                ${kindFilter}
               ORDER BY value ASC`,
        );
        return (rows.rows ?? (rows as unknown as { value: string }[])).map((r) => r.value);
      };
      const resolutionRows = await ctx.db.execute<{ value: string }>(
        sql`SELECT DISTINCT mm.resolution AS value
              FROM media_metadata mm JOIN media_items mi ON mi.id = mm.media_item_id
             ${kindFilter} ${input.arrKind ? sql`AND` : sql`WHERE`} mm.resolution IS NOT NULL
             ORDER BY value ASC`,
      );
      const resolutions = (
        resolutionRows.rows ?? (resolutionRows as unknown as { value: string }[])
      ).map((r) => r.value);
      return {
        genres: await distinctText('genres'),
        requesters: await distinctText('requesters'),
        sourceCollections: await distinctText('source_collections'),
        resolutions,
      };
    }),

  /** Full item + latest event page + open/recent fixes (the /library/[id] payload). */
  detail: authedProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const [item] = await ctx.db.select().from(mediaItems).where(eq(mediaItems.id, input.id));
    if (!item) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `Media item ${input.id} not found` });
    }
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
        metadata: meta ? metadataBlock(meta) : null,
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
        return children.map(({ arrChildId, label, hasFile, monitored, seasonNumber }) => ({
          arrChildId,
          label,
          hasFile,
          monitored,
          seasonNumber,
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
