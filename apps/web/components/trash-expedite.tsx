'use client';

// DESIGN-010 D-09 — the ADR-014 Expedite (destructive) confirm/report bodies, shared by the
// pending wall's "Expedite all…" pill (report only) and the /library/[id] deletion-schedule
// card's admin-gated "Delete now…" (owner refinement 2026-07-07 — per-item expedite moved OFF
// the wall so a poster tap only ever toggles save⇄slated). Expedite is ALWAYS a Modal (never a
// one-click delete); the confirm copy is keyed to the unit-tested guardian mirror (previewGuardian)
// so it predicts the same deleted / protected / skipped verdict the server enforces.
import { useState } from 'react';
import { Modal } from '@/components/modal';
import { formatBytes } from '@/lib/media';
import { appCodeOf, describeMutationError } from '@/lib/app-error';
import { trpc } from '@/lib/trpc-client';
import {
  expediteErrorAction,
  previewGuardian,
  type GuardianPreviewInput,
} from '@/lib/trash';

/** The minimal item shape the single-item confirm reads (guardian fields + display + size). */
export interface ExpediteConfirmItem extends GuardianPreviewInput {
  title: string;
  year: number | null;
  sizeBytes: number;
}

/** The post-run partition (trash.expediteItem/expediteAll response). */
export interface ExpediteOutcome {
  protectedCount: number;
  expeditedCount: number;
  skippedCount: number;
  /** scope 'all': snapshot ids no longer pending at run time. 0 for scope 'item'. */
  stalePending: number;
}

/**
 * The single-item confirm body — copy keyed to the guardian's predicted verdict (the verdict comes
 * SOLELY from the unit-tested mirror over the item's server-declared fields; the server is still
 * authoritative, so the honest outcome shows in the report).
 */
