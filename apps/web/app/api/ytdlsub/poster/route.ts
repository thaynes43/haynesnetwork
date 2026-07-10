// ADR-038 C-06 / ADR-041 / DESIGN-017 D-04+D-07 (PLAN-022 + the 2026-07-10 UX package) — the ytdl-sub
// Plex-thumb PROXY. Peloton/YouTube content is read live from the k8plex Plex server and has NO
// media_items row, so the ADR-019 /api/posters route can't serve it. This sibling route serves a Plex
// thumb server-side with the X-Plex-Token in a header (never the browser). It is BOTH session-gated AND
// `ytdlsub`-section-gated (a caller who can't see the sub-tabs can't probe thumbs), and
// `resolveYtdlsubThumbUpstream` allows ONLY a `/library/…` Plex path on the k8plex server with a CLOSED
// `size` allow-list — not an open image/resize proxy. Any miss → 404 → the MediaPoster fallback tile.
//
// ADR-041 (wall perf): the upstream is a fixed-size WebP variant from k8plex's photo-transcode endpoint
// (grid = the 2:3 poster tile, still = the 16:9 episode row) with the ORIGINAL art as a per-image
// fallback; responses carry a strong (size, thumb) ETag (Plex thumb paths embed lastWrite, so art
// changes rotate it) and hot variants are memoized in the in-process ThumbLruCache — repeat wall paints
// are 304s / memory hits, never a re-pull of megabyte originals.
import {
  effectiveSectionLevel,
  isYtdlsubThumbSize,
  resolveYtdlsubThumbUpstream,
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
  // Section-gated: only a caller who can SEE the ytdl-sub sub-tabs may fetch their posters.
  if (effectiveSectionLevel(session.user.role, 'ytdlsub') === 'disabled') return NOT_FOUND();

  const params = new URL(req.url).searchParams;
  const thumb = params.get('thumb');
  const size = params.get('size') ?? 'grid';
  if (!isYtdlsubThumbSize(size)) return NOT_FOUND(); // closed allow-list (ADR-041 C-05)
  const target = thumb ? resolveYtdlsubThumbUpstream(thumb, size) : null;
  if (!target) return NOT_FOUND();

  // Conditional revalidation first — an If-None-Match hit costs no upstream and no cache read.
  if (req.headers.get('if-none-match') === target.etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: target.etag, 'Cache-Control': CACHE_CONTROL },
    });
  }

  const cache = ytdlsubThumbCache();
  const cacheKey = `${size}:${thumb}`;
  const cached = cache.get(cacheKey);
  if (cached) return ok(cached.body as BodyInit, cached.contentType, cached.etag);

  // Miss: the sized transcode variant, then the original art (ADR-041 C-02 — a transcode quirk on a
  // specific image degrades to exactly the pre-ADR-041 behavior, never a broken tile).
  const image =
    (await fetchImage(target.url, target.headers)) ??
    (await fetchImage(target.fallbackUrl, target.headers));
  if (!image) return NOT_FOUND();

  cache.set(cacheKey, {
    body: new Uint8Array(image.body),
    contentType: image.contentType,
    etag: target.etag,
  });
  return ok(image.body, image.contentType, target.etag);
}
