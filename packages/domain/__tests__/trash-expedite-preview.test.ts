// ADR-086 D-11 / DESIGN-048 D-06 — the Expedite-all PREVIEW must partition exactly the way the
// server's own guardian will. Three hand-synced copies of that rule existed and had drifted: the
// server preview (`partitionPendingForExpedite`) still counted `requesters.length > 0` as
// `protected` long after the 2026-07-09 owner ruling made a requester informational and
// `classifyGuardian` started DELETING requested items. `trash-client.tsx` feeds the Expedite-all
// confirm from that server preview, so the confirm UNDERSTATED what a run would delete — a consent
// bug (latent only because no pool item currently carries a requester).
//
// The fix collapses the two server copies onto ONE derivation (`classifyForExpedite` =
// `classifyGuardian` + the 'all' loop's unactionable pre-check). These tests pin that derivation and
// prove the preview is now built from it. The remaining mirror — the client `previewGuardian`, which
// cannot import @hnet/domain — is pinned by apps/web/lib/__tests__/trash.test.ts.
import { describe, expect, it } from 'vitest';
import {
  classifyForExpedite,
  classifyGuardian,
  partitionPendingForExpedite,
  type TrashPendingItem,
} from '../src/index';

/** A cold, fully-evaluated pending movie — the deletable baseline every case varies from. */
function pendingItem(over: Partial<TrashPendingItem> = {}): TrashPendingItem {
  return {
    maintainerrMediaId: 'ms-1',
    collectionId: 1,
    collectionTitle: 'Movies leaving soon',
    tmdbId: 1,
    tvdbId: null,
    sizeBytes: 1_000,
    addedToCollectionAt: '2026-06-01T00:00:00Z',
    deleteAfterDays: 30,
    scheduledDeleteAt: '2026-07-01T00:00:00Z',
    mediaItemId: 'uuid-1',
    title: 'Cold Movie',
    year: 2011,
    arrKind: 'radarr',
    arrTags: [],
    protectedByTag: false,
    protectedByExclusion: false,
    recentlyWatched: false,
    lastViewedAt: null,
    lastWatchedAt: null,
    lastWatchedServer: null,
    requesters: [],
    sourceCollections: [],
    posterSource: null,
    genres: [],
    resolution: null,
    imdbRating: null,
    tmdbRating: null,
    ...over,
  };
}

describe('classifyForExpedite (the ONE shared derivation — ADR-086 D-11)', () => {
  it('cold + resolved to our ledger ⇒ deletable', () => {
    expect(classifyForExpedite(pendingItem())).toBe('deletable');
  });

  it('no Maintainerr id ⇒ unverifiable BEFORE any protection check (the all-loop order)', () => {
    // The expedite 'all' loop skips unactionable items before the guardian ever runs, so this must
    // win even over the dnd tag.
    expect(
      classifyForExpedite(pendingItem({ maintainerrMediaId: null, protectedByTag: true })),
    ).toBe('unverifiable');
  });

  it('the dnd tag ⇒ protected_tag (unchanged keep-signal — ADR-086 D-6)', () => {
    expect(classifyForExpedite(pendingItem({ protectedByTag: true }))).toBe('protected_tag');
  });

  it('recently watched ⇒ protected_watched', () => {
    expect(classifyForExpedite(pendingItem({ recentlyWatched: true }))).toBe('protected_watched');
  });

  it('unknown to our ledger ⇒ unverifiable (kept, but SKIPPED — not whitelisted)', () => {
    expect(classifyForExpedite(pendingItem({ mediaItemId: null }))).toBe('unverifiable');
  });

  it('THE D-11 FIX — a requester is NOT a keep; a requested cold item is DELETABLE', () => {
    // Owner ruling 2026-07-09: "Maintainerr rules decide what gets promoted; the app controls how
    // much and when it's deleted." classifyGuardian has deleted requested items since; the preview
    // said `protected`. Both must now agree.
    const requested = pendingItem({ requesters: ['manofoz'] });
    expect(classifyForExpedite(requested)).toBe('deletable');
    expect(classifyGuardian(requested)).toEqual({ keep: false });
  });

  it('never disagrees with classifyGuardian on an actionable item (it composes it)', () => {
    for (const protectedByTag of [false, true]) {
      for (const recentlyWatched of [false, true]) {
        for (const mediaItemId of ['uuid-1', null]) {
          for (const requesters of [[], ['manofoz']]) {
            const item = pendingItem({ protectedByTag, recentlyWatched, mediaItemId, requesters });
            const verdict = classifyForExpedite(item);
            expect({ ...item, kept: verdict !== 'deletable' }).toEqual({
              ...item,
              kept: classifyGuardian(item).keep,
            });
          }
        }
      }
    }
  });
});

describe('partitionPendingForExpedite (the server preview the confirm consumes)', () => {
  it('splits deleted-now / protected / unverifiable and sums only deletable bytes', () => {
    expect(
      partitionPendingForExpedite([
        pendingItem({ sizeBytes: 100 }), // deletable
        pendingItem({ recentlyWatched: true, sizeBytes: 10 }), // protected
        pendingItem({ protectedByTag: true, sizeBytes: 10 }), // protected
        pendingItem({ mediaItemId: null, sizeBytes: 10 }), // unverifiable (skipped)
        pendingItem({ maintainerrMediaId: null, sizeBytes: 10 }), // unverifiable (unactionable)
      ]),
    ).toEqual({ deletable: 1, deletableBytes: 100, protected: 2, unverifiable: 2 });
  });

  it('ADR-086 D-11 regression — a requested item counts as DELETABLE, not protected', () => {
    // Pre-fix this returned { deletable: 0, protected: 1 } and the Expedite-all confirm told the
    // owner nothing would be deleted while the server went on to delete it.
    expect(
      partitionPendingForExpedite([pendingItem({ requesters: ['manofoz'], sizeBytes: 500 })]),
    ).toEqual({ deletable: 1, deletableBytes: 500, protected: 0, unverifiable: 0 });
  });
});
