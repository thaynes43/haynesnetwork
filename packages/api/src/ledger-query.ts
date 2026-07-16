// ADR-018 / DESIGN-008 D-09 + ADR-022 / DESIGN-009 D-04 — the SHARED library query DSL.
// ledger.search (Member browse), ledgerAdmin.browse (Ledger section), and the Ledger export
// route ALL assemble their WHERE / sort / metadata projection from this one module so the
// filter contract never forks (PLAN-005 reuses PLAN-004's engine verbatim). The keyset cursor
// primitive lives in ./keyset.
import { z } from 'zod';
import { eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { ARR_KINDS, RESOLUTIONS, mediaItems, mediaMetadata, userMediaWatch } from '@hnet/db';
import type { KeysetKind } from './keyset';

const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());

/** Escape LIKE wildcards in user-typed search text. */
export const escapeLike = (q: string) => q.replace(/[\\%_]/g, '\\$&');

export const ON_DISK_FILTERS = ['any', 'complete', 'partial', 'none'] as const;
export type OnDiskFilter = (typeof ON_DISK_FILTERS)[number];

// ADR-053 / DESIGN-026 D-07/D-08 (PLAN-029) — the per-user (viewer-scoped) video watch-state facet.
// 'watched' = the viewer completed it; 'unwatched' = they have no completed play; 'in_progress' = a
// partial play with no completed one. Populated-value-gated (ADR-051 C-06): the UI offers it only when
// the viewer has any user_media_watch rows. The predicate is applied ONLY when a viewerUserId is present.
export const WATCH_STATES = ['watched', 'unwatched', 'in_progress'] as const;
export type WatchState = (typeof WATCH_STATES)[number];

// ADR-022 / DESIGN-009 D-04 — the Ledger-only completeness facet (superset of onDisk grains):
// 'none' (nothing on disk) | 'some' (>0 files) | 'all' (complete) | 'any'. 'none' is exactly
// the Fileless-Set half (T-66) when combined with monitored=false.
export const HAS_FILE_FILTERS = ['any', 'none', 'some', 'all'] as const;
export type HasFileFilter = (typeof HAS_FILE_FILTERS)[number];

// The shared sort-field contract (DESIGN-008 D-09). Each maps to its sortable expression + kind.
// ADR-051 C-05 / DESIGN-026 D-05 (PLAN-029) extends it with `released_at` (the second must-have date
// dimension) and `year` (Year sort, derived from the already-synced mediaItems.year — no new data).
export const LIBRARY_SORT_FIELDS = [
  'title',
  'imdb_rating',
  'tmdb_rating',
  'rt_tomatometer',
  'added_at',
  'released_at',
  'year',
  'play_count',
  'last_viewed',
  'runtime',
] as const;
export type LibrarySortField = (typeof LIBRARY_SORT_FIELDS)[number];

export const SORT_SPECS: Record<LibrarySortField, { col: SQL; kind: KeysetKind }> = {
  title: { col: sql`${mediaItems.sortTitle}`, kind: 'text' },
  imdb_rating: { col: sql`${mediaMetadata.imdbRating}`, kind: 'number' },
  tmdb_rating: { col: sql`${mediaMetadata.tmdbRating}`, kind: 'number' },
  rt_tomatometer: { col: sql`${mediaMetadata.rtTomatometer}`, kind: 'number' },
  added_at: { col: sql`${mediaMetadata.arrAddedAt}`, kind: 'date' },
  // DESIGN-026 D-05 — Date Released. A null sorts NULLS-LAST like every nullable date (the keyset
  // already handles it — no cursor change; Lidarr artists / date-less rows land last).
  released_at: { col: sql`${mediaMetadata.releasedAt}`, kind: 'date' },
  year: { col: sql`${mediaItems.year}`, kind: 'number' },
  play_count: { col: sql`${mediaMetadata.playCount}`, kind: 'number' },
  last_viewed: { col: sql`${mediaMetadata.lastViewedAt}`, kind: 'date' },
  runtime: { col: sql`${mediaMetadata.runtimeMinutes}`, kind: 'number' },
};

/** The joined media_metadata columns returned per search/browse/detail item. */
export const METADATA_SELECT = {
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
  releasedAt: mediaMetadata.releasedAt,
  playCount: mediaMetadata.playCount,
  lastViewedAt: mediaMetadata.lastViewedAt,
  requesters: mediaMetadata.requesters,
  sourceCollections: mediaMetadata.sourceCollections,
  posterSource: mediaMetadata.posterSource,
} as const;

