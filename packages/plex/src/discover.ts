// ADR-092 / DESIGN-051 D-03 / D-06 (PLAN-071) — the plex.tv DISCOVER id: the key the provider's watchlist
// actions, its external-id match and its per-title userState take. Verified live 2026-09-25: it is 24
// lower-case hex digits and equals the suffix of the title's `plex://movie|show/<id>` guid. Every URL that
// carries one is built only after `requireDiscoverId` accepted it (D-03: validated before any request).

/** The two title kinds the discover provider's watchlist holds. */
export type DiscoverKind = 'movie' | 'show';

/** A discover id: exactly 24 lower-case hex digits. */
export const DISCOVER_ID_PATTERN = /^[0-9a-f]{24}$/;

/** The `type` the provider's `library/metadata/matches` requires (mandatory; verified live). */
export const DISCOVER_TYPE: Readonly<Record<DiscoverKind, number>> = { movie: 1, show: 2 };

export function isDiscoverId(id: unknown): id is string {
  return typeof id === 'string' && DISCOVER_ID_PATTERN.test(id);
}

/** The id itself, or a TypeError before any request is built (a blank or foreign id addresses nothing). */
export function requireDiscoverId(id: string): string {
  if (!isDiscoverId(id)) throw new TypeError('plex discover: an id must be 24 lower-case hex digits');
  return id;
}

/**
 * The discover id of a `plex://movie/<id>` or `plex://show/<id>` guid whose type is `kind`; null for any
 * other guid (`local://`, a legacy agent guid, the other kind, a malformed suffix).
 */
export function discoverIdFromGuid(guid: string | null | undefined, kind: DiscoverKind): string | null {
  const m = /^plex:\/\/(movie|show)\/([^\s/]+)$/.exec(guid?.trim() ?? '');
  if (!m || m[1] !== kind) return null;
  return isDiscoverId(m[2]) ? m[2] : null;
}

/** The external ids a discover item's `Guid[]` carries (`tmdb://`, `tvdb://`, `imdb://tt…`). */
export interface DiscoverExternalIds {
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

function positiveInt(value: string): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function discoverExternalIds(guids: ReadonlyArray<{ id: string }> | undefined): DiscoverExternalIds {
  const out: DiscoverExternalIds = { tmdbId: null, tvdbId: null, imdbId: null };
  for (const { id } of guids ?? []) {
    const m = /^(tmdb|tvdb|imdb):\/\/(.+)$/i.exec(id.trim());
    if (!m) continue;
    const scheme = m[1]?.toLowerCase();
    const value = m[2] ?? '';
    if (scheme === 'tmdb') out.tmdbId ??= positiveInt(value);
    else if (scheme === 'tvdb') out.tvdbId ??= positiveInt(value);
    else if (/^tt\d+$/i.test(value)) out.imdbId ??= value.toLowerCase();
  }
  return out;
}
