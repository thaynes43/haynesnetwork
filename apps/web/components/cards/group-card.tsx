'use client';

// PLAN-047 / ADR-058 — the AGGREGATE group card (author/genre walls — DESIGN-026 D-01/D-04): the
// BaseCard anatomy wearing the group-art ladder (real portrait → stacked-cover fan → designed
// glyph tile; never fake art) with the group label + member count as the caption. Drill-in is the
// whole-card click-through (a PUSH — D-19).
import type { WallGroupingArt } from '@/lib/library-view-registry';
import { BaseCard } from './base-card';

export function GroupCard({
  href,
  art,
  label,
  imageUrl,
  coverUrls,
  kind,
  count,
}: {
  href: string;
  art: WallGroupingArt;
  label: string;
  /** The dimension's own portrait URL (null = none — server-gated), 'covers' art only. */
  imageUrl: string | null;
  /** The bounded member-cover sample (the fan fallback). */
  coverUrls: string[];
  /** KindIcon kind for the empty-group fallback tile. */
  kind: string;
  count: number;
}) {
  return (
    <BaseCard
      href={href}
      art={{ type: 'group', art, label, imageUrl, coverUrls, kind }}
      title={label}
      subtitle={`${count} ${count === 1 ? 'item' : 'items'}`}
      flavor="group"
    />
  );
}
