// DESIGN-010 D-09 — the Trash client helpers are safety-critical copy inputs: the guardian
// PREVIEW must partition exactly like @hnet/domain classifyGuardian + the expedite 'all' loop
// (an optimistic preview that under-counts "deleted" would make the confirm Modal lie).
import { describe, expect, it } from 'vitest';
import {
  daysLeftLabel,
  daysLeftTone,
  daysUntil,
  expediteErrorAction,
  overviewBadge,
  overviewCardTone,
  overviewDeadlineLabel,
  partitionForExpedite,
  pendingWallGlyph,
  pendingWallTappable,
  previewGuardian,
  reclaimLabel,
  type GuardianPreviewInput,
  type OverviewBatchLike,
} from '../trash';

const base: GuardianPreviewInput = {
  maintainerrMediaId: 'ms-1',
  mediaItemId: 'uuid-1',
  protectedByTag: false,
  recentlyWatched: false,
  requesters: [],
};

describe('previewGuardian (mirrors classifyGuardian — ADR-023 C-07b, fail closed)', () => {
  it('cold + evaluated ⇒ deletable', () => {
    expect(previewGuardian(base)).toBe('deletable');
  });
  it('no Maintainerr id ⇒ unverifiable BEFORE any protection check (the all-loop order)', () => {
    expect(previewGuardian({ ...base, maintainerrMediaId: null, protectedByTag: true })).toBe(
      'unverifiable',
    );
  });
  it('the dnd tag wins over watched/requested (already whitelisted)', () => {
    expect(
      previewGuardian({ ...base, protectedByTag: true, recentlyWatched: true, requesters: ['a'] }),
    ).toBe('protected_tag');
  });
  it('recently watched ⇒ protected', () => {
    expect(previewGuardian({ ...base, recentlyWatched: true })).toBe('protected_watched');
  });
  it('requested ⇒ protected', () => {
    expect(previewGuardian({ ...base, requesters: ['manofoz'] })).toBe('protected_requested');
  });
  it('unknown to the ledger ⇒ unverifiable (never deletable)', () => {
    expect(previewGuardian({ ...base, mediaItemId: null })).toBe('unverifiable');
  });
});

describe('partitionForExpedite', () => {
  it('splits deleted-now / protected / unverifiable and sums only deletable bytes', () => {
    const partition = partitionForExpedite([
      { ...base, sizeBytes: 100 }, // deletable
      { ...base, recentlyWatched: true, sizeBytes: 10 }, // protected
      { ...base, protectedByTag: true, sizeBytes: 10 }, // protected
      { ...base, mediaItemId: null, sizeBytes: 10 }, // unverifiable (skipped)
      { ...base, maintainerrMediaId: null, sizeBytes: 10 }, // unverifiable (unactionable)
    ]);
    expect(partition).toEqual({
      deletable: 1,
      deletableBytes: 100,
      protected: 2,
      unverifiable: 2,
    });
  });
});

describe('expediteErrorAction (F3 — always re-partition on ANY expedite error)', () => {
  it('MAINTAINERR_UNSAFE ⇒ invalidate + show the calm stale panel (no raw message)', () => {
    expect(expediteErrorAction('MAINTAINERR_UNSAFE', 'ignored')).toEqual({
      invalidate: true,
      stale: true,
      message: null,
    });
  });
  it('any OTHER error code STILL invalidates (the fix) and surfaces the message', () => {
    // Before F3 a non-UNSAFE error left the pending query (and the confirm partition) stale.
    expect(expediteErrorAction('BAD_GATEWAY', 'Maintainerr unreachable')).toEqual({
      invalidate: true,
      stale: false,
      message: 'Maintainerr unreachable',
    });
    expect(expediteErrorAction(null, 'Something broke')).toMatchObject({ invalidate: true });
  });
});

describe('pendingWallGlyph / pendingWallTappable (the pending WALL tap-toggle — ADR-033)', () => {
  const cold = { protectedByTag: false, protectedByExclusion: false, recentlyWatched: false };
  it('unprotected cold ⇒ trash (slated); tappable to SAVE only with save_exclude', () => {
    expect(pendingWallGlyph(cold, undefined)).toBe('trash');
    expect(pendingWallTappable('trash', true, false)).toBe(true);
    expect(pendingWallTappable('trash', false, true)).toBe(false);
  });
  it('a save made THIS session ⇒ the filled shield (yours); un-save needs remove_exclude', () => {
    expect(pendingWallGlyph(cold, 'saved')).toBe('shield');
    expect(pendingWallTappable('shield', false, true)).toBe(true);
    expect(pendingWallTappable('shield', true, false)).toBe(false);
  });
  it('your save wins over the server signals (the refetch lands protectedByExclusion)', () => {
    expect(
      pendingWallGlyph({ ...cold, protectedByExclusion: true }, 'saved'),
    ).toBe('shield');
  });
  it('tag or live-exclusion protection from elsewhere ⇒ the inert check (never tappable)', () => {
    expect(pendingWallGlyph({ ...cold, protectedByTag: true }, undefined)).toBe('check');
    expect(pendingWallGlyph({ ...cold, protectedByExclusion: true }, undefined)).toBe('check');
    expect(pendingWallTappable('check', true, true)).toBe(false);
  });
  it('recently watched (and not saved) ⇒ the inert eye — the guardian keeps it regardless', () => {
    expect(pendingWallGlyph({ ...cold, recentlyWatched: true }, undefined)).toBe('eye');
    expect(pendingWallTappable('eye', true, true)).toBe(false);
    // protection from elsewhere outranks the watch signal (both are inert, check reads first).
    expect(
      pendingWallGlyph({ protectedByTag: true, protectedByExclusion: false, recentlyWatched: true }, undefined),
    ).toBe('check');
    // a save this session still wins — the watched item can be deliberately protected.
    expect(pendingWallGlyph({ ...cold, recentlyWatched: true }, 'saved')).toBe('shield');
  });
  it('an un-save this session ⇒ back to trash even while the stale protection signal lingers', () => {
    expect(
      pendingWallGlyph({ protectedByTag: false, protectedByExclusion: true, recentlyWatched: false }, 'unsaved'),
    ).toBe('trash');
  });
});

