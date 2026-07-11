// ADR-047 / DESIGN-025 (PLAN-028 — Library "Watch/Listen/Read here" deep links). THE INVARIANT enforcement
// on the @hnet/api side: the SQL WHERE predicate + per-item checks + the "Watch on Plex" deep-link resolver
// + the server-side tab-visibility resolvers. All access decisions come from @hnet/domain's
// resolveLibraryAccessGate (which REUSES the ADR-024 effective-library resolver) — this module only turns
// the gate into query predicates the ledger router / poster route / library page apply.
//
// A title can live in SEVERAL Plex libraries (mirrored across servers), so the predicates use EXISTS
// subqueries over media_plex_matches (NOT a join — a join would multiply an item's row per library) and the
// detail view gets ONE gated "Watch on Plex — <library>" target per accessible library.
import { eq, sql, type SQL } from 'drizzle-orm';
import {
  db as defaultDb,
  mediaItems,
  mediaPlexMatches,
  plexLibraries,
  plexServers,
  type ArrKind,
  type Database,
  type DbClient,
  type PlexServerSlug,
} from '@hnet/db';
import {
  buildPlexWebDeepLink,
  isMediaItemAccessible,
  resolveLibraryAccessGate,
  type LibraryAccessGate,
} from '@hnet/domain';

export { resolveLibraryAccessGate, buildPlexWebDeepLink, type LibraryAccessGate };

