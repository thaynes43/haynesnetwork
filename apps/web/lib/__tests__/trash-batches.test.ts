// ADR-025 / DESIGN-011 D-07 (ADR-033 unification) — unit coverage for the poster wall's
// safety-critical client rules: the glyph language (trash/shield/check/skip/gone — the eye AND the
// requester person-shield were both retired from the corner 2026-07-09; requested is informational
// only now), the phase-and-grant tap permissions (mirrors the server's setItemSaved gate), the
// running header counts (must agree with the glyphs), and the Expire report rows
// (raceSkipped/aborted semantics surfaced honestly).
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
  wallSection,
  PROJECTED_SKIP_MEANING,
  WALL_GLYPH_MEANING,
  type TargetCandidate,
  type WallGlyph,
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

describe('wallGlyph — the overlay language (ADR-033 unified: trash/shield/check/skip/gone)', () => {
  it('maps each item state to its glyph; a pending item is always the saveable trash-can', () => {
    expect(wallGlyph('pending')).toBe('trash');
    expect(wallGlyph('saved')).toBe('shield');
    expect(wallGlyph('protected')).toBe('check');
    expect(wallGlyph('skipped')).toBe('skip');
    expect(wallGlyph('deleted')).toBe('gone');
  });

  it('the glyph depends ONLY on state — recently-watched and requesters are meta-line info, not corner glyphs', () => {
    // The eye (2026-07-09) AND the requester person-shield (owner ruling 2026-07-09 — requested is
    // informational only) were BOTH retired from the corner. Neither is a glyph input any more: a
    // pending watched/requested item is the plain slated trash-can (the sweep-time guardian still keeps
    // a recently-watched item); the watch + requester facts ride the meta line. wallGlyph takes only the
    // state — there is nowhere left to pass them, so a requester can never win a `requested` glyph.
    expect(wallGlyph('pending')).toBe('trash');
    expect(wallGlyph('saved')).toBe('shield'); // always a human rescue now (no system auto-saves)
  });
});

describe('wallGlyph — the pool projection (DESIGN-011 D-07 amendment (b) 2026-09-19)', () => {
  it('a pending item KNOWN to have left the live pool reads as the inert skip', () => {
    expect(wallGlyph('pending', false)).toBe('skip');
  });

  it('present (true) and unknown (null / omitted) both read as slated — the conservative side', () => {
    // `null` is a stale/missing trash_candidates state row or an item with no Maintainerr id. The
    // projection is only ever allowed to move a tile toward KEPT on a positive answer.
    expect(wallGlyph('pending', true)).toBe('trash');
    expect(wallGlyph('pending', null)).toBe('trash');
    expect(wallGlyph('pending')).toBe('trash');
  });

  it('the projection touches ONLY pending rows — every other state is unchanged by it', () => {
    for (const pool of [true, false, null] as const) {
      expect(wallGlyph('saved', pool)).toBe('shield');
      expect(wallGlyph('protected', pool)).toBe('check');
      expect(wallGlyph('skipped', pool)).toBe('skip');
      expect(wallGlyph('deleted', pool)).toBe('gone');
    }
  });

  it('a projected skip announces a DIFFERENT fact from a row the sweep actually skipped', () => {
    expect(PROJECTED_SKIP_MEANING).toBe(
      'is not in the trash pool right now, so it will not be deleted',
    );
    expect(WALL_GLYPH_MEANING.skip).toBe('kept — could not be verified safe, never deleted');
    expect(PROJECTED_SKIP_MEANING).not.toBe(WALL_GLYPH_MEANING.skip);
  });

  it('a projected skip is INERT, exactly like any other skip (nothing honest a tap could do)', () => {
    const admin = ctx({ canManage: true, canSaveWindow: true });
    expect(tileTappable(admin, wallGlyph('pending', false), null)).toBe(false);
    // …while the same row with an unknown/present pool answer stays the saveable trash-can.
    expect(tileTappable(admin, wallGlyph('pending', null), null)).toBe(true);
  });
});

