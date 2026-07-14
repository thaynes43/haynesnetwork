'use client';

// PLAN-045 owner-correction (DESIGN-029 amendment) — the composed Library-Wanted item, rendered as the
// SAME cohesive poster block as an on-disk book (the Movies/TV card anatomy, by construction: shared
// MediaPoster + PosterCardBody). It replaces the rejected "Wanted" STRIP (a bordered section of
// chip-stacked tiles + "for <requester>" + a "Search again" button that looked nothing like the rest of
// the library). A wanted item is an unmatched want by definition, so its art is the wall's standard
// KindIcon glyph tile — never a fake cover; its caption carries title + author and exactly ONE compact
// status badge in the Movies badge slot ("Wanted" amber / "Missing" red). There is NO force-search
// button and NO requester line on the card face: the whole card is a click-through into the owner's
// Goodreads request context (`?focus=` deep-link), where force-search and attribution live (ADR-057).
import Link from 'next/link';
import { MediaPoster } from '@/components/media-poster';
import { PosterCardBody } from '@/components/poster-card-body';
import type { RouterOutputs } from '@/lib/trpc-client';

type BooksMediaKind = 'book' | 'audiobook' | 'comic';
export type WantedWire = RouterOutputs['books']['wanted']['items'][number];

/** The single caption badge for a wanted card — Missing (red) else Wanted (amber), the Movies slot. */
export function wantedBadge(item: Pick<WantedWire, 'status'>): { label: string; tone: 'danger' | 'warn' } {
  return item.status === 'missing' ? { label: 'Missing', tone: 'danger' } : { label: 'Wanted', tone: 'warn' };
}

/** One wanted item as a Library poster card (identical anatomy to an on-disk book tile). */
export function WantedCard({ item, mediaKind }: { item: WantedWire; mediaKind: BooksMediaKind }) {
  const badge = wantedBadge(item);
  const requestHref = `/integrations/goodreads?tab=items&focus=${encodeURIComponent(item.requestId)}`;
  const inner = (
    <>
      {/* A want has no library row ⇒ the designed KindIcon glyph tile, never a fake cover. */}
      <MediaPoster posterUrl={null} kind={mediaKind} alt="" />
      <PosterCardBody title={item.title} subtitle={item.author} badges={[badge]} />
    </>
  );
  // The card click-throughs into its request context (a PUSH — D-19) where force-search + the requester
  // attribution live; a viewer who can't open it (not the owner) gets the same block, non-interactive.
  return item.canOpenRequest ? (
    <Link
      href={requestHref}
      className="media-card poster-card"
      data-testid="wanted-card"
      data-request-id={item.requestId}
    >
      {inner}
    </Link>
  ) : (
    <div className="media-card poster-card" data-testid="wanted-card" data-request-id={item.requestId}>
      {inner}
    </div>
  );
}
