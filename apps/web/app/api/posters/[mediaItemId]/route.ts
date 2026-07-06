// ADR-019 / DESIGN-008 — the authed poster PROXY. Posters are NEVER stored (no PVC, no image
// processing): this route streams a Media Item's poster server-side from either (a) the owning
// *arr's pre-resized MediaCover variant (with the API key in a header, never exposed to the
// browser) or (b) the TMDB CDN for tombstoned / lookup-sourced rows. Session-gated (mirrors the
// tRPC mount). A 404/miss surfaces the KindIcon fallback in the UI — never a broken <img>.
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getServerSession } from '@hnet/auth';
import { db, mediaItems, mediaMetadata } from '@hnet/db';
import { assertArrEnv, type ArrServiceName } from '@hnet/arr';

export const runtime = 'nodejs';

const CACHE_CONTROL = 'private, max-age=86400, stale-while-revalidate=604800';

/** The MediaCover variant path per *arr (verified live 2026-07-06). */
function arrMediaCoverPath(kind: ArrServiceName, arrItemId: number): string {
  if (kind === 'lidarr') return `/api/v1/mediacover/artist/${arrItemId}/poster-250.jpg`;
  return `/api/v3/mediacover/${arrItemId}/poster-250.jpg`; // radarr + sonarr
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ mediaItemId: string }> },
): Promise<Response> {
  const session = await getServerSession(req.headers);
  if (!session) return new Response('unauthorized', { status: 401 });

  const { mediaItemId } = await ctx.params;
  const uuid = /^[0-9a-f-]{36}$/i.test(mediaItemId) ? mediaItemId : null;
  if (!uuid) return new Response('not found', { status: 404 });

  const [row] = await db
    .select({
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      posterSource: mediaMetadata.posterSource,
      posterRef: mediaMetadata.posterRef,
    })
    .from(mediaItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
    .where(eq(mediaItems.id, uuid));

  if (!row || row.posterSource === null) return new Response('not found', { status: 404 });

  // ETag from the poster reference (the *arr url carries ?lastWrite; the tmdb path is stable) —
  // a cheap revalidation key so an unchanged poster returns 304.
  const etag = `"${createHash('sha1').update(`${row.posterSource}:${row.posterRef ?? ''}`).digest('base64url')}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL } });
  }

  let upstreamUrl: string;
  const headers: Record<string, string> = { Accept: 'image/*' };
  try {
    if (row.posterSource === 'arr') {
      const kind = row.arrKind as ArrServiceName;
      const cfg = assertArrEnv()[kind];
      upstreamUrl = `${cfg.baseUrl.replace(/\/+$/, '')}${arrMediaCoverPath(kind, row.arrItemId)}`;
      headers['X-Api-Key'] = cfg.apiKey;
    } else {
      // tmdb: poster_ref is a poster_path like /abc.jpg → the w342 CDN variant.
      const ref = row.posterRef ?? '';
      if (!ref.startsWith('/')) return new Response('not found', { status: 404 });
      upstreamUrl = `https://image.tmdb.org/t/p/w342${ref}`;
    }
  } catch {
    return new Response('not found', { status: 404 }); // e.g. *arr env not configured
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return new Response('not found', { status: 404 });
  }
  if (!upstream.ok || !upstream.body) return new Response('not found', { status: 404 });

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'Cache-Control': CACHE_CONTROL,
      ETag: etag,
    },
  });
}
