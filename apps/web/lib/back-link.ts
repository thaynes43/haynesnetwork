// DESIGN-005 D-17 amendment (2026-07-07) — the context-aware back affordance for /library/[id].
// Origin surfaces append `?from=<key>` when they link to an item; the detail page renders the
// back link as "← <Label>" and, when history.back() can't be trusted (a fresh/external entry),
// falls back to the mapped href. The mapping is a FIXED dictionary — never a raw URL from the
// query — so `from` can never become an open-redirect surface (a garbage/unknown key falls to
// Library). This module is pure so the mapping is unit-testable; the client component
// (components/back-link.tsx) layers the history.back() preference on top.

import { HELPDESK_NAME } from './bulletin';

export interface BackLinkTarget {
  /** The label rendered after "← " (e.g. "Trash Movies"). */
  label: string;
  /** The in-app href to navigate to when history.back() isn't an in-app entry. */
  href: string;
}

/** The closed set of known origins. Unknown/absent → the Library default (no open redirect). */
const BACK_LINKS: Record<string, BackLinkTarget> = {
  'trash-movies': { label: 'Trash Movies', href: '/trash?tab=movies' },
  'trash-tv': { label: 'Trash TV', href: '/trash?tab=tv' },
  // DESIGN-004 D-22 — the `bulletin` section renders under its ratified name (HELPDESK_NAME); the
  // `?from=` keys and hrefs are unchanged (route/section id stay `bulletin`).
  bulletin: { label: HELPDESK_NAME, href: '/bulletin?tab=helpdesk' },
  'bulletin-feed': { label: HELPDESK_NAME, href: '/bulletin' },
  // ADR-050 / DESIGN-012 D-12 (PLAN-034) — the ticket detail's way back to the ticket wall.
  helpdesk: { label: HELPDESK_NAME, href: '/bulletin?tab=helpdesk' },
  ledger: { label: 'Ledger', href: '/ledger' },
  // DESIGN-017 D-09 — the ytdl-sub drill-in's way back to its wall (the key IS the library id).
  peloton: { label: 'Peloton', href: '/library?tab=peloton' },
  youtube: { label: 'YouTube', href: '/library?tab=youtube' },
  // ADR-047 / DESIGN-025 (PLAN-028) — the Books/Audiobooks/Comics detail pages' way back to their wall.
  books: { label: 'Books', href: '/library?tab=books' },
  audiobooks: { label: 'Audiobooks', href: '/library?tab=audiobooks' },
  comics: { label: 'Comics', href: '/library?tab=comics' },
  // ADR-057 amendment (PLAN-047) — the Wanted / library detail pages' way back to the Goodreads items wall.
  'goodreads-items': { label: 'Goodreads', href: '/integrations/goodreads?tab=items' },
  // PLAN-048 / DESIGN-030 D-09 — the Activity tiles' way back to the Activity sub-tab (a hard/deep entry;
  // a soft nav restores the tab AND its URL filters via history.back()).
  activity: { label: 'Activity', href: '/library?tab=activity' },
};

export const DEFAULT_BACK_LINK: BackLinkTarget = { label: 'Library', href: '/library' };

/** Resolve a `?from=` key to its back target. Null/undefined/garbage → the Library default. */
export function resolveBackLink(from: string | null | undefined): BackLinkTarget {
  if (from === null || from === undefined) return DEFAULT_BACK_LINK;
  return BACK_LINKS[from] ?? DEFAULT_BACK_LINK;
}
