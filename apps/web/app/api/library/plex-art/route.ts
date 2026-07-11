// ADR-048 / DESIGN-005 D-22 (PLAN-030) — the TV season-poster + episode-thumbnail PROXY. A matched *arr
// ledger item's season/episode art lives on the MATCHED Plex server (ADR-047), not just k8plex, so the
// ytdl-sub `/api/ytdlsub/poster` route (hardwired to hayneskube + the coarse `ytdlsub` gate) can't serve
// it. This sibling route serves a Plex thumb from the matched server, transcoded to a fixed-size WebP
// (ADR-041), with the token in a server-side header (never the browser).
//
// THE INVARIANT (ADR-047): TV art for a title in a library the caller can't access must NEVER be served.
// Three gates, all server-side:
//   1. session — 401 unauthenticated.
//   2. SIGNATURE — the (item, server, thumb, size) HMAC proves this thumb was READ + minted by our server
//      for THIS item (the tRPC endpoint that read it already passed the per-item access gate). A caller
//      cannot substitute another (inaccessible) title's thumb — the signature would not verify.
//   3. per-item ACCESS — isMediaItemAccessibleToUser re-checks the SAME gate as the ledger surface, so a
//      revoked grant stops serving art immediately (defence in depth over the signature).
// Any miss ⇒ 404 → the MediaPoster fallback (no icon / tinted still). Repeat paints are 304s / LRU hits
// (the strong (server, size, thumb) ETag + the shared in-process ThumbLruCache — ADR-041, NOT a store).
import {
  isMediaItemAccessibleToUser,
  resolvePlexArtUpstream,
  verifyPlexArtRef,
  plexArtCacheKey,
  ytdlsubThumbCache,
} from '@hnet/api';
import { getServerSession } from '@hnet/auth';

export const runtime = 'nodejs';

const CACHE_CONTROL = 'private, max-age=86400, stale-while-revalidate=604800';
const NOT_FOUND = () => new Response('not found', { status: 404 });

function ok(body: BodyInit, contentType: string, etag: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType, 'Cache-Control': CACHE_CONTROL, ETag: etag },
  });
}

/** Fetch one upstream URL; null on any failure (the caller tries the next tier). */
async function fetchImage(
  url: string,
  headers: Record<string, string>,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  let upstream: Response;
  try {
    upstream = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (!upstream.ok || !upstream.body) return null;
  return {
    body: await upstream.arrayBuffer(),
    contentType: upstream.headers.get('content-type') ?? 'image/jpeg',
  };
}

export async function GET(req: Request): Promise<Response> {
  const session = await getServerSession(req.headers);
  if (!session) return new Response('unauthorized', { status: 401 });

  const params = new URL(req.url).searchParams;
  const item = params.get('item') ?? '';
  const server = params.get('server') ?? '';
  const thumb = params.get('thumb') ?? '';
  const size = params.get('size') ?? 'grid';
  const sig = params.get('sig') ?? '';
  if (!item || !server || !thumb || !sig) return NOT_FOUND();

  // (2) SIGNATURE — the thumb must be one our server minted for THIS item on THIS server at THIS size.
  if (!verifyPlexArtRef(item, server, thumb, size, sig)) return NOT_FOUND();
  // (3) per-item ACCESS — re-check the same gate the ledger surface applies (a revoked grant stops art).
  if (!(await isMediaItemAccessibleToUser(session.user.id, item))) return NOT_FOUND();

  const target = resolvePlexArtUpstream(server, thumb, size as 'grid' | 'still');
  if (!target) return NOT_FOUND();

  // Conditional revalidation first — an If-None-Match hit costs no upstream and no cache read.
  if (req.headers.get('if-none-match') === target.etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: target.etag, 'Cache-Control': CACHE_CONTROL },
    });
  }

  const cache = ytdlsubThumbCache();
  const cacheKey = plexArtCacheKey(server, thumb, size as 'grid' | 'still');
  const cached = cache.get(cacheKey);
  if (cached) return ok(cached.body as BodyInit, cached.contentType, cached.etag);

  // Miss: the sized transcode variant. Only THIS tier is memoized and ETagged (ADR-041 C-02/C-04).
  const transcoded = await fetchImage(target.url, target.headers);
  if (transcoded) {
    cache.set(cacheKey, {
      body: new Uint8Array(transcoded.body),
      contentType: transcoded.contentType,
      etag: target.etag,
    });
    return ok(transcoded.body, transcoded.contentType, target.etag);
  }

  // ADR-041 C-02 — the original-art fallback (a transcode quirk on a specific image degrades to the
  // pre-transcode behavior). Deliberately NOT memoized / NOT ETagged with the variant etag — a transient
  // transcoder outage must not make megabyte originals sticky; a short max-age lets recovery swap back in.
  const original = await fetchImage(target.fallbackUrl, target.headers);
  if (!original) return NOT_FOUND();
  return new Response(original.body, {
    status: 200,
    headers: { 'Content-Type': original.contentType, 'Cache-Control': 'private, max-age=300' },
  });
}
