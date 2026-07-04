'use client';

// DESIGN-005 D-17 — Force Search dialog: the search-only action for MISSING content
// (not broken, just missing). No reason taxonomy, no blocklist, no delete — a single
// confirm → fix.forceSearch → the owning *arr runs a fresh search for the target.
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { targetToInput, type ActionTarget } from '@/lib/media';
import { Modal } from '@/components/modal';

export interface ForceSearchDialogProps {
  open: boolean;
  onClose: () => void;
  item: { id: string; arrKind: string; title: string };
  /**
   * The scoped target: a single episode/album, a whole season, or the whole show /
   * artist. null ⇒ the movie / legacy whole-series search.
   */
  target?: ActionTarget | null;
  /** Invalidate/refresh hooks after a successful submit. */
  onSubmitted: () => void;
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

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ targetLabel: string | null } | null>(null);

  const search = trpc.fix.forceSearch.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: (result) => {
      setError(null);
      setDone({ targetLabel: result.targetLabel });
      onSubmitted();
    },
  });

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
