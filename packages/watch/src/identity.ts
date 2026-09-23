// Title identity (DESIGN-049 D-08): the `title_key` of a Title State, and every key a title can be
// matched by across sources that know different ids (Plex, Tautulli, the *arr ledger, TMDB, the
// plex.tv watchlist).

import { normalizeTitle } from './normalize';
import type { TitleIds } from './types';

const PLEX_GUID = /^plex:\/\/(show|movie)\/[^\s/]+$/;

function plexKey(ids: TitleIds): string | null {
  const guid = ids.plexGuid?.trim();
  if (!guid) return null;
  const m = PLEX_GUID.exec(guid);
  // `local://…` and legacy agent guids never match; a guid of the other kind is a data error.
  if (m?.[1] !== ids.kind) return null;
  return `plex:${guid}`;
}

function positiveInt(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

function tvdbKey(ids: TitleIds): string | null {
  const id = positiveInt(ids.tvdbId);
  return ids.kind === 'show' && id !== null ? `tvdb:${id}` : null;
}

function tmdbKey(ids: TitleIds): string | null {
  const id = positiveInt(ids.tmdbId);
  return id !== null ? `tmdb:${ids.kind}:${id}` : null;
}

function imdbKey(ids: TitleIds): string | null {
  const id = ids.imdbId?.trim().toLowerCase();
  return id && /^tt\d+$/.test(id) ? `imdb:${id}` : null;
}

/** `name:<normalized title>|<year>` — the year falls back to a hint in the title, else empty. */
export function nameKey(title: string, year?: number | null): string {
  const n = normalizeTitle(title);
  return `name:${n.norm}|${positiveInt(year) ?? n.year ?? ''}`;
}

/**
 * The strongest key for a title, in D-08 preference order: `plex:<guid>` (a `plex://show|movie/…`
 * guid of the same kind — `local://` never), then `tvdb:<id>` for a show or `tmdb:movie:<id>` for a
 * movie, then `imdb:<id>`, then `tmdb:show:<id>` (a show TMDB alone knows, e.g. a TMDB seed), last
 * `name:<normalized title>|<year>`.
 */
export function titleKeyFor(ids: TitleIds): string {
  const middle = ids.kind === 'show' ? tvdbKey(ids) : tmdbKey(ids);
  const late = ids.kind === 'show' ? tmdbKey(ids) : null;
  return plexKey(ids) ?? middle ?? imdbKey(ids) ?? late ?? nameKey(ids.title, ids.year);
}

/**
 * EVERY key a title can be matched by, strongest first: `plex:`, `tvdb:` (shows), `tmdb:<kind>:`,
 * `imdb:`, and always one `name:` key. Two records are the same title when their key sets intersect;
 * `titleKeyFor(ids)` is always a member.
 */
export function identityKeys(ids: TitleIds): string[] {
  const keys = [
    plexKey(ids),
    tvdbKey(ids),
    tmdbKey(ids),
    imdbKey(ids),
    nameKey(ids.title, ids.year),
  ];
  return keys.filter((k): k is string => k !== null);
}

/** `identityKeys` plus a stored `titleKey` (a row may carry a key its ids no longer produce). */
export function keysOf(ids: TitleIds & { titleKey?: string | null }): string[] {
  const keys = identityKeys(ids);
  if (ids.titleKey && !keys.includes(ids.titleKey)) keys.push(ids.titleKey);
  return keys;
}

/**
 * The strength of a key (lower is stronger), so a writer can tell when a later run learned a
 * stronger key and re-key the row in place (D-08). Unknown shapes rank last.
 */
export function titleKeyRank(key: string): number {
  if (key.startsWith('plex:')) return 0;
  if (key.startsWith('tvdb:') || key.startsWith('tmdb:movie:')) return 1;
  if (key.startsWith('imdb:')) return 2;
  if (key.startsWith('tmdb:show:')) return 3;
  if (key.startsWith('name:')) return 4;
  return 5;
}
