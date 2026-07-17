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
  provenance,
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
  /**
   * Collection PROVENANCE (owner directive 2026-07-16) — the display name of the software that
   * created a mirrored collection ("Kometa" / "Plex" / "Libretto" / "Kavita" / "Audiobookshelf").
   * Renders one muted badge in the caption's reserved badge row (ADR-015: a badge recolors, never
   * reflows — every card on a Collections wall carries one, so the row is consistent). Omit/null on
   * the author/genre group walls, which carry no provenance.
   */
  provenance?: string | null;
}) {
  return (
    <BaseCard
      href={href}
      art={{ type: 'group', art, label, imageUrl, coverUrls, kind }}
      title={label}
      subtitle={`${count} ${count === 1 ? 'item' : 'items'}`}
      badges={provenance ? [{ label: provenance, tone: 'muted', title: `Created by ${provenance}` }] : undefined}
      flavor="group"
    />
  );
}
