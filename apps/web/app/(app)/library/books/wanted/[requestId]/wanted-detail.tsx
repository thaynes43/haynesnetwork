'use client';

// ADR-057 amendment (PLAN-047 — DESIGN-029 amendment-2, owner Wanted-parity ruling) — the WANT detail view,
// the books analog of the /library/[id] Movies/TV detail. It mirrors that page's visual language BY REUSE of
// the shared @hnet/ui media-action system (ADR-071 / DESIGN-004 D-24): BackLink + <MediaHero> (the ONE
// `.detail-head` scaffold) with a 2:3 MediaPoster, title/author, a badges row, and — per FORMAT (Ebook/
// Audiobook, or the single Comic leg) — a Force-Search rendered through <MediaAction action="forceSearch">
// off the MEDIA_ACTIONS registry, inside the reflow-safe <ReservedActionSlot> (the ADR-015 button ↔ live-chip
// idiom). Each format carries its own downstream status (wanted/grabbed/landed/missing/parked). The button
// calls the same dispatching `integrations.search` surface (ebook/audio →
// LazyLibrarian, comic → Kapowarr — audited `request_book_search`), with PLAN-015-style feedback IN PLACE:
// the reserved slot swaps the button for a live PhaseChip (searching → fired / nothing / failed), no reflow.
// Books have no per-grab progress feed (DESIGN-029 Q-02 residual), so "fired → the next-reconcile status" is
// the honest downstream signal; the fired chip is the immediate confirmation.
//
// Attribution (source shelf + requesters) lives HERE — it was pulled off the card faces (amendment-1). The
// per-format Force-Search renders only when the server says `searchable` (OWN the request + the integrations
// section); a books-only household viewer sees the status rows read-only.
import { useState, type ReactNode } from 'react';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';
import {
  PhaseChip,
  MediaHero,
  MediaAction,
  ReservedActionSlot,
  type PhaseTone,
  type MediaHeroBadge,
} from '@hnet/ui';
import { BackLink } from '@/components/back-link';
import { MediaPoster } from '@/components/cards';
import {
  ActivityStageChip,
  useActivityItemStatus,
  type ActivityLiveStatus,
} from '@/components/activity-live';
import { effectiveFormatStatus, formatActivityId, formatLiveWins } from '@/lib/format-live-status';
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

/** The dominant hero badge — the wall's phase collapse (any landed ⇒ Have it; all missing ⇒ Missing; else
 *  Wanted). Collapses over the live-EFFECTIVE per-format statuses so the hero can't read "Missing" while a
 *  format is actively downloading (the terminology guard applied to the hero too). */
