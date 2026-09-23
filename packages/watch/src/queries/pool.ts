// DESIGN-049 D-13 — the resolver POOL: every title a spoken query may name. The owner's Title States (in
// history), the live *arr ledger (Sonarr shows, Radarr movies, not tombstoned) and the recommendation
// signals (watchlist, TMDB seeds). SELECT only; the pure `resolveTitle` does the scoring.
import {
  mediaItems,
  watchRecoSignals,
  watchTitles,
  type DbClient,
  type WatchRecoSource,
} from '@hnet/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { titleKeyFor } from '../identity';
import type { ResolverCandidate } from '../resolver';
import type { WatchKind } from '../types';

export type PoolSource = 'title' | WatchLedgerSource | WatchRecoSource;
type WatchLedgerSource = 'ledger';

/** A resolver candidate that remembers where it came from. */
export interface PoolEntry extends ResolverCandidate {
  source: PoolSource;
  /** `watch_titles.id` (source `title`). */
  titleRowId: number | null;
  /** `media_items.id` (source `ledger`, or a Title State's ledger link). */
  mediaItemId: string | null;
}

const KIND_OF_ARR = { sonarr: 'show', radarr: 'movie' } as const;

/**
 * The D-13 pool for the owner, optionally one kind only. Title States are `inHistory`. Ledger items and
 * signals carry the ids they know, so `resolveTitle` folds a title seen by several sources into one.
 */
export async function selectResolverPool(
  db: DbClient,
  plexAccountId: number,
  opts: { kind?: WatchKind | null } = {},
): Promise<PoolEntry[]> {
  const kind = opts.kind ?? null;
  const titleWhere = [eq(watchTitles.plexAccountId, plexAccountId)];
  if (kind) titleWhere.push(eq(watchTitles.kind, kind));
  const titles = await db
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
      mediaItemId: watchTitles.mediaItemId,
    })
    .from(watchTitles)
    .where(and(...titleWhere));

  const arrKinds =
    kind === 'show' ? (['sonarr'] as const) : kind === 'movie' ? (['radarr'] as const) : (['sonarr', 'radarr'] as const);
  const ledger = await db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      title: mediaItems.title,
      year: mediaItems.year,
      tmdbId: mediaItems.tmdbId,
      tvdbId: mediaItems.tvdbId,
      imdbId: mediaItems.imdbId,
    })
    .from(mediaItems)
    .where(and(inArray(mediaItems.arrKind, [...arrKinds]), isNull(mediaItems.deletedFromArrAt)));

  const signalWhere = [eq(watchRecoSignals.plexAccountId, plexAccountId)];
  if (kind) signalWhere.push(eq(watchRecoSignals.kind, kind));
  const signals = await db
    .select({
      source: watchRecoSignals.source,
      kind: watchRecoSignals.kind,
      title: watchRecoSignals.title,
      year: watchRecoSignals.year,
      plexGuid: watchRecoSignals.plexGuid,
      tmdbId: watchRecoSignals.tmdbId,
      tvdbId: watchRecoSignals.tvdbId,
      imdbId: watchRecoSignals.imdbId,
    })
    .from(watchRecoSignals)
    .where(and(...signalWhere));

  const pool: PoolEntry[] = titles.map((t) => ({
    titleKey: t.titleKey,
    kind: t.kind,
    title: t.title,
    year: t.year,
    inHistory: true,
    ids: { plexGuid: t.plexGuid, tmdbId: t.tmdbId, tvdbId: t.tvdbId, imdbId: t.imdbId },
    source: 'title',
    titleRowId: t.id,
    mediaItemId: t.mediaItemId,
  }));
  for (const m of ledger) {
    const k: WatchKind = m.arrKind === 'sonarr' ? KIND_OF_ARR.sonarr : KIND_OF_ARR.radarr;
    const ids = { tmdbId: m.tmdbId, tvdbId: k === 'show' ? m.tvdbId : null, imdbId: m.imdbId };
    pool.push({
      titleKey: titleKeyFor({ kind: k, title: m.title, year: m.year, ...ids }),
      kind: k,
      title: m.title,
      year: m.year,
      inHistory: false,
      ids,
      source: 'ledger',
      titleRowId: null,
      mediaItemId: m.id,
    });
  }
  // A seed title recommended by several of the owner's titles appears once per seed; one entry is enough.
  const seen = new Set<string>();
  for (const s of signals) {
    const ids = { plexGuid: s.plexGuid, tmdbId: s.tmdbId, tvdbId: s.tvdbId, imdbId: s.imdbId };
    const titleKey = titleKeyFor({ kind: s.kind, title: s.title, year: s.year, ...ids });
    const dedupe = `${s.source}\u0000${titleKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    pool.push({
      titleKey,
      kind: s.kind,
      title: s.title,
      year: s.year,
      inHistory: false,
      ids,
      source: s.source,
      titleRowId: null,
      mediaItemId: null,
    });
  }
  return pool;
}
