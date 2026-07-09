// DESIGN-010 D-09 — the Trash client helpers are safety-critical copy inputs: the guardian
// PREVIEW must partition exactly like @hnet/domain classifyGuardian + the expedite 'all' loop
// (an optimistic preview that under-counts "deleted" would make the confirm Modal lie).
import { describe, expect, it } from 'vitest';
import {
  candidatesAsOfLabel,
  daysLeftLabel,
  daysLeftTone,
  daysUntil,
  deadlineCountdown,
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
  const cold = {
    protectedByTag: false,
    protectedByExclusion: false,
    recentlyWatched: false,
    requesters: [] as string[],
  };
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
      pendingWallGlyph(
        { ...cold, protectedByTag: true, recentlyWatched: true },
        undefined,
      ),
    ).toBe('check');
    // a save this session still wins — the watched item can be deliberately protected.
    expect(pendingWallGlyph({ ...cold, recentlyWatched: true }, 'saved')).toBe('shield');
  });
  it('build B — a personal requester with NO exclusion ⇒ the person-shield, TAPPABLE as a save-toggle', () => {
    // Owner ruling (build B): a requested item is NEVER inert on the live wall. Unprotected ⇒ the
    // person-shield ('requested'), tappable ⇒ SAVE (tap adds the exclusion), exactly like a trash tile.
    expect(pendingWallGlyph({ ...cold, requesters: ['manofoz'] }, undefined)).toBe('requested');
    expect(pendingWallTappable('requested', true, false)).toBe(true); // saves with save_exclude
    expect(pendingWallTappable('requested', false, true)).toBe(false); // not a save right ⇒ inert
    // "Shield when both": a requested item that is ALSO live-EXCLUDED (the reversible save) reads as
    // the ordinary save shield (never inert) — tappable to UN-save — not the inert `check`.
    expect(
      pendingWallGlyph({ ...cold, protectedByExclusion: true, requesters: ['manofoz'] }, undefined),
    ).toBe('shield');
    // …but the deliberate dnd TAG (hard protection, un-protect on /library) stays the inert `check`
    // even for a requester item.
    expect(
      pendingWallGlyph({ ...cold, protectedByTag: true, requesters: ['manofoz'] }, undefined),
    ).toBe('check');
    // The watch keep still outranks the requester (a watched item is genuinely guardian-kept).
    expect(
      pendingWallGlyph({ ...cold, recentlyWatched: true, requesters: ['manofoz'] }, undefined),
    ).toBe('eye');
    // a save this session still wins — the requested item can be deliberately saved by you.
    expect(pendingWallGlyph({ ...cold, requesters: ['manofoz'] }, 'saved')).toBe('shield');
  });
  it('an un-save this session ⇒ back to trash even while the stale protection signal lingers', () => {
    expect(
      pendingWallGlyph({ ...cold, protectedByExclusion: true }, 'unsaved'),
    ).toBe('trash');
  });
});

describe('candidatesAsOfLabel (ADR-035 — snapshot honesty line)', () => {
  const now = new Date('2026-07-09T12:00:00Z');
  it('formats just-now / minutes / hours', () => {
    expect(candidatesAsOfLabel('2026-07-09T11:59:40Z', now)).toBe('candidates as of just now');
    expect(candidatesAsOfLabel('2026-07-09T11:47:00Z', now)).toBe('candidates as of 13 min ago');
    expect(candidatesAsOfLabel('2026-07-09T09:00:00Z', now)).toBe('candidates as of 3 h ago');
  });
  it('never fabricates an age: null/garbage/future → null or just-now', () => {
    expect(candidatesAsOfLabel(null, now)).toBeNull();
    expect(candidatesAsOfLabel('not-a-date', now)).toBeNull();
    expect(candidatesAsOfLabel('2026-07-09T12:05:00Z', now)).toBe('candidates as of just now');
  });
});

