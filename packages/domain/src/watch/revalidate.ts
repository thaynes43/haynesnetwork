// DESIGN-049 D-11 — live revalidation of an answer: `unfinished` and `watch_status` re-check the titles they
// are about to report. One `/library/metadata/<key>` read per title on its preferred server, in parallel,
// inside an overall budget (400 ms; each request is bounded by the caller's client timeout, 300 ms). A show
// whose counters moved has its `allLeaves` re-read inside the same budget and is written through; a movie
// is recomputed from the one read. On timeout the snapshot answers. Reads only — `revalidateTitles` never
// writes Plex.
import type { DbClient, WatchOnPlexEntry, WatchTitleRow } from '@hnet/db';
import {
  computeMovieProgress,
  computeShowProgress,
  countsEqual,
  episodeObsFromLeaves,
  eventObs,
  movieCounts,
  movieObsFromItem,
  movieProgressFields,
  preferredHolder,
  selectTitleEvents,
  serverEpisodesFromMap,
  showCounts,
  showProgressFields,
  storedMovieObs,
  withServerEpisodes,
  type PlexItemLike,
} from '@hnet/watch';
import { resolveDb } from '../db-client';
import { WatchBudgetExceeded, withDeadline, type WatchPlexReaders } from './plex';
import { upsertWatchTitles, type WatchTitleWrite } from './titles';

/** D-11: the overall budget of one answer's revalidation. */
export const REVALIDATE_BUDGET_MS = 400;

export interface RevalidateTitlesResult {
  /** The rows in input order: fresh where Plex had moved, the snapshot otherwise. */
  rows: WatchTitleRow[];
  /** Rows written through. */
  changed: number;
  /** The budget ran out before every read answered (the snapshot answered for those). */
  timedOut: boolean;
  /** Reads that failed for another reason (Plex down, 404, …). */
  failed: number;
}

/** Where to re-read a title: a movie's resume server when it has one, else the preferred holder. */
function revalidationHolder(row: WatchTitleRow): WatchOnPlexEntry | null {
  if (row.kind === 'movie' && row.nextServer && row.nextRatingKey) {
    return (
      row.onPlex.find((e) => e.server === row.nextServer && e.ratingKey === row.nextRatingKey) ?? {
        server: row.nextServer,
        ratingKey: row.nextRatingKey,
        local: false,
      }
    );
  }
  return preferredHolder(row.onPlex);
}

function rowWrite(row: WatchTitleRow): Omit<WatchTitleWrite, keyof ReturnType<typeof showProgressFields>> {
  return {
    id: row.id,
    kind: row.kind,
    titleKey: row.titleKey,
    plexGuid: row.plexGuid,
    tmdbId: row.tmdbId,
    tvdbId: row.tvdbId,
    imdbId: row.imdbId,
    mediaItemId: row.mediaItemId,
    title: row.title,
    year: row.year,
    genres: row.genres,
    contentRating: row.contentRating,
    isKids: row.isKids,
    onPlex: row.onPlex,
    plexCounts: row.plexCounts,
    showStatus: row.showStatus,
  };
}

/**
 * Revalidate `rows` (D-11). Returns them with any that moved recomputed and written through; never throws
 * for a Plex problem (the snapshot answers). `budgetMs` defaults to 400.
 */
