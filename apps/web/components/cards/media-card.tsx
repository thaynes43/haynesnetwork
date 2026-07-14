'use client';

// PLAN-047 / ADR-058 — the LEDGER/PLEX media wall card (Movies · TV · Music · Peloton · YouTube):
// the canonical BaseCard anatomy with a 2:3 poster box and the wall's badge row (★ rating ·
// on-disk state · tombstone on the ledger walls; the season/episode count pill on the ytdl-sub
// walls). A thin, prop-typed BaseCard extension — never a fork.
import type { CardBadge } from './poster-card-body';
import { BaseCard } from './base-card';

export function MediaCard({
  href,
  posterUrl,
  kind,
  title,
  year,
  badges,
}: {
  href: string;
  posterUrl: string | null;
  /** KindIcon kind for the no-art fallback (arr kind or 'show'). */
  kind: string;
  title: string;
  year?: number | null;
  badges?: ReadonlyArray<CardBadge | null | false | undefined>;
}) {
  return (
    <BaseCard
      href={href}
      art={{ type: 'poster', posterUrl, kind }}
      title={title}
      year={year}
      badges={badges}
    />
  );
}
