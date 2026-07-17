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
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PhaseChip } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { BackLink } from '@/components/back-link';
import { MediaPoster } from '@/components/cards';
import { formatBytes, formatWhen } from '@/lib/media';
import { BookFixControl } from './book-fix-dialog';

/** Kind-aware display label for the hero badge (owner tone: plain, friendly). */
const KIND_LABEL: Record<string, string> = { book: 'Book', comic: 'Comic', audiobook: 'Audiobook' };

/** The wall tab a collection chip drills into, by media kind. */
const WALL_FOR_KIND: Record<string, 'books' | 'audiobooks' | 'comics'> = {
  book: 'books',
  comic: 'comics',
  audiobook: 'audiobooks',
};

// DESIGN-033 / DESIGN-025 D-08 — the book-Fix trail labels (owner tone: no em-dashes, no jargon).
const FIX_STATUS_LABEL: Record<string, string> = {
  pending: 'Requested',
  queued: 'Queued',
  search_triggered: 'Searching for a replacement',
  failed: 'Failed',
  completed: 'Replaced',
};
const FIX_REASON_LABEL: Record<string, string> = {
  wrong_language: 'Wrong language',
  corrupt_file: "Won't open",
  wrong_edition: 'Wrong edition',
  bad_quality: 'Bad quality',
  other: 'Something else',
};
const REQUEST_STATUS_LABEL: Record<string, string> = {
  requested: 'Requested',
  wanted: 'Wanted',
  grabbed: 'Grabbed',
  landed: 'Landed',
  missing: 'Missing',
};
const REQUEST_ORIGIN_LABEL: Record<string, string> = {
  goodreads: 'From a reading list',
  pairing: 'Format pairing',
};

/** Badge tone for a fix/request status (reuses the ledger badge palette; no new hex). */
function statusTone(status: string): 'ok' | 'info' | 'warn' | 'danger' | 'muted' {
  if (status === 'completed' || status === 'landed') return 'ok';
  if (status === 'failed' || status === 'missing') return 'danger';
  if (status === 'search_triggered' || status === 'grabbed' || status === 'wanted') return 'info';
  return 'muted';
}

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

/**
 * The About summary prose. Kavita/ABS descriptions frequently carry the FULL jacket copy — the
 * blurb plus "Praise for…" review pull-quotes — so the block clamps to a few lines and offers an
 * in-place Show more / Show less toggle. This is a deliberate in-place expansion (the ADR-015
 * exception): the toggle reveals/collapses this block only, it never reflows a neighbour. The
 * toggle appears only when the prose actually overflows the clamp (short summaries stay plain).
 */
function AboutSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // Measured while clamped (the initial render is collapsed): a positive delta means the prose
    // exceeds the clamp, so the toggle is worth showing. Deps are [text] only — never re-run on
    // expand, or the un-clamped element would measure flush and hide the "Show less" affordance.
    setOverflows(el.scrollHeight - el.clientHeight > 4);
  }, [text]);
  return (
    <div className="about-summary-wrap">
      <p
        ref={ref}
        className={`about-summary${expanded ? '' : ' about-summary--clamped'}`}
        data-testid="books-about-summary"
      >
        {text}
      </p>
      {overflows ? (
        <button
          type="button"
          className="about-summary__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
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
  const { item, play, canFix, pairing, collections, fixes, requests } = detail.data!;
  const kindLabel = KIND_LABEL[item.mediaKind] ?? null;
  const wall = WALL_FOR_KIND[item.mediaKind] ?? 'books';
  const isAudio = item.mediaKind === 'audiobook';
  // The About "released / publisher / language" fact line — a peer of the movie About's ADDED row.
  const hasAboutFacts =
    item.year !== null || item.publisher !== null || item.language !== null;
  const hasAbout =
    item.summary !== null || item.genres.length > 0 || collections.length > 0 || hasAboutFacts;
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
            {kindLabel !== null ? <span className="badge badge--muted">{kindLabel}</span> : null}
            {item.formatLabel !== null && item.formatLabel !== kindLabel ? (
              <span className="badge badge--muted">{item.formatLabel}</span>
            ) : null}
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

      {/* About — the movie-About peer: summary prose, the released/publisher/language fact line, and
          the GENRES + COLLECTIONS chip rows. Renders only with real content; each row collapses when
          empty (the movie-page idiom). Static layout, no reflow on interaction (ADR-015). */}
      {hasAbout ? (
        <section className="card admin-section" data-testid="books-about">
          <h2>About</h2>
          {item.summary !== null ? <AboutSummary text={item.summary} /> : null}
          {hasAboutFacts ? (
            <dl className="about-facts">
              {item.year !== null ? (
                <div>
                  <dt>Released</dt>
                  <dd>{item.year}</dd>
                </div>
              ) : null}
              {item.publisher !== null ? (
                <div>
                  <dt>Publisher</dt>
                  <dd>{item.publisher}</dd>
                </div>
              ) : null}
              {item.language !== null ? (
                <div>
                  <dt>Language</dt>
                  <dd>{item.language}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {item.genres.length > 0 ? (
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
          ) : null}
          {collections.length > 0 ? (
            <div className="meta-chips" data-testid="books-collections">
              <span className="meta-chips__label">Collections</span>
              <span className="chips">
                {collections.map((c) => (
                  <Link
                    key={c.id}
                    className="chip"
                    href={`/library?tab=${wall}&view=grouped&by=collection&group=${encodeURIComponent(c.id)}`}
                  >
                    {c.title}
                  </Link>
                ))}
              </span>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="card admin-section">
        <h2>Details</h2>
        <dl className="meta-grid">
          <div>
            <dt>Library</dt>
            <dd>{item.libraryName}</dd>
          </div>
          {item.formatLabel !== null ? (
            <div>
              <dt>Format</dt>
              <dd>{item.formatLabel}</dd>
            </div>
          ) : null}
          {isAudio && item.narrator !== null ? (
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
          {isAudio && duration !== null ? (
            <div>
              <dt>Length</dt>
              <dd>{duration}</dd>
            </div>
          ) : null}
          {!isAudio && item.pageCount !== null ? (
            <div>
              <dt>Pages</dt>
              <dd>{item.pageCount}</dd>
            </div>
          ) : null}
          {item.fileCount !== null ? (
            <div>
              <dt>{isAudio ? 'Audio files' : 'Files'}</dt>
              <dd>{item.fileCount}</dd>
            </div>
          ) : null}
          {item.sizeBytes !== null && item.sizeBytes > 0 ? (
            <div>
              <dt>Size on disk</dt>
              <dd>{formatBytes(item.sizeBytes)}</dd>
            </div>
          ) : null}
          {item.isbn !== null ? (
            <div>
              <dt>ISBN</dt>
              <dd className="url-cell">{item.isbn}</dd>
            </div>
          ) : null}
          {item.addedAt !== null ? (
            <div>
              <dt>Added</dt>
              <dd>{formatWhen(item.addedAt)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Last synced</dt>
            <dd>{formatWhen(item.lastSyncedAt)}</dd>
          </div>
        </dl>
      </section>

      {/* Fixes on this item — the audited book-Fix trail (DESIGN-033), the movie "Fixes on this item"
          peer. Renders only when a fix was requested; newest first. */}
      {fixes.length > 0 ? (
        <section className="card admin-section" data-testid="books-fix-history">
          <h2>Fixes on this item</h2>
          <ul className="fix-list">
            {fixes.map((fix) => (
              <li key={fix.id} className="fix-list__row">
                <span className={`badge badge--${statusTone(fix.status)}`}>
                  {FIX_STATUS_LABEL[fix.status] ?? fix.status}
                </span>
                <span className="fix-list__what">
                  {FIX_REASON_LABEL[fix.reason] ?? fix.reason}
                  {fix.reasonText ? `: ${fix.reasonText}` : ''}
                </span>
                <span className="muted fix-list__when">
                  {fix.requesterDisplayName ?? 'someone'} · {formatWhen(fix.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* History — the linked request lifecycle (how the title was wanted / landed), the movie-History
          idiom. Renders only when a request touched this item; newest first. */}
      {requests.length > 0 ? (
        <section className="card admin-section" data-testid="books-request-history">
          <h2>History</h2>
          <ol className="timeline">
            {requests.map((req) => {
              const line =
                req.comicStatus !== null
                  ? `Comic: ${REQUEST_STATUS_LABEL[req.comicStatus] ?? req.comicStatus}`
                  : `Ebook: ${REQUEST_STATUS_LABEL[req.ebookStatus] ?? req.ebookStatus} · Audio: ${
                      REQUEST_STATUS_LABEL[req.audioStatus] ?? req.audioStatus
                    }`;
              return (
                <li key={req.id}>
                  <span className="timeline__type">
                    {REQUEST_ORIGIN_LABEL[req.origin] ?? req.origin}
                  </span>
                  <span className="timeline__detail">{line}</span>
                  <span className="muted timeline__when">{formatWhen(req.createdAt)}</span>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </>
  );
}
