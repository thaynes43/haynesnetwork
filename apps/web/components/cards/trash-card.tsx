'use client';

// PLAN-047 / ADR-058 — the TRASH wall tile (ADR-023/ADR-033 / DESIGN-010/011), refit onto the card
// family: the shared reserved 2:3 poster box with the wall's TWO fixed corner slots — the
// state/action puck (top-right: trash · shield · check · skip · gone; a tap flips glyph + color in
// place) and the /library nav puck (top-left, a book glyph — never a state) — over the fixed-height
// caption + ONE meta row (size · ★rating text, the requester person chip, the watch eye). Every
// slot is a typed prop (ADR-058 — no children escape hatch); serves BOTH trash walls (the pending
// candidates wall and the batch curation/terminal wall). Pixel-neutral with the pre-refit markup:
// same classes, same DOM, same fixed heights (ADR-015 — a state flip recolors, never reflows).
import Link from 'next/link';
import { EyeGlyph, LibraryLinkGlyph, PersonGlyph, WallGlyphSvg } from '../trash-shield';
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
  busy?: boolean;
  onTap?: () => void;
  /** data-testid on the tap surface ('trash-toggle' on the pending walls; none on the batch wall). */
  testId?: string;
  /** Mark the inert span with data-inert (the pending walls' e2e hook). */
  markInert?: boolean;
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

export function TrashCard({
  glyph,
  posterUrl,
  kind,
  title,
  year,
  toggle,
  libraryLink,
  metaText,
  requesters,
  watchNote,
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
  /** The size · ★rating text line (ellipsizes; the chips stay pinned). */
  metaText: string;
  requesters: readonly string[];
  watchNote: { label: string; tone: 'info' | 'muted' } | null;
  /** The pending walls' tile marker class (same geometry; kept for selector parity). */
  pwall?: boolean;
  /** data-testid on the tile ('trash-tile' pending / 'wall-tile' batch). */
  testId: string;
}) {
  const inner = (
    <>
      <MediaPoster posterUrl={posterUrl} kind={kind} alt="" />
      {/* keyed by glyph: a flip re-mounts the badge so the pop animation replays
          (transform-only — never layout; killed by prefers-reduced-motion). */}
      <span key={glyph} className="bwall-overlay" data-glyph={glyph} aria-hidden="true">
        <WallGlyphSvg glyph={glyph} />
      </span>
    </>
  );
  return (
    <li
      className={`bwall-tile${pwall ? ' pwall-tile' : ''}`}
      data-glyph={glyph}
      data-testid={testId}
    >
      {toggle.tappable ? (
        <button
          type="button"
          className="bwall-tap"
          data-testid={toggle.testId}
          aria-pressed={toggle.pressed}
          aria-label={toggle.label}
          title={toggle.title}
          aria-busy={toggle.busy || undefined}
          onClick={toggle.onTap}
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
          title={toggle.title}
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
      <span className="bwall-caption">
        {title}
        {year !== null ? <span className="muted"> ({year})</span> : null}
      </span>
      <span className="bwall-meta">
        <span className="bwall-meta-text">{metaText}</span>
        <RequestedByBadge requesters={requesters} />
        {watchNote !== null ? <WatchNoteBadge label={watchNote.label} tone={watchNote.tone} /> : null}
      </span>
    </li>
  );
}
