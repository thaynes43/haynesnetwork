'use client';

// ADR-057 / DESIGN-029 (PLAN-045 step 4) — the Library-Wanted COMPOSITION: household Wanted tiles
// on the Books/Audiobooks/Comics walls, composed from the `book_requests` ledger (the *arr
// monitored-but-missing idiom for books; the books_items mirror stays PURE — ADR-046). Rides the
// wall's own BOOKS-section gate (owner ruling Q-01; `books.wanted` is server-authoritative) and is
// CLEARLY badged: a labeled strip above the library grid (or the whole wall under the registry's
// Wanted filter), every tile wearing the corner-puck state mark + a "Wanted" badge + its source
// shelf. A wanted tile has NO library row (an unmatched want by definition), so its art is the
// designed KindIcon fallback tile — never fake covers.
//
// Per-viewer affordances come from the wire, never guessed client-side: `canSearch` renders the
// shared force-search control (the dispatching `integrations.search` — LL for books/audio, Kapowarr
// for comics; PLAN-015-style feedback in a reserved slot), `canOpenRequest` deep-links the tile
// into the owner's Goodreads sub-section request context.
import Link from 'next/link';
import { MediaPoster } from '@/components/media-poster';
import { RequestPhaseGlyph } from '@/components/request-glyphs';
import { RequestSearchButton } from '@/components/request-search-button';
import { shelfLabel, type RequestPhaseName } from '@/lib/goodreads-shelf-wall';
import type { RouterOutputs } from '@/lib/trpc-client';

type BooksMediaKind = 'book' | 'audiobook' | 'comic';
export type WantedWire = RouterOutputs['books']['wanted']['items'][number];

/** The corner-puck phase for a wanted tile (never 'have' here — a landed want leaves the overlay). */
export function wantedPhase(item: Pick<WantedWire, 'parked' | 'status'>): RequestPhaseName {
  if (item.parked) return 'parked';
  return item.status === 'missing' ? 'missing' : 'searching';
}

function WantedTile({ item, mediaKind }: { item: WantedWire; mediaKind: BooksMediaKind }) {
  const phase = wantedPhase(item);
  const requestHref = `/integrations/goodreads?tab=items&focus=${encodeURIComponent(item.requestId)}`;
  const poster = (
    <div className="gwall-tile__poster">
      <MediaPoster posterUrl={null} kind={mediaKind} alt="" />
      <span className="gwall-overlay" data-phase={phase} aria-hidden="true">
        <RequestPhaseGlyph phase={phase} />
      </span>
    </div>
  );
  return (
    <li className="gwall-tile wanted-tile" data-testid="wanted-tile" data-phase={phase}>
      {item.canOpenRequest ? (
        // Deep-link into the request's context in the Goodreads sub-section (a PUSH — D-19).
        <Link href={requestHref} className="gwall-tile__link" data-testid="wanted-tile-link">
          {poster}
        </Link>
      ) : (
        poster
      )}
      <div className="gwall-caption" title={item.title}>
        {item.title}
      </div>
      <div className="gwall-sub muted">{item.author ?? '—'}</div>
      <div className="gwall-shelves">
        <span className={`badge ${phase === 'missing' ? 'badge--danger' : 'badge--warn'}`}>
          {phase === 'missing' ? 'Missing' : 'Wanted'}
        </span>
        <span className="badge badge--muted gwall-shelf">{shelfLabel(item.shelf)}</span>
      </div>
      <div className="gwall-sub muted wanted-tile__by" title={`Requested by ${item.requestedBy.join(', ')}`}>
        {item.requestedBy.length > 0 ? `for ${item.requestedBy.join(', ')}` : ' '}
      </div>
      <div className="request-action">
        {item.canSearch ? (
          <RequestSearchButton requestId={item.requestId} />
        ) : item.parked ? (
          <span className="muted request-action__note">Waiting on a ComicVine match.</span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The Wanted overlay for one book wall. `only` = the registry's Wanted filter is active (the wanted
 * tiles ARE the wall); otherwise the strip renders above the library grid with its labeled header.
 * Renders nothing while the wall has no wanted tiles (populated-value-gated, ADR-051 C-06).
 */
export function WantedStrip({
  mediaKind,
  items,
  only = false,
}: {
  mediaKind: BooksMediaKind;
  items: WantedWire[];
  only?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="gwanted" data-testid="wanted-strip">
      {!only ? (
        <h2 className="gwanted__title">
          Wanted <span className="muted">· {items.length}</span>
        </h2>
      ) : null}
      <ul className="gwall gwall--wanted">
        {items.map((item) => (
          <WantedTile key={item.requestId} item={item} mediaKind={mediaKind} />
        ))}
      </ul>
    </section>
  );
}
