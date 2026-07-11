// ADR-019 / DESIGN-008 — the authed poster PROXY. Posters are NEVER stored (no PVC, no image
// processing): this route streams a Media Item's poster server-side from either the owning *arr's
// pre-resized MediaCover variant (API key in a header, never exposed to the browser) or the TMDB
// CDN. Session-gated (mirrors the tRPC mount). @hnet/api resolves the upstream + ETag; this route
// only checks the session and streams. A 404/miss surfaces the KindIcon fallback — never a broken
// <img>.
//
// Deleted-item fallback (ADR-019): when the primary upstream is the owning *arr's MediaCover and it
// 404s — because the item was removed from the *arr (a Trash expedite / "Recently Deleted"), so its
// MediaCover no longer exists while the ledger still says poster_source='arr' — stream the TMDB
// poster instead so removed items keep their art. TMDB missing too ⇒ the placeholder (as before).
import {
  isMediaItemAccessibleToUser,
  resolvePosterUpstream,
  resolveTmdbPosterFallback,
  type PosterUpstream,
} from '@hnet/api';
import { getServerSession } from '@hnet/auth';

export const runtime = 'nodejs';

const CACHE_CONTROL = 'private, max-age=86400, stale-while-revalidate=604800';

/** Serve one poster upstream: a conditional 304, a 200 stream, or null (a miss → try the next). */
async function serve(req: Request, target: PosterUpstream): Promise<Response | null> {
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
    return null;
  }
  if (!upstream.ok || !upstream.body) return null;

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'Cache-Control': CACHE_CONTROL,
      ETag: target.etag,
    },
  });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ mediaItemId: string }> },
): Promise<Response> {
  const session = await getServerSession(req.headers);
  if (!session) return new Response('unauthorized', { status: 401 });

  const { mediaItemId } = await ctx.params;
  // ADR-047 THE INVARIANT — the cover proxy is a parallel leak vector (art by id). Apply the SAME per-item
  // access gate as the tRPC surface: a poster for an item in a Plex library the caller can't access 404s.
  if (!(await isMediaItemAccessibleToUser(session.user.id, mediaItemId))) {
    return new Response('not found', { status: 404 });
  }
  const target = await resolvePosterUpstream(mediaItemId);
  if (target) {
    const served = await serve(req, target);
    if (served) return served;
    // The primary upstream missed. When it was the owning *arr's MediaCover (the item was removed
    // from the *arr, so it 404s), stream the TMDB poster instead so removed / Recently-Deleted
    // items keep their art. A failed TMDB primary just misses again — only 'arr' primaries fall back.
    if (target.source === 'arr') {
      const fallback = await resolveTmdbPosterFallback(mediaItemId);
      if (fallback) {
        const fell = await serve(req, fallback);
        if (fell) return fell;
      }
    }
  }
  return new Response('not found', { status: 404 });
}
