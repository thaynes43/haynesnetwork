'use client';

// PLAN-047 / ADR-058 / DESIGN-004 D-21 — the BASE wall card: the ONE way a poster-idiom wall tile
// is built. Anatomy is FIXED by construction (the REFERENCE-movies-wall grammar the PLAN-045
// incident violated): a reserved art box (2:3 MediaPoster or the group-art ladder) over a caption
// block of title (year) · optional muted subtitle · ONE badge row (≤ MAX_CARD_BADGES). Every slot
// is a TYPED prop — there is deliberately NO children passthrough, so a surface cannot bolt chip
// stacks, requester lines, or buttons onto a card face. Cards are whole-face click-throughs
// (`href`); a null href renders the same anatomy as a non-interactive tile (the pre-mint want).
//
// Variants extend by COMPOSITION, never by copy: MediaCard / BookCard / GroupCard / RequestCard are
// thin prop-typed wrappers in this package; the Helpdesk/Trash tiles (TicketCard / TrashCard) carry
// the same anatomy contract with their corner-puck state grammar. The class names below are the
// pre-refit walls' exact markup — the refit is pixel-neutral (the reviewer's bar) — and they are
// lint-locked outside components/cards (the card-anatomy guard), so this file is the only place
// that can emit them.
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { WallGroupingArt } from '@/lib/library-view-registry';
import { MediaPoster } from './media-poster';
import { GroupCardArt } from './group-card-art';
import { PosterCardBody, type CardBadge } from './poster-card-body';

/** The reserved art box — a typed union, never free markup. */
export type CardArt =
  | {
      /** The 2:3 poster box (authed proxy URL or null → the designed KindIcon glyph tile). */
      type: 'poster';
      posterUrl: string | null;
      /** KindIcon kind for the no-art fallback tile. */
      kind: string;
    }
  | {
      /** The aggregate-group art ladder (portrait → cover fan → glyph tile — DESIGN-026 D-04). */
      type: 'group';
      art: WallGroupingArt;
      label: string;
      imageUrl: string | null;
      coverUrls: string[];
      kind: string;
    };

/** Typed data-* passthrough (attributes only — never markup). */
export type CardDataAttrs = Readonly<Record<`data-${string}`, string | undefined>>;

export interface BaseCardProps {
  /** Whole-card click-through; null renders the same anatomy as a non-interactive tile. */
  href: string | null;
  art: CardArt;
  title: string;
  year?: number | null;
  subtitle?: ReactNode;
  /** The ONE badge row (≤ MAX_CARD_BADGES; falsy entries allowed for inline conditionals). */
  badges?: ReadonlyArray<CardBadge | null | false | undefined>;
  /** Typed flavor classes: 'group' = the aggregate card skin; 'request' = the Goodreads item skin. */
  flavor?: 'group' | 'request';
  /** The Goodreads `?focus=` highlight ring (request flavor). */
  focused?: boolean;
  testId?: string;
  data?: CardDataAttrs;
  /** Element ref (the one-time focus-scroll on the Goodreads wall). */
  cardRef?: (el: HTMLElement | null) => void;
}

function CardArtBox({ art }: { art: CardArt }) {
  if (art.type === 'group') {
    return (
      <GroupCardArt
        art={art.art}
        label={art.label}
        imageUrl={art.imageUrl}
        coverUrls={art.coverUrls}
        kind={art.kind}
      />
    );
  }
  return <MediaPoster posterUrl={art.posterUrl} kind={art.kind} alt="" />;
}

export function BaseCard({
  href,
  art,
  title,
  year,
  subtitle,
  badges,
  flavor,
  focused = false,
  testId,
  data,
  cardRef,
}: BaseCardProps) {
  const className = `media-card poster-card${flavor === 'group' ? ' group-card' : ''}${
    flavor === 'request' ? ' gr-item' : ''
  }${focused ? ' is-focused' : ''}`;
  const inner = (
    <>
      <CardArtBox art={art} />
      <PosterCardBody title={title} year={year} subtitle={subtitle} badges={badges} />
    </>
  );
  return href !== null ? (
    <Link ref={cardRef} href={href} className={className} data-testid={testId} {...data}>
      {inner}
    </Link>
  ) : (
    <div ref={cardRef} className={className} data-testid={testId} {...data}>
      {inner}
    </div>
  );
}
