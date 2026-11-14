// DESIGN-008 D-15/Q-16: one-off, positive-proof repair. Never called by a harvest.
import {
  mediaItems,
  mediaPlexMatches,
  plexLibraries,
  plexServers,
  userAccountMap,
  userMediaWatch,
  type DbClient,
} from '@hnet/db';
import {
  mergeUserWatchContributions,
  upsertUserMediaWatchBatch,
  type UserMediaWatchInput,
} from '@hnet/domain';
import { eq, isNull, sql } from 'drizzle-orm';
import type { MetadataSourceClients } from './clients';
import { loadPlexRatingGuids, plexRatingGuidKey } from './db-reads';
import { lookupHouseholdWatch, readHouseholdWatch, type TitleWatch } from './metadata-refresh';
import { usableWatchGuids, type WatchTarget } from './watch-identity';
import { noopLogger } from './logger';

export interface ViewerRepairReport {
  complete: boolean;
  rowsExamined: number;
  rowsToClear: number;
  rowsCleared: number;
  titlesTouched: number;
  viewersTouched: number;
}

async function legacyCache(db: DbClient) {
  return db
    .select({
      slug: plexServers.slug,
      ratingKey: mediaPlexMatches.ratingKey,
      arrKind: mediaItems.arrKind,
      mediaType: plexLibraries.mediaType,
      tmdbId: mediaItems.tmdbId,
      tvdbId: mediaItems.tvdbId,
      imdbId: mediaItems.imdbId,
    })
    .from(mediaPlexMatches)
    .innerJoin(plexLibraries, eq(plexLibraries.id, mediaPlexMatches.plexLibraryId))
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .innerJoin(mediaItems, eq(mediaItems.id, mediaPlexMatches.mediaItemId));
}
const snapshot = (rows: readonly unknown[]) =>
  JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());

const liveIdentity = (rows: readonly (WatchTarget & { id: string })[]) =>
  snapshot(
    rows.map(({ id, arrKind, tmdbId, tvdbId, imdbId }) => ({
      id,
      arrKind,
      tmdbId,
      tvdbId,
      imdbId,
    })),
  );

function shares(a: Omit<WatchTarget, 'arrKind'>, b: Omit<WatchTarget, 'arrKind'>): boolean {
  const left = usableWatchGuids(a),
    right = usableWatchGuids(b);
  return (['tmdbId', 'tvdbId', 'imdbId'] as const).some(
    (k) => left[k] !== undefined && left[k] === right[k],
  );
}