export type MetadataRow = {
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
  releasedAt: Date | null;
  playCount: number | null;
  lastViewedAt: Date | null;
  requesters: string[] | null;
  sourceCollections: string[] | null;
  posterSource: string | null;
};

const numOrNull = (v: string | null) => (v === null ? null : Number(v));

/** Shape the joined media_metadata columns into the wire metadata block. ALWAYS an object
 *  (all-null fields when unharvested / no row) — search, browse and detail return the identical
 *  shape, so consumers never null-check the block itself (DESIGN-008 D-09). */
export function metadataBlock(row: MetadataRow | null | undefined) {
  return {
    imdbRating: numOrNull(row?.imdbRating ?? null),
    imdbVotes: row?.imdbVotes ?? null,
    tmdbRating: numOrNull(row?.tmdbRating ?? null),
    tmdbVotes: row?.tmdbVotes ?? null,
    rtTomatometer: row?.rtTomatometer ?? null,
    rtPopcorn: row?.rtPopcorn ?? null,
    runtimeMinutes: row?.runtimeMinutes ?? null,
    resolution: row?.resolution ?? null,
    genres: row?.genres ?? [],
    addedAt: isoOrNull(row?.arrAddedAt ?? null),
    releasedAt: isoOrNull(row?.releasedAt ?? null),
    playCount: row?.playCount ?? null,
    lastViewedAt: isoOrNull(row?.lastViewedAt ?? null),
    requesters: row?.requesters ?? [],
    sourceCollections: row?.sourceCollections ?? [],
  };
}

/** The authed poster-proxy URL (ADR-019) — null when no poster tier resolved. */
export const posterUrlFor = (id: string, posterSource: string | null) =>
  posterSource === null ? null : `/api/posters/${id}`;

