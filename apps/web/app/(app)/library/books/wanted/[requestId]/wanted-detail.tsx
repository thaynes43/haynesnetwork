'use client';

// ADR-057 amendment (PLAN-047 — DESIGN-029 amendment-2, owner Wanted-parity ruling) — the WANT detail view,
// the books analog of the /library/[id] Movies/TV detail. It mirrors that page's visual language BY REUSE:
// BackLink + `.card.detail-head` with a 2:3 MediaPoster, title/author, a badges row, and the ADR-015
// reserved-slot action idiom (`.action-slot`) — but the "grains" are FORMATS (Ebook/Audiobook, or the single
// Comic leg), each carrying its own downstream status (wanted/grabbed/landed/missing/parked) and its own
// Force-Search button. The button calls the same dispatching `integrations.search` surface (ebook/audio →
// LazyLibrarian, comic → Kapowarr — audited `request_book_search`), with PLAN-015-style feedback IN PLACE:
// the reserved slot swaps the button for a live PhaseChip (searching → fired / nothing / failed), no reflow.
// Books have no per-grab progress feed (DESIGN-029 Q-02 residual), so "fired → the next-reconcile status" is
// the honest downstream signal; the fired chip is the immediate confirmation.
//
// Attribution (source shelf + requesters) lives HERE — it was pulled off the card faces (amendment-1). The
// per-format Force-Search renders only when the server says `searchable` (OWN the request + the integrations
// section); a books-only household viewer sees the status rows read-only.
import { useState } from 'react';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import { PhaseChip, type PhaseTone } from '@hnet/ui';
import { BackLink } from '@/components/back-link';
import { MediaPoster } from '@/components/cards';
import { ActivityStageChip, useActivityItemStatus } from '@/components/activity-live';
import { formatWhen } from '@/lib/media';
import { shelfLabel } from '@/lib/goodreads-shelf-wall';
import type { BookRequestStatus } from '@hnet/db';

type WantedDetailWire = RouterOutputs['books']['wantedDetail'];
type FormatRow = WantedDetailWire['formats'][number];

/** The per-format status label — the *arr wanted/missing idiom in book words. */
const STATUS_LABEL: Record<BookRequestStatus, string> = {
  requested: 'Requested',
  wanted: 'Wanted',
  grabbed: 'Grabbed',
  landed: 'Have it',
  missing: 'Missing',
};

/** The per-format status → the shared `.badge--<tone>` accent (green have · info grabbed · amber wanted · red missing). */
function statusTone(status: BookRequestStatus): 'ok' | 'info' | 'warn' | 'danger' {
  if (status === 'landed') return 'ok';
  if (status === 'grabbed') return 'info';
  if (status === 'missing') return 'danger';
  return 'warn'; // requested / wanted — actively looking
}

const FORMAT_LABEL: Record<FormatRow['format'], string> = {
  ebook: 'Ebook',
  audiobook: 'Audiobook',
  comic: 'Comic',
};

/** The dominant hero badge — the wall's phase collapse (any landed ⇒ Have it; all missing ⇒ Missing; else Wanted). */
function heroBadge(
  detail: WantedDetailWire,
): { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (detail.parked) return { label: 'Parked', tone: 'muted' };
  const statuses = detail.formats.map((f) => f.status);
  if (statuses.includes('landed')) return { label: 'Have it', tone: 'ok' };
  if (statuses.every((s) => s === 'missing')) return { label: 'Missing', tone: 'danger' };
  return { label: 'Wanted', tone: 'warn' };
}

// ---------------------------------------------------------------------------
// The per-format Force-Search slot — the reserved ADR-015 slot (button ↔ live chip), the books analog of
// the item-detail ActionSlot. A single fire per session terminal (reload to re-fire — the wall puck idiom);
// non-destructive ⇒ a plain button, never a ConfirmButton (hard rule 8).
// ---------------------------------------------------------------------------

type Fired =
  | { kind: 'fired'; target: 'kapowarr' | 'lazylibrarian'; formats: string[] }
  | { kind: 'noop'; reason: string | undefined }
  | { kind: 'failed'; message: string };

const FIRED_FORMAT_LABEL: Record<string, string> = { ebook: 'Ebook', audiobook: 'Audio' };

