'use client';

// PLAN-047 / ADR-058 — the HELPDESK ticket wall tile (ADR-050 / DESIGN-012 D-12), refit onto the
// card family: the same reserved-art + caption anatomy as every poster wall, with the ticket
// grammar the wall already follows — the linked title's poster (or the intake-CATEGORY tile in the
// same 2:3 box), the STATE baked on as a colored corner puck (the Trash `.bwall-overlay` idiom),
// a fixed-height caption/sub pair, and ONE meta row (status badge · reply count · last activity).
// All slots are typed props — no children escape hatch (ADR-058); the whole tile is the drill-in
// link. Pixel-neutral with the pre-refit markup: same classes, same DOM, same fixed heights
// (ADR-015 — data states recolor, never reflow).
import Link from 'next/link';
import {
  TICKET_CATEGORY_LABELS,
  TICKET_STATUS_LABELS,
  ticketStatusTone,
  type TicketCategoryDisplay,
  type TicketStatusName,
} from '@/lib/bulletin';
import { ReplyGlyph, TicketCategoryIcon, TicketStatusGlyph } from '../ticket-glyphs';
import { MediaPoster } from './media-poster';

/** The intake-category tile a NON-MEDIA ticket gets where a poster would be (shared with the
 *  ticket detail head): the category icon large over the same tinted 2:3 box the Library fallback
 *  uses, plus a small label. */
export function TicketCategoryTile({ category }: { category: TicketCategoryDisplay }) {
  return (
    <span className="poster-box twall-cattile" data-category={category}>
      <TicketCategoryIcon category={category} className="twall-cattile__icon" />
      <span className="twall-cattile__label">{TICKET_CATEGORY_LABELS[category]}</span>
    </span>
  );
}

export function TicketCard({
  href,
  title,
  status,
  category,
  media,
  targetLabel,
  replyCount,
  whenLabel,
}: {
  href: string;
  title: string;
  status: TicketStatusName;
  category: TicketCategoryDisplay;
  /** The linked title (poster + caption sub-line) — null renders the category tile instead.
   *  `title` may be null (a ledger row can vanish); the sub-line then falls back to the category. */
  media: { posterUrl: string | null; kind: string; title: string | null; year: number | null } | null;
  /** ADR-061 (PLAN-038) — the snapshotted locator label ("S06E02 · Rich"); joins the sub line. */
  targetLabel?: string | null;
  replyCount: number;
  /** The formatted last-activity label (the host owns time formatting). */
  whenLabel: string;
}) {
  const tone = ticketStatusTone(status);
  return (
    <li className="twall-tile" data-status={status} data-testid="ticket-tile">
      <Link
        className="twall-link"
        href={href}
        aria-label={`${title} — ${TICKET_STATUS_LABELS[status]}${
          media?.title != null ? ` — ${media.title}` : ''
        }`}
      >
        <span className="twall-poster">
          {media !== null ? (
            <MediaPoster posterUrl={media.posterUrl} kind={media.kind} alt="" />
          ) : (
            <TicketCategoryTile category={category} />
          )}
          <span className="twall-overlay" data-status={status} aria-hidden="true">
            <TicketStatusGlyph status={status} />
          </span>
        </span>
        <span className="twall-caption">{title}</span>
        <span className="twall-sub muted">
          {media?.title != null
            ? `${media.title}${media.year !== null ? ` (${media.year})` : ''}${
                targetLabel != null ? ` — ${targetLabel}` : ''
              }`
            : TICKET_CATEGORY_LABELS[category]}
        </span>
        <span className="twall-meta">
          <span className={`badge badge--${tone}`}>{TICKET_STATUS_LABELS[status]}</span>
          {replyCount > 0 ? (
            <span className="twall-replies" aria-label={`${replyCount} replies`}>
              <ReplyGlyph className="twall-replies__icon" />
              {replyCount}
            </span>
          ) : null}
          <span className="muted twall-when">{whenLabel}</span>
        </span>
      </Link>
    </li>
  );
}