function heroBadge(
  parked: boolean,
  statuses: BookRequestStatus[],
): { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (parked) return { label: 'Parked', tone: 'muted' };
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
  origin,
  onFired,
}: {
  requestId: string;
  format: FormatRow['format'];
  /** ADR-065 / DESIGN-038 D-13 — picks the endpoint: a goodreads want fires the owner-gated
   *  `integrations.search`; a SYSTEM want (pairing OR collection) fires the books-gated
   *  `books.searchPairingWant`. */
  origin: 'goodreads' | 'pairing' | 'collection';
  onFired: () => void;
}) {
  const isSystemWant = origin === 'pairing' || origin === 'collection';
  const [fired, setFired] = useState<Fired | null>(null);
  const handlers = {
    onSuccess: (result: {
      searched: boolean;
      target: 'kapowarr' | 'lazylibrarian';
      formats?: string[];
      reason?: string;
    }) => {
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
    onError: (error: { message: string }) => setFired({ kind: 'failed', message: error.message }),
  };
  const searchGoodreads = trpc.integrations.search.useMutation(handlers);
  const searchPairing = trpc.books.searchPairingWant.useMutation(handlers);
  const search = isSystemWant ? searchPairing : searchGoodreads;

  const chip = (
    phase: string,
    label: string,
    tone: PhaseTone,
    opts?: { pulse?: boolean; title?: string },
  ) => (
    <PhaseChip
      phase={phase}
      label={label}
      tone={tone}
      pulse={opts?.pulse}
      meter={opts?.pulse}
      title={opts?.title}
    />
  );

  // ADR-071 / DESIGN-004 D-24 — the in-flight live node shown IN PLACE of the resting Force-Search
  // button. The button is the shared <MediaAction action="forceSearch"> (the ONE registry look/label);
  // the reflow-safe swap is the shared <ReservedActionSlot>. Only the mutation/state machine (which
  // needs trpc) stays here — the audit's "the state machine stays in the app" split.
  let live: ReactNode = null;
  if (search.isPending) {
    live = chip('searching', 'Searching…', 'neutral', { pulse: true });
  } else if (fired?.kind === 'fired') {
    live = chip('fired', 'Search fired', 'info', { pulse: true, title: firedTitle(fired) });
  } else if (fired?.kind === 'noop') {
    live = chip('noop', 'Nothing to search', 'warning', {
      title: (fired.reason ? NOOP_COPY[fired.reason] : undefined) ?? 'Nothing to search.',
    });
  } else if (fired?.kind === 'failed') {
    live = chip('failed', 'Search failed', 'danger', { title: fired.message });
  }

  return (
    <ReservedActionSlot reserve="roll" testId="format-search" live={live}>
      {/* The comic leg searches the whole Kapowarr volume (no per-format param); a book leg targets
          its format; a pairing want has exactly one open leg so its endpoint needs no format param. */}
      <MediaAction
        action="forceSearch"
        size="sm"
        testId="format-search-btn"
        onFire={() =>
          isSystemWant
            ? searchPairing.mutate({ requestId })
            : searchGoodreads.mutate(format === 'comic' ? { requestId } : { requestId, format })
        }
      />
    </ReservedActionSlot>
  );
}

// ---------------------------------------------------------------------------

/**
 * D-10 + fix/live-status-precedence — one per-format row: LIVE-STATE-WINS. It polls `activity.itemStatus` for
 * this format's activity id (`books:ll:<llBookId>:<format>` / `kapowarr:<volumeId>`) ON MOUNT (not only after a
 * re-search fires here) and while visible (the #279 cadence), so a live in-flight/landed signal OVERRIDES the
 * reconciled `book_requests` snapshot the instant the page opens — the wall and this detail can never disagree.
 * When live wins the row shows the live stage chip (searching → downloading % → importing → landed, the Fix
 * grammar) in the RESERVED action slot and the snapshot status badge is suppressed (so an active grab never
 * reads "Missing" — the terminology guard). The snapshot renders only when there is no live state.
 */
function FormatDetailRow({
  requestId,
  row,
  origin,
  activityId,
  live,
  onFired,
}: {
  requestId: string;
  row: FormatRow;
  origin: 'goodreads' | 'pairing' | 'collection';
  activityId: string | null;
  /** This format's live status (polled by the parent, so the hero + row read ONE source of truth). */
  live: ActivityLiveStatus;
  onFired: () => void;
}) {
  const utils = trpc.useUtils();
  const showLive = formatLiveWins(row.status, live);
  // Firing a re-search flips this format's live state → nudge itemStatus so the row is seen to MOVE (the
  // #279 poll may have stopped after a `present:false` idle answer), then refresh the reconciled snapshot.
  const handleFired = () => {
    if (activityId !== null) void utils.activity.itemStatus.invalidate({ itemId: activityId });
    onFired();
  };
  return (
    <li
      className="child-row"
      data-testid="format-row"
      data-format={row.format}
      data-live={showLive ? '' : undefined}
    >
      <span className="child-row__label">{FORMAT_LABEL[row.format]}</span>
      {showLive ? null : (
        <span className={`badge badge--${statusTone(row.status)}`} data-testid="format-status">
          {STATUS_LABEL[row.status]}
        </span>
      )}
      <span className="child-row__actions">
        {showLive ? <ActivityStageChip status={live} /> : null}
        {row.searchable ? (
          <FormatSearchSlot
            requestId={requestId}
            format={row.format}
            origin={origin}
            onFired={handleFired}
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

  // fix/live-status-precedence — poll `activity.itemStatus` per format ON MOUNT (not only post-fire) and while
  // visible, LIFTED here (above the early returns → a fixed hook count) so the hero badge AND each format row
  // read ONE live source and can't disagree. A request is comic XOR book, so at most these three ids exist;
  // each poll is disabled when its id is null (not routed yet). When live wins it OVERRIDES the reconciled
  // snapshot everywhere on this page.
  const data = detail.data;
  const refs = {
    llBookId: data?.llBookId ?? null,
    kapowarrVolumeId: data?.kapowarrVolumeId ?? null,
  };
  const comicId = formatActivityId('comic', refs);
  const ebookId = formatActivityId('ebook', refs);
  const audioId = formatActivityId('audiobook', refs);
  const comicLive = useActivityItemStatus(comicId, comicId !== null);
  const ebookLive = useActivityItemStatus(ebookId, ebookId !== null);
  const audioLive = useActivityItemStatus(audioId, audioId !== null);
  const liveFor = (format: FormatRow['format']): ActivityLiveStatus =>
    format === 'comic' ? comicLive : format === 'ebook' ? ebookLive : audioLive;
  const idFor = (format: FormatRow['format']): string | null =>
    format === 'comic' ? comicId : format === 'ebook' ? ebookId : audioId;

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
  const hero = heroBadge(
    d.parked,
    d.formats.map((f) => effectiveFormatStatus(f.status, liveFor(f.format))),
  );
  const refresh = () => void utils.books.wantedDetail.invalidate({ requestId });

  // DESIGN-004 D-24 (ADR-071) — the hero is now the shared <MediaHero>: poster, title, typed badges,
  // the muted author meta line and the requesters attribution (the `secondary` slot) are its inputs.
  // It emits the exact `.detail-head*` anatomy the page hand-rolled before (pixel-neutral). A want has
  // no consume link and no head action bar — its Force-Search lives per-format in the Formats section.
  const heroBadges: MediaHeroBadge[] = [
    { label: shelfLabel(d.shelf), tone: 'muted' },
    { label: hero.label, tone: hero.tone },
    ...(d.isComic ? [{ label: 'Comic', tone: 'muted' as const }] : []),
    ...(d.matchedBooksItemId !== null
      ? [{ label: 'In your library', tone: 'ok' as const }]
      : []),
  ];

  return (
    <>
      <BackLink from={from} />

      {/* A want is unmatched by definition ⇒ the designed KindIcon glyph tile; the cover-proxy art
          shows only if the want is already matched into the library (ADR-015 reserved box). */}
      <MediaHero
        testId="wanted-detail-head"
        poster={<MediaPoster posterUrl={d.posterUrl} kind={d.mediaKind} alt="" />}
        title={d.title}
        badges={heroBadges}
        meta={d.author}
        secondary={
          /* Attribution lives HERE now (off the card face) — the household requesters, the Movies
             "Requested by" chip idiom. */
          d.requestedBy.length > 0 ? (
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
          ) : undefined
        }
      />

      {/* The per-format status rows + Force-Search (the *arr per-grain idiom in book words). */}
      <section className="card admin-section">
        <h2>Formats</h2>
        <ul className="child-list">
          {d.formats.map((f) => (
            <FormatDetailRow
              key={f.format}
              requestId={d.requestId}
              row={f}
              origin={d.origin}
              activityId={idFor(f.format)}
              live={liveFor(f.format)}
              onFired={refresh}
            />
          ))}
        </ul>
        {d.parked ? (
          <p className="muted">
            Waiting on a ComicVine match — this comic can’t be routed to Kapowarr yet, so there’s
            nothing to search. The hourly sync retries automatically.
          </p>
        ) : !d.canSearch ? (
          <p className="muted">
            {d.origin === 'pairing' || d.origin === 'collection'
              ? 'Force Search on this want comes with books access. The library keeps looking on the scheduled sync in the meantime.'
              : 'Force Search is available to the person who shelved this want (or an admin). The library keeps looking on the hourly sync in the meantime.'}
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
