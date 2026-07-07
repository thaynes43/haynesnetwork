'use client';

// DESIGN-005 D-17 — Force Search dialog: the search-only action for MISSING content
// (not broken, just missing). No reason taxonomy, no blocklist, no delete — a single
// confirm → fix.forceSearch → then the ADR-028 / D-20 LIVE progress view: the dialog
// polls fix.searchProgress (anchored on the search_requested event) and walks
// searching → found-something → downloading% → completed, or lands the honest
// nothing_found terminal with a "Search again" retry. Season/artist scopes expand a
// per-child roll-up (D-21).
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { targetToInput, type ActionTarget, type ArrKindName } from '@/lib/media';
import { Modal } from '@/components/modal';
import {
  ActionProgressBlock,
  useActionProgress,
  type SearchProgressInput,
} from '@/components/action-progress';

export interface ForceSearchDialogProps {
  open: boolean;
  onClose: () => void;
  item: { id: string; arrKind: string; title: string };
  /**
   * The scoped target: a single episode/album, a whole season, or the whole show /
   * artist. null ⇒ the movie / legacy whole-series search.
   */
  target?: ActionTarget | null;
  /**
   * Invalidate/refresh hooks after a successful submit. Receives the submitted grain
   * so the item view can lock that slot behind the live chip (D-21).
   */
  onSubmitted: (search: { input: SearchProgressInput; label: string }) => void;
}

export function ForceSearchDialog({
  open,
  onClose,
  item,
  target,
  onSubmitted,
}: ForceSearchDialogProps) {
  const preselected = target ?? null;
  const what = preselected !== null ? preselected.label : item.title;

  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ input: SearchProgressInput } | null>(null);

  const search = trpc.fix.forceSearch.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: (_result, variables) => {
      setError(null);
      const input: SearchProgressInput = {
        mediaItemId: variables.mediaItemId,
        scope: variables.scope,
        targetChildId: variables.targetChildId,
        seasonNumber: variables.seasonNumber,
      };
      setDone({ input });
      // A retry lands while the previous poll is STOPPED on its terminal — invalidate
      // so the fresh anchor is fetched and the non-terminal phase re-arms the interval.
      void utils.fix.searchProgress.invalidate();
      onSubmitted({ input, label: what });
    },
  });

  // A retry re-issues the SAME grain: the latest search_requested event becomes the
  // fresh anchor, so the ongoing poll simply picks the new window up — no source swap.
  const live = useActionProgress(open && done !== null ? { kind: 'search', input: done.input } : null);

  function reset() {
    setError(null);
    setDone(null);
  }

  function close() {
    reset();
    onClose();
  }

  function submit() {
    setError(null);
    search.mutate({ mediaItemId: item.id, ...targetToInput(preselected) });
  }

  return (
    <Modal open={open} title={`Force search ${item.title}`} onClose={close}>
      {done ? (
        <div className="fix-done">
          <p className="fix-done__lead">
            A fresh search is running — the manager will grab {what} as soon as a release is
            found.
          </p>
          <p className="muted">Nothing was blocklisted or deleted — this was a search only.</p>
          <ActionProgressBlock
            progress={live.progress}
            pending={live.pending}
            checkFailed={live.checkFailed}
            kind={item.arrKind as ArrKindName}
            onRetry={() => search.mutate({ ...done.input })}
            retryLabel="Search again"
            retryPending={search.isPending}
          />
          <p className="muted">
            You can close this — the live status stays on the item until it finishes.
          </p>
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="fix-done">
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}
          <p className="fix-done__lead">
            Force a fresh search for <strong>{what}</strong>?
          </p>
          <p className="muted">
            This is for content that is simply missing — no release is blocklisted and no file
            is removed.
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="btn primary"
              disabled={search.isPending}
              onClick={submit}
            >
              {search.isPending ? 'Searching…' : 'Force search'}
            </button>
            <button type="button" className="btn" disabled={search.isPending} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
