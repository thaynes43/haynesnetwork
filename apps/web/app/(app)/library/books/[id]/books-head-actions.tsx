'use client';

// ADR-071 / DESIGN-004 D-24 (ADR-062 / DESIGN-033 D-07) — the books detail-head ACTION PAIR: Fix (green
// primary) + Force Search (outline) in ONE reserved slot, mirroring the Movies/TV item-detail ActionSlot
// (item-detail.tsx). Folding the two former per-control slots (BookFixControl + BookForceSearchControl)
// into a single <ReservedActionSlot reserve="head"> removes the ~70-80px void the two side-by-side
// right-aligned 12rem reservations opened between the pills: now one 16rem reservation holds the pair
// flush-right, the only gap between them is the .action-slot{gap:8px} token, and reserved whitespace
// collects to the LEFT of the pair. Fix and Force Search are mutually exclusive in flight — once either
// fires, `live` swaps the WHOLE pair (and the Modal) for that action's honest downstream PhaseChip IN
// PLACE, so neighbours never reflow (ADR-015 / hard rule 9). Fix opens an explanatory reason Modal
// (ADR-014 — never ConfirmButton/window.confirm); Force Search is a one-click non-destructive fire
// (hard rule 8). Books have no *arr live meter, so "fired" is the honest downstream signal (D-08).
import { useState, type ReactNode } from 'react';
import { PhaseChip, MediaAction, MediaActionBar, ReservedActionSlot } from '@hnet/ui';
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

type FiredState =
  | { kind: 'fired' }
  | { kind: 'noop' }
  | { kind: 'failed'; message: string }
  | null;

export function BooksHeadActions({
  booksItemId,
  title,
  canFix,
  canForceSearch,
}: {
  booksItemId: string;
  title: string;
  canFix: boolean;
  canForceSearch: boolean;
}) {
  // FORCE SEARCH — a one-click quick re-search (books.forceSearch); the slot swaps the pair for the
  // honest downstream chip IN PLACE (ADR-015). Books have no *arr live meter, so "Search fired" is
  // the honest signal (the pairing-search precedent).
  const [searchState, setSearchState] = useState<FiredState>(null);
  const forceSearch = trpc.books.forceSearch.useMutation({
    onSuccess: (result) => setSearchState(result.searched ? { kind: 'fired' } : { kind: 'noop' }),
    onError: (error) => setSearchState({ kind: 'failed', message: describeMutationError(error) }),
  });

  let searchLive: ReactNode = null;
  if (forceSearch.isPending) {
    searchLive = <PhaseChip phase="searching" label="Searching…" tone="neutral" pulse meter />;
  } else if (searchState?.kind === 'fired') {
    searchLive = (
      <PhaseChip
        phase="fired"
        label="Search fired"
        tone="info"
        pulse
        meter
        title="A fresh copy is being searched for; the current file stays until it lands."
      />
    );
  } else if (searchState?.kind === 'noop') {
    searchLive = (
      <PhaseChip
        phase="noop"
        label="Nothing to search"
        tone="warning"
        title="This title has no acquisition record to re-search right now."
      />
    );
  } else if (searchState?.kind === 'failed') {
    searchLive = (
      <PhaseChip phase="failed" label="Search failed" tone="danger" title={searchState.message} />
    );
  }

  // FIX — the reasoned, durable repair (bookFix.create) behind an explanatory reason Modal (ADR-014).
  // On submit the reserved slot swaps the pair for the honest downstream chip (searching/queued/failed).
  // ADR-067: 'queued' is quota weather, not a failure — the fix is saved and the retry pass fires it.
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('wrong_language');
  const [reasonText, setReasonText] = useState('');
  const [fixError, setFixError] = useState<string | null>(null);
  const utils = trpc.useUtils();

  const create = trpc.bookFix.create.useMutation({
    onError: (err: unknown) => setFixError(describeMutationError(err)),
    onSuccess: () => {
      setFixError(null);
      setOpen(false);
      void utils.bookFix.myFixes.invalidate();
    },
  });

  const fired = create.isSuccess ? create.data : null;
  let fixLive: ReactNode = null;
  if (fired !== null) {
    const failed = fired.status === 'failed';
    const queued = fired.status === 'queued';
    fixLive = (
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
  }

  // Mutually exclusive in flight: whichever action fired owns the ONE reserved slot.
  const live = fixLive ?? searchLive ?? null;

  return (
    <MediaActionBar placement="head">
      <ReservedActionSlot reserve="head" live={live} testId="books-head-actions">
        {canFix ? (
          <MediaAction
            action="fix"
            testId="book-fix-btn"
            disabled={create.isPending}
            onFire={() => setOpen(true)}
          />
        ) : null}
        {canForceSearch ? (
          <MediaAction
            action="forceSearch"
            testId="book-force-search-btn"
            onFire={() => forceSearch.mutate({ booksItemId })}
          />
        ) : null}
        <Modal
          open={open}
          title={`Fix “${title}”`}
          onClose={() => {
            if (!create.isPending) setOpen(false);
          }}
          banner={
            fixError !== null ? (
              <p className="alert" role="alert">
                {fixError}
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
    </MediaActionBar>
  );
}
