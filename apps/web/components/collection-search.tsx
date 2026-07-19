'use client';

// ADR-071 owner ruling 2026-07-19 (DESIGN-035 D-16/D-17 · DESIGN-043 D-07 amendment) — the
// collection-centric "Search Missing" affordance: one control that force-searches EVERY still-missing
// member of a collection. It renders through the sealed @hnet/ui <MediaAction action="forceSearch">
// (the action-anatomy drift guard demands it), in two owner-specified LOOKS off the same registry
// action: a corner magnifier BADGE (grid cards) and a header PILL (the collection drill header). A
// collection-level search is a bulk explanatory action, so firing opens the shared confirm Modal
// (hard rule 8) that states the missing count and what the whole action does — the #418 idiom.
//
// TWO server paths, ONE component (so the badge/pill/copy can't drift between media types):
//  • arr-backed (movies/TV) → `ledger.forceSearchCollection` (the new bulk fan-out over Radarr/Sonarr
//    per-item Force Search, gated exactly as the per-item path);
//  • app-managed (books/audiobooks, librettoRecipeId known) → `collections.forceSearchCollection`
//    (the shipped Libretto/LazyLibrarian on-demand leg, gated by the books force_search_book grant).
import { useState } from 'react';
import { MediaAction } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { Modal } from '@/components/modal';

/** Which collection to search + which server path drives it. */
export type CollectionSearchTarget =
  | { provider: 'arr'; ratingKey: string; arrKind: 'radarr' | 'sonarr' }
  | { provider: 'libretto'; recipeId: string };

interface Outcome {
  searched: number;
  failed: number;
  rateLimited: boolean;
  unreachable: boolean;
}

export function CollectionForceSearch({
  target,
  missingCount,
  noun,
  presentation,
  testId,
  onDone,
}: {
  target: CollectionSearchTarget;
  /** The collection's current missing-member count (for the "N missing" copy); null ⇒ generic copy. */
  missingCount: number | null;
  /** Singular media noun for the copy: 'movie' | 'show' | 'book' | 'audiobook'. */
  noun: string;
  /** `badge` = the corner magnifier puck (grid cards); `pill` = the header Force Search pill. */
  presentation: 'badge' | 'pill';
  testId?: string;
  /** Fired after a successful mutation so the caller can refetch the collection view. */
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const arrM = trpc.ledger.forceSearchCollection.useMutation({
    onSuccess: (res) => {
      setOutcome({
        searched: res.searched,
        failed: res.failed,
        rateLimited: res.rateLimited,
        unreachable: false,
      });
      onDone?.();
    },
  });
  const libM = trpc.collections.forceSearchCollection.useMutation({
    onSuccess: (res) => {
      setOutcome({
        searched: res.searched,
        failed: res.failed,
        rateLimited: false,
        unreachable: res.unreachable,
      });
      onDone?.();
    },
  });
  const active = target.provider === 'arr' ? arrM : libM;

  function fire() {
    setOutcome(null);
    if (target.provider === 'arr') {
      arrM.mutate({ ratingKey: target.ratingKey, arrKind: target.arrKind });
    } else {
      libM.mutate({ recipeId: target.recipeId });
    }
  }

  function close() {
    setOpen(false);
    setOutcome(null);
    active.reset();
  }

  const plural = missingCount === 1 ? '' : 's';
  const countLine =
    missingCount != null && missingCount > 0
      ? `Search for the ${missingCount} missing ${noun}${plural} in this collection now.`
      : `Search for the missing ${noun}s in this collection now.`;

  return (
    <>
      <MediaAction
        action="forceSearch"
        presentation={presentation}
        size={presentation === 'pill' ? 'md' : 'sm'}
        onFire={() => setOpen(true)}
        ariaLabel={
          presentation === 'badge' ? `Search the missing ${noun}s in this collection` : undefined
        }
        testId={testId}
      />
      <Modal
        open={open}
        title={`Search for missing ${noun}s`}
        onClose={close}
        banner={
          active.error ? (
            <p className="alert" role="alert">
              {describeMutationError(active.error)}
            </p>
          ) : null
        }
      >
        <div className="find-missing-confirm" data-testid="collection-search-modal">
          {outcome ? (
            <>
              <p className="fix-done__lead">
                {outcome.unreachable
                  ? 'The collections service was unreachable, so nothing was searched. Try again in a bit.'
                  : outcome.searched > 0
                    ? `Searching for ${outcome.searched} missing ${noun}${outcome.searched === 1 ? '' : 's'} now.`
                    : 'Nothing to search — everything in this collection is already on the shelf.'}
              </p>
              {outcome.rateLimited ? (
                <p className="muted">
                  You hit the hourly search limit, so the rest were left for later.
                </p>
              ) : null}
              {outcome.failed > 0 ? (
                <p className="muted">{outcome.failed} could not be searched and were skipped.</p>
              ) : null}
              <div className="form-actions">
                <button type="button" className="btn primary" onClick={close}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <p>{countLine}</p>
              <p className="muted">
                This searches for the titles that are monitored but not on the shelf yet. Titles
                already on the shelf are left alone.
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn primary"
                  data-testid="collection-search-confirm"
                  disabled={active.isPending}
                  onClick={fire}
                >
                  {active.isPending ? 'Searching…' : 'Search now'}
                </button>
                <button type="button" className="btn" disabled={active.isPending} onClick={close}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
