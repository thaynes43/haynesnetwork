// DESIGN-005 D-17 amendment (ADR-033) — the context-aware back-link mapping is a FIXED
// dictionary; unknown/garbage `from` MUST fall to the Library default (never a raw URL — no
// open-redirect surface). These cases pin the label + href for every known origin and the
// fallback.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BACK_LINK, resolveBackLink } from '../back-link';

describe('resolveBackLink — the fixed `?from=` dictionary', () => {
  it('maps every known origin to its label + in-app href', () => {
    expect(resolveBackLink('trash-movies')).toEqual({
      label: 'Trash Movies',
      href: '/trash?tab=movies',
    });
    expect(resolveBackLink('trash-tv')).toEqual({ label: 'Trash TV', href: '/trash?tab=tv' });
    expect(resolveBackLink('bulletin')).toEqual({
      label: 'Bulletin',
      href: '/bulletin?tab=messages',
    });
    expect(resolveBackLink('bulletin-feed')).toEqual({ label: 'Bulletin', href: '/bulletin' });
    expect(resolveBackLink('ledger')).toEqual({ label: 'Ledger', href: '/ledger' });
  });

  it('falls to the Library default for null, absent, and garbage keys (no open redirect)', () => {
    expect(resolveBackLink(null)).toEqual(DEFAULT_BACK_LINK);
    expect(resolveBackLink(undefined)).toEqual(DEFAULT_BACK_LINK);
    expect(resolveBackLink('')).toEqual(DEFAULT_BACK_LINK);
    expect(resolveBackLink('nonsense')).toEqual(DEFAULT_BACK_LINK);
    // a would-be open redirect is just an unknown key — mapped to Library, never navigated to.
    expect(resolveBackLink('https://evil.example.com')).toEqual(DEFAULT_BACK_LINK);
    expect(resolveBackLink('/trash?tab=movies')).toEqual(DEFAULT_BACK_LINK);
    expect(DEFAULT_BACK_LINK).toEqual({ label: 'Library', href: '/library' });
  });
});
