'use client';

// ADR-047 / DESIGN-025 (PLAN-028) — the Books/Audiobooks/Comics READ-ONLY drill-in. Mirrors the /library/[id]
// visual language (BackLink + `.card.detail-head` with a 2:3 MediaPoster, title/year, a badges row, an About
// block, last-synced) but the PRIMARY action is the deep link; ADR-062 (PLAN-041) adds a server-gated Fix control. The PRIMARY
// action is the app-specific deep link — "Read in Kavita ↗" / "Listen on Audiobookshelf ↗" (from
// books_items.deep_link_url) — opening the item in the serving app (new tab). Reflow-free (ADR-015).
//
// ADR-065 / DESIGN-036 D-09 (PLAN-050) — the FORMAT PAIRING row: a PAIRED title renders BOTH consume
// buttons (each format's own deep link); an unpaired title keeps its active button and adds the
// missing format's honest affordance below it — a link to the pairing want's wanted-detail when the
// paced backfill minted one, plus the audited Search button (the FormatSearchSlot reserved-slot
// idiom: button swaps to a PhaseChip IN PLACE, recolor never reflow) when actionable.
import { useState } from 'react';
import Link from 'next/link';
import { PhaseChip } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { BackLink } from '@/components/back-link';
import { MediaPoster } from '@/components/cards';
import { formatWhen } from '@/lib/media';
import { BookFixControl } from './book-fix-dialog';

/** "3h 12m" / "48m" from whole seconds; null when absent. */
function formatDuration(seconds: number | null): string | null {
  if (seconds == null || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const MISSING_FORMAT_LABEL: Record<'ebook' | 'audiobook', string> = {
  ebook: 'Ebook',
  audiobook: 'Audiobook',
};

/**
 * The pairing want's audited Search button in a reserved slot (the wanted-detail FormatSearchSlot
 * idiom): one fire per page load, the button swaps to a live PhaseChip in place. Non-destructive, so
 * a plain button (hard rule 8); the endpoint is the books-gated `books.searchPairingWant`.
 */
function PairingSearchSlot({ requestId, missingLabel }: { requestId: string; missingLabel: string }) {
  const [fired, setFired] = useState<
    | { kind: 'fired' }
    | { kind: 'noop' }
    | { kind: 'failed'; message: string }
    | null
  >(null);
  const search = trpc.books.searchPairingWant.useMutation({
    onSuccess: (result) => setFired(result.searched ? { kind: 'fired' } : { kind: 'noop' }),
    onError: (error) => setFired({ kind: 'failed', message: error.message }),
  });

  let content;
  if (search.isPending) {
    content = <PhaseChip phase="searching" label="Searching…" tone="neutral" pulse meter />;
  } else if (fired?.kind === 'fired') {
    content = <PhaseChip phase="fired" label="Search fired" tone="info" pulse meter title={`${missingLabel} search sent to the library.`} />;
  } else if (fired?.kind === 'noop') {
    content = <PhaseChip phase="noop" label="Nothing to search" tone="warning" title="Nothing to search right now." />;
  } else if (fired?.kind === 'failed') {
    content = <PhaseChip phase="failed" label="Search failed" tone="danger" title={fired.message} />;
  } else {
    content = (
      <button
        type="button"
        className="btn sm"
        data-testid="pairing-search-btn"
        onClick={() => search.mutate({ requestId })}
      >
        Search for {missingLabel.toLowerCase()}
      </button>
    );
  }
  return (
    <span className="action-slot action-slot--roll" data-testid="pairing-search">
      {content}
    </span>
  );
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
  const { item, play, canFix, pairing } = detail.data!;
  const missingLabel =
    pairing?.missingFormat != null ? MISSING_FORMAT_LABEL[pairing.missingFormat] : null;
  const wantedHref =
    pairing?.want != null
      ? `/library/books/wanted/${encodeURIComponent(pairing.want.requestId)}?from=${
          item.mediaKind === 'audiobook' ? 'audiobooks' : 'books'
        }`
      : null;
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
          {/* The PRIMARY deep link — opens the item in Kavita/ABS (new tab); ↗ marks the external jump.
              ADR-065 — a PAIRED title renders the counterpart format's button right beside it. */}
          <p className="detail-head__play">
            <a className="btn primary" href={play.url} target="_blank" rel="noopener noreferrer">
              {play.label}
              <span className="btn__ext" aria-hidden="true"> ↗</span>
            </a>
            {pairing?.pairedPlay ? (
              <a
                className="btn"
                href={pairing.pairedPlay.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="paired-play"
              >
                {pairing.pairedPlay.label}
                <span className="btn__ext" aria-hidden="true"> ↗</span>
              </a>
            ) : null}
            {/* ADR-062 (PLAN-041) — the Fix control (server-gated by canFix). */}
            {canFix ? <BookFixControl booksItemId={item.id} title={item.title} /> : null}
          </p>
          {/* ADR-065 / DESIGN-036 D-09 — the MISSING format's honest affordance (unpaired titles only):
              a link to the pairing want's status page when minted, the audited Search button when
              actionable, or the plain note while the paced backfill has not reached this title yet. */}
          {pairing !== null && pairing.pairedPlay === null && missingLabel !== null ? (
            <p className="detail-head__play" data-testid="pairing-missing">
              {pairing.want !== null && wantedHref !== null ? (
                <>
                  <Link className="btn sm" href={wantedHref} data-testid="pairing-want-link">
                    {missingLabel}: view wanted status
                  </Link>
                  {pairing.want.searchable ? (
                    <PairingSearchSlot requestId={pairing.want.requestId} missingLabel={missingLabel} />
                  ) : null}
                </>
              ) : (
                <span className="muted" data-testid="pairing-pending">
                  No {missingLabel.toLowerCase()} in the library yet. The pairing sync will request one
                  automatically.
                </span>
              )}
            </p>
          ) : null}
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
