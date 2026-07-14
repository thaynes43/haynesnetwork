'use client';

// PLAN-045 owner-correction (DESIGN-029 amendment) — the composed Library-Wanted item, rendered as the
// SAME cohesive poster block as an on-disk book (the Movies/TV card anatomy, by construction: shared
// MediaPoster + PosterCardBody). It replaces the rejected "Wanted" STRIP (a bordered section of
// chip-stacked tiles + "for <requester>" + a "Search again" button that looked nothing like the rest of
// the library). A wanted item is an unmatched want by definition, so its art is the wall's standard
// KindIcon glyph tile — never a fake cover; its caption carries title + author and exactly ONE compact
// status badge in the Movies badge slot ("Wanted" amber / "Missing" red). There is NO force-search
// button and NO requester line on the card face.
//
// PLAN-047 (DESIGN-029 amendment-2 — owner Wanted-parity ruling) — the whole card now click-throughs into
// the in-app Wanted DETAIL PAGE `/library/books/wanted/[requestId]` (the Movies/TV poster→detail idiom),
// where the poster hero, source-shelf + requester attribution, per-format status rows, and the per-format
// Force-Search live there. It is books-gated + HOUSEHOLD (Q-01), so EVERY books-visible viewer can open it
// (the old `?focus=` deep-link into the owner-only Goodreads sub-section is replaced) — the card always
// links; the detail page decides per-viewer whether Force-Search renders.
import Link from 'next/link';
import { MediaPoster } from '@/components/media-poster';
import { PosterCardBody } from '@/components/poster-card-body';
import type { RouterOutputs } from '@/lib/trpc-client';

type BooksMediaKind = 'book' | 'audiobook' | 'comic';
export type WantedWire = RouterOutputs['books']['wanted']['items'][number];

/** The wall id (the `?from=` back-link key) for the detail page's way back to THIS wall. */
const WALL_FROM: Record<BooksMediaKind, string> = {
  book: 'books',
  audiobook: 'audiobooks',
  comic: 'comics',
};

/** The single caption badge for a wanted card — Missing (red) else Wanted (amber), the Movies slot. */
export function wantedBadge(item: Pick<WantedWire, 'status'>): { label: string; tone: 'danger' | 'warn' } {
  return item.status === 'missing' ? { label: 'Missing', tone: 'danger' } : { label: 'Wanted', tone: 'warn' };
}

/** One wanted item as a Library poster card (identical anatomy to an on-disk book tile). */
export function WantedCard({ item, mediaKind }: { item: WantedWire; mediaKind: BooksMediaKind }) {
  const badge = wantedBadge(item);
  const detailHref = `/library/books/wanted/${encodeURIComponent(item.requestId)}?from=${WALL_FROM[mediaKind]}`;
  return (
    <Link
      href={detailHref}
      className="media-card poster-card"
      data-testid="wanted-card"
      data-request-id={item.requestId}
    >
      {/* A want has no library row ⇒ the designed KindIcon glyph tile, never a fake cover. */}
      <MediaPoster posterUrl={null} kind={mediaKind} alt="" />
      <PosterCardBody title={item.title} subtitle={item.author} badges={[badge]} />
    </Link>
  );
}
