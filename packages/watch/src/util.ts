// Internal helpers shared by the modules; not part of the package's public API.

import { PLEX_SERVERS, type PlexServer, type WatchKind } from './types';

/** Index of a server in {@link PLEX_SERVERS} (lower is preferred). */
export function serverRank(server: PlexServer): number {
  return PLEX_SERVERS.indexOf(server);
}

/** A usable unix-seconds time: finite and positive, else null (Plex reports 0 for "never"). */
export function validTime(t: number | null | undefined): number | null {
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null;
}

/** Deterministic, locale-free string order (case-insensitive first, then exact). */
export function compareText(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}

/** Scope keys by kind for grouping, so a show and a movie never merge through a shared `name:` key. */
export function kindScopedKeys(kind: WatchKind, keys: readonly string[]): string[] {
  return keys.map((k) => `${kind}|${k}`);
}
