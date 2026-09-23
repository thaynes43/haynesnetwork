// ADR-089 / DESIGN-049 D-07 / D-09 steps 6–7 / D-17 — the single writer of `watch_reco_signals`, the
// recommendation INPUT cache. Each run REPLACES one source's rows for the account in one transaction
// (delete + insert): the plex.tv watchlist every run, the TMDB seed recommendations when they are older
// than 20 hours. Rebuildable; no audit row.
import {
  watchRecoSignals,
  type DbClient,
  type WatchRecoSource,
  type WatchTitleKind,
} from '@hnet/db';
import { and, eq } from 'drizzle-orm';
import { inTransaction } from '../db-client';

export interface RecoSignalInput {
  kind: WatchTitleKind;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  plexGuid: string | null;
  /** `tmdb_seed` only: the owner's title that produced the recommendation. */
  seedTitleKey?: string | null;
  seedTitle?: string | null;
  /** Position in the source list. */
  rank: number;
  addedAt?: Date | null;
  /** Defaults to the run's `fetchedAt` (a kept older seed passes its own). */
  fetchedAt?: Date;
}

const CHUNK = 500;

/** Replace every `source` row of the account with `rows`, in one transaction. */
export async function replaceRecoSignals(input: {
  db?: DbClient;
  plexAccountId: number;
  source: WatchRecoSource;
  rows: readonly RecoSignalInput[];
  fetchedAt?: Date;
}): Promise<{ replaced: number }> {
  const fetchedAt = input.fetchedAt ?? new Date();
  await inTransaction(input.db, async (tx) => {
    await tx
      .delete(watchRecoSignals)
      .where(
        and(
          eq(watchRecoSignals.plexAccountId, input.plexAccountId),
          eq(watchRecoSignals.source, input.source),
        ),
      );
    for (let i = 0; i < input.rows.length; i += CHUNK) {
      const chunk = input.rows.slice(i, i + CHUNK).map((r) => ({
        plexAccountId: input.plexAccountId,
        source: input.source,
        kind: r.kind,
        title: r.title,
        year: r.year,
        tmdbId: r.tmdbId,
        tvdbId: r.tvdbId,
        imdbId: r.imdbId,
        plexGuid: r.plexGuid,
        seedTitleKey: r.seedTitleKey ?? null,
        seedTitle: r.seedTitle ?? null,
        rank: Math.max(0, Math.min(32767, Math.trunc(r.rank))),
        addedAt: r.addedAt ?? null,
        fetchedAt: r.fetchedAt ?? fetchedAt,
      }));
      await tx.insert(watchRecoSignals).values(chunk);
    }
  });
  return { replaced: input.rows.length };
}
