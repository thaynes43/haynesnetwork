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
  formatWatchMonth,
  lastWatchedLabel,
  overviewBadge,
  overviewCardTone,
  overviewDeadlineLabel,
  partitionForExpedite,
  pendingWallGlyph,
  pendingWallTappable,
  previewGuardian,
  nextSweepSlot,
  reclaimLabel,
  recentlyWatchedLabel,
  SWEEP_CRON_MINUTE,
  sweepTimeLabel,
  watchNote,
  watchedLongAgo,
  watchServerLabel,
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
  it('the dnd tag wins (already whitelisted), even with a watcher/requester present', () => {
    expect(
      previewGuardian({ ...base, protectedByTag: true, recentlyWatched: true, requesters: ['a'] }),
    ).toBe('protected_tag');
  });
  it('recently watched ⇒ protected', () => {
    expect(previewGuardian({ ...base, recentlyWatched: true })).toBe('protected_watched');
  });
  it('requested ⇒ DELETABLE (owner ruling 2026-07-09 — requested is informational only, not a keep)', () => {
    // A requester no longer protects an item at expedite; it is cold-deletable like any other item.
    expect(previewGuardian({ ...base, requesters: ['manofoz'] })).toBe('deletable');
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
  it('BUG FIX 2026-07-09 — recently watched no longer produces the inert eye corner: it is a normal, SAVEABLE tile', () => {
    // The owner-reported bug: a recently-watched candidate (PAW Patrol) showed the inert eye corner
    // and clicking did nothing — could not be saved. The eye is retired from the corner; the tile is
    // the slated trash-can (tap ⇒ save), and the watch fact moves to the meta line (watchNote).
    expect(pendingWallGlyph({ ...cold, recentlyWatched: true }, undefined)).toBe('trash');
    expect(pendingWallTappable('trash', true, false)).toBe(true); // now saveable with save_exclude
    // A recently-watched REQUESTER item is ALSO the plain slated trash-can now — a requester no longer
    // wins a corner glyph (owner ruling 2026-07-09 — requested is informational only, a meta badge).
    expect(
      pendingWallGlyph({ ...cold, recentlyWatched: true, requesters: ['manofoz'] }, undefined),
    ).toBe('trash');
    // Hard protection (dnd tag / a foreign exclusion) still outranks — the inert check, unchanged.
    expect(
      pendingWallGlyph({ ...cold, protectedByTag: true, recentlyWatched: true }, undefined),
    ).toBe('check');
    // a save this session still wins — the watched item can be deliberately protected.
    expect(pendingWallGlyph({ ...cold, recentlyWatched: true }, 'saved')).toBe('shield');
  });
  it('a personal requester is INFO ONLY — it never changes the corner glyph (owner ruling 2026-07-09)', () => {
    // "Maintainerr rules decide what gets promoted; the app controls how much and when it's deleted."
    // A requester no longer wins a corner glyph — the person-shield is retired. An unprotected requested
    // candidate is the ordinary slated trash-can (tap ⇒ save); its attribution rides the meta badge.
    expect(pendingWallGlyph({ ...cold, requesters: ['manofoz'] }, undefined)).toBe('trash');
    expect(pendingWallTappable('trash', true, false)).toBe(true); // saves with save_exclude
    // A requester item that is live-EXCLUDED reads exactly like any foreign exclusion — the inert
    // `check` (no more requester carve-out / "shield when both"). Un-protect lives on /library.
    expect(
      pendingWallGlyph({ ...cold, protectedByExclusion: true, requesters: ['manofoz'] }, undefined),
    ).toBe('check');
    // The dnd TAG (hard protection) is likewise the inert `check` for a requester item.
    expect(
      pendingWallGlyph({ ...cold, protectedByTag: true, requesters: ['manofoz'] }, undefined),
    ).toBe('check');
    // A recently-watched requester item is ALSO the plain slated trash-can (nothing about the requester
    // or the watch signal changes the corner — both are meta-line info now).
    expect(
      pendingWallGlyph({ ...cold, recentlyWatched: true, requesters: ['manofoz'] }, undefined),
    ).toBe('trash');
    // a save this session still wins — the requested item can be deliberately saved by you.
    expect(pendingWallGlyph({ ...cold, requesters: ['manofoz'] }, 'saved')).toBe('shield');
  });
  it('an un-save this session ⇒ back to trash even while the stale protection signal lingers', () => {
    expect(
      pendingWallGlyph({ ...cold, protectedByExclusion: true }, 'unsaved'),
    ).toBe('trash');
  });

  // DESIGN-010 D-12 (build C) — the watch-visibility indicator NEVER touches the corner glyph, in
  // EITHER watch state. Both recently-watched and watched-long-ago items resolve to their normal
  // glyph (trash / shield / check); the eye chip is a separate meta-line element (info vs muted tone).
  // The requester attribution is likewise a meta-line badge now, never a corner glyph.
  it('D-12 — a watched/requested item keeps its normal corner glyph (watch + requester → meta notes)', () => {
    // requested (unprotected) ⇒ the slated trash-can corner; the requester is a separate meta badge.
    expect(pendingWallGlyph({ ...cold, requesters: ['manofoz'] }, undefined)).toBe('trash');
    // unprotected + watched (either state) ⇒ the slated, saveable trash-can — the eye corner is gone.
    expect(pendingWallGlyph(cold, undefined)).toBe('trash');
  });
});

