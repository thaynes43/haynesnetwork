// DESIGN-049 D-09 step 4 / D-14 — what the *arr ledger knows about a title: its genres (the Taste Profile
// reads ledger genres first, D-16) and, for shows, whether Sonarr says it ended (D-07 `show_status`).
// SELECT only.
import { mediaItems, mediaMetadata, type DbClient, type WatchShowStatus } from '@hnet/db';
import { eq, inArray } from 'drizzle-orm';

export interface LedgerFacts {
  mediaItemId: string;
  genres: string[];
  showStatus: WatchShowStatus | null;
}

/** Sonarr's `ended` / `status` → the D-07 `show_status` (`upcoming` counts as continuing). */
export function showStatusOf(attrs: Record<string, unknown> | null | undefined): WatchShowStatus | null {
  if (!attrs) return null;
  if (attrs.ended === true) return 'ended';
  const status = typeof attrs.status === 'string' ? attrs.status.toLowerCase() : '';
  if (status === 'ended') return 'ended';
  if (status === 'continuing' || status === 'upcoming') return 'continuing';
  return null;
}

export async function selectLedgerFacts(
  db: DbClient,
  mediaItemIds: readonly string[],
): Promise<LedgerFacts[]> {
  if (mediaItemIds.length === 0) return [];
  const rows = await db
    .select({
      mediaItemId: mediaItems.id,
      arrKind: mediaItems.arrKind,
      arrAttrs: mediaItems.arrAttrs,
      genres: mediaMetadata.genres,
    })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(inArray(mediaItems.id, [...mediaItemIds]));
  return rows.map((r) => ({
    mediaItemId: r.mediaItemId,
    genres: r.genres ?? [],
    showStatus: r.arrKind === 'sonarr' ? showStatusOf(r.arrAttrs) : null,
  }));
}
