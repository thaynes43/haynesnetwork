// ADR-047 / DESIGN-025 (PLAN-028 — Library deep links) — the SINGLE WRITER for the *arr→Plex match cache
// (`media_plex_matches`). The `plex-match` sync mode resolves each ledger media_item to its exact Plex
// {library, ratingKey} by shared-GUID match inside the fitting library type (ADR-123: radarr→movie,
// sonarr→show, lidarr→artist). The @hnet/sync fetcher knows the Plex wire shape and hands the resolved
// rows here to be UPSERTED (one row per media_item), stripped of any cross-type row, then RECONCILED (a
// title that dropped out of a fully-read library is removed) — all in one transaction. Rebuildable derived cache (the *arrs + Plex
// are the sources of truth), so no per-row audit event; the no-direct-state-writes guard forbids any other
// module from touching the table.
import {
  mediaItems,
  mediaPlexMatches,
  plexLibraries,
  plexServers,
  type ArrKind,
  type DbClient,
  type PlexMatchGuidSource,
  type PlexMediaType,
} from '@hnet/db';
import { and, eq, inArray, lt, not, or, sql, type SQL } from 'drizzle-orm';
import { inTransaction } from './db-client';

/**
 * ADR-123 / DESIGN-025 D-10 — the library type a ledger kind may match. TMDB and TVDB number movies and
 * shows separately, and the same number in the other library is a different title. Every GUID kind
 * (tmdb, imdb, tvdb, musicbrainz) is looked up only inside this type. A photo library fits nothing.
 */
export const FITTING_PLEX_MEDIA_TYPE = {
  radarr: 'movie',
  sonarr: 'show',
  lidarr: 'artist',
} as const satisfies Record<ArrKind, PlexMediaType>;

/** One resolved *arr→Plex match the plex-match fetcher produced. */
export interface PlexMatchInput {
  mediaItemId: string;
  plexLibraryId: string;
  ratingKey: string;
  matchedVia: PlexMatchGuidSource;
  /** DESIGN-052 D-26 — the title's Plex `addedAt` in this library; null when Plex omits it (absent ⇒ null). */
  plexAddedAt?: Date | null;
}

export interface SyncPlexMatchesInput {
  db?: DbClient;
  matches: PlexMatchInput[];
  /**
   * plex_libraries.id whose Plex section was FULLY read this run. Reconciliation (stale-delete) is scoped
   * to these, so a server outage never wrongly drops matches for a library it couldn't read this run.
   */
  scopedLibraryIds: string[];
  now?: Date;
  /**
   * plex_libraries.id whose live section type disagreed with the registry this run. Left out of the
   * cross-type delete: the registry type would call a live-fitting row wrong, and the skipped
   * section will not put it back.
   */
  excludeCrossTypeLibraryIds?: readonly string[];
}

export interface SyncPlexMatchesReport {
  upserted: number;
  /** Stale matches removed (matched before into a scoped library, absent from this run's set). */
  removed: number;
  /**
   * ADR-123 — cross-type rows deleted after the upsert and before the reconcile, so a stale wrong
   * row in a fully read library is counted here rather than as `removed`. Includes one this run
   * just upserted and one in a library that was not read. A library whose live section type
   * disagreed with the registry is left out. A fitting row is never deleted here.
   */
  crossTypeRemoved: number;
  /** The groups behind `crossTypeRemoved`. Empty when that count is 0. */
  crossTypeGroups: CrossTypePlexMatchGroup[];
}

/** One cross-type row the repair would delete, grouped the way the census counts them. */
export interface CrossTypePlexMatchGroup {
  serverSlug: string;
  libraryName: string;
  mediaType: PlexMediaType;
  arrKind: ArrKind;
  matchedVia: PlexMatchGuidSource;
  rows: number;
}

export interface CrossTypePlexMatchRepairReport {
  dryRun: boolean;
  /** Rows the fitting-pair rule selects. */
  selected: number;
  /** Rows deleted. 0 when `dryRun` is true. */
  removed: number;
  groups: CrossTypePlexMatchGroup[];
  /** One line per selected row, so a dry run can be read as a list. */
  titles: CrossTypePlexMatchTitle[];
}

/** One selected cross-type row, named so a person can read the dry run. */
export interface CrossTypePlexMatchTitle {
  title: string;
  year: number | null;
  arrKind: ArrKind;
  serverSlug: string;
  libraryName: string;
}

