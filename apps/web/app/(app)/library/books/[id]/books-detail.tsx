'use client';

// ADR-047 / DESIGN-025 (PLAN-028) — the Books/Audiobooks/Comics READ-ONLY drill-in. Mirrors the /library/[id]
// visual language (BackLink + `.card.detail-head` with a 2:3 MediaPoster, title/year, a badges row, an About
// block, last-synced) but LEAN: no Fix/Force-Search (books have no *arr semantics, ADR-046). The PRIMARY
// action is the app-specific deep link — "Read in Kavita ↗" / "Listen on Audiobookshelf ↗" (from
// books_items.deep_link_url) — opening the item in the serving app (new tab). Reflow-free (ADR-015).
import { trpc } from '@/lib/trpc-client';
import { BackLink } from '@/components/back-link';
import { MediaPoster } from '@/components/cards';
import { formatWhen } from '@/lib/media';

/** "3h 12m" / "48m" from whole seconds; null when absent. */
function formatDuration(seconds: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function BooksDetail({ id, from }: { id: string; from: string | null }) {
  const detail = trpc.books.detail.useQuery({ id });

  if (detail.isLoading) {
    return (
      <>
        <BackLink from={from} />
        <p className="muted">Loading…</p>
      </>
    );
  }
  if (detail.error) {
    return (
      <>
        <BackLink from={from} />
        <p className="alert" role="alert">
          Failed to load this title: {detail.error.message}
        </p>
      </>
    );
  }
  const { item, play } = detail.data!;
  const duration = formatDuration(item.durationSeconds);
  const badges = [
    item.pageCount ? `${item.pageCount} pages` : null,
    duration,
    item.narrator ? `Narrated by ${item.narrator}` : null,
  ].filter((b): b is string => b !== null);

  return (
    <>
      <BackLink from={from} />

      <section className="card detail-head" data-testid="books-detail-head">
        <span className="detail-head__poster">
          <MediaPoster posterUrl={item.posterUrl} kind={item.mediaKind} alt="" />
        </span>
        <div className="detail-head__body">
          <h1 className="detail-head__title">
            {item.title}
            {item.year !== null ? <span className="muted"> ({item.year})</span> : null}
          </h1>
          <div className="media-card__badges">
            {item.author !== null ? <span className="badge badge--muted">{item.author}</span> : null}
            {item.seriesName !== null ? <span className="badge">{item.seriesName}</span> : null}
          </div>
          {badges.length > 0 ? <p className="detail-head__meta muted">{badges.join(' · ')}</p> : null}
          {/* The PRIMARY deep link — opens the item in Kavita/ABS (new tab); ↗ marks the external jump. */}
          <p className="detail-head__play">
            <a className="btn primary" href={play.url} target="_blank" rel="noopener noreferrer">
              {play.label}
              <span className="btn__ext" aria-hidden="true"> ↗</span>
            </a>
          </p>
        </div>
      </section>

      {item.genres.length > 0 ? (
        <section className="card admin-section">
          <h2>About</h2>
          <div className="meta-chips">
            <span className="meta-chips__label">Genres</span>
            <span className="chips">
              {item.genres.map((g) => (
                <span key={g} className="chip">
                  {g}
                </span>
              ))}
            </span>
          </div>
        </section>
      ) : null}

      <section className="card admin-section">
        <h2>Details</h2>
        <dl className="meta-grid">
          <div>
            <dt>Library</dt>
            <dd>{item.libraryName}</dd>
          </div>
          {item.narrator !== null ? (
            <div>
              <dt>Narrator</dt>
              <dd>{item.narrator}</dd>
            </div>
          ) : null}
          {item.seriesName !== null ? (
            <div>
              <dt>Series</dt>
              <dd>{item.seriesName}</dd>
            </div>
          ) : null}
          {duration !== null ? (
            <div>
              <dt>Length</dt>
              <dd>{duration}</dd>
            </div>
          ) : null}
          {item.pageCount !== null ? (
            <div>
              <dt>Pages</dt>
              <dd>{item.pageCount}</dd>
            </div>
          ) : null}
          <div>
            <dt>Last synced</dt>
            <dd>{formatWhen(item.lastSyncedAt)}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}
