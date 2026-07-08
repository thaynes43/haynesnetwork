// DESIGN-010 D-09 — the Trash client helpers are safety-critical copy inputs: the guardian
// PREVIEW must partition exactly like @hnet/domain classifyGuardian + the expedite 'all' loop
// (an optimistic preview that under-counts "deleted" would make the confirm Modal lie).
import { describe, expect, it } from 'vitest';
import {
  daysLeftLabel,
  daysLeftTone,
  daysUntil,
  expediteErrorAction,
  partitionForExpedite,
  pendingWallGlyph,
  pendingWallTappable,
  previewGuardian,
  reclaimLabel,
  type GuardianPreviewInput,
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
