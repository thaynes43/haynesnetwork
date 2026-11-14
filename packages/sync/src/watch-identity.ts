// DESIGN-008 D-15 — one identity rule for targets, cached ids and get_metadata ids.
import type { ArrKind } from '@hnet/db';
import type { ParsedGuids } from './adapt-metadata';

export type WatchKind = Extract<ArrKind, 'radarr' | 'sonarr'>;
export type WatchTarget = {
  arrKind: ArrKind;
  tmdbId?: number | null;
  tvdbId?: number | null;
  imdbId?: string | null;
};

export function usableWatchGuids(ids: Omit<WatchTarget, 'arrKind'>): ParsedGuids {
  const positive = (id: number | null | undefined): number | undefined =>
    typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined;
  const imdb = ids.imdbId?.trim();
  return {
    tmdbId: positive(ids.tmdbId),
    tvdbId: positive(ids.tvdbId),
    imdbId: imdb && /^tt\d+$/.test(imdb) && /[1-9]/.test(imdb) ? imdb : undefined,
  };
}

export function identifiableWatchTarget(target: WatchTarget): boolean {
  return (
    (target.arrKind === 'radarr' || target.arrKind === 'sonarr') &&
    Object.values(usableWatchGuids(target)).some((id) => id !== undefined)
  );
}
