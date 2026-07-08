// DESIGN-005 D-17 amendment (2026-07-07) — the context-aware back affordance for /library/[id].
// Origin surfaces append `?from=<key>` when they link to an item; the detail page renders the
// back link as "← <Label>" and, when history.back() can't be trusted (a fresh/external entry),
// falls back to the mapped href. The mapping is a FIXED dictionary — never a raw URL from the
// query — so `from` can never become an open-redirect surface (a garbage/unknown key falls to
// Library). This module is pure so the mapping is unit-testable; the client component
// (components/back-link.tsx) layers the history.back() preference on top.

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
  bulletin: { label: 'Bulletin', href: '/bulletin?tab=messages' },
  'bulletin-feed': { label: 'Bulletin', href: '/bulletin' },
  ledger: { label: 'Ledger', href: '/ledger' },
};

export const DEFAULT_BACK_LINK: BackLinkTarget = { label: 'Library', href: '/library' };

/** Resolve a `?from=` key to its back target. Null/undefined/garbage → the Library default. */
export function resolveBackLink(from: string | null | undefined): BackLinkTarget {
  if (from === null || from === undefined) return DEFAULT_BACK_LINK;
  return BACK_LINKS[from] ?? DEFAULT_BACK_LINK;
}
