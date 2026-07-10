// ADR-038 C-06 / DESIGN-017 D-04 (PLAN-022) — the ytdl-sub Plex-thumb proxy upstream resolver. Mirrors
// the ADR-019 poster proxy (`poster.ts`) but for the k8plex/HAYNESKUBE ytdl-sub content, which has NO
// `media_items` row (it is read live from Plex, never synced). The app route streams the returned upstream
// with the token in a SERVER-SIDE header so the Plex token never reaches the browser. Kept out of the app
// route so the @hnet/plex config coupling stays in @hnet/api (same split as `resolvePosterUpstream`).
//
// SECURITY: this must not become an open image proxy. Only a Plex-metadata thumb path (`/library/…`) on the
// single k8plex server is allowed — no scheme, no `..`, no host override, no other server. Anything else ⇒
// the caller gets a null (→ the route 404s → the MediaPoster fallback tile).
import { assertPlexEnv } from '@hnet/plex';

export interface YtdlsubThumbUpstream {
  url: string;
  headers: Record<string, string>;
}

/** A safe Plex thumb path: `/library/...`, no scheme/host, no traversal, bounded length. */
export function isValidPlexThumbPath(thumb: string): boolean {
  if (typeof thumb !== 'string' || thumb.length === 0 || thumb.length > 512) return false;
  if (!thumb.startsWith('/library/')) return false; // Plex metadata/thumb paths only
  if (thumb.includes('://')) return false; // no scheme (no absolute URL smuggling)
  if (thumb.includes('..')) return false; // no path traversal
  if (/[\s\\]/.test(thumb)) return false; // no whitespace / backslashes
  return true;
}

/**
 * Resolve a ytdl-sub Plex thumb path to its authed upstream on the k8plex server. Returns null for an
 * invalid path OR when the Plex env is absent/misconfigured (⇒ the route 404s, the tile falls back). The
 * token is placed in the X-Plex-Token header, never the URL.
 */
export function resolveYtdlsubThumbUpstream(
  thumb: string,
  env: Record<string, string | undefined> = process.env,
): YtdlsubThumbUpstream | null {
  if (!isValidPlexThumbPath(thumb)) return null;
  let baseUrl: string;
  let token: string;
  try {
    const cfg = assertPlexEnv(env).hayneskube;
    baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    token = cfg.token;
  } catch {
    return null; // Plex env missing ⇒ no poster, clean 404 → fallback (never leaks config)
  }
  return {
    url: `${baseUrl}${thumb}`,
    headers: { 'X-Plex-Token': token, Accept: 'image/*' },
  };
}
