// ADR-025 / DESIGN-011 D-07 (ADR-033 unification) — unit coverage for the poster wall's
// safety-critical client rules: the glyph language (trash/shield/check/eye/skip/gone), the
// phase-and-grant tap permissions (mirrors
// the server's setItemSaved gate), the running header counts (must agree with the glyphs), and
// the Expire report rows (raceSkipped/aborted semantics surfaced honestly).
import { describe, expect, it } from 'vitest';
import {
  batchStateTone,
  countdownCopy,
  sweepReportRows,
  tileTappable,
  wallCounts,
  wallGlyph,
  wallInteractive,
  type WallTapContext,
} from '../trash-batches';

const ctx = (over: Partial<WallTapContext> = {}): WallTapContext => ({
  batchState: 'admin_review',
  windowOpen: false,
  reachable: true,
  canManage: false,
  canSaveWindow: false,
  viewerId: 'user-1',
  ...over,
});

describe('wallGlyph — the overlay language (ADR-033 unified: trash/shield/check/eye/skip/gone)', () => {
  it('maps every item state, with recently-watched pending items getting the eye (not trash)', () => {
    expect(wallGlyph('pending', false)).toBe('trash');
    expect(wallGlyph('pending', true)).toBe('eye');
    expect(wallGlyph('saved', false)).toBe('shield');
    expect(wallGlyph('protected', false)).toBe('check');
    expect(wallGlyph('skipped', false)).toBe('skip');
    expect(wallGlyph('deleted', false)).toBe('gone');
  });

  it('recently-watched only softens PENDING — terminal/saved states keep their own glyph', () => {
    expect(wallGlyph('saved', true)).toBe('shield');
    expect(wallGlyph('skipped', true)).toBe('skip');
    expect(wallGlyph('deleted', true)).toBe('gone');
  });

  it('a requester on a PENDING item ⇒ the inert requested glyph (the sweep keeps it)', () => {
    expect(wallGlyph('pending', false, ['manofoz'])).toBe('requested');
    // watched outranks the requester (both inert; the eye reads first — guardian precedence).
    expect(wallGlyph('pending', true, ['manofoz'])).toBe('eye');
    // an explicit saved/protected/terminal state keeps its own glyph regardless of a requester.
    expect(wallGlyph('saved', false, ['manofoz'])).toBe('shield');
    expect(wallGlyph('protected', false, ['manofoz'])).toBe('check');
    // no requester ⇒ the slated trash-can, unchanged.
    expect(wallGlyph('pending', false, [])).toBe('trash');
  });
});

describe('wallInteractive — phase gate (mirrors trash.batches.setItemSaved)', () => {
  it('admin_review: only manage_batches holders interact', () => {
    expect(wallInteractive(ctx({ canManage: true }))).toBe(true);
    expect(wallInteractive(ctx({ canSaveWindow: true }))).toBe(false);
    expect(wallInteractive(ctx())).toBe(false);
  });

  it('leaving_soon: save_leaving_soon holders, and ONLY while the window is open', () => {
    const base = { batchState: 'leaving_soon' as const, canSaveWindow: true };
    expect(wallInteractive(ctx({ ...base, windowOpen: true }))).toBe(true);
    expect(wallInteractive(ctx({ ...base, windowOpen: false }))).toBe(false);
    // manage_batches alone is NOT the window grant (the server gate is save_leaving_soon;
    // admins pass because Admin implies every action, i.e. canSaveWindow is also true).
    expect(
      wallInteractive(ctx({ batchState: 'leaving_soon', windowOpen: true, canManage: true })),
    ).toBe(false);
  });

  it('terminal batches and an unreachable Maintainerr are always read-only', () => {
    expect(wallInteractive(ctx({ batchState: 'deleted', canManage: true }))).toBe(false);
    expect(wallInteractive(ctx({ batchState: 'cancelled', canManage: true }))).toBe(false);
    expect(wallInteractive(ctx({ canManage: true, reachable: false }))).toBe(false);
  });
});

