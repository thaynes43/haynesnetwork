// ADR-087 / ADR-088 / ADR-089 / DESIGN-049 (PLAN-068 S5) — the Watch Companion's single writers and flows:
// the owner account, the append-only Watch Event log (+ the Q-06 show-guid fill), the Title State snapshot,
// the recommendation signal cache, and the Watch Mark flows (mark, dismiss, undo) with the live
// revalidation — the only code that writes Plex watched state; and (ADR-092, PLAN-071) the Watchlist Changes —
// the only code that writes the owner's plex.tv watchlist.
export * from './plex';
export * from './accounts';
export * from './events';
export * from './titles';
export * from './signals';
export * from './resolve';
export * from './marks';
export * from './watchlist';
export * from './revalidate';
