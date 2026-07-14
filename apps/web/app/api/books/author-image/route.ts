// DESIGN-026 D-04 amendment (group-card art) — the ABS AUTHOR-PORTRAIT proxy, the sibling of
// /api/books/cover (ADR-046 / ADR-041 idiom). The grouped-by-Author Audiobooks wall points its
// author cards here ONLY when ABS actually holds a photo (books.groups attaches the URL through
// the populated-value-gated author directory — a card never renders a broken slot). The route
// serves the image with the ABS bearer applied SERVER-SIDE (the ADR-019 posture), BOTH
// session-gated AND `books`-section-gated exactly like its parent, and accepts only a
// uuid-shaped ABS author id + a numeric updatedAt version — not an open image proxy.
//
// ADR-041 discipline: the served representation is the FIXED sized WebP variant (original art as
// the per-image fallback tier — short max-age, no ETag, never memoized), a strong
// (id, updatedAt, variant) ETag, and the shared in-process byte-capped books LRU. Repeat wall
// paints are 304s / memory hits. Any miss → 404 → the card's stacked-cover fan fallback.
import {
  absAuthorImageEtag,
  effectiveSectionLevel,
  getAbsAuthorImage,
  isValidAbsAuthorId,
  isValidAbsAuthorVersion,
} from '@hnet/api';
import { getServerSession } from '@hnet/auth';

export const runtime = 'nodejs';

const CACHE_CONTROL = 'private, max-age=86400, stale-while-revalidate=604800';
const NOT_FOUND = () => new Response('not found', { status: 404 });

export async function GET(req: Request): Promise<Response> {
  const session = await getServerSession(req.headers);
  if (!session) return new Response('unauthorized', { status: 401 });
  // Section-gated: only a caller who can SEE the Books sub-tabs may fetch their author art.
  if (effectiveSectionLevel(session.user.role, 'books') === 'disabled') return NOT_FOUND();

  const params = new URL(req.url).searchParams;
  const id = params.get('id') ?? '';
  const version = params.get('v') ?? '';
  if (!isValidAbsAuthorId(id) || !isValidAbsAuthorVersion(version)) return NOT_FOUND();

  // Strong ETag over (author id, updatedAt, variant) — a re-matched photo rotates the URL + this.
  const etag = absAuthorImageEtag(id, version);
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': CACHE_CONTROL } });
  }

  const image = await getAbsAuthorImage(id, version);
  if (!image) return NOT_FOUND();
  if (image.tier === 'fallback') {
    // The original after a sized-variant miss: short max-age, no ETag — a transient resize quirk
    // must not make originals sticky in browser caches (ADR-041 C-02 discipline).
    return new Response(image.body as BodyInit, {
      status: 200,
      headers: { 'Content-Type': image.contentType, 'Cache-Control': 'private, max-age=300' },
    });
  }
  return new Response(image.body as BodyInit, {
    status: 200,
    headers: { 'Content-Type': image.contentType, 'Cache-Control': CACHE_CONTROL, ETag: etag },
  });
}
