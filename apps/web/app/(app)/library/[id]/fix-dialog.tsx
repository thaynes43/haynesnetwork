'use client';

// DESIGN-005 D-15 / R-43..R-45 — the Fix dialog: episode/album target picker (live
// children via ledger.children, D-06), the mandatory reason taxonomy (free text only
// on Other), submit → fix.create → then the ADR-028 / D-20 LIVE progress view: the
// dialog polls fix.progress and walks the user through
// searching → queued → downloading% → importing → completed (or an honest
// nothing_found / stalled / failed terminal with a retry) instead of a static
// "a search is running" line. Closing the dialog is safe — the same state lives on
// the item's action slot (D-21).
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';
import {
  FIX_REASON_LABELS,
  fixReasonsForKind,
  targetToInput,
  type ActionTarget,
  type ArrKindName,
  type FixReasonName,
} from '@/lib/media';
import { Modal } from '@/components/modal';
import {
  ActionProgressBlock,
  useActionProgress,
  type ProgressSource,
  type SearchProgressInput,
} from '@/components/action-progress';

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

interface DoneState {
  fixRequestId: string;
  pathTaken: string;
  targetLabel: string | null;
  /** The grain submitted — the "Search again" retry re-issues a search on it. */
  searchInput: SearchProgressInput;
}

export function FixDialog({ open, onClose, item, target, onSubmitted }: FixDialogProps) {
  const needsTarget = item.arrKind === 'sonarr' || item.arrKind === 'lidarr';
  const targetNoun = item.arrKind === 'sonarr' ? 'episode' : 'album';
  const preselected = target ?? null;
  // ADR-016 / D-19: the reason set is fixed by kind at dialog-open (Music excludes
  // 'missing_subtitles' — Bazarr covers movies/TV only). It never changes on interaction,
  // so no reflow-on-interaction (ADR-015 / hard rule 9).
  const reasons = fixReasonsForKind(item.arrKind as ArrKindName);

  const [targetChildId, setTargetChildId] = useState<number | ''>('');
  const [reason, setReason] = useState<FixReasonName>('wont_play_corrupt');
  const [reasonText, setReasonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DoneState | null>(null);
  // After a retry the live anchor is the NEW search event, not the old fix row
  // (whose found-nothing window already elapsed) — so the poll source swaps.
  const [retried, setRetried] = useState(false);

  // Only fetch the live picker when we need a target AND one wasn't handed in.
  const children = trpc.ledger.children.useQuery(
    { mediaItemId: item.id },
    { enabled: open && needsTarget && preselected === null },
  );
  const create = trpc.fix.create.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: (result, variables) => {
      setError(null);
      setDone({
        fixRequestId: result.id,
        pathTaken: result.pathTaken,
        targetLabel: result.targetLabel,
        searchInput: {
          mediaItemId: variables.mediaItemId,
          scope: variables.scope,
          targetChildId: variables.targetChildId,
          seasonNumber: variables.seasonNumber,
        },
      });
      onSubmitted();
    },
  });
  const utils = trpc.useUtils();
  const retrySearch = trpc.fix.forceSearch.useMutation({
    onError: (err) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      setRetried(true);
      // The retry may reuse a search query that already stopped on a terminal —
      // invalidate so the fresh anchor is fetched and polling re-arms.
      void utils.fix.searchProgress.invalidate();
      onSubmitted();
    },
  });

  // Bazarr subtitle fixes have no *arr queue/import to watch — they keep the
  // static fire-and-forget copy (mirrors the completeFixRequests exclusion).
  const isSubtitlePath = done?.pathTaken === 'bazarr_subtitle';
  const source: ProgressSource | null =
    open && done !== null && !isSubtitlePath
      ? retried
        ? { kind: 'search', input: done.searchInput }
        : { kind: 'fix', fixRequestId: done.fixRequestId }
      : null;
  const live = useActionProgress(source, { onTerminal: () => onSubmitted() });

  function reset() {
    setTargetChildId('');
    setReason('wont_play_corrupt');
    setReasonText('');
    setError(null);
    setDone(null);
    setRetried(false);
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
            {done.pathTaken === 'bazarr_subtitle'
              ? 'Bazarr is searching for and downloading subtitles — the media file itself is untouched.'
              : done.pathTaken === 'blocklist_search'
                ? 'The bad release was blocklisted and a search for a replacement is running.'
                : 'The file was removed and a search for a replacement is running.'}
          </p>
          {done.targetLabel ? <p className="muted">Target: {done.targetLabel}</p> : null}
          {isSubtitlePath ? (
            <p className="muted">
              Subtitle downloads finish on their own — nothing else to watch here.
            </p>
          ) : (
            <>
              <ActionProgressBlock
                progress={live.progress}
                pending={live.pending}
                checkFailed={live.checkFailed}
                kind={item.arrKind as ArrKindName}
                onRetry={() => retrySearch.mutate({ ...done.searchInput })}
                retryLabel="Search again"
                retryPending={retrySearch.isPending}
              />
              <p className="muted">
                You can close this — the live status stays on the item and under Library → My
                Fixes.
              </p>
            </>
          )}
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
              {reasons.map((value) => (
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