const CHUNK = 500;

/**
 * A match is cross-type when its library's media type is not the fitting type for its ledger kind.
 * Built from `FITTING_PLEX_MEDIA_TYPE` so the matcher and this delete name the same pairs.
 */
function crossTypeCondition(): SQL {
  const pairs = (Object.keys(FITTING_PLEX_MEDIA_TYPE) as ArrKind[]).map((arrKind) =>
    and(
      eq(mediaItems.arrKind, arrKind),
      eq(plexLibraries.mediaType, FITTING_PLEX_MEDIA_TYPE[arrKind]),
    ),
  );
  const built = pairs.filter((pair): pair is SQL => pair !== undefined);
  if (built.length !== Object.keys(FITTING_PLEX_MEDIA_TYPE).length) {
    throw new Error('plex-match fitting pairs did not build');
  }
  const fitting = or(...built);
  if (fitting === undefined) throw new Error('plex-match fitting pairs are empty');
  return not(fitting);
}

interface CrossTypeRow {
  id: string;
  title: string;
  year: number | null;
  serverSlug: string;
  libraryName: string;
  mediaType: PlexMediaType;
  arrKind: ArrKind;
  matchedVia: PlexMatchGuidSource;
}

async function selectCrossTypeRows(
  tx: DbClient,
  excludeLibraryIds: readonly string[],
): Promise<CrossTypeRow[]> {
  const fitting = crossTypeCondition();
  const where =
    excludeLibraryIds.length === 0
      ? fitting
      : and(fitting, not(inArray(mediaPlexMatches.plexLibraryId, [...excludeLibraryIds])));
  if (where === undefined) throw new Error('plex-match cross-type filter did not build');
  const rows = await tx
    .select({
      id: mediaPlexMatches.id,
      title: mediaItems.title,
      year: mediaItems.year,
      serverSlug: plexServers.slug,
      libraryName: plexLibraries.name,
      mediaType: plexLibraries.mediaType,
      arrKind: mediaItems.arrKind,
      matchedVia: mediaPlexMatches.matchedVia,
    })
    .from(mediaPlexMatches)
    .innerJoin(mediaItems, eq(mediaItems.id, mediaPlexMatches.mediaItemId))
    .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId))
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(where);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    year: row.year,
    serverSlug: row.serverSlug,
    libraryName: row.libraryName,
    mediaType: row.mediaType,
    arrKind: row.arrKind,
    matchedVia: row.matchedVia,
  }));
}

function groupCrossTypeRows(rows: readonly CrossTypeRow[]): CrossTypePlexMatchGroup[] {
  const groups = new Map<string, CrossTypePlexMatchGroup>();
  for (const row of rows) {
    const key = [row.serverSlug, row.libraryName, row.mediaType, row.arrKind, row.matchedVia].join(
      '\u0000',
    );
    const existing = groups.get(key);
    if (existing) {
      existing.rows += 1;
      continue;
    }
    groups.set(key, {
      serverSlug: row.serverSlug,
      libraryName: row.libraryName,
      mediaType: row.mediaType,
      arrKind: row.arrKind,
      matchedVia: row.matchedVia,
      rows: 1,
    });
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.serverSlug.localeCompare(b.serverSlug) ||
      a.libraryName.localeCompare(b.libraryName) ||
      a.arrKind.localeCompare(b.arrKind) ||
      a.matchedVia.localeCompare(b.matchedVia),
  );
}

function listCrossTypeTitles(rows: readonly CrossTypeRow[]): CrossTypePlexMatchTitle[] {
  return rows
    .map((row) => ({
      title: row.title,
      year: row.year,
      arrKind: row.arrKind,
      serverSlug: row.serverSlug,
      libraryName: row.libraryName,
    }))
    .sort(
      (a, b) =>
        a.title.localeCompare(b.title) ||
        (a.year ?? 0) - (b.year ?? 0) ||
        a.arrKind.localeCompare(b.arrKind) ||
        a.serverSlug.localeCompare(b.serverSlug) ||
        a.libraryName.localeCompare(b.libraryName),
    );
}

