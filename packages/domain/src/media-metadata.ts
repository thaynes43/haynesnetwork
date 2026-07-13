import {
  mediaMetadata,
  type DbClient,
  type PosterSource,
  type Resolution,
} from '@hnet/db';
import { sql } from 'drizzle-orm';
import { inTransaction } from './db-client';

/**
 * ADR-018 / DESIGN-008 D-12 — the harvested metadata field set for one Media Item, assembled
 * by the sync harvest from all reachable tiers (per-source degradation: a failed tier simply
 * contributes nothing this cycle — D-03). `mediaItemId` is the 1:1 key; every other field is
 * optional (a tier that couldn't supply it leaves it undefined ⇒ null on write).
 */
export interface MediaMetadataFields {
  mediaItemId: string;
  imdbRating?: number | null;
  imdbVotes?: number | null;
  tmdbRating?: number | null;
  tmdbVotes?: number | null;
  rtTomatometer?: number | null;
  rtPopcorn?: number | null;
  runtimeMinutes?: number | null;
  resolution?: Resolution | null;
  genres?: string[];
  arrAddedAt?: Date | null;
  /** ADR-051 C-05 / DESIGN-026 D-05 — the canonical Date RELEASED (Radarr digitalRelease ?? inCinemas
   *  ?? physicalRelease; Sonarr firstAired; Lidarr null). Null sorts NULLS-LAST like every nullable sort. */
  releasedAt?: Date | null;
  playCount?: number | null;
  lastViewedAt?: Date | null;
  /** DESIGN-010 D-12 — the cross-server watch-visibility pair (same MAX instant as lastViewedAt, plus
   *  its origin estate slug). Info only — no protection semantics ride these. */
  lastWatchedAt?: Date | null;
  lastWatchedServer?: string | null;
  requesters?: string[];
  sourceCollections?: string[];
  posterSource?: PosterSource | null;
  posterRef?: string | null;
  /** which tiers contributed this harvest, e.g. {arr:true, tautulli:true, maintainerr:false}. */
  sources?: Record<string, boolean>;
  extra?: Record<string, unknown>;
}

export interface UpsertMediaMetadataBatchInput {
  db?: DbClient;
  rows: MediaMetadataFields[];
}

export interface UpsertMediaMetadataBatchResult {
  written: number;
}

/** numeric columns take a string on the wire (drizzle default); null passes through. */
function num(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function int(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : value;
}

/**
 * ADR-018 / DESIGN-008 D-12 — the SINGLE WRITER for media_metadata (the no-direct-state-writes
 * guard forbids any other module from touching the table). Upserts on media_item_id
 * (ON CONFLICT DO UPDATE): a refresh REPLACES the row from the freshly-harvested tiers so the
 * synced copy tracks the *arrs (a briefly-down Tautulli tier just leaves watch-stats null this
 * cycle and self-heals next cycle). fetched_at advances every write (the D-03 staleness key).
 * Batched by the caller (harvest passes ~500/tx, mirroring media-sync.ts).
 *
 * Metadata is NOT a guarded-audit aggregate (no per-row audit event — it is synced descriptive
 * data, the same class as media_items itself); it is single-writer-confined so the guard passes.
 */
export async function upsertMediaMetadataBatch(
  input: UpsertMediaMetadataBatchInput,
): Promise<UpsertMediaMetadataBatchResult> {
  if (input.rows.length === 0) return { written: 0 };
  return inTransaction(input.db, async (tx) => {
    const values = input.rows.map((r) => ({
      mediaItemId: r.mediaItemId,
      imdbRating: num(r.imdbRating),
      imdbVotes: int(r.imdbVotes),
      tmdbRating: num(r.tmdbRating),
      tmdbVotes: int(r.tmdbVotes),
      rtTomatometer: int(r.rtTomatometer),
      rtPopcorn: int(r.rtPopcorn),
      runtimeMinutes: int(r.runtimeMinutes),
      resolution: r.resolution ?? null,
      genres: r.genres ?? [],
      arrAddedAt: r.arrAddedAt ?? null,
      releasedAt: r.releasedAt ?? null,
      playCount: int(r.playCount),
      lastViewedAt: r.lastViewedAt ?? null,
      lastWatchedAt: r.lastWatchedAt ?? null,
      lastWatchedServer: r.lastWatchedServer ?? null,
      requesters: r.requesters ?? [],
      sourceCollections: r.sourceCollections ?? [],
      posterSource: r.posterSource ?? null,
      posterRef: r.posterRef ?? null,
      sources: r.sources ?? {},
      extra: r.extra ?? {},
    }));

    await tx
      .insert(mediaMetadata)
      .values(values)
      .onConflictDoUpdate({
        target: mediaMetadata.mediaItemId,
        // Full replace from the just-harvested row (excluded.*) — the synced-copy semantics.
        set: {
          imdbRating: sql`excluded.imdb_rating`,
          imdbVotes: sql`excluded.imdb_votes`,
          tmdbRating: sql`excluded.tmdb_rating`,
          tmdbVotes: sql`excluded.tmdb_votes`,
          rtTomatometer: sql`excluded.rt_tomatometer`,
          rtPopcorn: sql`excluded.rt_popcorn`,
          runtimeMinutes: sql`excluded.runtime_minutes`,
          resolution: sql`excluded.resolution`,
          genres: sql`excluded.genres`,
          arrAddedAt: sql`excluded.arr_added_at`,
          releasedAt: sql`excluded.released_at`,
          playCount: sql`excluded.play_count`,
          lastViewedAt: sql`excluded.last_viewed_at`,
          lastWatchedAt: sql`excluded.last_watched_at`,
          lastWatchedServer: sql`excluded.last_watched_server`,
          requesters: sql`excluded.requesters`,
          sourceCollections: sql`excluded.source_collections`,
          posterSource: sql`excluded.poster_source`,
          posterRef: sql`excluded.poster_ref`,
          sources: sql`excluded.sources`,
          extra: sql`excluded.extra`,
          fetchedAt: sql`now()`,
          updatedAt: sql`now()`,
        },
      });

    return { written: values.length };
  });
}

/**
 * DESIGN-008 D-07 — parse the raw *arr tag LABELS into structured, filterable dimensions
 * (live-verified taxonomy 2026-07-06). Two dimensions:
 *   • REQUESTER tags encode `<n>-<user>` (e.g. `1-manofoz`, `23-helmu15`) — the Seerr/porting
 *     convention where a numeric prefix precedes the requesting user → a KEEP signal. The
 *     captured `<user>` is the requester.
 *   • Every OTHER tag is a COLLECTION provenance (Kometa/PMM auto-collections + import tags:
 *     `emmycollection`, `showcollection`, `kometa-added`, `traktrecommended`, `tmdbpopular`, …)
 *     → recorded verbatim as source_collections.
 * The raw media_items.arr_tags snapshot is untouched; these are the parsed projections.
 */
const REQUESTER_TAG = /^\d+-(.+)$/;

export function parseArrTags(tags: readonly string[]): {
  requesters: string[];
  sourceCollections: string[];
} {
  const requesters: string[] = [];
  const sourceCollections: string[] = [];
  for (const tag of tags) {
    const m = REQUESTER_TAG.exec(tag);
    if (m) {
      const user = m[1]!.trim();
      if (user && !requesters.includes(user)) requesters.push(user);
    } else {
      const c = tag.trim();
      if (c && !sourceCollections.includes(c)) sourceCollections.push(c);
    }
  }
  return { requesters, sourceCollections };
}