const NOOP_COPY: Record<string, string> = {
  unroutable: 'Nothing to search — routing pending.',
  no_ll_id: 'Nothing to search — no LazyLibrarian id yet.',
  no_kapowarr_id: 'Nothing to search — not routed to Kapowarr yet.',
  landed: 'Already landed — nothing to search.',
};

function firedTitle(fired: Extract<Fired, { kind: 'fired' }>): string {
  if (fired.target === 'kapowarr') return 'Search fired — Kapowarr (auto-search)';
  const formats = fired.formats.map((f) => FIRED_FORMAT_LABEL[f] ?? f).join(' + ');
  return `Search fired — LazyLibrarian${formats ? ` (${formats})` : ''}`;
}

function FormatSearchSlot({
  requestId,
  format,
  onFired,
}: {
  requestId: string;
  format: FormatRow['format'];
  onFired: () => void;
}) {
  const [fired, setFired] = useState<Fired | null>(null);
  const search = trpc.integrations.search.useMutation({
    onSuccess: (result) => {
      if (result.searched) {
        setFired({
          kind: 'fired',
          target: result.target,
          formats: 'formats' in result ? (result.formats ?? []) : [],
        });
        onFired();
      } else {
        setFired({ kind: 'noop', reason: 'reason' in result ? result.reason : undefined });
      }
    },
    onError: (error) => setFired({ kind: 'failed', message: error.message }),
  });

  const chip = (phase: string, label: string, tone: PhaseTone, opts?: { pulse?: boolean; title?: string }) => (
    <PhaseChip phase={phase} label={label} tone={tone} pulse={opts?.pulse} meter={opts?.pulse} title={opts?.title} />
  );

  let content;
  if (search.isPending) {
    content = chip('searching', 'Searching…', 'neutral', { pulse: true });
  } else if (fired?.kind === 'fired') {
    content = chip('fired', 'Search fired', 'info', { pulse: true, title: firedTitle(fired) });
  } else if (fired?.kind === 'noop') {
    content = chip('noop', 'Nothing to search', 'warning', {
      title: (fired.reason ? NOOP_COPY[fired.reason] : undefined) ?? 'Nothing to search.',
    });
  } else if (fired?.kind === 'failed') {
    content = chip('failed', 'Search failed', 'danger', { title: fired.message });
  } else {
    // The comic leg searches the whole Kapowarr volume (no per-format param); a book leg targets its format.
    content = (
      <button
        type="button"
        className="btn sm"
        data-testid="format-search-btn"
        onClick={() => search.mutate(format === 'comic' ? { requestId } : { requestId, format })}
      >
        Force Search
      </button>
    );
  }

  return (
    <span className="action-slot action-slot--roll" data-testid="format-search">
      {content}
    </span>
  );
}

// ---------------------------------------------------------------------------

/**
 * D-10 — one per-format row: the status badge + Force-Search slot, PLUS a live in-flight PhaseChip that walks
 * the stage (searching → downloading % → importing → done) once this format is actively being acquired (its
 * status is wanted/grabbed) or a re-search has just fired here. The chip polls `activity.itemStatus` for this
 * format's activity id (`books:ll:<llBookId>:<format>` / `kapowarr:<volumeId>`) so the row MOVES like Fix.
 */
function FormatDetailRow({
  requestId,
  row,
  activityId,
  onFired,
}: {
  requestId: string;
  row: FormatRow;
  activityId: string | null;
  onFired: () => void;
}) {
  const [fired, setFired] = useState(false);
  const inFlight = row.status === 'wanted' || row.status === 'grabbed';
  const live = useActivityItemStatus(activityId, activityId !== null && (fired || inFlight));
  const showLive = activityId !== null && (fired || inFlight) && (live.pending || live.present);
  return (
    <li className="child-row" data-testid="format-row" data-format={row.format}>
      <span className="child-row__label">{FORMAT_LABEL[row.format]}</span>
      <span className={`badge badge--${statusTone(row.status)}`}>{STATUS_LABEL[row.status]}</span>
      <span className="child-row__actions">
        {showLive ? <ActivityStageChip status={live} /> : null}
        {row.searchable ? (
          <FormatSearchSlot
            requestId={requestId}
            format={row.format}
            onFired={() => {
              setFired(true);
              onFired();
            }}
          />
        ) : null}
      </span>
    </li>
  );
}

