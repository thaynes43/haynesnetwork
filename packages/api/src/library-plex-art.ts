// ADR-048 / DESIGN-005 D-22 (PLAN-030) — the TV season-poster + episode-thumbnail art seam. TV season /
// episode art comes from the EXACT Plex title the *arr ledger item matched to (ADR-047 media_plex_matches),
// served through the ADR-041 photo-transcode proxy — the SAME sized-WebP + LRU + strong-ETag machinery the
// ytdl-sub walls use, but on the MATCHED server (haynestower / haynesops / hayneskube), not just k8plex.
//
// THE INVARIANT (ADR-047) — TV art for a show in a library the caller can't access must NEVER be served.
// Two mismatched hazards, both closed here:
//   1. A caller could pass an accessible item id but a DIFFERENT (inaccessible) title's thumb path on the
//      same server. To prevent that, every art URL is a SIGNED, ITEM-SCOPED reference: the tRPC endpoint
//      (which has already passed the per-item access gate to READ the thumb from Plex) mints an HMAC over
//      `(mediaItemId, serverSlug, thumb, size)`. The proxy verifies the signature AND re-checks item
//      access — a thumb path can only be fetched bound to the accessible item it was read for.
//   2. The token must never reach the browser — it stays in the X-Plex-Token header (ADR-019/ADR-041).
// The size set is the SAME closed allow-list as ytdl-sub (grid = the season poster, still = the episode
// row); dimensions are single-sourced in ytdlsub-poster.ts.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { assertPlexEnv, PLEX_SERVERS, type PlexServerName } from '@hnet/plex';
import {
  PLEX_TRANSCODE_DIMENSIONS,
  isValidPlexThumbPath,
  isYtdlsubThumbSize,
  type YtdlsubThumbSize,
} from './ytdlsub-poster';

/** The proxy's size allow-list is the same closed set the ytdl-sub proxy uses (grid poster / still row). */
export type PlexArtSize = YtdlsubThumbSize;

/**
 * The signing secret — Better Auth's session-cookie secret (the app already requires it in the cluster;
 * a dev fallback keeps mint + verify consistent within one process in dev:local, matching @hnet/auth's
 * DEV_FALLBACK_SECRET). Both the tRPC mint and the app proxy run in the SAME Next.js server process, so
 * they read the same value — the signature never crosses a process boundary.
 */
function artSigningSecret(env: Record<string, string | undefined> = process.env): string {
  return env.BETTER_AUTH_SECRET?.trim() || 'dev-only-not-for-prod-not-for-prod';
}

/** A server slug is one of the three Plex servers of record (never client-trusted without this check). */
export function isPlexServerSlug(value: string): value is PlexServerName {
  return (PLEX_SERVERS as readonly string[]).includes(value);
}

/**
 * HMAC-SHA256 over the art tuple → base64url. Binds the thumb path to the accessible item it was read
 * for, on a specific server, at a specific size — so a valid signature is proof our server minted this
 * reference for a caller who passed the per-item access gate (THE INVARIANT).
 */
export function signPlexArtRef(
  mediaItemId: string,
  serverSlug: PlexServerName,
  thumb: string,
  size: PlexArtSize,
  env: Record<string, string | undefined> = process.env,
): string {
  return createHmac('sha256', artSigningSecret(env))
    .update(`${mediaItemId}\n${serverSlug}\n${thumb}\n${size}`)
    .digest('base64url');
}

/** Constant-time signature check (length-guarded so timingSafeEqual never throws on a mismatched length). */
export function verifyPlexArtRef(
  mediaItemId: string,
  serverSlug: string,
  thumb: string,
  size: string,
  sig: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!isPlexServerSlug(serverSlug) || !isYtdlsubThumbSize(size)) return false;
  const expected = signPlexArtRef(mediaItemId, serverSlug, thumb, size, env);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Build the signed proxy URL for one Plex thumb of a matched item. null when the thumb path is unsafe
 * (→ the UI renders no icon / the tinted still, never a broken <img>). The URL carries the item id +
 * server slug + size + HMAC; the proxy re-gates item access and verifies the signature.
 */
export function buildPlexArtUrl(
  mediaItemId: string,
  serverSlug: PlexServerName,
  thumb: string,
  size: PlexArtSize,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (!isValidPlexThumbPath(thumb)) return null;
  const sig = signPlexArtRef(mediaItemId, serverSlug, thumb, size, env);
  const q = new URLSearchParams({ item: mediaItemId, server: serverSlug, thumb, size, sig });
  return `/api/library/plex-art?${q.toString()}`;
}

export interface PlexArtUpstream {
  /** The sized WebP transcode variant on the matched server (ADR-041 C-01). */
  url: string;
  /** The original full-size art — the per-image fallback when the transcode misses (ADR-041 C-02). */
  fallbackUrl: string;
  headers: Record<string, string>;
  /** Strong ETag over (server, size, thumb) — server-scoped so two servers' identical paths never collide. */
  etag: string;
}

/** Strong ETag for a (server, size, thumb) triple — mirrors ytdlsubThumbEtag but server-scoped. */
export function plexArtEtag(serverSlug: string, thumb: string, size: PlexArtSize): string {
  return `"${createHash('sha1').update(`${serverSlug}:${size}:${thumb}`).digest('base64url')}"`;
}

/**
 * Resolve a matched-item thumb to its authed, SIZED transcode upstream on the given server. Returns null
 * for an invalid path/size/slug OR when the Plex env is absent (→ the proxy 404s → the UI falls back). The
 * token is placed in the X-Plex-Token header, never the URL — mirrors resolveYtdlsubThumbUpstream but the
 * server is the matched one, not hardwired to hayneskube.
 */
export function resolvePlexArtUpstream(
  serverSlug: string,
  thumb: string,
  size: PlexArtSize = 'grid',
  env: Record<string, string | undefined> = process.env,
): PlexArtUpstream | null {
  if (!isPlexServerSlug(serverSlug)) return null;
  if (!isValidPlexThumbPath(thumb)) return null;
  if (!isYtdlsubThumbSize(size)) return null;
  let baseUrl: string;
  let token: string;
  try {
    const cfg = assertPlexEnv(env)[serverSlug];
    baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    token = cfg.token;
  } catch {
    return null; // Plex env missing ⇒ no art, clean 404 → fallback (never leaks config)
  }
  const { width, height } = PLEX_TRANSCODE_DIMENSIONS[size];
  return {
    url:
      `${baseUrl}/photo/:/transcode?width=${width}&height=${height}` +
      `&minSize=1&upscale=1&format=webp&url=${encodeURIComponent(thumb)}`,
    fallbackUrl: `${baseUrl}${thumb}`,
    headers: { 'X-Plex-Token': token, Accept: 'image/*' },
    etag: plexArtEtag(serverSlug, thumb, size),
  };
}

/** The proxy's LRU cache key — server-prefixed so it never collides with the ytdl-sub `${size}:${thumb}` keys. */
export function plexArtCacheKey(serverSlug: string, thumb: string, size: PlexArtSize): string {
  return `art:${serverSlug}:${size}:${thumb}`;
}
