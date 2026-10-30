'use client';

// PLAN-047 / ADR-058 — the TRASH wall tile (ADR-023/ADR-033 / DESIGN-010/011), refit onto the card
// family: the shared reserved 2:3 poster box with the wall's TWO fixed corner slots — the
// state/action puck (top-right: trash · shield · check · skip · gone; a tap the server confirmed flips
// glyph + color in place, ADR-096) and the /library nav puck (top-left, a book glyph — never a state) — over the fixed-height
// caption + ONE fixed Size · Year · Rating row, with status icons over the poster. Every
// slot is a typed prop (ADR-058 — no children escape hatch); serves BOTH trash walls (the pending
// candidates wall and the batch curation/terminal wall). Fixed heights keep state flips in place
// (ADR-015 — a state flip recolors, never reflows; DESIGN-052 D-10 amendment, 2026-10-30).
import Link from 'next/link';
import {
  BookmarkGlyph,
  EyeGlyph,
  LibraryLinkGlyph,
  PersonGlyph,
  WallGlyphSvg,
} from '../trash-shield';
import { WATCHLIST_NOTE_DETAIL } from '@/lib/trash';
import { MediaPoster } from './media-poster';

/** The unified wall glyph set (ADR-033 — keep in lockstep with lib/trash-batches.ts WallGlyph
 *  and lib/trash.ts PendingWallGlyph). */
export type TrashCardGlyph = 'trash' | 'shield' | 'check' | 'skip' | 'gone';

export interface TrashCardToggle {
  /** Interactive (button) vs read-only (role="img" span) corner state. */
  tappable: boolean;
  /** aria-pressed for the tappable state (pending: saved; batch: saved OR protected). */
  pressed: boolean;
  /** aria-label — the state + invitation copy. */
  label: string;
  /** The hover tooltip (the retired table columns' detail). */
  title: string;
  /** ADR-096 — a request for this tile is out. The glyph does NOT change (nothing is confirmed
   *  yet); the tile shows the busy ring instead (color only, ADR-015) and ignores taps. */
  busy?: boolean;
  onTap?: () => void;
  /** data-testid on the tap surface ('trash-toggle' on the pending walls; none on the batch wall). */
  testId?: string;
  /** Mark the inert span with data-inert (the pending walls' e2e hook). */
  markInert?: boolean;
  /** Armed two-step state for a protection RELEASE (shield/check → slated). Color only, never
   *  geometry (ADR-014 / ADR-015): the puck deepens to danger-strong in place, same 30px circle,
   *  same glyph, no re-mount. */
  armed?: boolean;
}

/**
 * The corner LIBRARY-nav link (owner refinement 2026-07-07 — the poster toggles, so /library/[id]
 * navigation lives on this dedicated, visually-distinct corner). Carries `?from=` context so the
 * item page's back link returns to the wall with scroll/filters intact.
 */
function LibraryCornerLink({
  href,
  title,
  ariaLabel,
}: {
  href: string;
  title: string;
  ariaLabel: string;
}) {
  return (
    <Link
      className="pwall-corner pwall-liblink"
      href={href}
      data-testid="wall-lib-link"
      title={title}
      aria-label={ariaLabel}
    >
      <LibraryLinkGlyph />
    </Link>
  );
}

/** The requester INFO chip (ADR-025 / DESIGN-011 errata — informational only, never the action
 *  corner): a person icon + "Requested by <names>" tooltip. Renders nothing with no requesters. */
function RequestedByBadge({ requesters }: { requesters: readonly string[] }) {
  if (requesters.length === 0) return null;
  const label = `Requested by ${requesters.join(', ')}`;
  return (
    <span
      className="bwall-requested"
      data-testid="wall-requested"
      role="img"
      aria-label={label}
      title={label}
    >
      <PersonGlyph />
    </span>
  );
}

/** DESIGN-010 D-12 (build C) — the cross-server watch chip for the meta line (info, NOT
 *  protection): info tone = recently watched, muted = watched a while ago. */
function WatchNoteBadge({ label, tone }: { label: string; tone: 'info' | 'muted' }) {
  return (
    <span
      className={`bwall-watched bwall-watched--${tone}`}
      data-testid="wall-watched"
      data-tone={tone}
      role="img"
      aria-label={label}
      title={label}
    >
      <EyeGlyph />
    </span>
  );
}

/** DESIGN-052 D-10 amendment — icon-only watchlist status on every screen size.
 *  Tooltip and accessible name retain its meaning; never whose watchlist or how many. */
function WatchlistNoteBadge() {
  return (
    <span
      className="bwall-watchlisted"
      data-testid="wall-watchlisted"
      role="img"
      aria-label={WATCHLIST_NOTE_DETAIL}
      title={WATCHLIST_NOTE_DETAIL}
    >
      <BookmarkGlyph />
    </span>
  );
}

