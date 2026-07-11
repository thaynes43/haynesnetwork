// ADR-038 C-06 / ADR-041 / DESIGN-017 D-04+D-07 — the ytdl-sub Plex-thumb proxy upstream resolver.
// Mirrors the ADR-019 poster proxy (`poster.ts`) but for the k8plex/HAYNESKUBE ytdl-sub content, which
// has NO `media_items` row (it is read live from Plex, never synced). The app route streams the returned
// upstream with the token in a SERVER-SIDE header so the Plex token never reaches the browser. Kept out
// of the app route so the @hnet/plex config coupling stays in @hnet/api (same split as
// `resolvePosterUpstream`).
//
// ADR-041 (2026-07-10, the owner's wall-perf review): the upstream is now a FIXED-SIZE WebP variant from
// k8plex's own photo-transcode endpoint (`/photo/:/transcode` — verified live: header token honored, 401
// unauthenticated; a 2.35 MB Peloton JPEG becomes a 3.5 KB 300×450 WebP), with the ORIGINAL art kept as
// a per-image fallback (a transcode miss degrades to exactly the old behavior, never a broken wall). The
// strong ETag hashes `(size, thumb)` — self-versioning, because Plex thumb paths embed `lastWrite` — and
// the in-process `ThumbLruCache` memoizes hot variants so repeat wall paints never re-hit Plex. The LRU
// is memoization, NOT a store (no PVC, no table, evaporates on restart — the ADR-019 posture stands).
//
// SECURITY: this must not become an open image (or resize) proxy. Only a Plex-metadata thumb path
// (`/library/…`) on the single k8plex server is allowed — no scheme, no `..`, no host override, no other
// server — and the variant set is a CLOSED allow-list (never client-chosen dimensions). Anything else ⇒
// the caller gets a null (→ the route 404s → the MediaPoster fallback tile).
import { createHash } from 'node:crypto';
import { assertPlexEnv } from '@hnet/plex';

/** ADR-041 C-01 / T-120 — the closed variant allow-list (never client-chosen dimensions). */
export const YTDLSUB_THUMB_SIZES = ['grid', 'still'] as const;
export type YtdlsubThumbSize = (typeof YTDLSUB_THUMB_SIZES)[number];

/**
 * grid = the 2:3 poster tile at ≈2× its 132–160px box; still = the 16:9 episode row. PLAN-030 (ADR-048)
 * reuses this exact allow-list for the TV season-poster (grid) + episode-thumb (still) proxy variants —
 * the season/episode art path is the same closed-size transcode seam, just on the matched (non-k8plex)
 * server, so the dimensions are single-sourced here.
 */
export const PLEX_TRANSCODE_DIMENSIONS: Record<YtdlsubThumbSize, { width: number; height: number }> = {
  grid: { width: 300, height: 450 },
  still: { width: 320, height: 180 },
};
const SIZE_DIMENSIONS = PLEX_TRANSCODE_DIMENSIONS;

export function isYtdlsubThumbSize(value: string): value is YtdlsubThumbSize {
  return (YTDLSUB_THUMB_SIZES as readonly string[]).includes(value);
}

export interface YtdlsubThumbUpstream {
  /** The sized WebP transcode variant (ADR-041 C-01). */
  url: string;
  /** The original full-size art — the per-image fallback when the transcode misses (ADR-041 C-02). */
  fallbackUrl: string;
  headers: Record<string, string>;
  /** Strong ETag over (size, thumb). Plex thumb paths embed lastWrite ⇒ art changes rotate it. */
  etag: string;
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
 * Resolve a ytdl-sub Plex thumb path to its authed, SIZED upstream on the k8plex server. Returns null
 * for an invalid path OR when the Plex env is absent/misconfigured (⇒ the route 404s, the tile falls
 * back). The token is placed in the X-Plex-Token header, never the URL.
 */
export function resolveYtdlsubThumbUpstream(
  thumb: string,
  size: YtdlsubThumbSize = 'grid',
  env: Record<string, string | undefined> = process.env,
): YtdlsubThumbUpstream | null {
  if (!isValidPlexThumbPath(thumb)) return null;
  if (!isYtdlsubThumbSize(size)) return null; // defense in depth — the route validates too
  let baseUrl: string;
  let token: string;
  try {
    const cfg = assertPlexEnv(env).hayneskube;
    baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    token = cfg.token;
  } catch {
    return null; // Plex env missing ⇒ no poster, clean 404 → fallback (never leaks config)
  }
  const { width, height } = SIZE_DIMENSIONS[size];
  return {
    // minSize=1&upscale=1: fill the tile box exactly (Plex Web's own grid-thumb invocation);
    // format=webp is the byte lever (the transcoder ignores `quality`; JPEG output stays ~40×
    // larger). The url= param carries the ALREADY-VALIDATED Plex-relative path, encoded.
    url:
      `${baseUrl}/photo/:/transcode?width=${width}&height=${height}` +
      `&minSize=1&upscale=1&format=webp&url=${encodeURIComponent(thumb)}`,
    fallbackUrl: `${baseUrl}${thumb}`,
    headers: { 'X-Plex-Token': token, Accept: 'image/*' },
    etag: ytdlsubThumbEtag(thumb, size),
  };
}

/** Strong ETag for a (size, thumb) pair — mirrors poster.ts's posterEtag discipline. */
export function ytdlsubThumbEtag(thumb: string, size: YtdlsubThumbSize): string {
  return `"${createHash('sha1').update(`${size}:${thumb}`).digest('base64url')}"`;
}

// ---------------------------------------------------------------------------
// ADR-041 C-04 — the in-process LRU. Byte-capped memoization of transcoded variants; NOT a store
// (process-local, evaporates on restart, no backup surface). Both walls' variants total well under
// 1 MiB, so the default cap fits the whole estate many times over.
// ---------------------------------------------------------------------------

export interface CachedThumb {
  body: Uint8Array;
  contentType: string;
  etag: string;
}

export class ThumbLruCache {
  private readonly entries = new Map<string, CachedThumb>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxEntryBytes = 1024 * 1024,
  ) {}

  /** Recency-refreshing get (Map insertion order IS the LRU order). */
  get(key: string): CachedThumb | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  /** Insert, evicting oldest until under the byte cap. Over-cap bodies are skipped (served, not cached). */
  set(key: string, value: CachedThumb): void {
    if (value.body.byteLength > this.maxEntryBytes) return;
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.totalBytes -= existing.body.byteLength;
    }
    this.entries.set(key, value);
    this.totalBytes += value.body.byteLength;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.totalBytes <= this.maxBytes || oldestKey === key) break;
      this.entries.delete(oldestKey);
      this.totalBytes -= oldest.body.byteLength;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }
}

let singleton: ThumbLruCache | undefined;

/** The route's process-wide cache (one per Node server — the Next standalone runtime). */
export function ytdlsubThumbCache(): ThumbLruCache {
  singleton ??= new ThumbLruCache();
  return singleton;
}