describe('watch visibility helpers (DESIGN-010 D-12 — info, not protection)', () => {
  it('watchServerLabel maps estate slugs to display names; unknown slug is verbatim; blank → null', () => {
    expect(watchServerLabel('haynesops')).toBe('HaynesOps');
    expect(watchServerLabel('hayneskube')).toBe('HaynesKube');
    expect(watchServerLabel('haynestower')).toBe('HaynesTower');
    expect(watchServerLabel('somethingelse')).toBe('somethingelse');
    expect(watchServerLabel(null)).toBeNull();
    expect(watchServerLabel('  ')).toBeNull();
  });

  it('formatWatchMonth renders "Mon YYYY" in the app tz; bad/absent input → null', () => {
    // 2024-07-15T02:00:00Z = Jul 14 22:00 EDT — still July in ET.
    expect(formatWatchMonth('2024-07-15T02:00:00Z')).toBe('Jul 2024');
    // 2025-01-01T02:00:00Z = Dec 31 2024 21:00 EST — the ET calendar month is Dec 2024.
    expect(formatWatchMonth('2025-01-01T02:00:00Z')).toBe('Dec 2024');
    expect(formatWatchMonth(null)).toBeNull();
    expect(formatWatchMonth('not-a-date')).toBeNull();
  });

  it('watchedLongAgo is true only for a known last-watch that is NOT recently watched', () => {
    expect(watchedLongAgo({ lastWatchedAt: '2024-01-01T00:00:00Z', recentlyWatched: false })).toBe(true);
    // recently watched ⇒ the info-tone note owns it (watchNote), not the muted long-ago predicate.
    expect(watchedLongAgo({ lastWatchedAt: '2024-01-01T00:00:00Z', recentlyWatched: true })).toBe(false);
    // never watched ⇒ nothing.
    expect(watchedLongAgo({ lastWatchedAt: null, recentlyWatched: false })).toBe(false);
  });

  it('recentlyWatchedLabel composes "Watched recently on <server> · <Mon YYYY>", degrading gracefully', () => {
    expect(recentlyWatchedLabel('2024-07-15T02:00:00Z', 'haynesops')).toBe('Watched recently on HaynesOps · Jul 2024');
    // no server ⇒ drop " on <server>" (space, not " · ", before the month).
    expect(recentlyWatchedLabel('2024-07-15T02:00:00Z', null)).toBe('Watched recently Jul 2024');
    // server, unparseable date ⇒ just the server clause.
    expect(recentlyWatchedLabel('not-a-date', 'hayneskube')).toBe('Watched recently on HaynesKube');
    // neither ⇒ a bare "Watched recently" (never blank — a recent item always earns its note).
    expect(recentlyWatchedLabel(null, null)).toBe('Watched recently');
  });

  it('watchNote — build C: BOTH watch states resolve to a meta note (info vs muted); no watch ⇒ null', () => {
    // recently watched ⇒ the INFO-tone note, ALWAYS present (even unattributed).
    expect(
      watchNote({ lastWatchedAt: '2024-07-15T02:00:00Z', lastWatchedServer: 'haynesops', recentlyWatched: true }),
    ).toEqual({ label: 'Watched recently on HaynesOps · Jul 2024', tone: 'info', recent: true });
    expect(
      watchNote({ lastWatchedAt: null, lastWatchedServer: null, recentlyWatched: true }),
    ).toEqual({ label: 'Watched recently', tone: 'info', recent: true });
    // watched a while ago ⇒ the MUTED note.
    expect(
      watchNote({ lastWatchedAt: '2024-07-15T02:00:00Z', lastWatchedServer: 'hayneskube', recentlyWatched: false }),
    ).toEqual({ label: 'Last watched on HaynesKube · Jul 2024', tone: 'muted', recent: false });
    // never watched ⇒ null (the chip is suppressed).
    expect(
      watchNote({ lastWatchedAt: null, lastWatchedServer: null, recentlyWatched: false }),
    ).toBeNull();
  });

  it('lastWatchedLabel composes "Last watched on <server> · <Mon YYYY>", degrading gracefully', () => {
    expect(lastWatchedLabel('2024-07-15T02:00:00Z', 'hayneskube')).toBe('Last watched on HaynesKube · Jul 2024');
    // unknown server slug is still shown verbatim.
    expect(lastWatchedLabel('2024-07-15T02:00:00Z', 'legacybox')).toBe('Last watched on legacybox · Jul 2024');
    // no server ⇒ drop the "on <server>".
    expect(lastWatchedLabel('2024-07-15T02:00:00Z', null)).toBe('Last watched Jul 2024');
    // bad date, known server ⇒ just the server clause.
    expect(lastWatchedLabel('not-a-date', 'haynesops')).toBe('Last watched on HaynesOps');
    // no instant at all ⇒ null (the indicator is suppressed).
    expect(lastWatchedLabel(null, 'haynesops')).toBeNull();
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

  it('deadline line names the sweep time once the window has CLOSED (awaiting the sweep)', () => {
    const afterClose = new Date('2026-07-10T03:20:00Z'); // 11:20 PM EDT — window already shut
    const closed: OverviewBatchLike = {
      state: 'leaving_soon',
      expiresAt: '2026-07-10T03:04:00Z', // closed at 11:04 PM EDT; next :45 sweep is 11:45 PM
      pendingCount: 3,
    };
    expect(overviewDeadlineLabel(closed, afterClose)).toBe(
      'Leaving Soon — window closed · deletes at 11:45 PM',
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

// ── next-sweep slot math (DESIGN-011 amendment 2026-07-09) ──────────────────────────────────
describe('nextSweepSlot / sweepTimeLabel — the honest sweep time (hourly at :SWEEP_CRON_MINUTE)', () => {
  it('SWEEP_CRON_MINUTE mirrors the deployed CronJob minute (45)', () => {
    expect(SWEEP_CRON_MINUTE).toBe(45);
  });

  it('rolls to THIS hour :45 when before it', () => {
    // 11:20:30 → the 11:45:00 sweep this hour.
    expect(nextSweepSlot(new Date('2026-07-10T11:20:30Z')).toISOString()).toBe(
      '2026-07-10T11:45:00.000Z',
    );
  });

  it('rolls to the NEXT hour :45 when already past this hour’s slot', () => {
    // 11:50:00 → this hour’s :45 passed → 12:45:00.
    expect(nextSweepSlot(new Date('2026-07-10T11:50:00Z')).toISOString()).toBe(
      '2026-07-10T12:45:00.000Z',
    );
  });

  it('keeps the slot when the instant is EXACTLY on :45 (the exactly-:45 edge)', () => {
    expect(nextSweepSlot(new Date('2026-07-10T11:45:00.000Z')).toISOString()).toBe(
      '2026-07-10T11:45:00.000Z',
    );
    // One ms past the slot rolls to the next hour (the :45 sweep already fired).
    expect(nextSweepSlot(new Date('2026-07-10T11:45:00.001Z')).toISOString()).toBe(
      '2026-07-10T12:45:00.000Z',
    );
  });

  it('sweepTimeLabel PRE-expiry names the :45 after the future deadline (tz-correct)', () => {
    // now 8:04 AM EDT; deadline 11:04 PM EDT ⇒ sweep 11:45 PM EDT.
    const now = new Date('2026-07-09T12:04:00Z');
    expect(sweepTimeLabel('2026-07-10T03:04:00Z', now)).toBe('11:45 PM');
  });

  it('sweepTimeLabel POST-expiry uses the :45 after max(now, expiresAt)', () => {
    // Deadline was 11:04 PM EDT; now is 11:50 PM EDT (past this hour’s :45) ⇒ next sweep 12:45 AM.
    const now = new Date('2026-07-10T03:50:00Z');
    expect(sweepTimeLabel('2026-07-10T03:04:00Z', now)).toBe('12:45 AM');
  });

  it('is null on a garbage / absent deadline (caller falls back to vague copy)', () => {
    expect(sweepTimeLabel(null)).toBeNull();
    expect(sweepTimeLabel('not-a-date')).toBeNull();
  });
});
