// ADR-019 / DESIGN-008 — the authed poster PROXY. Posters are NEVER stored (no PVC, no image
// processing): this route streams a Media Item's poster server-side from either the owning *arr's
// pre-resized MediaCover variant (API key in a header, never exposed to the browser) or the TMDB
// CDN. Session-gated (mirrors the tRPC mount). @hnet/api resolves the upstream + ETag; this route
// only checks the session and streams. A 404/miss surfaces the KindIcon fallback — never a broken
// <img>.
import { resolvePosterUpstream } from '@hnet/api';
import { getServerSession } from '@hnet/auth';

export const runtime = 'nodejs';

const CACHE_CONTROL = 'private, max-age=86400, stale-while-revalidate=604800';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ mediaItemId: string }> },
): Promise<Response> {
  const session = await getServerSession(req.headers);
  if (!session) return new Response('unauthorized', { status: 401 });

  const { mediaItemId } = await ctx.params;
  const target = await resolvePosterUpstream(mediaItemId);
  if (!target) return new Response('not found', { status: 404 });

  if (req.headers.get('if-none-match') === target.etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: target.etag, 'Cache-Control': CACHE_CONTROL },
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.url, {
      headers: target.headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
  if (!upstream.ok || !upstream.body) return new Response('not found', { status: 404 });

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'Cache-Control': CACHE_CONTROL,
      ETag: target.etag,
    },
  });
}