describe('daysUntil / daysLeftLabel / daysLeftTone', () => {
  const now = new Date('2026-07-06T12:00:00Z');
  it('counts whole days (ceil) and handles null/garbage', () => {
    expect(daysUntil('2026-07-18T12:00:00Z', now)).toBe(12);
    expect(daysUntil('2026-07-06T18:00:00Z', now)).toBe(1);
    expect(daysUntil('2026-07-06T12:00:00Z', now)).toBe(0);
    expect(daysUntil('2026-07-01T00:00:00Z', now)).toBeLessThan(0);
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil('not-a-date', now)).toBeNull();
  });
  it('labels read naturally', () => {
    expect(daysLeftLabel(12)).toBe('in 12 days');
    expect(daysLeftLabel(1)).toBe('tomorrow');
    expect(daysLeftLabel(0)).toBe('today');
    expect(daysLeftLabel(-2)).toBe('overdue');
    expect(daysLeftLabel(null)).toBe('no date');
  });
  it('tone deepens as the delete nears', () => {
    expect(daysLeftTone(30)).toBe('muted');
    expect(daysLeftTone(7)).toBe('warn');
    expect(daysLeftTone(3)).toBe('danger');
    expect(daysLeftTone(-1)).toBe('danger');
    expect(daysLeftTone(null)).toBe('muted');
  });
});

describe('reclaimLabel', () => {
  const fmt = (b: number) => `${b} B`;
  it('reads "Reclaiming N across M items" and handles the empty set', () => {
    expect(reclaimLabel(4200, 3, fmt)).toBe('Reclaiming 4200 B across 3 items');
    expect(reclaimLabel(1, 1, fmt)).toBe('Reclaiming 1 B across 1 item');
    expect(reclaimLabel(0, 0, fmt)).toBe('Nothing pending');
  });
});

// ── the Overview landing + tab badge (DESIGN-010 amendment 2026-07-08) ──────────────────────
describe('overviewCardTone / overviewBadge / overviewDeadlineLabel', () => {
  const now = new Date('2026-07-08T12:00:00Z');
  const admin: OverviewBatchLike = { state: 'admin_review', expiresAt: null, pendingCount: 18 };
  const leavingFar: OverviewBatchLike = {
    state: 'leaving_soon',
    expiresAt: '2026-07-21T12:00:00Z', // 13 days out
    pendingCount: 9,
  };
  const leavingSoon: OverviewBatchLike = {
    state: 'leaving_soon',
    expiresAt: '2026-07-10T12:00:00Z', // 2 days out ⇒ danger
    pendingCount: 4,
  };
  const fmtDay = (iso: string) => (iso.startsWith('2026-07-21') ? 'Jul 21' : 'Jul 10');

  it('card tone: neutral no-batch → info admin-review → warn leaving-soon → danger ≤3 days', () => {
    expect(overviewCardTone(null, now)).toBe('neutral');
    expect(overviewCardTone(admin, now)).toBe('info');
    expect(overviewCardTone(leavingFar, now)).toBe('warn');
    expect(overviewCardTone(leavingSoon, now)).toBe('danger');
    // draft (transient skip-gate leftover) reads as admin-review.
    expect(overviewCardTone({ state: 'draft', expiresAt: null, pendingCount: 1 }, now)).toBe('info');
  });

  it('deadline line reads the owner examples', () => {
    expect(overviewDeadlineLabel(admin, fmtDay, now)).toBe('Admin review — 18 items');
    expect(overviewDeadlineLabel({ ...admin, pendingCount: 1 }, fmtDay, now)).toBe(
      'Admin review — 1 item',
    );
    expect(overviewDeadlineLabel(leavingFar, fmtDay, now)).toBe(
      'Leaving Soon — window closes Jul 21 (in 13 days)',
    );
    expect(overviewDeadlineLabel(null, fmtDay, now)).toBe('');
  });

  it('badge: suppressed at zero / unknown, warn while the window is open, danger ≤3 days', () => {
    // No batch, positive live count ⇒ shown, muted tone.
    expect(overviewBadge({ slatedCount: 5, live: true, batch: null }, now)).toEqual({
      show: true,
      count: 5,
      tone: 'muted',
    });
    // Zero ⇒ suppressed.
    expect(overviewBadge({ slatedCount: 0, live: true, batch: null }, now).show).toBe(false);
    // Unknown live count (Maintainerr down) is stored as 0 ⇒ suppressed.
    expect(overviewBadge({ slatedCount: 0, live: false, batch: null }, now).show).toBe(false);
    // Leaving-soon window open ⇒ warn; ≤3 days ⇒ danger.
    expect(overviewBadge({ slatedCount: 9, live: true, batch: leavingFar }, now).tone).toBe('warn');
    expect(overviewBadge({ slatedCount: 4, live: true, batch: leavingSoon }, now).tone).toBe(
      'danger',
    );
    // Admin review is informational (muted pill) even with a positive count.
    expect(overviewBadge({ slatedCount: 18, live: true, batch: admin }, now).tone).toBe('muted');
  });
});