/** jsonb-array overlap: true when the column shares ANY value with `values` (same-field OR). */
export const jsonbOverlap = (col: SQL, values: string[]): SQL =>
  sql`${col} ?| ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/**
 * The shared filter fields (DESIGN-008 D-09 chip DSL). ledger.search and ledgerAdmin.browse
 * spread these into their input schemas so the contract is single-sourced. The Ledger-only
 * dims (`monitored`, `hasFile`) are added by browse (see LEDGER_FILTER_SHAPE).
 */
export const LIBRARY_FILTER_SHAPE = {
  query: z.string().trim().max(200).optional(),
  arrKind: z.enum(ARR_KINDS).optional(),
  onDisk: z.enum(ON_DISK_FILTERS).default('any'),
  wanted: z.boolean().optional(),
  includeTombstoned: z.boolean().default(false),
  genres: z.array(z.string().min(1)).max(50).optional(),
  resolutions: z.array(z.enum(RESOLUTIONS)).max(RESOLUTIONS.length).optional(),
  requesters: z.array(z.string().min(1)).max(50).optional(),
  sourceCollections: z.array(z.string().min(1)).max(50).optional(),
  ratingMin: z.number().min(0).max(10).optional(), // on COALESCE(imdb_rating, tmdb_rating)
  ratingMax: z.number().min(0).max(10).optional(),
  // ADR-051 C-05 / DESIGN-026 D-05/D-08 (PLAN-029) — the Release-Date range facet (ISO instants,
  // inclusive) over media_metadata.released_at.
  releasedFrom: z.string().datetime().optional(),
  releasedTo: z.string().datetime().optional(),
  // DESIGN-026 D-08 — Year/Decade facet, derived from the already-synced mediaItems.year (no new data).
  // `decades` is a list of decade-start years (e.g. [1990, 2000]); yearMin/yearMax bound a range.
  yearMin: z.number().int().min(0).max(3000).optional(),
  yearMax: z.number().int().min(0).max(3000).optional(),
  decades: z.array(z.number().int().min(0).max(3000)).max(30).optional(),
  // ADR-053 / DESIGN-026 D-07 — the per-user watch-state facet (viewer-scoped; see WATCH_STATES). The
  // predicate binds to the viewer via buildLibraryWhere's viewerUserId (set server-side from the session).
  watchState: z.enum(WATCH_STATES).optional(),
  // DESIGN-026 D-09 (PLAN-029 step 6) — the A–Z letter jump: page to the first item at this letter
  // (a `sort_title >= letter` narrowing that composes with the keyset cursor for later pages). The
  // client offers it only on the asc Title sort (the registry's azSorts gate); '#' = cleared.
  letter: z.string().regex(/^[a-z]$/).optional(),
  // ADR-064 / DESIGN-035 D-04 (PLAN-037) — the Collections drill-in: narrow to the ledger members of
  // ONE mirrored Plex collection, keyed by the COLLECTION's rating_key (`?group=<ratingKey>` — keys,
  // never titles). One EXISTS predicate, so the drilled wall inherits every other filter/sort + the
  // ADR-047 gate unchanged.
  collection: z.string().min(1).max(64).optional(),
} as const;

/** The Ledger-section-only filter dims (ADR-022 / DESIGN-009 D-04): monitored + completeness. */
export const LEDGER_FILTER_SHAPE = {
  ...LIBRARY_FILTER_SHAPE,
  monitored: z.boolean().optional(),
  hasFile: z.enum(HAS_FILE_FILTERS).default('any'),
} as const;

export const librarySortShape = {
  sort: z
    .object({
      field: z.enum(LIBRARY_SORT_FIELDS).default('title'),
      dir: z.enum(['asc', 'desc']).default('asc'),
    })
    .default({ field: 'title', dir: 'asc' }),
} as const;

/** The already-parsed filter values buildLibraryWhere consumes (a superset — all optional). */
export interface LibraryWhereInput {
  query?: string;
  arrKind?: (typeof ARR_KINDS)[number];
  onDisk?: OnDiskFilter;
  hasFile?: HasFileFilter;
  monitored?: boolean;
  wanted?: boolean;
  includeTombstoned?: boolean;
  genres?: string[];
  resolutions?: (typeof RESOLUTIONS)[number][];
  requesters?: string[];
  sourceCollections?: string[];
  ratingMin?: number;
  ratingMax?: number;
  // PLAN-029 (DESIGN-026 D-05/D-08) — Release-Date range + Year/Decade facets.
  releasedFrom?: string;
  releasedTo?: string;
  yearMin?: number;
  yearMax?: number;
  decades?: number[];
  // ADR-053 / DESIGN-026 D-07 — the per-user watch-state facet + the viewer it is scoped to. The
  // predicate is applied ONLY when BOTH are present (viewerUserId is set server-side from the session,
  // never from the wire — a facet on already-gated content, ADR-053 C-07). Undefined ⇒ no predicate.
  watchState?: WatchState;
  viewerUserId?: string;
  // DESIGN-026 D-09 — the A–Z jump letter (see LIBRARY_FILTER_SHAPE.letter).
  letter?: string;
  // ADR-064 / DESIGN-035 D-04 — the Collections drill-in (a mirrored collection's rating_key).
  collection?: string;
}

/**
 * Assemble the WHERE predicates shared by search/browse/export. Metadata facets are same-field
 * OR (jsonb overlap / IN) and cross-field AND (chip semantics). The keyset cursor predicate is
 * NOT included here (it depends on the sort spec — added by each caller).
 */
export function buildLibraryWhere(input: LibraryWhereInput): SQL[] {
  const where: SQL[] = [];
  if (input.query) {
    const escaped = escapeLike(input.query);
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
  // ADR-022 / DESIGN-009 D-04 — Ledger completeness facet (superset of onDisk).
  if (input.hasFile === 'none') {
    where.push(eq(mediaItems.onDiskFileCount, 0));
  } else if (input.hasFile === 'some') {
    where.push(sql`${mediaItems.onDiskFileCount} > 0`);
  } else if (input.hasFile === 'all') {
    where.push(
      sql`${mediaItems.onDiskFileCount} > 0 AND ${mediaItems.onDiskFileCount} >= ${mediaItems.expectedFileCount}`,
    );
  }
  if (input.monitored !== undefined) where.push(eq(mediaItems.monitored, input.monitored));
  if (input.wanted === true) {
    where.push(eq(mediaItems.monitored, true), eq(mediaItems.onDiskFileCount, 0));
    where.push(isNull(mediaItems.deletedFromArrAt));
  }
  if (!input.includeTombstoned) where.push(isNull(mediaItems.deletedFromArrAt));
  if (input.genres?.length) where.push(jsonbOverlap(sql`${mediaMetadata.genres}`, input.genres));
  if (input.resolutions?.length) where.push(inArray(mediaMetadata.resolution, input.resolutions));
  if (input.requesters?.length) {
    where.push(jsonbOverlap(sql`${mediaMetadata.requesters}`, input.requesters));
  }
  if (input.sourceCollections?.length) {
    where.push(jsonbOverlap(sql`${mediaMetadata.sourceCollections}`, input.sourceCollections));
  }
  // COALESCE(imdb_rating, tmdb_rating): Radarr fills imdb_rating; Sonarr/Lidarr land their single
  // community rating in tmdb_rating (ADR-018 C-07). Coalescing makes the bound work on all tiers.
  if (input.ratingMin !== undefined) {
    where.push(
      sql`COALESCE(${mediaMetadata.imdbRating}, ${mediaMetadata.tmdbRating}) >= ${input.ratingMin}`,
    );
  }
  if (input.ratingMax !== undefined) {
    where.push(
      sql`COALESCE(${mediaMetadata.imdbRating}, ${mediaMetadata.tmdbRating}) <= ${input.ratingMax}`,
    );
  }
  // ADR-051 C-05 / DESIGN-026 D-05 — the Release-Date range (inclusive) over media_metadata.released_at.
  if (input.releasedFrom !== undefined) {
    where.push(sql`${mediaMetadata.releasedAt} >= ${input.releasedFrom}::timestamptz`);
  }
  if (input.releasedTo !== undefined) {
    where.push(sql`${mediaMetadata.releasedAt} <= ${input.releasedTo}::timestamptz`);
  }
  // DESIGN-026 D-08 — Year range + Decade facet, derived from mediaItems.year (integer). A decade is
  // its start year; `(year / 10) * 10` truncates to it (positive years, integer division).
  if (input.yearMin !== undefined) where.push(sql`${mediaItems.year} >= ${input.yearMin}`);
  if (input.yearMax !== undefined) where.push(sql`${mediaItems.year} <= ${input.yearMax}`);
  if (input.decades?.length) {
    where.push(
      sql`(${mediaItems.year} / 10) * 10 IN (${sql.join(
        input.decades.map((d) => sql`${d}`),
        sql`, `,
      )})`,
    );
  }
  // DESIGN-026 D-09 — the A–Z jump: narrow to sort_title at/after the letter. Composes with the
  // keyset cursor (later pages) because both are plain AND predicates over the same asc order.
  if (input.letter !== undefined) {
    where.push(sql`LOWER(${mediaItems.sortTitle}) >= ${input.letter}`);
  }
  // ADR-064 / DESIGN-035 D-04 — the Collections drill-in: keep items that are a MEMBER of the named
  // mirrored collection, resolved member-ratingKey → media_plex_matches within the collection's OWN
  // library. Just an AND predicate, so every other filter/sort + the ADR-047 access gate (applied by
  // the caller) compose unchanged — a withheld member never surfaces through a collection drill.
  if (input.collection !== undefined) {
    where.push(
      sql`EXISTS (SELECT 1
                    FROM plex_collection_members pcm
                    JOIN plex_collections pc ON pc.id = pcm.collection_id
                    JOIN media_plex_matches cmx
                      ON cmx.plex_library_id = pc.plex_library_id
                     AND cmx.rating_key = pcm.rating_key
                   WHERE pc.rating_key = ${input.collection}
                     AND cmx.media_item_id = ${mediaItems.id})`,
    );
  }
  // ADR-053 / DESIGN-026 D-07 — the per-user watch-state facet (viewer-scoped EXISTS over
  // user_media_watch). Applied ONLY when a viewerUserId is present (a facet on already-gated content).
  if (input.watchState !== undefined && input.viewerUserId !== undefined) {
    const viewer = sql`${input.viewerUserId}::uuid`;
    if (input.watchState === 'watched') {
      where.push(
        sql`EXISTS (SELECT 1 FROM ${userMediaWatch} umw WHERE umw.media_item_id = ${mediaItems.id} AND umw.app_user_id = ${viewer} AND umw.watched = true)`,
      );
    } else if (input.watchState === 'in_progress') {
      where.push(
        sql`EXISTS (SELECT 1 FROM ${userMediaWatch} umw WHERE umw.media_item_id = ${mediaItems.id} AND umw.app_user_id = ${viewer} AND umw.in_progress = true)`,
      );
    } else {
      // 'unwatched' — the viewer has NO completed play recorded for this item.
      where.push(
        sql`NOT EXISTS (SELECT 1 FROM ${userMediaWatch} umw WHERE umw.media_item_id = ${mediaItems.id} AND umw.app_user_id = ${viewer} AND umw.watched = true)`,
      );
    }
  }
  return where;
}
