// ADR-025 / DESIGN-011 D-07 — unit coverage for the poster wall's safety-critical client rules:
// the glyph language (X/lock/eye/shield/skip/gone), the phase-and-grant tap permissions (mirrors
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

describe('wallGlyph — the overlay language', () => {
  it('maps every item state, with recently-watched pending items getting the eye (not X)', () => {
    expect(wallGlyph('pending', false)).toBe('x');
    expect(wallGlyph('pending', true)).toBe('eye');
    expect(wallGlyph('saved', false)).toBe('lock');
    expect(wallGlyph('protected', false)).toBe('shield');
    expect(wallGlyph('skipped', false)).toBe('skip');
    expect(wallGlyph('deleted', false)).toBe('gone');
  });

  it('recently-watched only softens PENDING — terminal/saved states keep their own glyph', () => {
    expect(wallGlyph('saved', true)).toBe('lock');
    expect(wallGlyph('skipped', true)).toBe('skip');
    expect(wallGlyph('deleted', true)).toBe('gone');
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

  it('X is tappable for anyone who may interact (a save is protective)', () => {
    expect(tileTappable(admin, 'x', null)).toBe(true);
    expect(tileTappable(family, 'x', null)).toBe(true);
  });

  it('a family saver may undo their OWN lock (incl. an optimistic one) but not a foreign one', () => {
    expect(tileTappable(family, 'lock', 'user-1')).toBe(true); // their save
    expect(tileTappable(family, 'lock', null)).toBe(true); // optimistic — refetch not landed
    expect(tileTappable(family, 'lock', 'someone-else')).toBe(false);
  });

  it('a batch manager may release any lock', () => {
    const managing = ctx({
      batchState: 'leaving_soon',
      windowOpen: true,
      canManage: true,
      canSaveWindow: true,
    });
    expect(tileTappable(managing, 'lock', 'someone-else')).toBe(true);
  });

  it('eye/shield/skip/gone are inert for everyone', () => {
    for (const glyph of ['eye', 'shield', 'skip', 'gone'] as const) {
      expect(tileTappable(admin, glyph, null)).toBe(false);
    }
  });
});

describe('wallCounts — the running header agrees with the glyphs', () => {
  it('partitions slated/rescued/kept/deleted and sums slated bytes only', () => {
    const counts = wallCounts([
      { state: 'pending', recentlyWatched: false, sizeBytes: 100 }, // x
      { state: 'pending', recentlyWatched: false, sizeBytes: 50 }, // x
      { state: 'pending', recentlyWatched: true, sizeBytes: 999 }, // eye → kept
      { state: 'saved', recentlyWatched: false, sizeBytes: 10 }, // lock
      { state: 'protected', recentlyWatched: false, sizeBytes: 1 }, // shield → kept
      { state: 'skipped', recentlyWatched: false, sizeBytes: 2 }, // skip → kept
      { state: 'deleted', recentlyWatched: false, sizeBytes: 3 }, // gone
    ]);
    expect(counts).toEqual({
      slated: 2,
      slatedBytes: 150,
      rescued: 1,
      kept: 3,
      deleted: 1,
    });
  });
});

describe('countdownCopy — the family banner', () => {
  it('invites the tap while the window is open and the viewer may save', () => {
    expect(countdownCopy('in 14 days', true, true)).toBe(
      'These delete in 14 days — tap the ✕ on anything you want to keep.',
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
