// ADR-019 / DESIGN-008 — the poster PROXY resolution (server-side; no image storage). Given a
// Media Item id, resolve where its poster streams from — the owning *arr's pre-resized MediaCover
// variant (with the API key in a header, never exposed to the browser) or the TMDB CDN — plus a
// cheap ETag. The Next route handler (apps/web) does the session check + streaming; this keeps the
// DB + *arr-config coupling inside @hnet/api (which has both deps), so the app route stays thin.
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db as defaultDb, mediaItems, mediaMetadata, type Database } from '@hnet/db';
import { assertArrEnv, type ArrServiceName } from '@hnet/arr';

export interface PosterUpstream {
  url: string;
  headers: Record<string, string>;
  /** Revalidation key from the poster reference (the *arr url carries ?lastWrite; tmdb is stable). */
  etag: string;
}

/** The MediaCover variant path per *arr (verified live 2026-07-06). */
function arrMediaCoverPath(kind: ArrServiceName, arrItemId: number): string {
  if (kind === 'lidarr') return `/api/v1/mediacover/artist/${arrItemId}/poster-250.jpg`;
  return `/api/v3/mediacover/${arrItemId}/poster-250.jpg`; // radarr + sonarr
}

/**
 * Resolve the upstream a Media Item's poster streams from, or null when there is none (→ the UI
 * shows the KindIcon fallback). Never throws for a misconfigured *arr env — returns null.
 */
export async function resolvePosterUpstream(
  mediaItemId: string,
  database: Database = defaultDb,
): Promise<PosterUpstream | null> {
  if (!/^[0-9a-f-]{36}$/i.test(mediaItemId)) return null;
  const [row] = await database
    .select({
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      posterSource: mediaMetadata.posterSource,
      posterRef: mediaMetadata.posterRef,
    })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(eq(mediaItems.id, mediaItemId));

  if (!row || row.posterSource === null) return null;

  const etag = `"${createHash('sha1')
    .update(`${row.posterSource}:${row.posterRef ?? ''}`)
    .digest('base64url')}"`;

  if (row.posterSource === 'arr') {
    try {
      const kind = row.arrKind as ArrServiceName;
      const cfg = assertArrEnv()[kind];
      return {
        url: `${cfg.baseUrl.replace(/\/+$/, '')}${arrMediaCoverPath(kind, row.arrItemId)}`,
        headers: { 'X-Api-Key': cfg.apiKey, Accept: 'image/*' },
        etag,
      };
    } catch {
      return null; // *arr env not configured
    }
  }
  // tmdb: poster_ref is a poster_path like /abc.jpg → the w342 CDN variant.
  const ref = row.posterRef ?? '';
  if (!ref.startsWith('/')) return null;
  return { url: `https://image.tmdb.org/t/p/w342${ref}`, headers: { Accept: 'image/*' }, etag };
}
