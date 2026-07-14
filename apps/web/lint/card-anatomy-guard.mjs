// PLAN-047 / ADR-058 / DESIGN-004 D-21 — the CARD-ANATOMY lint guard (the arr-write-import-guard
// idiom, applied to markup): wall-card anatomy may exist ONLY inside the card package
// (components/cards). This module is the single source of the guard's patterns; it is consumed by
//   • apps/web/eslint.config.mjs — a no-restricted-syntax / no-restricted-imports override on every
//     app/components/lib file OUTSIDE components/cards (runs in CI's lint-and-typecheck job), and
//   • lib/__tests__/card-system-guard.test.ts — the executable proof: a violating fixture FAILS,
//     the sanctioned form passes, and a repo walk shows zero live violations (runs in CI's test job).
//
// WHY: the PLAN-045 "Wanted strip" incident — an agent re-invented card anatomy in per-surface
// markup. With this guard, hand-rolling `media-card`/`poster-grid`/`bwall-*`/`twall-*` markup (or
// deep-importing the package's internals to compose a bespoke card) is a lint error; the only path
// is the typed card family exported by the @/components/cards barrel.

/** The locked class tokens — the wall-card anatomy (poster cards, grids, trash/ticket tiles,
 *  corner pucks, group/glyph art). Deliberately NOT locked: `media-card__badges` (the estate-wide
 *  detail-head badge-row idiom) and the page-level chrome classes (`bwall-counts`, `twall-bar`…). */
export const CARD_ANATOMY_CLASS_PATTERN =
  '\\b(?:media-list|media-card|media-card__title|media-card__subtitle' +
  '|poster-card|poster-card__body|poster-grid|poster-box|poster-img|poster-fallback|epi-still' +
  '|glyph-tile|group-card|group-card__stack|group-card__portrait|group-card__cover' +
  '|bwall-(?:tile|tap|overlay|caption|meta|watched|requested)' +
  '|twall-(?:tile|link|poster|overlay|caption|sub|meta|cattile)' +
  '|pwall-(?:tile|corner|liblink))\\b';

const MESSAGE =
  'Wall-card anatomy is locked to the card package (PLAN-047 / ADR-058): build walls from the ' +
  "typed card family in '@/components/cards' (BaseCard extensions + PosterGrid/TicketWall/" +
  'TrashWall) instead of raw card markup.';

/** `no-restricted-syntax` entries: the locked classes in string literals AND template literals. */
export const cardAnatomyRestrictedSyntax = [
  {
    selector: `Literal[value=/${CARD_ANATOMY_CLASS_PATTERN}/]`,
    message: MESSAGE,
  },
  {
    selector: `TemplateElement[value.raw=/${CARD_ANATOMY_CLASS_PATTERN}/]`,
    message: MESSAGE,
  },
];

/** `no-restricted-imports` config: the package barrel is the ONLY sanctioned import surface —
 *  deep imports (media-poster, poster-card-body, base-card, …) would let a surface re-compose
 *  bespoke cards around the internals. */
export const cardAnatomyRestrictedImports = {
  patterns: [
    {
      group: ['@/components/cards/*', '**/components/cards/*'],
      message:
        "Import the card package barrel ('@/components/cards') — its internals are sealed " +
        '(PLAN-047 / ADR-058).',
    },
  ],
};
