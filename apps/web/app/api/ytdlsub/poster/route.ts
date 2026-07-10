// ADR-038 C-06 / DESIGN-017 D-04 (PLAN-022) — the ytdl-sub Plex-thumb PROXY. Peloton/YouTube content is
// read live from the k8plex Plex server and has NO media_items row, so the ADR-019 /api/posters route
// can't serve it. This sibling route streams a Plex thumb server-side with the X-Plex-Token in a header
// (never the browser). It is BOTH session-gated AND `ytdlsub`-section-gated (a caller who can't see the
// sub-tabs can't probe thumbs), and `resolveYtdlsubThumbUpstream` allows ONLY a `/library/…` Plex path on
// the k8plex server — not an open image proxy. Any miss → 404 → the MediaPoster KindIcon fallback tile.
import { effectiveSectionLevel, resolveYtdlsubThumbUpstream } from '@hnet/api';
import { getServerSession } from '@hnet/auth';

export const runtime = 'nodejs';

const CACHE_CONTROL = 'private, max-age=86400, stale-while-revalidate=604800';
const NOT_FOUND = () => new Response('not found', { status: 404 });

export async function GET(req: Request): Promise<Response> {
  const session = await getServerSession(req.headers);
  if (!session) return new Response('unauthorized', { status: 401 });
  // Section-gated: only a caller who can SEE the ytdl-sub sub-tabs may fetch their posters.
  if (effectiveSectionLevel(session.user.role, 'ytdlsub') === 'disabled') return NOT_FOUND();

  const thumb = new URL(req.url).searchParams.get('thumb');
  const target = thumb ? resolveYtdlsubThumbUpstream(thumb) : null;
  if (!target) return NOT_FOUND();

  let upstream: Response;
  try {
    upstream = await fetch(target.url, {
      headers: target.headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return NOT_FOUND();
  }
  if (!upstream.ok || !upstream.body) return NOT_FOUND();

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
      'Cache-Control': CACHE_CONTROL,
    },
  });
}
