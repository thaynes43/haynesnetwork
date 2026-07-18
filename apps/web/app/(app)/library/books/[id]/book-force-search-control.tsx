'use client';

// ADR-071 (media-action UX) — the books FORCE SEARCH control: the outline <MediaAction> beside Fix
// on the books detail page (on-disk ⇒ Fix + Force Search). One click fires `books.forceSearch` (a
// quick re-search that grabs a fresh/better copy, no reason, no durable row), then the reserved slot
// swaps the button for the honest downstream chip IN PLACE (ADR-015). Non-destructive ⇒ a plain
// action button (hard rule 8); books have no *arr live meter, so "Search fired" is the honest signal
// (the pairing-search precedent). Server grant-gated (force_search_book) — the button only mounts
// when `canForceSearch`.
import { useState } from 'react';
import { PhaseChip, MediaAction, ReservedActionSlot } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import { describeMutationError } from '@/lib/app-error';

type FiredState =
  | { kind: 'fired' }
  | { kind: 'noop' }
  | { kind: 'failed'; message: string }
  | null;

export function BookForceSearchControl({ booksItemId }: { booksItemId: string }) {
  const [state, setState] = useState<FiredState>(null);
  const search = trpc.books.forceSearch.useMutation({
    onSuccess: (result) => setState(result.searched ? { kind: 'fired' } : { kind: 'noop' }),
    onError: (error) => setState({ kind: 'failed', message: describeMutationError(error) }),
  });

  let live = null;
  if (search.isPending) {
    live = <PhaseChip phase="searching" label="Searching…" tone="neutral" pulse meter />;
  } else if (state?.kind === 'fired') {
    live = (
      <PhaseChip
        phase="fired"
        label="Search fired"
        tone="info"
        pulse
        meter
        title="A fresh copy is being searched for; the current file stays until it lands."
      />
    );
  } else if (state?.kind === 'noop') {
    live = (
      <PhaseChip
        phase="noop"
        label="Nothing to search"
        tone="warning"
        title="This title has no acquisition record to re-search right now."
      />
    );
  } else if (state?.kind === 'failed') {
    live = <PhaseChip phase="failed" label="Search failed" tone="danger" title={state.message} />;
  }

  return (
    <ReservedActionSlot reserve="roll" live={live} testId="book-force-search">
      <MediaAction
        action="forceSearch"
        testId="book-force-search-btn"
        onFire={() => search.mutate({ booksItemId })}
      />
    </ReservedActionSlot>
  );
}
