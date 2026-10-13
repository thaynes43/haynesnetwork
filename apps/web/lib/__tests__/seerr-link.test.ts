// ADR-111 C-04 / DESIGN-055 D-11 (PLAN-077 P3) — the `/r/seerr/<id>` rules: signed out always gets the onboarding card
// (which signs in and comes back to the same link, and never names the report); signed in goes to the title page with
// the guide preselected, after a fresh read when the mirror is missing the report, its title or its reporter; and the
// cards for a report that cannot be opened.
import { describe, expect, it, vi } from 'vitest';
import { resolveSeerrLink, seerrLinkIssueId, type SeerrLinkTargetLike } from '../seerr-link';
import { safeNext } from '../safe-next';

const ITEM = '7a3c1c56-1c1b-4b3a-9f5e-1d2e3f4a5b6c';

function deps(sequence: SeerrLinkTargetLike[], canSee = true) {
  const lookup = vi.fn(async () => sequence.shift() ?? { kind: 'unknown' as const });
  const refresh = vi.fn(async () => undefined);
  const see = vi.fn(async () => canSee);
  return { lookup, refresh, canSee: see };
}

describe('resolveSeerrLink (D-11)', () => {
  it('signed out: the onboarding card, coming back to this link, with no lookup at all', async () => {
    const d = deps([]);
    const view = await resolveSeerrLink({ rawId: '3', userId: null, ...d });
    expect(view).toEqual({ kind: 'sign_in', next: '/r/seerr/3', seerrIssueId: 3 });
    expect(d.lookup).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
    // The way back survives /login's and Better Auth's callbackURL rules unchanged.
    expect(safeNext('/r/seerr/3')).toBe('/r/seerr/3');
    expect(await resolveSeerrLink({ rawId: '../admin', userId: null, ...deps([]) })).toEqual({
      kind: 'sign_in',
      next: '/',
      seerrIssueId: null,
    });
  });

  it('signed in: the title page with the guide preselected (Case B: issue 3)', async () => {
    const d = deps([{ kind: 'title', mediaItemId: ITEM, status: 'resolved', reporterUserId: 'u1' }]);
    expect(await resolveSeerrLink({ rawId: '3', userId: 'u1', ...d })).toEqual({
      kind: 'redirect',
      to: `/library/${ITEM}?seerr=3`,
    });
    expect(d.refresh).not.toHaveBeenCalled();
    expect(d.canSee).toHaveBeenCalledWith('u1', ITEM);
  });

  it('reads the report fresh when the mirror lacks it, its title or its reporter', async () => {
    for (const first of [
      { kind: 'unknown' as const },
      { kind: 'no_title' as const, status: 'open' as const, mediaType: 'tv' as const },
      { kind: 'title' as const, mediaItemId: ITEM, status: 'open' as const, reporterUserId: null },
    ]) {
      const d = deps([first, { kind: 'title', mediaItemId: ITEM, status: 'open', reporterUserId: 'u1' }]);
      expect(await resolveSeerrLink({ rawId: '12', userId: 'u1', ...d })).toEqual({
        kind: 'redirect',
        to: `/library/${ITEM}?seerr=12`,
      });
      expect(d.refresh).toHaveBeenCalledWith(12);
      expect(d.lookup).toHaveBeenCalledTimes(2);
    }
  });

  it('a Seerr outage during that read answers from the mirror', async () => {
    const d = deps([{ kind: 'unknown' }, { kind: 'unknown' }]);
    d.refresh.mockRejectedValueOnce(new Error('seerr down'));
    expect(await resolveSeerrLink({ rawId: '12', userId: 'u1', ...d })).toEqual({ kind: 'not_found' });
  });

  it('the cards: no title yet, removed, no access, a bad id', async () => {
    expect(
      await resolveSeerrLink({ rawId: '5', userId: 'u1', ...deps([{ kind: 'no_title', status: 'open', mediaType: 'movie' }, { kind: 'no_title', status: 'open', mediaType: 'movie' }]) }),
    ).toEqual({ kind: 'no_title' });
    expect(await resolveSeerrLink({ rawId: '5', userId: 'u1', ...deps([{ kind: 'removed' }]) })).toEqual({ kind: 'removed' });
    expect(
      await resolveSeerrLink({ rawId: '5', userId: 'u1', ...deps([{ kind: 'title', mediaItemId: ITEM, status: 'open', reporterUserId: 'u2' }], false) }),
    ).toEqual({ kind: 'no_access' });
    const d = deps([]);
    expect(await resolveSeerrLink({ rawId: 'abc', userId: 'u1', ...d })).toEqual({ kind: 'not_found' });
    expect(d.lookup).not.toHaveBeenCalled();
  });

  it('accepts only a positive id of digits', () => {
    expect(seerrLinkIssueId('3')).toBe(3);
    for (const bad of ['0', '-3', '3.5', '1e2', ' 3', '9999999999', '']) expect(seerrLinkIssueId(bad)).toBeNull();
  });
});
