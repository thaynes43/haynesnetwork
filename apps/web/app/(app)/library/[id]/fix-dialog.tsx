'use client';

// DESIGN-005 D-15 / R-43..R-45 — the Fix dialog: episode/album target picker (live
// children via ledger.children, D-06), the mandatory reason taxonomy (free text only
// on Other), submit → fix.create → status feedback (path taken).
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import { FIX_REASON_LABELS, targetToInput, type ActionTarget } from '@/lib/media';
import { Modal } from '@/components/modal';

const REASONS = [
  'wont_play_corrupt',
  'wrong_language',
  'wrong_version_quality',
  'missing_subtitles',
  'wrong_content',
  'other',
] as const;
type Reason = (typeof REASONS)[number];

export interface FixDialogProps {
  open: boolean;
  onClose: () => void;
  item: { id: string; arrKind: string; title: string };
  /**
   * The scoped target already chosen (per-episode / per-album / whole-season Fix from
   * the detail list). When present the picker is skipped and the scope is carried into
   * fix.create. null ⇒ the radarr movie (item scope).
   */
  target?: ActionTarget | null;
  /** Invalidate/refresh hooks after a successful submit. */
  onSubmitted: () => void;
}

export function FixDialog({ open, onClose, item, target, onSubmitted }: FixDialogProps) {
  const needsTarget = item.arrKind === 'sonarr' || item.arrKind === 'lidarr';
  const targetNoun = item.arrKind === 'sonarr' ? 'episode' : 'album';
  const preselected = target ?? null;

  const [targetChildId, setTargetChildId] = useState<number | ''>('');
  const [reason, setReason] = useState<Reason>('wont_play_corrupt');
  const [reasonText, setReasonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ pathTaken: string; targetLabel: string | null } | null>(null);

  // Only fetch the live picker when we need a target AND one wasn't handed in.
  const children = trpc.ledger.children.useQuery(
    { mediaItemId: item.id },
    { enabled: open && needsTarget && preselected === null },
  );
  const create = trpc.fix.create.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: (result) => {
      setError(null);
      setDone({ pathTaken: result.pathTaken, targetLabel: result.targetLabel });
      onSubmitted();
    },
  });

  function reset() {
    setTargetChildId('');
    setReason('wont_play_corrupt');
    setReasonText('');
    setError(null);
    setDone(null);
  }

  function close() {
    reset();
    onClose();
  }

  function submit() {
    setError(null);
    // The preselected scope (episode/album/season/item) drives the mutation; the picker
    // is the fallback for a bare sonarr/lidarr Fix and always resolves to a single child.
    let scopeInput: ReturnType<typeof targetToInput>;
    if (preselected !== null) {
      scopeInput = targetToInput(preselected);
    } else if (needsTarget) {
      if (targetChildId === '') {
        setError(`Pick the ${targetNoun} that needs fixing first.`);
        return;
      }
      scopeInput = {
        scope: item.arrKind === 'sonarr' ? 'episode' : 'album',
        targetChildId,
      };
    } else {
      scopeInput = {}; // radarr movie (item scope)
    }
    if (reason === 'other' && reasonText.trim() === '') {
      setError('Tell us what is wrong — the Other reason needs a few words.');
      return;
    }
    create.mutate({
      mediaItemId: item.id,
      ...scopeInput,
      reason,
      ...(reason === 'other' ? { reasonText: reasonText.trim() } : {}),
    });
  }

  return (
    <Modal
      open={open}
      title={`Fix ${item.title}`}
      onClose={close}
      // Errors ride a pinned aria-live slot above the scrolling body so the alert never
      // squeezes the reason list into a cut-off scrollbox (owner UX nitpick).
      banner={error ? <p className="alert">{error}</p> : null}
    >
      {done ? (
        <div className="fix-done">
          <p className="fix-done__lead">
            {done.pathTaken === 'blocklist_search'
              ? 'The bad release was blocklisted and a search for a replacement is running.'
              : 'The file was removed and a search for a replacement is running.'}
          </p>
          {done.targetLabel ? <p className="muted">Target: {done.targetLabel}</p> : null}
          <p className="muted">
            Track progress under Library → My Fixes — it completes when the new copy imports.
          </p>
          <div className="form-actions">
            <button type="button" className="btn primary" onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="admin-form fix-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {needsTarget && preselected !== null ? (
            <p className="fix-target">
              Fixing <strong>{preselected.label}</strong>
            </p>
          ) : null}

          {needsTarget && preselected === null ? (
            <label className="field">
              <span>Which {targetNoun}?</span>
              {children.isLoading ? (
                <span className="muted">Loading {targetNoun}s…</span>
              ) : children.error ? (
                <span className="field-error">
                  Could not load the {targetNoun} list: {children.error.message}
                </span>
              ) : (
                <select
                  required
                  value={targetChildId}
                  onChange={(e) =>
                    setTargetChildId(e.target.value === '' ? '' : Number(e.target.value))
                  }
                >
                  <option value="">Select a {targetNoun}…</option>
                  {(children.data ?? []).map((child) => (
                    <option key={child.arrChildId} value={child.arrChildId}>
                      {child.label}
                      {child.hasFile ? '' : ' (not on disk)'}
                    </option>
                  ))}
                </select>
              )}
            </label>
          ) : null}

          <fieldset className="field">
            <legend>What is wrong? (required)</legend>
            <ul className="check-list">
              {REASONS.map((value) => (
                <li key={value}>
                  <label className="check-row">
                    <input
                      type="radio"
                      name="fix-reason"
                      value={value}
                      checked={reason === value}
                      onChange={() => setReason(value)}
                    />
                    <span>{FIX_REASON_LABELS[value]}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>

          {reason === 'other' ? (
            <label className="field">
              <span>Tell us more</span>
              <textarea
                required
                maxLength={500}
                rows={3}
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder="What exactly is broken?"
              />
            </label>
          ) : null}

          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={create.isPending}>
              {create.isPending ? 'Submitting…' : 'Submit fix'}
            </button>
            <button type="button" className="btn" disabled={create.isPending} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
