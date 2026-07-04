// DESIGN-005 D-17 — Force Search orchestrator (ADR-008 sanctioned write: search only).
// Missing content is "not broken, just missing", so this path triggers ONLY the owning
// *arr's search command — never history/failed, never a file delete, no reason. Steps:
//
//   1. validate item (exists, not tombstoned) + resolve the live child label if a
//      sonarr episode / lidarr album target was given (read-only);
//   2. recordSearchRequest — the audited 'search_requested' ledger event, committed
//      under the shared per-requester hourly budget BEFORE the *arr call (D-07/D-17);
//   3. POST /command (EpisodeSearch | SeriesSearch | MoviesSearch | AlbumSearch).
//
// Lives in packages/domain so @hnet/arr/write stays confined here (D-12/D-18 guard).
import { mediaItems, type DbClient } from '@hnet/db';
import { eq } from 'drizzle-orm';
import { ArrError } from '@hnet/arr';
import { ArrUpstreamError, LedgerItemTombstonedError, NotFoundError } from './errors';
import { resolveDb } from './db-client';
import { recordSearchRequest } from './search-requests';
import { type ArrClientBundle } from './arr-clients';
import { listMediaChildren } from './media-children';
import { resolveSearchTarget, type SearchScope } from './action-scope';

export interface RunForceSearchInput {
  db?: DbClient;
  arr: ArrClientBundle;
  requesterId: string;
  /** Admins bypass the shared hourly budget (D-17). */
  requesterIsAdmin?: boolean;
  mediaItemId: string;
  /**
   * The roll-up scope (media-hierarchy actions): radarr 'item'; sonarr 'show' |
   * 'season' | 'episode'; lidarr 'artist' | 'album'. Omitted ⇒ the legacy default.
   */
  scope?: SearchScope;
  /** Episode id (sonarr) / album id (lidarr) — for the 'episode'/'album' scopes. */
  targetChildId?: number;
  /** Sonarr season number — for the 'season' scope. */
  seasonNumber?: number;
}

export interface RunForceSearchResult {
  eventId: string;
  targetLabel: string | null;
  /** The *arr command that was accepted, e.g. 'EpisodeSearch' — surfaced to the UI. */
  commandName: string;
}

export async function runForceSearch(input: RunForceSearchInput): Promise<RunForceSearchResult> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      title: mediaItems.title,
      deletedFromArrAt: mediaItems.deletedFromArrAt,
    })
    .from(mediaItems)
    .where(eq(mediaItems.id, input.mediaItemId));
  if (!item) throw new NotFoundError(`Media item ${input.mediaItemId} not found`);
  if (item.deletedFromArrAt !== null) {
    throw new LedgerItemTombstonedError(
      `Media item ${input.mediaItemId} is tombstoned — nothing to search in the *arr`,
    );
  }

  const kind = item.arrKind;
  // Validate the (kind, scope, child, season) tuple up front — a bad combo aborts
  // BEFORE the audit row (nothing promised yet). Kind/scope mismatches throw here.
  const { scope, targetChildId, seasonNumber } = resolveSearchTarget(kind, {
    scope: input.scope,
    targetChildId: input.targetChildId,
    seasonNumber: input.seasonNumber,
  });

  // Resolve the display label per scope (child labels come from the D-06 live children;
  // a read failure here still precedes the audit row). Whole-show/artist use the title.
  let targetLabel: string | null = null;
  if (scope === 'episode' || scope === 'album') {
    const children = await listMediaChildren({ db: input.db, arr: input.arr, mediaItemId: item.id });
    const child = children.find((c) => c.arrChildId === targetChildId);
    if (!child) {
      throw new NotFoundError(
        `${kind} ${scope} ${targetChildId} not found on live item ${item.arrItemId}`,
      );
    }
    targetLabel = child.label;
  } else if (scope === 'season') {
    targetLabel = `Season ${seasonNumber}`;
  } else if (scope === 'show' || scope === 'artist') {
    targetLabel = item.title;
  }

  // D-17: audit event commits (budget-checked, attributed) before the *arr call.
  const { eventId } = await recordSearchRequest({
    db: input.db,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    mediaItemId: item.id,
    scope,
    targetArrChildId: targetChildId,
    seasonNumber,
    targetLabel,
  });

  // Search only — no mark-failed, no delete (ADR-008: this is the whole point).
  try {
    const write = input.arr.write;
    const command =
      scope === 'episode'
        ? await write.sonarr.searchEpisodes([targetChildId!])
        : scope === 'season'
          ? await write.sonarr.searchSeason(item.arrItemId, seasonNumber!)
          : scope === 'show'
            ? await write.sonarr.searchSeries(item.arrItemId)
            : scope === 'album'
              ? await write.lidarr.searchAlbums([targetChildId!])
              : scope === 'artist'
                ? await write.lidarr.searchArtist(item.arrItemId)
                : await write.radarr.searchMovies([item.arrItemId]); // 'item'
    return { eventId, targetLabel, commandName: command.name };
  } catch (err) {
    if (err instanceof ArrError) {
      throw new ArrUpstreamError(
        err instanceof Error ? err.message : 'force-search command failed',
        { cause: err },
      );
    }
    throw err;
  }
}
