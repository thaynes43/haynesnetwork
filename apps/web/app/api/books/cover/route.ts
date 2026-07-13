// ADR-046 / DESIGN-024 D-05 (PLAN-023, F-06 perf) — the book-cover PROXY. The Books/Audiobooks/Comics
// walls point their poster tiles here; the route serves the cover from Kavita (series-cover) /
// Audiobookshelf (item-cover) with the apiKey/bearer applied SERVER-SIDE, so the credential never
// reaches the browser (the ADR-019 posture). It is BOTH session-gated AND `books`-section-gated (a
// caller who can't see the Books sub-tabs can't probe covers), and `getBooksCover` allows ONLY a closed
// `source` enum with a format-validated `id` — not an open image proxy. Any miss → 404 → the MediaPoster
// KindIcon fallback tile.
//
// F-06 (the ADR-041 idiom, ported): ABS covers are served as the sized upstream WebP variant (original
// art as the per-image fallback tier); Kavita serves its pre-generated cover as stored (resize params
// verified ignored). Hot covers are memoized in the in-process byte-capped ThumbLruCache — repeat wall
// paints are 304s / memory hits, never a per-request upstream fetch.
import { booksCoverEtag, getBooksCover, isBooksSource, isValidBooksExternalId } from '@hnet/api';
import { effectiveSectionLevel } from '@hnet/api';
import { getServerSession } from '@hnet/auth';

export const runtime = 'nodejs';

const CACHE_CONTROL = 'private, max-age=86400, stale-while-revalidate=604800';
const NOT_FOUND = () => new Response('not found', { status: 404 });

export async function GET(req: Request): Promise<Response> {
  const session = await getServerSession(req.headers);
  if (!session) return new Response('unauthorized', { status: 401 });
  // Section-gated: only a caller who can SEE the Books sub-tabs may fetch their covers.
  if (effectiveSectionLevel(session.user.role, 'books') === 'disabled') return NOT_FOUND();

  const params = new URL(req.url).searchParams;
  const source = params.get('source') ?? '';
  const id = params.get('id') ?? '';
  const version = params.get('v') ?? '';
  if (!isBooksSource(source) || !isValidBooksExternalId(source, id)) return NOT_FOUND();

  // Strong ETag over (source, id, coverVersion) — replaced art rotates the URL + this etag.
  const etag = booksCoverEtag(source, id, version);
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL } });
  }

  const cover = await getBooksCover(source, id, version);
  if (!cover) return NOT_FOUND();
  if (cover.tier === 'fallback') {
    // The ABS original after a sized-variant miss: short max-age, no ETag — a transient resize quirk
    // must not make megabyte originals sticky in browser caches (ADR-041 C-02 discipline).
    return new Response(cover.body as BodyInit, {
      status: 200,
      headers: { 'Content-Type': cover.contentType, 'Cache-Control': 'private, max-age=300' },
    });
  }
  return new Response(cover.body as BodyInit, {
    status: 200,
    headers: { 'Content-Type': cover.contentType, 'Cache-Control': CACHE_CONTROL, ETag: etag },
  });
}