export async function revalidateTitles(input: {
  db?: DbClient;
  plex: WatchPlexReaders;
  plexAccountId: number;
  rows: readonly WatchTitleRow[];
  budgetMs?: number;
  now?: Date;
}): Promise<RevalidateTitlesResult> {
  const db = resolveDb(input.db);
  const deadline = Date.now() + (input.budgetMs ?? REVALIDATE_BUDGET_MS);
  const result: RevalidateTitlesResult = { rows: [...input.rows], changed: 0, timedOut: false, failed: 0 };
  const noteFailure = (error: unknown) => {
    if (error instanceof WatchBudgetExceeded) result.timedOut = true;
    else result.failed += 1;
  };

  // Phase 1 — one metadata read per title, in parallel.
  const probes = await Promise.all(
    input.rows.map(async (row) => {
      const holder = revalidationHolder(row);
      const client = holder ? input.plex.read[holder.server] : undefined;
      if (!holder || !client) return null;
      try {
        const meta = await withDeadline(client.getMetadataItem(holder.ratingKey), deadline);
        return meta ? { holder, item: meta.item } : null;
      } catch (error) {
        noteFailure(error);
        return null;
      }
    }),
  );

  // Phase 2 — shows whose counters moved: allLeaves on that server, same budget.
  const leaves = await Promise.all(
    input.rows.map(async (row, i): Promise<PlexItemLike[] | null> => {
      const probe = probes[i];
      if (!probe || row.kind !== 'show') return null;
      if (countsEqual(showCounts(probe.item), row.plexCounts[probe.holder.server])) return null;
      const client = input.plex.read[probe.holder.server];
      if (!client) return null;
      try {
        return (await withDeadline(client.listAllLeaves(probe.holder.ratingKey), deadline)).items;
      } catch (error) {
        noteFailure(error);
        return null;
      }
    }),
  );

  // Phase 3 — recompute what moved and write it through (the database, not Plex, so outside the budget).
  const writes: Array<{ index: number; write: WatchTitleWrite }> = [];
  for (const [i, row] of input.rows.entries()) {
    const probe = probes[i];
    if (!probe) continue;
    const server = probe.holder.server;
    if (row.kind === 'show') {
      const fresh = leaves[i];
      if (!fresh) continue;
      const events = (
        await selectTitleEvents(db, input.plexAccountId, {
          kind: 'show',
          plexGuid: row.plexGuid,
          title: row.title,
          year: row.year,
        })
      ).map(eventObs);
      const servers = withServerEpisodes(serverEpisodesFromMap(row.episodeMap), [
        { server, episodes: episodeObsFromLeaves(fresh) },
      ]);
      writes.push({
        index: i,
        write: {
          ...rowWrite(row),
          plexCounts: { ...row.plexCounts, [server]: showCounts(probe.item) },
          ...showProgressFields(computeShowProgress(servers, events), {
            season: row.nextSeason,
            episode: row.nextEpisode,
            title: row.nextTitle,
          }),
        },
      });
    } else {
      const obs = movieObsFromItem(server, probe.item);
      const storedHere = storedMovieObs(row).find((o) => o.server === server);
      const sameResume =
        (storedHere?.viewOffsetMs ?? null) === null
          ? obs.viewOffsetMs === null
          : obs.viewOffsetMs !== null &&
            Math.round((100 * obs.viewOffsetMs) / (obs.durationMs ?? 1)) === row.resumePercent;
      if (countsEqual(movieCounts(obs), row.plexCounts[server]) && sameResume) continue;
      const events = (
        await selectTitleEvents(db, input.plexAccountId, {
          kind: 'movie',
          plexGuid: row.plexGuid,
          title: row.title,
          year: row.year,
        })
      ).map(eventObs);
      const servers = [obs, ...storedMovieObs(row).filter((o) => o.server !== server)];
      writes.push({
        index: i,
        write: {
          ...rowWrite(row),
          plexCounts: { ...row.plexCounts, [server]: movieCounts(obs) },
          ...movieProgressFields(computeMovieProgress(servers, events), servers),
        },
      });
    }
  }
  if (writes.length > 0) {
    const report = await upsertWatchTitles({
      db,
      plexAccountId: input.plexAccountId,
      titles: writes.map((w) => w.write),
      now: input.now,
    });
    report.rows.forEach((row, j) => {
      const at = writes[j]?.index;
      if (row && at !== undefined) result.rows[at] = row;
    });
    result.changed = report.updated;
  }
  return result;
}