describe('daysUntil / daysLeftLabel / daysLeftTone', () => {
  // 2026-07-06T12:00:00Z = 08:00 EDT on Jul 6 (America/New_York, UTC-4).
  const now = new Date('2026-07-06T12:00:00Z');
  it('counts CALENDAR days in the display tz and handles null/garbage', () => {
    expect(daysUntil('2026-07-18T12:00:00Z', now)).toBe(12);
    // A same-calendar-day-but-later time is TODAY (0), not tomorrow — the pre-build-A ms-ceil bug.
    expect(daysUntil('2026-07-06T18:00:00Z', now)).toBe(0);
    expect(daysUntil('2026-07-06T12:00:00Z', now)).toBe(0);
    expect(daysUntil('2026-07-01T00:00:00Z', now)).toBeLessThan(0);
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil('not-a-date', now)).toBeNull();
  });
  it('crosses the calendar boundary in ET, not UTC', () => {
    // 2026-07-07T02:00:00Z is still 10:00 PM EDT on Jul 6 — so from 08:00 EDT Jul 6 it is TODAY (0).
    expect(daysUntil('2026-07-07T02:00:00Z', now)).toBe(0);
    // 2026-07-07T05:00:00Z is 01:00 EDT on Jul 7 — the next ET calendar day (tomorrow, 1).
    expect(daysUntil('2026-07-07T05:00:00Z', now)).toBe(1);
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

// ── the tz-correct, hour-aware deadline countdown (DESIGN-011/014 amendment 2026-07-09, build A) ──
describe('deadlineCountdown', () => {
  it('REGRESSION: an 11:04 PM-ET-today expiry reads "today", never "tomorrow" (UTC-day bug)', () => {
    // now = 8:04 AM EDT Jul 9; expiry = 11:04 PM EDT the SAME day (2026-07-10T03:04Z is 11:04 PM Jul 9 ET).
    const now = new Date('2026-07-09T12:04:00Z');
    const c = deadlineCountdown('2026-07-10T03:04:00Z', now);
    expect(c.hourLevel).toBe(true);
    expect(c.days).toBe(0);
    expect(c.whenLabel).toBe('today 11:04 PM');
    expect(c.relLabel).toBe('in 15h');
    expect(c.tone).toBe('danger');
  });
  it('a tomorrow-morning expiry under 48h reads "tomorrow <time> · in Nh"', () => {
    // now = 8:35 AM EDT Jul 9; expiry = 7:35 AM EDT Jul 10 (2026-07-10T11:35Z) ⇒ 23h, ET calendar +1.
    const now = new Date('2026-07-09T12:35:00Z');
    const c = deadlineCountdown('2026-07-10T11:35:00Z', now);
    expect(c.hourLevel).toBe(true);
    expect(c.whenLabel).toBe('tomorrow 7:35 AM');
    expect(c.relLabel).toBe('in 23h');
  });
  it('48h+ falls back to the calendar-day label ("Jul 21" + "in 12 days")', () => {
    const now = new Date('2026-07-09T12:00:00Z');
    const c = deadlineCountdown('2026-07-21T12:00:00Z', now);
    expect(c.hourLevel).toBe(false);
    expect(c.whenLabel).toBe('Jul 21');
    expect(c.relLabel).toBe('in 12 days');
    expect(c.tone).toBe('muted');
  });
  it('no/garbage date is calm', () => {
    const c = deadlineCountdown(null);
    expect(c).toMatchObject({ whenLabel: '', relLabel: 'no date', hourLevel: false, days: null });
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
  it('card tone: neutral no-batch → info admin-review → warn leaving-soon → danger ≤3 days', () => {
    expect(overviewCardTone(null, now)).toBe('neutral');
    expect(overviewCardTone(admin, now)).toBe('info');
    expect(overviewCardTone(leavingFar, now)).toBe('warn');
    expect(overviewCardTone(leavingSoon, now)).toBe('danger');
    // draft (transient skip-gate leftover) reads as admin-review.
    expect(overviewCardTone({ state: 'draft', expiresAt: null, pendingCount: 1 }, now)).toBe('info');
  });

  it('deadline line reads the owner examples (tz-correct, day-level at 48h+)', () => {
    expect(overviewDeadlineLabel(admin, now)).toBe('Admin review — 18 items');
    expect(overviewDeadlineLabel({ ...admin, pendingCount: 1 }, now)).toBe('Admin review — 1 item');
    expect(overviewDeadlineLabel(leavingFar, now)).toBe(
      'Leaving Soon — window closes Jul 21 (in 13 days)',
    );
    expect(overviewDeadlineLabel(null, now)).toBe('');
  });

  it('deadline line goes hour-level under 48h ("closes today <time> · in Nh")', () => {
    const hourNow = new Date('2026-07-09T12:04:00Z'); // 8:04 AM EDT
    const closingToday: OverviewBatchLike = {
      state: 'leaving_soon',
      expiresAt: '2026-07-10T03:04:00Z', // 11:04 PM EDT the same ET day
      pendingCount: 3,
    };
    expect(overviewDeadlineLabel(closingToday, hourNow)).toBe(
      'Leaving Soon — window closes today 11:04 PM · in 15h',
    );
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
