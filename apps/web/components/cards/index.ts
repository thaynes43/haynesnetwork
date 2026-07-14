// PLAN-047 / ADR-058 / DESIGN-004 D-21 — THE card package barrel: the ONLY sanctioned surface for
// wall-card anatomy. Everything a wall needs is here — the typed card family (BaseCard + its
// per-type extensions), the grid containers + skeletons, and the two detail-head art primitives
// (MediaPoster heroes; the bare PosterBox placeholder). The card-anatomy lint guard
// (lint/card-anatomy-guard.mjs + lib/__tests__/card-system-guard.test.ts) forbids the raw anatomy
// class names and deep imports of this package's internals outside components/cards, so a surface
// CANNOT hand-roll or fork a card — extending the family means adding a typed variant HERE, in the
// gallery (/e2e/card-gallery), and in its spec, in the same change.
export { BaseCard, type BaseCardProps, type CardArt, type CardDataAttrs } from './base-card';
export { MediaCard } from './media-card';
export { BookCard } from './book-card';
export { GroupCard } from './group-card';
export { RequestCard } from './request-card';
export { TicketCard, TicketCategoryTile } from './ticket-card';
export { TrashCard, type TrashCardGlyph, type TrashCardToggle } from './trash-card';
export {
  PosterBox,
  PosterGrid,
  PosterGridSkeleton,
  TicketWall,
  TicketWallSkeleton,
  TrashWall,
  TrashWallSkeleton,
} from './card-grid';
export {
  MAX_CARD_BADGES,
  type CardBadge,
  type PosterBadge,
  type PosterBadgeTone,
} from './poster-card-body';
// Detail-head hero art (ADR-019/ADR-041 — the reserved-box progressive reveal). Sanctioned for
// detail pages; wall tiles get theirs through the card family, never by composing this directly.
export { MediaPoster } from './media-poster';
