'use client';

// ADR-056/ADR-057 / DESIGN-029 (PLAN-045) — the shared book-request FORCE-SEARCH control: the one
// button both the Goodreads items wall and the Library composed-Wanted tiles render. It calls the
// dispatching `integrations.search` mutation (comic → Kapowarr auto_search; book/audio → LL
// searchBook — ADR-056 C-04, audited server-side) and gives PLAN-015-style live feedback in a
// RESERVED fixed-height slot (ADR-015): idle button → "Searching…" (pending) → a pulsing
// "Search fired — <target>" phase chip (or the honest no-op/error copy). Non-destructive ⇒ a plain
// `.btn.sm`, NEVER a ConfirmButton (hard rule 8 is for destructive actions).
import { useState } from 'react';
import { PhaseChip } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';

type Fired =
  | { kind: 'fired'; target: 'kapowarr' | 'lazylibrarian'; formats: string[] }
  | { kind: 'noop'; reason: string }
  | { kind: 'failed'; message: string };

const FORMAT_LABELS: Record<string, string> = { ebook: 'Ebook', audiobook: 'Audio' };

/** Compact chip copy (the slot is a poster-tile column); the formats detail rides the title. */
function firedLabel(fired: Extract<Fired, { kind: 'fired' }>): string {
  return fired.target === 'kapowarr' ? 'Search fired — Kapowarr' : 'Search fired — LazyLibrarian';
}

function firedTitle(fired: Extract<Fired, { kind: 'fired' }>): string {
  if (fired.target === 'kapowarr') return 'Kapowarr auto-search fired for this volume';
  const formats = fired.formats.map((f) => FORMAT_LABELS[f] ?? f).join(' + ');
  return `LazyLibrarian search fired${formats ? ` — ${formats}` : ''}`;
}

const NOOP_COPY: Record<string, string> = {
  unroutable: 'Nothing to search — routing pending.',
  no_ll_id: 'Nothing to search — no LazyLibrarian id yet.',
  no_kapowarr_id: 'Nothing to search — not routed to Kapowarr yet.',
  landed: 'Already landed — nothing to search.',
};

export function RequestSearchButton({
  requestId,
  onSearched,
}: {
  requestId: string;
  /** Invalidate/refetch hook for the surrounding wall (fired only on a real search). */
  onSearched?: () => void;
}) {
  const [fired, setFired] = useState<Fired | null>(null);
  const search = trpc.integrations.search.useMutation({
    onSuccess: (result) => {
      if (result.searched) {
        setFired({
          kind: 'fired',
          target: result.target,
          formats: 'formats' in result ? (result.formats ?? []) : [],
        });
        onSearched?.();
      } else {
        setFired({ kind: 'noop', reason: ('reason' in result ? result.reason : undefined) ?? 'unroutable' });
      }
    },
    onError: (error) => setFired({ kind: 'failed', message: error.message }),
  });

  // The slot is a fixed-height row (CSS .request-action) so the button ⇄ chip swap never reflows
  // neighbors (ADR-015). A fired chip stays until the wall's data catches up (the honest feedback —
  // book statuses advance on the next sync reconcile, PLAN-015's ledger idiom adapted to books).
  if (fired?.kind === 'fired') {
    return (
      <PhaseChip
        phase="searching"
        tone="warning"
        label={firedLabel(fired)}
        pulse
        className="request-action__chip"
        title={firedTitle(fired)}
      />
    );
  }
  if (fired?.kind === 'noop') {
    return <span className="muted request-action__note">{NOOP_COPY[fired.reason] ?? 'Nothing to search.'}</span>;
  }
  if (fired?.kind === 'failed') {
    return (
      <PhaseChip
        phase="failed"
        tone="danger"
        label={`Search failed — ${fired.message}`}
        className="request-action__chip"
        title={fired.message}
      />
    );
  }
  return (
    <button
      type="button"
      className="btn sm"
      data-testid="request-search-btn"
      disabled={search.isPending}
      onClick={() => search.mutate({ requestId })}
    >
      {search.isPending ? 'Searching…' : 'Search again'}
    </button>
  );
}