/** `libId IN (…)` bound-param list, or `false` when the set is empty. */
function inLibs(col: SQL, ids: string[]): SQL {
  if (ids.length === 0) return sql`false`;
  return sql`${col} IN (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/** `kindKey IN (…)` bound-param list, or `false` when empty. */
function inKinds(kindExpr: SQL, keys: string[]): SQL {
  if (keys.length === 0) return sql`false`;
  return sql`${kindExpr} IN (${sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  )})`;
}

/**
 * THE INVARIANT predicate for a media_items query. No join required (EXISTS subqueries, so an item in
 * several libraries is not duplicated): keep an item iff it has a match in an allowed library, OR it has NO
 * match at all and its (kind,instance) home is accessible. `null` for an unrestricted (admin) caller.
 */
export function libraryAccessWhere(gate: LibraryAccessGate): SQL | null {
  if (gate.unrestricted) return null;
  const allowedMatch = sql`EXISTS (SELECT 1 FROM media_plex_matches mpx WHERE mpx.media_item_id = ${mediaItems.id} AND ${inLibs(sql`mpx.plex_library_id`, [...gate.allowedLibraryIds])})`;
  const kindExpr = sql`(${mediaItems.arrKind} || ':' || ${mediaItems.arrInstanceId})`;
  const unmatchedAllowed = sql`(NOT EXISTS (SELECT 1 FROM media_plex_matches mpx WHERE mpx.media_item_id = ${mediaItems.id}) AND ${inKinds(kindExpr, [...gate.allowedKindKeys])})`;
  return sql`(${allowedMatch} OR ${unmatchedAllowed})`;
}

/**
 * Same predicate for a RAW facet query that aliases media_items `mi` (ledger.filterFacets). Returns null
 * for an unrestricted caller. Uses its own `m2` correlation alias inside the subqueries.
 */
export function libraryAccessConditionRaw(gate: LibraryAccessGate, miAlias = 'mi'): SQL | null {
  if (gate.unrestricted) return null;
  const mi = sql.raw(miAlias);
  const allowedMatch = sql`EXISTS (SELECT 1 FROM media_plex_matches m2 WHERE m2.media_item_id = ${mi}.id AND ${inLibs(sql`m2.plex_library_id`, [...gate.allowedLibraryIds])})`;
  const kindExpr = sql`(${mi}.arr_kind || ':' || ${mi}.arr_instance_id)`;
  const unmatchedAllowed = sql`(NOT EXISTS (SELECT 1 FROM media_plex_matches m2 WHERE m2.media_item_id = ${mi}.id) AND ${inKinds(kindExpr, [...gate.allowedKindKeys])})`;
  return sql`(${allowedMatch} OR ${unmatchedAllowed})`;
}

/** Every Plex library id an item matched into (empty ⇒ unmatched). */
export async function matchLibraryIdsForItem(
  database: DbClient,
  mediaItemId: string,
): Promise<string[]> {
  const rows = await database
    .select({ plexLibraryId: mediaPlexMatches.plexLibraryId })
    .from(mediaPlexMatches)
    .where(eq(mediaPlexMatches.mediaItemId, mediaItemId));
  return rows.map((r) => r.plexLibraryId);
}

/**
 * Per-item access check by id (detail / events / children paths, which fetch by id and must re-gate so a
 * hidden item can't be reached directly). Missing item ⇒ denied.
 */
export async function itemAccessById(
  database: DbClient,
  gate: LibraryAccessGate,
  mediaItemId: string,
): Promise<boolean> {
  if (gate.unrestricted) return true;
  const [item] = await database
    .select({ arrKind: mediaItems.arrKind, arrInstanceId: mediaItems.arrInstanceId })
    .from(mediaItems)
    .where(eq(mediaItems.id, mediaItemId));
  if (!item) return false;
  const matchLibraryIds = await matchLibraryIdsForItem(database, mediaItemId);
  return isMediaItemAccessible(gate, {
    arrKind: item.arrKind,
    arrInstanceId: item.arrInstanceId,
    matchLibraryIds,
  });
}

/** The poster-proxy gate: resolve the caller's gate + check one item (ADR-047 — the cover proxy is a
 *  parallel leak vector; it must apply the SAME per-item access as the tRPC surface). */
export async function isMediaItemAccessibleToUser(
  userId: string,
  mediaItemId: string,
  database: Database = defaultDb,
): Promise<boolean> {
  const gate = await resolveLibraryAccessGate(userId, database);
  return itemAccessById(database, gate, mediaItemId);
}

export interface PlexPlayTarget {
  app: 'plex';
  /** The primary-button label, e.g. "Watch on Plex — HNet Movies". */
  label: string;
  /** The Plex library this button opens the title in. */
  libraryName: string;
  url: string;
}

/**
 * The "Watch on Plex" deep links for a PRESENT, matched item — ONE per Plex library the caller can access
 * (unrestricted ⇒ all matched libraries), each labeled with its library name. Empty for a missing/unmatched
 * item or when the caller can access none of its libraries (PLAN-028 Q-D + owner UX ruling 2026-07-11).
 */
export async function resolvePlexPlayTargets(
  database: DbClient,
  gate: LibraryAccessGate,
  mediaItemId: string,
  present: boolean,
): Promise<PlexPlayTarget[]> {
  if (!present) return [];
  const rows = await database
    .select({
      plexLibraryId: mediaPlexMatches.plexLibraryId,
      ratingKey: mediaPlexMatches.ratingKey,
      libraryName: plexLibraries.name,
      machineIdentifier: plexServers.machineIdentifier,
    })
    .from(mediaPlexMatches)
    .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId))
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(eq(mediaPlexMatches.mediaItemId, mediaItemId))
    .orderBy(plexServers.slug, plexLibraries.name);
  return rows
    .filter((r) => gate.unrestricted || gate.allowedLibraryIds.has(r.plexLibraryId))
    .map((r) => ({
      app: 'plex' as const,
      label: `Watch on Plex — ${r.libraryName}`,
      libraryName: r.libraryName,
      url: buildPlexWebDeepLink(r.machineIdentifier, r.ratingKey),
    }));
}

export interface PlexArtMatch {
  /** The matched Plex server the season/episode art is read + transcoded from. */
  serverSlug: PlexServerSlug;
  /** The matched Plex title's ratingKey (the show, for a TV item) — the art subtree root. */
  ratingKey: string;
}

/**
 * ADR-048 / DESIGN-005 D-22 (PLAN-030) — the FIRST accessible *arr→Plex match for an item's season/episode
 * art (server slug + the matched title's ratingKey). Reuses the ADR-047 match join + the SAME accessibility
 * filter as resolvePlexPlayTargets (a title mirrored across several libraries picks the first the caller can
 * access, ordered by server slug then library name for determinism). null ⇒ unmatched OR the caller can
 * access none of its libraries — so the season rows simply show no art (PLAN-030 Q-01; THE INVARIANT: a
 * withheld title never yields an art source). Read-only.
 */
export async function resolveArtMatchForItem(
  database: DbClient,
  gate: LibraryAccessGate,
  mediaItemId: string,
): Promise<PlexArtMatch | null> {
  const rows = await database
    .select({
      plexLibraryId: mediaPlexMatches.plexLibraryId,
      ratingKey: mediaPlexMatches.ratingKey,
      serverSlug: plexServers.slug,
    })
    .from(mediaPlexMatches)
    .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId))
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(eq(mediaPlexMatches.mediaItemId, mediaItemId))
    .orderBy(plexServers.slug, plexLibraries.name);
  const hit = rows.find((r) => gate.unrestricted || gate.allowedLibraryIds.has(r.plexLibraryId));
  return hit ? { serverSlug: hit.serverSlug, ratingKey: hit.ratingKey } : null;
}

/**
 * Server-side Movies/TV/Music tab visibility for the /library page: a kind's tab shows iff the caller can
 * access that kind's home Plex library (admin ⇒ all three). Mirrors the ytdlsubVisible/booksVisible pattern.
 */
export async function resolveMediaTabVisibility(
  userId: string,
  database: Database = defaultDb,
): Promise<Record<ArrKind, boolean>> {
  const gate = await resolveLibraryAccessGate(userId, database);
  return {
    radarr: gate.unrestricted || gate.visibleArrKinds.has('radarr'),
    sonarr: gate.unrestricted || gate.visibleArrKinds.has('sonarr'),
    lidarr: gate.unrestricted || gate.visibleArrKinds.has('lidarr'),
  };
}