export function ExpediteItemConfirm({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: ExpediteConfirmItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const verdict = previewGuardian(item);
  const title = `${item.title}${item.year !== null ? ` (${item.year})` : ''}`;
  return (
    <div className="trash-confirm" data-testid="trash-expedite-item-confirm">
      <p>
        Expedite <strong>{title}</strong>
        {item.sizeBytes > 0 ? <> — {formatBytes(item.sizeBytes)} on disk.</> : '.'}
      </p>
      {verdict === 'deletable' ? (
        <p className="alert" role="alert">
          This deletes the files <strong>NOW</strong> — immediate and permanent. It is not the
          scheduled cleanup; there is no undo beyond a re-download via Restore.
        </p>
      ) : verdict === 'unverifiable' ? (
        <p className="status-note status-note--warn">
          This item can’t be verified safe (it isn’t in our ledger), so the server will{' '}
          <strong>keep it</strong> — nothing will be deleted.
        </p>
      ) : (
        <p className="status-note">
          This item is{' '}
          {verdict === 'protected_watched'
            ? 'recently watched'
            : verdict === 'protected_requested'
              ? 'personally requested'
              : 'whitelisted'}{' '}
          — instead of deleting, Maintainerr will <strong>protect it</strong> (auto-whitelist).
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className={`btn ${verdict === 'deletable' ? 'danger' : 'primary'}`}
          data-testid="trash-expedite-item-submit"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'Working…' : verdict === 'deletable' ? 'Delete now' : 'Run it (nothing deletes)'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The post-run report — deleted / protected / skipped are THREE different things (ADR-023
 *  C-07b): skipped means "could not be verified safe, kept", NOT deliberately whitelisted. */
export function ExpediteReport({
  outcome,
  onClose,
}: {
  outcome: ExpediteOutcome;
  onClose: () => void;
}) {
  return (
    <div className="trash-confirm" data-testid="trash-expedite-report">
      <p className="ledger-report__summary" data-testid="trash-expedite-summary">
        <span className={`badge badge--${outcome.expeditedCount > 0 ? 'danger' : 'muted'}`}>
          {outcome.expeditedCount} deleted
        </span>{' '}
        <span className={`badge badge--${outcome.protectedCount > 0 ? 'ok' : 'muted'}`}>
          {outcome.protectedCount} protected
        </span>{' '}
        <span className={`badge badge--${outcome.skippedCount > 0 ? 'warn' : 'muted'}`}>
          {outcome.skippedCount} skipped
        </span>
        {outcome.stalePending > 0 ? (
          <>
            {' '}
            <span className="badge badge--muted" data-testid="trash-expedite-stale-count">
              {outcome.stalePending} no longer pending
            </span>
          </>
        ) : null}
      </p>
      <ul className="ledger-confirm__outcomes">
        <li>
          <strong>Deleted</strong> — handed to Maintainerr’s per-item delete handler; the files are
          being removed now.
        </li>
        <li>
          <strong>Protected</strong> — deliberately kept: recently watched, requested, or
          whitelisted/saved (watched/requested items were auto-whitelisted during this run).
        </li>
        <li>
          <strong>Skipped</strong> — could not be verified safe <em>or</em> its protection could not
          be applied, so it was <em>kept, never deleted</em>. Not the same as protected: these items
          are unknown to the ledger (or unactionable) and are never deleted blind.
        </li>
        {outcome.stalePending > 0 ? (
          <li>
            <strong>No longer pending</strong> — you saw these when you opened the dialog, but
            Maintainerr’s pending set changed before the run, so they were left untouched.
          </li>
        ) : null}
      </ul>
      <div className="form-actions">
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * The /library/[id] deletion-schedule card's "Delete now…" Modal (owner refinement 2026-07-07).
 * Drives trash.expediteItem for a single pending item and renders the confirm → report → calm
 * "nothing deleted" (MAINTAINERR_UNSAFE) states, matching the wall's Expedite discipline (F3 —
 * refetch on every error). Admin/expedite_item-gated by the caller.
 */
export function ItemExpediteModal({
  media,
  item,
  safe,
  onClose,
  onDeleted,
}: {
  media: 'movie' | 'tv';
  item: ExpediteConfirmItem & { collectionId: number; maintainerrMediaId: string };
  safe: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const utils = trpc.useUtils();
  const [outcome, setOutcome] = useState<ExpediteOutcome | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expedite = trpc.trash.expediteItem.useMutation({
    onSuccess: (res: ExpediteOutcome) => {
      setError(null);
      setOutcome(res);
      void utils.trash.pending.invalidate();
      void utils.trash.status.invalidate();
      if (res.expeditedCount > 0) onDeleted?.();
    },
    onError: (err: unknown) => {
      const action = expediteErrorAction(appCodeOf(err), describeMutationError(err));
      void utils.trash.pending.invalidate();
      void utils.trash.status.invalidate();
      setStale(action.stale);
      setError(action.message);
    },
  });

  const close = () => {
    if (!expedite.isPending) onClose();
  };

  return (
    <Modal
      open
      title={outcome !== null ? 'Expedite report' : 'Delete now'}
      onClose={close}
      banner={
        error !== null ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null
      }
    >
      {stale ? (
        <div className="trash-confirm" data-testid="trash-expedite-stale">
          <p>
            <strong>Nothing was deleted.</strong> Maintainerr refused — the item is no longer
            pending, or the install just failed its safety check. The list has been refreshed; check
            the Trash banner and try again from the current list.
          </p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={close}>
              Close
            </button>
          </div>
        </div>
      ) : outcome !== null ? (
        <ExpediteReport outcome={outcome} onClose={close} />
      ) : (
        <ExpediteItemConfirm
          item={item}
          busy={expedite.isPending || !safe}
          onCancel={close}
          onConfirm={() =>
            expedite.mutate({
              media,
              collectionId: item.collectionId,
              maintainerrMediaId: item.maintainerrMediaId,
              mediaItemId: item.mediaItemId,
            })
          }
        />
      )}
    </Modal>
  );
}