describe('wallSection — the load-time grouping (amendment (a))', () => {
  it('maps every glyph to its stacked group', () => {
    expect(wallSection('trash')).toBe('slated');
    expect(wallSection('shield')).toBe('rescued');
    expect(wallSection('check')).toBe('kept');
    expect(wallSection('skip')).toBe('kept');
    // `gone` is terminal-only (the Past-batches wall stays one grid); folded in with `trash` so the
    // mapping is total. It is never reached by a rendered section.
    expect(wallSection('gone')).toBe('slated');
  });

  it('is total over WallGlyph — every glyph has a home', () => {
    const glyphs: WallGlyph[] = ['trash', 'shield', 'check', 'skip', 'gone'];
    for (const g of glyphs) {
      expect(['slated', 'rescued', 'kept']).toContain(wallSection(g));
    }
  });

  it('a projected skip lands in Kept, not in the slated grid', () => {
    expect(wallSection(wallGlyph('pending', false))).toBe('kept');
    expect(wallSection(wallGlyph('pending', true))).toBe('slated');
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
});

describe('wallCounts — the running header agrees with the glyphs', () => {
  it('partitions slated/rescued/kept/deleted and sums slated bytes only', () => {
    // The glyph (and so the count bucket) depends only on state now — a requester or a recently-watched
    // signal on a pending item is still the slated trash-can (informational only).
    const counts = wallCounts([
      { state: 'pending', sizeBytes: 100 }, // trash → slated
      { state: 'pending', sizeBytes: 50 }, // trash → slated
      { state: 'pending', sizeBytes: 999 }, // trash → slated (recently-watched: kept at the sweep, still slated on the wall)
      { state: 'pending', sizeBytes: 42 }, // trash → slated (requested is informational only now)
      { state: 'saved', sizeBytes: 10 }, // shield (human rescue) → rescued
      { state: 'saved', sizeBytes: 8 }, // shield (human rescue) → rescued
      { state: 'protected', sizeBytes: 1 }, // check → kept
      { state: 'skipped', sizeBytes: 2 }, // skip → kept
      { state: 'deleted', sizeBytes: 3 }, // gone
    ]);
    expect(counts).toEqual({
      slated: 4,
      slatedBytes: 1191,
      rescued: 2, // both saves are ordinary human rescues now (no system auto-saves)
      kept: 2, // check + skip
      deleted: 1,
    });
  });

  it('a projected tile counts under kept and its bytes LEAVE frees (amendment (c) — honest numbers)', () => {
    // The owner-reported dishonesty: "Deleting 44 · frees 1.2 TB" while 15 of the 44 had already
    // left the live pool and were certain to be skipped.
    const counts = wallCounts([
      { state: 'pending', sizeBytes: 100, inLivePool: true }, // trash → slated
      { state: 'pending', sizeBytes: 50, inLivePool: null }, // unknown → still slated
      { state: 'pending', sizeBytes: 7 }, // omitted ⇒ unknown → still slated
      { state: 'pending', sizeBytes: 900, inLivePool: false }, // projected skip → kept, bytes excluded
      { state: 'pending', sizeBytes: 800, inLivePool: false }, // projected skip → kept, bytes excluded
      { state: 'saved', sizeBytes: 10, inLivePool: false }, // a save is a save — pool is irrelevant
      { state: 'protected', sizeBytes: 1, inLivePool: false },
    ]);
    expect(counts).toEqual({
      slated: 3,
      slatedBytes: 157, // 100 + 50 + 7 — the 1.7 GB of projected tiles never enters `frees`
      rescued: 1,
      kept: 3, // 2 projected + 1 protected
      deleted: 0,
    });
  });

  it('keeps the standing ruling: a recently-watched pending item still counts as SLATED', () => {
    // Owner ruling 2026-07-09, re-affirmed by the 2026-09-19 amendment (c). The watch guardian acts
    // at the SWEEP; the wall corner is the action, and the modal's "up to N" covers the difference.
    // wallCounts has no watch input at all — there is nowhere to smuggle one in.
    const counts = wallCounts([{ state: 'pending', sizeBytes: 999, inLivePool: true }]);
    expect(counts.slated).toBe(1);
    expect(counts.slatedBytes).toBe(999);
    expect(counts.kept).toBe(0);
  });

  it('the header can never disagree with the tiles — both go through wallGlyph on the same inputs', () => {
    const rows = [
      { state: 'pending' as const, sizeBytes: 5, inLivePool: false },
      { state: 'pending' as const, sizeBytes: 6, inLivePool: true },
      { state: 'saved' as const, sizeBytes: 7, inLivePool: null },
    ];
    const bySection = rows.map((r) => wallSection(wallGlyph(r.state, r.inLivePool)));
    const counts = wallCounts(rows);
    expect(bySection.filter((s) => s === 'slated')).toHaveLength(counts.slated);
    expect(bySection.filter((s) => s === 'rescued')).toHaveLength(counts.rescued);
    expect(bySection.filter((s) => s === 'kept')).toHaveLength(counts.kept);
  });
});

describe('countdownCopy — the family banner (DESIGN-011 amendment: honest next-sweep time)', () => {
  it('invites the tap while the window is open, naming the concrete sweep time', () => {
    expect(
      countdownCopy({
        whenLabel: 'today 11:04 PM',
        sweepLabel: '11:45 PM',
        windowOpen: true,
        canSave: true,
      }),
    ).toBe('window closes today 11:04 PM · deletes at the 11:45 PM sweep — tap anything you want to keep');
  });
  it('drops the invitation for read-only viewers but still names the sweep', () => {
    expect(
      countdownCopy({
        whenLabel: 'Jul 21',
        sweepLabel: '11:45 PM',
        windowOpen: true,
        canSave: false,
      }),
    ).toBe('window closes Jul 21 · deletes at the 11:45 PM sweep');
  });
  it('the closed window names the actual sweep time, not a vague "the next sweep"', () => {
    expect(
      countdownCopy({
        whenLabel: 'today 11:04 PM',
        sweepLabel: '11:45 PM',
        windowOpen: false,
        canSave: true,
      }),
    ).toBe('window closed — deletes at 11:45 PM');
  });
  it('falls back to the old vague copy only when the sweep time cannot be computed', () => {
    expect(
      countdownCopy({ whenLabel: 'today', sweepLabel: null, windowOpen: false, canSave: true }),
    ).toBe('The save window has closed — the remaining items delete on the next sweep.');
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

  it('ADR-093 D-08 — a watchlisted candidate takes no slot in a targeted pick, yet an untargeted batch snapshots it', () => {
    const listed = [c(4e9, { onWatchlist: true }), c(3e9), c(2e9, { protectedByTag: true }), c(1e9)];
    expect(previewTargetSelection(listed, {})).toMatchObject({ count: 3, bytes: 8e9, poolCount: 2, poolBytes: 4e9 });
    expect(previewTargetSelection(listed, { maxItems: 1, strategy: 'largest' })).toMatchObject({ count: 1, bytes: 3e9 });
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
