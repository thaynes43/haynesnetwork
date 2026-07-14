'use client';

// PLAN-047 / ADR-058 — the BOOKS wall card (Books · Audiobooks · Comics), on-disk AND composed
// Wanted (ADR-057): the BaseCard anatomy with the author subtitle line (DESIGN-024) and the wall's
// single badge (pages/duration on disk; the Wanted/Missing status badge on a composed want — the
// PLAN-045 owner-corrected anatomy, never a strip). A want has no library row, so its callers pass
// posterUrl null → the designed KindIcon glyph tile, never a fake cover.
import type { ReactNode } from 'react';
import type { CardBadge } from './poster-card-body';
import { BaseCard, type CardDataAttrs } from './base-card';

export function BookCard({
  href,
  posterUrl,
  mediaKind,
  title,
  year,
  author,
  badges,
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
  testId?: string;
  data?: CardDataAttrs;
}) {
  return (
    <BaseCard
      href={href}
      art={{ type: 'poster', posterUrl, kind: mediaKind }}
      title={title}
      year={year}
      subtitle={author}
      badges={badges}
      testId={testId}
      data={data}
    />
  );
}