/**
 * ADR-123 / DESIGN-025 D-10 — delete cross-type `media_plex_matches` rows and nothing else.
 * `dryRun` selects and writes nothing. A second apply selects nothing. The plex-match sync calls this
 * with `dryRun: false` after its upsert and before its reconcile, so a stale wrong row in a fully
 * read library is counted as `crossTypeRemoved`. `excludeLibraryIds` leaves out a library whose live
 * section type disagreed with the registry.
 */
export async function repairCrossTypePlexMatches(input: {
  db?: DbClient;
  dryRun: boolean;
  excludeLibraryIds?: readonly string[];
}): Promise<CrossTypePlexMatchRepairReport> {
  let selected: CrossTypeRow[] = [];
  let removed = 0;
  await inTransaction(input.db, async (tx) => {
    selected = await selectCrossTypeRows(tx, input.excludeLibraryIds ?? []);
    if (input.dryRun || selected.length === 0) return;
    const ids = selected.map((row) => row.id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const deleted = await tx
        .delete(mediaPlexMatches)
        .where(inArray(mediaPlexMatches.id, chunk))
        .returning({ id: mediaPlexMatches.id });
      removed += deleted.length;
    }
  });
  return {
    dryRun: input.dryRun,
    selected: selected.length,
    removed,
    groups: groupCrossTypeRows(selected),
    titles: listCrossTypeTitles(selected),
  };
}

/**
 * ADR-047 — upsert the fresh match set on `(media_item_id, plex_library_id)` (ON CONFLICT DO UPDATE: a
 * re-match REPLACES the ratingKey/matched_via and advances last_seen_at) then RECONCILE: delete any row of a
 * fully-read library whose last_seen_at predates the run (its title left that library). One transaction; no
 * per-row audit (derived cache). A title in several libraries has several rows — each is upserted separately.
 */
export async function syncPlexMatches(input: SyncPlexMatchesInput): Promise<SyncPlexMatchesReport> {
  const runStart = input.now ?? new Date();
  const values = input.matches.map((m) => ({
    mediaItemId: m.mediaItemId,
    plexLibraryId: m.plexLibraryId,
    ratingKey: m.ratingKey,
    matchedVia: m.matchedVia,
    plexAddedAt: m.plexAddedAt ?? null,
    firstSeenAt: runStart,
    lastSeenAt: runStart,
    updatedAt: runStart,
  }));

  let removed = 0;
  let crossTypeRemoved = 0;
  let crossTypeGroups: CrossTypePlexMatchGroup[] = [];

  await inTransaction(input.db, async (tx) => {
    for (let i = 0; i < values.length; i += CHUNK) {
      const chunk = values.slice(i, i + CHUNK);
      await tx
        .insert(mediaPlexMatches)
        .values(chunk)
        .onConflictDoUpdate({
          target: [mediaPlexMatches.mediaItemId, mediaPlexMatches.plexLibraryId],
          set: {
            ratingKey: sql`excluded.rating_key`,
            matchedVia: sql`excluded.matched_via`,
            // DESIGN-052 D-26 — re-stamped every run: a re-keyed title (a replaced file) carries its new date added.
            plexAddedAt: sql`excluded.plex_added_at`,
            lastSeenAt: sql`excluded.last_seen_at`,
            updatedAt: sql`excluded.updated_at`,
            // firstSeenAt / createdAt keep their original values (not in the set).
          },
        });
    }

    // ADR-123 — before reconcile, so a stale wrong row in a fully read library is counted here
    // (reconcile would otherwise delete it as `removed` and this count would stay 0). A library
    // whose live type disagreed with the registry is left out.
    const repair = await repairCrossTypePlexMatches({
      db: tx,
      dryRun: false,
      ...(input.excludeCrossTypeLibraryIds !== undefined
        ? { excludeLibraryIds: input.excludeCrossTypeLibraryIds }
        : {}),
    });
    crossTypeRemoved = repair.removed;
    crossTypeGroups = repair.groups;

    if (input.scopedLibraryIds.length > 0) {
      const result = await tx
        .delete(mediaPlexMatches)
        .where(
          and(
            inArray(mediaPlexMatches.plexLibraryId, input.scopedLibraryIds),
            lt(mediaPlexMatches.lastSeenAt, runStart),
          ),
        )
        .returning({ id: mediaPlexMatches.id });
      removed = result.length;
    }
  });

  return { upserted: values.length, removed, crossTypeRemoved, crossTypeGroups };
}
