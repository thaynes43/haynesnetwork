// ADR-025 / DESIGN-011 D-07 (ADR-033 unification) — unit coverage for the poster wall's
// safety-critical client rules: the glyph language (trash/shield/check/requested/skip/gone — the
// eye was retired from the corner 2026-07-09), the
// phase-and-grant tap permissions (mirrors
// the server's setItemSaved gate), the running header counts (must agree with the glyphs), and
// the Expire report rows (raceSkipped/aborted semantics surfaced honestly).
import { describe, expect, it } from 'vitest';
import {
  batchStateTone,
  countdownCopy,
  forceExpireConfirmMatches,
  previewTargetSelection,
  sweepReportRows,
  tileTappable,
  wallCounts,
  wallGlyph,
  wallInteractive,
  type TargetCandidate,
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

describe('wallGlyph — the overlay language (ADR-033 unified: trash/shield/check/requested/skip/gone)', () => {
  it('BUG FIX 2026-07-09 — the eye is retired from the corner: a recently-watched pending item reads as its normal glyph', () => {
    expect(wallGlyph('pending', false)).toBe('trash');
    // recently watched no longer produces the inert eye — the corner is the action (a saveable trash-can).
    expect(wallGlyph('pending', true)).toBe('trash');
    expect(wallGlyph('saved', false)).toBe('shield');
    expect(wallGlyph('protected', false)).toBe('check');
    expect(wallGlyph('skipped', false)).toBe('skip');
    expect(wallGlyph('deleted', false)).toBe('gone');
  });

  it('recently-watched never changes the glyph now (in ANY state) — the watch fact is a meta note', () => {
    expect(wallGlyph('pending', true)).toBe('trash');
    expect(wallGlyph('saved', true)).toBe('shield');
    expect(wallGlyph('protected', true)).toBe('check');
    expect(wallGlyph('skipped', true)).toBe('skip');
    expect(wallGlyph('deleted', true)).toBe('gone');
  });

  it('a requester on a PENDING item ⇒ the requested person-shield (a recently-watched requester keep, saveable)', () => {
    expect(wallGlyph('pending', false, ['manofoz'])).toBe('requested');
    // recently-watched + requester ⇒ still the person-shield (no eye — the corner is the action).
    expect(wallGlyph('pending', true, ['manofoz'])).toBe('requested');
    // an explicit saved/protected/terminal state keeps its own glyph regardless of a requester.
    expect(wallGlyph('saved', false, ['manofoz'])).toBe('shield');
    expect(wallGlyph('protected', false, ['manofoz'])).toBe('check');
    // no requester ⇒ the slated trash-can, unchanged.
    expect(wallGlyph('pending', false, [])).toBe('trash');
  });

  it('build B — a SAVED requested auto-save is the person-shield; a human save stays the filled shield', () => {
    // savedReason 'requested' ⇒ the DISTINCT person-shield (a machine auto-keep), not the human shield.
    expect(wallGlyph('saved', false, ['alice'], { savedReason: 'requested' })).toBe('requested');
    expect(wallGlyph('saved', false, [], { savedReason: null })).toBe('shield');
    // A requester item a human explicitly UN-SAVED (requestedOverride) is genuinely slated ⇒ trash-can.
    expect(wallGlyph('pending', false, ['alice'], { requestedOverride: true })).toBe('trash');
    // …but a requester item that was NOT overridden still reads as the inert person-shield.
    expect(wallGlyph('pending', false, ['alice'], { requestedOverride: false })).toBe('requested');
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

  it('skip/gone are inert for everyone (there is no longer an eye glyph)', () => {
    for (const glyph of ['skip', 'gone'] as const) {
      expect(tileTappable(admin, glyph, null)).toBe(false);
    }
  });

  it('a check (protected) tile is now tappable to un-protect it (ADR-025 errata — the Baldwins fix)', () => {
    // A protected item is held by a live Maintainerr exclusion; tapping removes it + re-classifies. Any
    // saver for the phase may act (a manager in admin_review, a family saver in the open window).
    expect(tileTappable(admin, 'check', null)).toBe(true);
    expect(tileTappable(family, 'check', null)).toBe(true);
    // …but only while the phase is interactive — terminal / read-only walls keep it inert.
    const readOnly = ctx({ batchState: 'deleted' });
    expect(tileTappable(readOnly, 'check', null)).toBe(false);
  });

  it('the person-shield is tappable for any saver in an interactive phase: SAVED ⇒ un-save, PENDING ⇒ save (the batch eye-corner fix)', () => {
    // A system requested auto-save has no human owner, so ownership never blocks it: any saver may tap
    // it to un-save (family window OR manager). BUG FIX 2026-07-09 — a `pending` requested item (a
    // recently-watched requester keep that stayed pending, no longer the inert eye) is likewise SAVEABLE
    // by any saver: tap ⇒ create the exclusion. Either direction, whenever the phase is interactive.
    expect(tileTappable(family, 'requested', null)).toBe(true);
    expect(tileTappable(admin, 'requested', null)).toBe(true);
    // …but only in an interactive phase — a terminal/read-only wall keeps it inert.
    expect(tileTappable(ctx({ batchState: 'deleted' }), 'requested', null)).toBe(false);
  });
});

describe('wallCounts — the running header agrees with the glyphs', () => {
  it('partitions slated/rescued/kept/deleted and sums slated bytes only', () => {
    const counts = wallCounts([
      { state: 'pending', recentlyWatched: false, sizeBytes: 100 }, // trash → slated
      { state: 'pending', recentlyWatched: false, sizeBytes: 50 }, // trash → slated
      { state: 'pending', recentlyWatched: true, sizeBytes: 999 }, // trash → slated (recently-watched: the eye is retired, the sweep-time guardian still keeps it)
      { state: 'pending', recentlyWatched: false, requesters: ['manofoz'], sizeBytes: 42 }, // requested → kept
      { state: 'saved', recentlyWatched: false, sizeBytes: 10 }, // shield (human) → rescued
      { state: 'saved', recentlyWatched: false, requesters: ['alice'], savedReason: 'requested', sizeBytes: 8 }, // person-shield → kept
      { state: 'protected', recentlyWatched: false, sizeBytes: 1 }, // check → kept
      { state: 'skipped', recentlyWatched: false, sizeBytes: 2 }, // skip → kept
      { state: 'deleted', recentlyWatched: false, sizeBytes: 3 }, // gone
    ]);
    expect(counts).toEqual({
      slated: 3,
      slatedBytes: 1149,
      rescued: 1, // only the HUMAN save is 'rescued'; the requested auto-save reads as 'kept'
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

describe('previewTargetSelection — the Start-a-batch client preview (mirrors selectBatchCandidates)', () => {
  const c = (sizeBytes: number, over: Partial<TargetCandidate> = {}): TargetCandidate => ({
    sizeBytes,
    imdbRating: null,
    tmdbRating: null,
    protectedByTag: false,
    ...over,
  });
  // a=4, b=3, c=2(protected), d=1 (×1e9)
  const pool = [c(4e9), c(3e9), c(2e9, { protectedByTag: true }), c(1e9)];

  it('no target ⇒ the whole DELETABLE pool (protected excluded from count/bytes)', () => {
    expect(previewTargetSelection(pool, {})).toMatchObject({ count: 3, bytes: 8e9, poolCount: 3 });
  });

  it('targetBytes largest ⇒ crossing item included; poolCount/Bytes describe the deletable pool', () => {
    const p = previewTargetSelection(pool, { targetBytes: 6e9, strategy: 'largest' });
    expect(p).toMatchObject({ count: 2, bytes: 7e9, poolCount: 3, poolBytes: 8e9 });
  });

  it('maxItems caps; a target under the first item still yields one', () => {
    expect(previewTargetSelection(pool, { maxItems: 1 })).toMatchObject({ count: 1, bytes: 4e9 });
    expect(previewTargetSelection(pool, { targetBytes: 1 })).toMatchObject({ count: 1, bytes: 4e9 });
  });

  it('worst-rated ⇒ unrated first, then rating asc (ties by size desc)', () => {
    const rated = [
      c(1e9, { imdbRating: 8 }),
      c(2e9, { imdbRating: 4 }),
      c(5e9), // unrated
    ];
    // unrated (5e9) → rating 4 (2e9) → rating 8 (1e9); maxItems 2 ⇒ first two.
    expect(previewTargetSelection(rated, { maxItems: 2, strategy: 'worst-rated' }).bytes).toBe(7e9);
  });

  it('all-protected pool ⇒ nothing to target', () => {
    const allProt = [c(4e9, { protectedByTag: true })];
    expect(previewTargetSelection(allProt, { targetBytes: 1e9 })).toMatchObject({ count: 0, poolCount: 0 });
  });
});

describe('forceExpireConfirmMatches — the mid-window force-expire typed gate', () => {
  it('accepts the word DELETE (case-insensitive) or the exact delete count; rejects anything else', () => {
    expect(forceExpireConfirmMatches('DELETE', 3)).toBe(true);
    expect(forceExpireConfirmMatches('delete', 3)).toBe(true);
    expect(forceExpireConfirmMatches(' Delete ', 3)).toBe(true);
    expect(forceExpireConfirmMatches('3', 3)).toBe(true);
    expect(forceExpireConfirmMatches('', 3)).toBe(false);
    expect(forceExpireConfirmMatches('nope', 3)).toBe(false);
    expect(forceExpireConfirmMatches('2', 3)).toBe(false);
  });
});