describe('tileTappable — per-tile rules', () => {
  const admin = ctx({ canManage: true, canSaveWindow: true });
  const family = ctx({ batchState: 'leaving_soon', windowOpen: true, canSaveWindow: true });

  it('a trash (slated) tile is tappable for anyone who may interact (a save is protective)', () => {
    expect(tileTappable(admin, 'trash', null)).toBe(true);
    expect(tileTappable(family, 'trash', null)).toBe(true);
  });

  it('a family saver may undo their OWN save (incl. an optimistic one) but not a foreign one', () => {
    expect(tileTappable(family, 'shield', 'user-1')).toBe(true); // their save
    expect(tileTappable(family, 'shield', null)).toBe(true); // optimistic — refetch not landed
    expect(tileTappable(family, 'shield', 'someone-else')).toBe(false);
  });

  it('a batch manager may release any save', () => {
    const managing = ctx({
      batchState: 'leaving_soon',
      windowOpen: true,
      canManage: true,
      canSaveWindow: true,
    });
    expect(tileTappable(managing, 'shield', 'someone-else')).toBe(true);
  });

  it('check/eye/skip/gone are inert for everyone', () => {
    for (const glyph of ['check', 'eye', 'skip', 'gone'] as const) {
      expect(tileTappable(admin, glyph, null)).toBe(false);
    }
  });
});

describe('wallCounts — the running header agrees with the glyphs', () => {
  it('partitions slated/rescued/kept/deleted and sums slated bytes only', () => {
    const counts = wallCounts([
      { state: 'pending', recentlyWatched: false, sizeBytes: 100 }, // trash
      { state: 'pending', recentlyWatched: false, sizeBytes: 50 }, // trash
      { state: 'pending', recentlyWatched: true, sizeBytes: 999 }, // eye → kept
      { state: 'pending', recentlyWatched: false, requesters: ['manofoz'], sizeBytes: 42 }, // requested → kept
      { state: 'saved', recentlyWatched: false, sizeBytes: 10 }, // shield
      { state: 'protected', recentlyWatched: false, sizeBytes: 1 }, // check → kept
      { state: 'skipped', recentlyWatched: false, sizeBytes: 2 }, // skip → kept
      { state: 'deleted', recentlyWatched: false, sizeBytes: 3 }, // gone
    ]);
    expect(counts).toEqual({
      slated: 2,
      slatedBytes: 150,
      rescued: 1,
      kept: 4,
      deleted: 1,
    });
  });
});

describe('countdownCopy — the family banner', () => {
  it('invites the tap while the window is open and the viewer may save', () => {
    expect(countdownCopy('in 14 days', true, true)).toBe(
      'These delete in 14 days — tap anything you want to keep.',
    );
  });
  it('drops the invitation for read-only viewers and explains the closed window', () => {
    expect(countdownCopy('in 14 days', true, false)).toBe('These delete in 14 days.');
    expect(countdownCopy('today', false, true)).toBe(
      'The save window has closed — the remaining items delete on the next sweep.',
    );
  });
});

describe('sweepReportRows — the Expire report (D-05 SweepReport)', () => {
  it('always shows the four partition rows; deleted reads danger only when non-zero', () => {
    const rows = sweepReportRows({
      deletedCount: 2,
      skippedCount: 1,
      savedCount: 0,
      protectedCount: 1,
      handleErrors: 0,
      raceSkipped: 0,
      aborted: false,
    });
    expect(rows.map((r) => r.key)).toEqual(['deleted', 'saved', 'protected', 'skipped']);
    expect(rows[0]).toMatchObject({ count: 2, tone: 'danger' });
    expect(rows[1]).toMatchObject({ count: 0, tone: 'muted' });
  });

  it('surfaces raceSkipped (a save won the race — protective, ok tone) and handle errors', () => {
    const rows = sweepReportRows({
      deletedCount: 0,
      skippedCount: 0,
      savedCount: 3,
      protectedCount: 0,
      handleErrors: 2,
      raceSkipped: 1,
      aborted: true,
    });
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.raceSkipped).toMatchObject({ count: 1, tone: 'ok', label: 'saved mid-run' });
    expect(byKey.handleErrors).toMatchObject({ count: 2, tone: 'warn' });
  });
});

describe('batchStateTone', () => {
  it('leaving_soon warns, deleted is danger, cancelled/draft muted', () => {
    expect(batchStateTone('admin_review')).toBe('info');
    expect(batchStateTone('leaving_soon')).toBe('warn');
    expect(batchStateTone('deleted')).toBe('danger');
    expect(batchStateTone('cancelled')).toBe('muted');
    expect(batchStateTone('draft')).toBe('muted');
  });
});