export function WantedDetail({ requestId, from }: { requestId: string; from: string | null }) {
  const utils = trpc.useUtils();
  // Poll while the page is visible so a status reconcile (wanted → grabbed → landed) appears without a manual
  // reload — the same "live-update while visible" contract the Activity tab honors (D-10).
  const detail = trpc.books.wantedDetail.useQuery(
    { requestId },
    { refetchInterval: 8000, refetchOnWindowFocus: true, placeholderData: (prev) => prev },
  );

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
          Failed to load this request: {detail.error.message}
        </p>
      </>
    );
  }
  const d = detail.data!;
  const hero = heroBadge(d);
  const refresh = () => void utils.books.wantedDetail.invalidate({ requestId });

  // The live-read activity id for one format — the poll key the per-format live chip watches.
  const activityIdFor = (format: FormatRow['format']): string | null =>
    format === 'comic'
      ? d.kapowarrVolumeId != null
        ? `kapowarr:${d.kapowarrVolumeId}`
        : null
      : d.llBookId != null
        ? `books:ll:${d.llBookId}:${format}`
        : null;

  return (
    <>
      <BackLink from={from} />

      <section className="card detail-head" data-testid="wanted-detail-head">
        {/* A want is unmatched by definition ⇒ the designed KindIcon glyph tile; the cover-proxy art
            shows only if the want is already matched into the library (ADR-015 reserved box). */}
        <span className="detail-head__poster">
          <MediaPoster posterUrl={d.posterUrl} kind={d.mediaKind} alt="" />
        </span>
        <div className="detail-head__body">
          <h1 className="detail-head__title">{d.title}</h1>
          <div className="media-card__badges">
            <span className="badge badge--muted">{shelfLabel(d.shelf)}</span>
            <span className={`badge badge--${hero.tone}`}>{hero.label}</span>
            {d.isComic ? <span className="badge badge--muted">Comic</span> : null}
            {d.matchedBooksItemId !== null ? (
              <span className="badge badge--ok">In your library</span>
            ) : null}
          </div>
          {d.author !== null ? <p className="detail-head__meta muted">{d.author}</p> : null}
          {/* Attribution lives HERE now (off the card face) — the household requesters, the Movies "Requested
              by" chip idiom. */}
          {d.requestedBy.length > 0 ? (
            <div className="meta-chips">
              <span className="meta-chips__label">Requested by</span>
              <span className="chips">
                {d.requestedBy.map((name) => (
                  <span key={name} className="chip chip--requester">
                    {name}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
        </div>
      </section>

      {/* The per-format status rows + Force-Search (the *arr per-grain idiom in book words). */}
      <section className="card admin-section">
        <h2>Formats</h2>
        <ul className="child-list">
          {d.formats.map((f) => (
            <FormatDetailRow
              key={f.format}
              requestId={d.requestId}
              row={f}
              activityId={activityIdFor(f.format)}
              onFired={refresh}
            />
          ))}
        </ul>
        {d.parked ? (
          <p className="muted">
            Waiting on a ComicVine match — this comic can’t be routed to Kapowarr yet, so there’s nothing to
            search. The hourly sync retries automatically.
          </p>
        ) : !d.canSearch ? (
          <p className="muted">
            Force Search is available to the person who shelved this want. The library keeps looking on the
            hourly sync in the meantime.
          </p>
        ) : null}
      </section>

      <section className="card admin-section">
        <h2>Details</h2>
        <dl className="meta-grid">
          <div>
            <dt>Source shelf</dt>
            <dd>{shelfLabel(d.shelf)}</dd>
          </div>
          <div>
            <dt>Shelved</dt>
            <dd>{d.shelvedAt !== null ? formatWhen(d.shelvedAt) : '—'}</dd>
          </div>
          <div>
            <dt>Last searched</dt>
            <dd>{d.lastSearchedAt !== null ? formatWhen(d.lastSearchedAt) : 'Not yet'}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}