export function TrashCard({
  glyph,
  posterUrl,
  kind,
  title,
  year,
  toggle,
  libraryLink,
  sizeLabel,
  ratingLabel,
  requesters,
  watchNote,
  onWatchlist = false,
  failedNote = null,
  pwall = false,
  testId,
}: {
  glyph: TrashCardGlyph;
  posterUrl: string | null;
  /** KindIcon kind for the no-art fallback ('radarr' | 'sonarr'). */
  kind: string;
  title: string;
  year: number | null;
  toggle: TrashCardToggle;
  /** The top-left /library nav corner — null when the item isn't ledger-joined. */
  libraryLink: { href: string; title: string; ariaLabel: string } | null;
  /** Fixed facts, independent of the title's truncation and changing status icons. */
  sizeLabel: string;
  ratingLabel: string | null;
  requesters: readonly string[];
  watchNote: { label: string; tone: 'info' | 'muted' } | null;
  /** ADR-093 / DESIGN-052 D-10 — the title is on a watchlist (the "On a watchlist" note). */
  onWatchlist?: boolean;
  /** ADR-096 / D-10 amendment — an accessible failure icon and danger ring, keeping
   *  the fixed facts visible. Null = no failure; the wall retains its error slot. */
  failedNote?: string | null;
  /** The pending walls' tile marker class (same geometry; kept for selector parity). */
  pwall?: boolean;
  /** data-testid on the tile ('trash-tile' pending / 'wall-tile' batch). */
  testId: string;
}) {
  const armed = toggle.armed === true;
  const fullTitle = `${title}${year !== null ? ` (${year})` : ''}`;
  const facts = `${sizeLabel} · ${year ?? '—'} · ★${ratingLabel ?? '—'}`;
  const inner = (
    <>
      <MediaPoster posterUrl={posterUrl} kind={kind} alt="" />
      {/* keyed by glyph ONLY: a flip re-mounts the badge so the pop animation replays
          (transform-only — never layout; killed by prefers-reduced-motion). Arming is a pure
          recolor on the SAME element — the key must not fold in `armed`, or every arm would
          replay the pop and the ADR-014 two-step would read as a state flip. */}
      <span
        key={glyph}
        className="bwall-overlay"
        data-glyph={glyph}
        data-armed={armed ? 'true' : undefined}
        aria-hidden="true"
      >
        <WallGlyphSvg glyph={glyph} />
      </span>
      {/* ADR-014 — the visually-hidden live region announces the armed transition (the
          ConfirmButton idiom; the glyph itself is aria-hidden, the label swap is on the button). */}
      <span className="sr-only" role="status" aria-live="polite">
        {armed ? 'Tap again to release protection.' : ''}
      </span>
    </>
  );
  return (
    <li
      className={`bwall-tile${pwall ? ' pwall-tile' : ''}`}
      data-glyph={glyph}
      data-failed={failedNote !== null ? 'true' : undefined}
      data-testid={testId}
    >
      <span className="bwall-art">
        {toggle.tappable ? (
          <button
            type="button"
            className="bwall-tap"
            data-testid={toggle.testId}
            data-armed={armed ? 'true' : undefined}
            aria-pressed={toggle.pressed}
            aria-label={toggle.label}
            title={`${toggle.title}\n${fullTitle}`}
            aria-busy={toggle.busy || undefined}
            onClick={toggle.busy ? undefined : toggle.onTap}
          >
            {inner}
          </button>
        ) : (
          <span
            className="bwall-tap"
            data-testid={toggle.testId}
            data-inert={toggle.markInert ? 'true' : undefined}
            role="img"
            aria-label={toggle.label}
            title={`${toggle.title}\n${fullTitle}`}
          >
            {inner}
          </span>
        )}
        {libraryLink !== null ? (
          <LibraryCornerLink
            href={libraryLink.href}
            title={libraryLink.title}
            ariaLabel={libraryLink.ariaLabel}
          />
        ) : null}
        <span className="bwall-notes">
          <RequestedByBadge requesters={requesters} />
          {watchNote !== null ? (
            <WatchNoteBadge label={watchNote.label} tone={watchNote.tone} />
          ) : null}
          {onWatchlist ? <WatchlistNoteBadge /> : null}
          {failedNote !== null ? (
            <span
              className="bwall-note--failed"
              data-testid="wall-failed-note"
              role="img"
              aria-label={failedNote}
              title={failedNote}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v6m0 3v1" />
              </svg>
              <span className="sr-only">{failedNote}</span>
            </span>
          ) : null}
        </span>
      </span>
      <span className="bwall-caption" title={fullTitle}>
        {title}
      </span>
      <span className="bwall-meta" title={facts}>
        <span className="bwall-meta-text">{sizeLabel}</span>
        <span aria-hidden="true">·</span>
        <span className="bwall-year" data-testid="wall-year">
          {year ?? '—'}
        </span>
        <span aria-hidden="true">·</span>
        <span className="bwall-rating">★{ratingLabel ?? '—'}</span>
      </span>
    </li>
  );
}
