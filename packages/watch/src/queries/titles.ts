// DESIGN-049 D-07/D-14 — Title State and ledger-availability reads. SELECT only.
import {
  mediaPlexMatches,
  plexLibraries,
  plexServers,
  watchTitles,
  type DbClient,
  type PlexServerSlug,
  type WatchTitleRow,
} from '@hnet/db';
import { and, eq, inArray } from 'drizzle-orm';
import { keysOf } from '../identity';
import type { TitleIds, WatchKind } from '../types';

/** Title States of the owner: all of them, one kind, or the given row ids. */
export async function selectTitleRows(
  db: DbClient,
  plexAccountId: number,
  opts: { ids?: readonly number[]; kind?: WatchKind | null } = {},
): Promise<WatchTitleRow[]> {
  const where = [eq(watchTitles.plexAccountId, plexAccountId)];
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    where.push(inArray(watchTitles.id, [...opts.ids]));
  }
  if (opts.kind) where.push(eq(watchTitles.kind, opts.kind));
  return db
    .select()
    .from(watchTitles)
    .where(and(...where));
}

/**
 * The owner's Title State rows that ARE a given title: those sharing any identity key with it (same
 * kind). Usually one; a second can exist when two rows were created before a key linked them.
 */
export async function selectTitleRowsByIdentity(
  db: DbClient,
  plexAccountId: number,
  ids: TitleIds & { titleKey?: string | null },
): Promise<WatchTitleRow[]> {
  const light = await db
    .select({
      id: watchTitles.id,
      kind: watchTitles.kind,
      titleKey: watchTitles.titleKey,
      title: watchTitles.title,
      year: watchTitles.year,
      plexGuid: watchTitles.plexGuid,
      tmdbId: watchTitles.tmdbId,
      tvdbId: watchTitles.tvdbId,
      imdbId: watchTitles.imdbId,
    })
    .from(watchTitles)
    .where(and(eq(watchTitles.plexAccountId, plexAccountId), eq(watchTitles.kind, ids.kind)));
  const wanted = new Set(keysOf(ids));
  const hits = light.filter((r) => keysOf(r).some((k) => wanted.has(k))).map((r) => r.id);
  const rows = await selectTitleRows(db, plexAccountId, { ids: hits });
  // The exact key first, then the oldest row.
  return rows.sort(
    (a, b) => Number(b.titleKey === ids.titleKey) - Number(a.titleKey === ids.titleKey) || a.id - b.id,
  );
}

/** Where a ledger item is on Plex now (D-14 step 2's second source): `media_plex_matches` by server. */
export interface LedgerHolder {
  mediaItemId: string;
  server: PlexServerSlug;
  ratingKey: string;
  /** When the match was first seen — when the title arrived on Plex (D-19 "new on Plex"). */
  firstSeenAt: Date;
}

export async function selectLedgerHolders(
  db: DbClient,
  mediaItemIds: readonly string[],
): Promise<LedgerHolder[]> {
  if (mediaItemIds.length === 0) return [];
  return db
    .select({
      mediaItemId: mediaPlexMatches.mediaItemId,
      server: plexServers.slug,
      ratingKey: mediaPlexMatches.ratingKey,
      firstSeenAt: mediaPlexMatches.firstSeenAt,
    })
    .from(mediaPlexMatches)
    .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId))
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(inArray(mediaPlexMatches.mediaItemId, [...mediaItemIds]));
}