export async function repairViewerContamination(input: {
  db: DbClient;
  tautulli: MetadataSourceClients['tautulli'];
  apply: boolean;
}): Promise<ViewerRepairReport> {
  const rawCache = await legacyCache(input.db);
  const initialLive = await input.db
    .select()
    .from(mediaItems)
    .where(isNull(mediaItems.deletedFromArrAt));
  const initialRows = new Map(
    (await input.db.select().from(userMediaWatch)).map((r) => [r.id, r.updatedAt.getTime()]),
  );
  const read = await readHouseholdWatch({
    sources: { tautulli: input.tautulli },
    logger: noopLogger,
    ratingKeyGuids: await loadPlexRatingGuids(input.db),
  });
  // Silence the reader completely: the CLI reports only aggregate proof outcomes.
  const titles = new Set<TitleWatch>();
  for (const map of [read.index.byTmdb, read.index.byTvdb, read.index.byImdb])
    for (const group of map.values()) for (const title of group) titles.add(title);
  const cached = new Map(rawCache.map((r) => [plexRatingGuidKey(r.slug, r.ratingKey), r]));
  const ratingKinds = new Map<string, Set<string>>();
  for (const tw of titles) {
    // Rating keys are retained only in memory to reconstruct the old cache route.
    const key = plexRatingGuidKey(tw.instanceSlug, tw.ratingKey);
    const kinds = ratingKinds.get(key) ?? new Set<string>();
    kinds.add(tw.arrKind);
    ratingKinds.set(key, kinds);
  }

  return input.db.transaction(async (tx) => {
    if (input.apply) {
      // Prevent a mapping/target/cache or row changing between proof and the domain writer.
      await tx.execute(sql`LOCK TABLE media_items, media_plex_matches, plex_libraries,
        plex_servers, user_account_map, user_media_watch IN SHARE ROW EXCLUSIVE MODE`);
    }
    const rows = await tx.select().from(userMediaWatch);
    const report: ViewerRepairReport = {
      complete: read.complete && !read.attributionIncomplete && titles.size > 0,
      rowsExamined: rows.length,
      rowsToClear: 0,
      rowsCleared: 0,
      titlesTouched: 0,
      viewersTouched: 0,
    };
    if (
      !read.complete ||
      read.attributionIncomplete ||
      titles.size === 0 ||
      snapshot(await legacyCache(tx)) !== snapshot(rawCache)
    ) {
      report.complete = false;
      return report;
    }
    const live = await tx.select().from(mediaItems).where(isNull(mediaItems.deletedFromArrAt));
    if (liveIdentity(live) !== liveIdentity(initialLive)) {
      report.complete = false;
      return report;
    }
    const mappings = new Map((await tx.select().from(userAccountMap)).map((r) => [r.userId, r]));
    const clears: UserMediaWatchInput[] = [];
    for (const row of rows) {
      if (initialRows.get(row.id) !== row.updatedAt.getTime()) continue;
      const target = live.find((t) => t.id === row.mediaItemId);
      const mapping = mappings.get(row.appUserId);
      if (
        !target ||
        !mapping?.plexUserId ||
        mapping.updatedAt >= row.updatedAt ||
        read.uncertainUsers.has(mapping.plexUserId)
      )
        continue;
      if (target.arrKind !== 'radarr' && target.arrKind !== 'sonarr') continue;
      const contaminated =
        target.tmdbId === 0 ||
        target.tvdbId === 0 ||
        live.some((t) => t.arrKind !== target.arrKind && shares(t, target));
      if (
        !contaminated ||
        lookupHouseholdWatch(read.index, target)?.perUser.has(mapping.plexUserId)
      )
        continue;
      const legacy: TitleWatch[] = [];
      let uncertain = false;
      for (const tw of titles) {
        const key = plexRatingGuidKey(tw.instanceSlug, tw.ratingKey);
        const old = cached.get(key);
        // Metadata-route zeros were already dropped by main's Number(id) || undefined.
        const ids = old ?? tw.guids;
        const oldMatch = (['tmdbId', 'tvdbId', 'imdbId'] as const).some(
          (k) => target[k] !== null && target[k] !== undefined && ids[k] === target[k],
        );
        if (!oldMatch || !tw.perUser.has(mapping.plexUserId)) continue;
        const accounted =
          [...tw.perUser.values()].reduce((n, v) => n + v.playCount, 0) === tw.playCount;
        if (
          !accounted ||
          ratingKinds.get(key)!.size !== 1 ||
          (old &&
            (old.arrKind !== tw.arrKind ||
              old.mediaType !== (tw.arrKind === 'radarr' ? 'movie' : 'show'))) ||
          !live.some((t) => t.id !== target.id && t.arrKind === tw.arrKind && shares(t, tw.guids))
        ) {
          uncertain = true;
          break;
        }
        legacy.push(tw);
      }
      if (uncertain || legacy.length === 0) continue;
      const was = mergeUserWatchContributions(
        legacy.map((tw) => tw.perUser.get(mapping.plexUserId!)!),
      );
      if (
        row.playCount !== was.playCount ||
        row.lastViewedAt?.getTime() !== was.lastViewedAt?.getTime() ||
        row.watched !== was.watched ||
        row.inProgress !== was.inProgress
      )
        continue;
      clears.push({
        mediaItemId: row.mediaItemId,
        appUserId: row.appUserId,
        playCount: 0,
        lastViewedAt: null,
        watched: false,
        inProgress: false,
      });
    }
    report.rowsToClear = clears.length;
    report.titlesTouched = new Set(clears.map((r) => r.mediaItemId)).size;
    report.viewersTouched = new Set(clears.map((r) => r.appUserId)).size;
    if (input.apply)
      report.rowsCleared = (await upsertUserMediaWatchBatch({ db: tx, rows: clears })).written;
    return report;
  });
}
