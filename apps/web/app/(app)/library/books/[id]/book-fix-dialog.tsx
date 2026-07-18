'use client';

// ADR-062 / DESIGN-033 D-07 (PLAN-041) — the books Fix control on the detail page. A Fix button
// opens a reason Modal (ADR-014 — explanatory/multi-field, never ConfirmButton/window.confirm):
// the taxonomy radios, a free-text box shown only for `other`, and the HONEST stale-file note
// (v1 re-acquires; the current file stays until quarantined — ADR-062 C-03). On submit the
// button's reserved slot swaps for a fired PhaseChip (searching → fired / failed), no reflow
// (ADR-015). Books have no *arr live meter — "fired" is the honest downstream signal (D-08).
import { useState } from 'react';
import { PhaseChip, MediaAction, ReservedActionSlot } from '@hnet/ui';
import { Modal } from '@/components/modal';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

const REASONS: { value: string; label: string; hint: string }[] = [
  { value: 'wrong_language', label: 'Wrong language', hint: 'e.g. a German copy of an English book' },
  { value: 'corrupt_file', label: "Won't open / corrupt", hint: 'the file is damaged or unreadable' },
  { value: 'wrong_edition', label: 'Wrong edition', hint: 'abridged, wrong translation, wrong version' },
  { value: 'bad_quality', label: 'Bad quality / conversion', hint: 'chapters mangled, one giant page, bad formatting' },
  { value: 'other', label: 'Something else', hint: 'tell us what' },
];

export function BookFixControl({ booksItemId, title }: { booksItemId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('wrong_language');
  const [reasonText, setReasonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const create = trpc.bookFix.create.useMutation({
    onError: (err: unknown) => setError(describeMutationError(err)),
    onSuccess: () => {
      setError(null);
      setOpen(false);
      void utils.bookFix.myFixes.invalidate();
    },
  });

  const fired = create.isSuccess ? create.data : null;

  // ADR-071 — Fix is the shared green primary <MediaAction> everywhere (was the neutral "Fix this"
  // outline button). Once fired, the reserved slot swaps the button for the honest downstream chip
  // (searching/fired/queued/failed) IN PLACE (ADR-015). ADR-067 (PLAN-055): 'queued' is quota
  // weather, not a failure — the fix is saved and the goodreads-sync retry pass fires it
  // automatically. Copy per owner tone: no em-dashes, no jargon.
  const firedChip =
    fired !== null
      ? (() => {
          const failed = fired.status === 'failed';
          const queued = fired.status === 'queued';
          return (
            <PhaseChip
              phase={failed ? 'failed' : queued ? 'queued' : 'fired'}
              label={
                failed
                  ? 'Fix failed'
                  : queued
                    ? 'Fix queued. It will run by itself.'
                    : 'Fix requested. Searching for a replacement'
              }
              tone={failed ? 'danger' : 'info'}
              title={
                failed
                  ? 'The re-grab could not start — try again later'
                  : queued
                    ? 'The book lookup is at its daily limit. Your fix is saved and runs automatically when the limit resets. Nothing else to do.'
                    : 'A replacement is being searched; the current file stays until you quarantine it'
              }
            />
          );
        })()
      : null;

  return (
    <ReservedActionSlot reserve="roll" live={firedChip} testId="book-fix-status">
      <MediaAction
        action="fix"
        testId="book-fix-btn"
        disabled={create.isPending}
        onFire={() => setOpen(true)}
      />
      <Modal
        open={open}
        title={`Fix “${title}”`}
        onClose={() => {
          if (!create.isPending) setOpen(false);
        }}
        banner={
          error !== null ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null
        }
      >
        <form
          className="admin-form"
          data-testid="book-fix-dialog"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              booksItemId,
              reason: reason as 'wrong_language',
              ...(reason === 'other' ? { reasonText: reasonText.trim() } : {}),
            });
          }}
        >
          <p className="muted">
            We’ll search for a better copy and re-acquire it. The current file stays on your shelf
            until it’s quarantined. Ask an admin if it needs removing.
          </p>
          <fieldset className="field">
            <legend>What’s wrong with it?</legend>
            {REASONS.map((r) => (
              <label key={r.value} className="check-row" data-testid={`book-fix-reason-${r.value}`}>
                <input
                  type="radio"
                  name="book-fix-reason"
                  checked={reason === r.value}
                  onChange={() => setReason(r.value)}
                />
                <span>
                  {r.label} <span className="muted">— {r.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {reason === 'other' ? (
            <label className="field">
              <span>Tell us what</span>
              <textarea
                required
                rows={3}
                maxLength={1000}
                data-testid="book-fix-reason-text"
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
              />
            </label>
          ) : null}
          <div className="form-actions">
            <button
              type="submit"
              className="btn primary"
              data-testid="book-fix-submit"
              disabled={create.isPending || (reason === 'other' && reasonText.trim() === '')}
            >
              {create.isPending ? 'Requesting…' : 'Request the fix'}
            </button>
            <button type="button" className="btn" disabled={create.isPending} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </ReservedActionSlot>
  );
}
