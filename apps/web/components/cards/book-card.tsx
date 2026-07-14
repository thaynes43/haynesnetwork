'use client';

// PLAN-047 / ADR-058 — the BOOKS wall card (Books · Audiobooks · Comics), on-disk AND composed
// Wanted (ADR-057): the BaseCard anatomy with the author subtitle line (DESIGN-024) and the wall's
// single badge (pages/duration on disk; the Wanted/Missing status badge on a composed want — the
// PLAN-045 owner-corrected anatomy, never a strip). A want has no library row, so its callers pass
// posterUrl null → the designed KindIcon glyph tile, never a fake cover.
import type { ReactNode } from 'react';
import type { CardBadge } from './poster-card-body';
import { BaseCard, type CardDataAttrs } from './base-card';
import { activityStageBadge, type InFlightBadge } from './activity-badge';

export function BookCard({
  href,
  posterUrl,
  mediaKind,
  title,
  year,
  author,
  badges,
  inFlight,
  testId,
  data,
}: {
  href: string;
  posterUrl: string | null;
  mediaKind: 'book' | 'audiobook' | 'comic';
  title: string;
  year?: number | null;
  /** The muted author/subtitle line (DESIGN-024 amendment). */
  author?: ReactNode;
  badges?: ReadonlyArray<CardBadge | null | false | undefined>;
  /** PLAN-048 / ADR-059 — the in-flight stage badge (leads the caption badge row; DESIGN-030 D-03). */
  inFlight?: InFlightBadge | null;
  testId?: string;
  data?: CardDataAttrs;
}) {
  const allBadges = inFlight ? [activityStageBadge(inFlight), ...(badges ?? [])] : badges;
  return (
    <BaseCard
      href={href}
      art={{ type: 'poster', posterUrl, kind: mediaKind }}
      title={title}
      year={year}
      subtitle={author}
      badges={allBadges}
      testId={testId}
      data={data}
    />
  );
}
