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

export interface RunForceSearchInput {
  db?: DbClient;
  arr: ArrClientBundle;
  requesterId: string;
  /** Admins bypass the shared hourly budget (D-17). */
  requesterIsAdmin?: boolean;
  mediaItemId: string;
  /** Episode id (sonarr) / album id (lidarr); absent for radarr or a whole-series search. */
  targetChildId?: number;
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
  const targetChildId = input.targetChildId;

  // Resolve the display label for a child target (D-06 live children). A read failure
  // here aborts BEFORE the audit row — nothing has been promised yet.
  let targetLabel: string | null = null;
  if ((kind === 'sonarr' || kind === 'lidarr') && targetChildId !== undefined) {
    const children = await listMediaChildren({
      db: input.db,
      arr: input.arr,
      mediaItemId: item.id,
    });
    const child = children.find((c) => c.arrChildId === targetChildId);
    if (!child) {
      throw new NotFoundError(
        `${kind} ${kind === 'sonarr' ? 'episode' : 'album'} ${targetChildId} not found on live item ${item.arrItemId}`,
      );
    }
    targetLabel = child.label;
  }

  // D-17: audit event commits (budget-checked, attributed) before the *arr call.
  const { eventId } = await recordSearchRequest({
    db: input.db,
    requesterId: input.requesterId,
    requesterIsAdmin: input.requesterIsAdmin,
    mediaItemId: item.id,
    targetArrChildId: targetChildId ?? null,
    targetLabel,
  });

  // Search only — no mark-failed, no delete (ADR-008: this is the whole point).
  try {
    let commandName: string;
    if (kind === 'sonarr') {
      const command =
        targetChildId !== undefined
          ? await input.arr.write.sonarr.searchEpisodes([targetChildId])
          : await input.arr.write.sonarr.searchSeries(item.arrItemId);
      commandName = command.name;
    } else if (kind === 'radarr') {
      const command = await input.arr.write.radarr.searchMovies([item.arrItemId]);
      commandName = command.name;
    } else {
      const command = await input.arr.write.lidarr.searchAlbums([targetChildId!]);
      commandName = command.name;
    }
    return { eventId, targetLabel, commandName };
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
