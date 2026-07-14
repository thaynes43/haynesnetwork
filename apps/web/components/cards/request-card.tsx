'use client';

// PLAN-047 / ADR-058 — the GOODREADS request/item card (ADR-057 / DESIGN-029): the BaseCard anatomy
// with the author subtitle and the two-badge caption row (primary shelf · dominant status — max two,
// the remaining shelves / per-format detail ride the tooltips, never pills). Whole-card
// click-through per the owner Wanted-parity ruling ("Have it" → library detail, any other want →
// the Wanted detail page); a pre-mint want (no request row yet) passes href null and stays
// non-interactive with the SAME anatomy.
import type { CardBadge } from './poster-card-body';
import { BaseCard } from './base-card';

export function RequestCard({
  href,
  posterUrl,
  isComic,
  title,
  author,
  shelfBadge,
  statusBadge,
  phase,
  requestId,
  focused = false,
  cardRef,
}: {
  href: string | null;
  posterUrl: string | null;
  isComic: boolean;
  title: string;
  author?: string | null;
  /** The primary-shelf badge (muted; the full shelf list rides its tooltip). */
  shelfBadge: CardBadge | null;
  /** The dominant status badge (Have it / Wanted / Missing / Parked — DESIGN-029). */
  statusBadge: CardBadge;
  /** The request phase, baked on as `data-phase` (e2e + capture hooks). */
  phase: string;
  requestId: string | null;
  /** The one-time `?focus=` deep-link highlight. */
  focused?: boolean;
  cardRef?: (el: HTMLElement | null) => void;
}) {
  return (
    <BaseCard
      href={href}
      art={{ type: 'poster', posterUrl, kind: isComic ? 'comic' : 'book' }}
      title={title}
      subtitle={author}
      badges={[shelfBadge, statusBadge]}
      flavor="request"
      focused={focused}
      testId="gr-item"
      data={{ 'data-phase': phase, 'data-request-id': requestId ?? undefined }}
      cardRef={cardRef}
    />
  );
}
