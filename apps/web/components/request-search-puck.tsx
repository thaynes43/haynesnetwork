'use client';

// PLAN-045 owner-correction (DESIGN-029 amendment) — the COMPACT force-search affordance for the
// Goodreads items wall: a single small round icon button pinned top-right of the poster (the ADR-015
// reserved corner-puck slot, the twall/bwall idiom). It REPLACES the big "Search again" text button
// the owner rejected — the cohesive poster block carries the state in its caption badge, and the only
// action is this puck. It calls the same dispatching `integrations.search` mutation (comic → Kapowarr
// auto_search; book/audio → LL searchBook — audited server-side) and gives PLAN-015-style feedback IN
// PLACE: the puck recolors + pulses and its tooltip/aria narrates the result — no reflow, no text
// button, no stacked pills. Non-destructive ⇒ a plain button, never a ConfirmButton (hard rule 8).
import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';

type Fired =
  | { kind: 'fired'; target: 'kapowarr' | 'lazylibrarian'; formats: string[] }
  | { kind: 'noop'; reason: string }
  | { kind: 'failed'; message: string };

type PuckState = 'idle' | 'searching' | 'fired' | 'noop' | 'failed';

const FORMAT_LABELS: Record<string, string> = { ebook: 'Ebook', audiobook: 'Audio' };

const NOOP_COPY: Record<string, string> = {
  unroutable: 'Nothing to search — routing pending.',
  no_ll_id: 'Nothing to search — no LazyLibrarian id yet.',
  no_kapowarr_id: 'Nothing to search — not routed to Kapowarr yet.',
  landed: 'Already landed — nothing to search.',
};

function firedTitle(fired: Extract<Fired, { kind: 'fired' }>): string {
  if (fired.target === 'kapowarr') return 'Search fired — Kapowarr (auto-search)';
  const formats = fired.formats.map((f) => FORMAT_LABELS[f] ?? f).join(' + ');
  return `Search fired — LazyLibrarian${formats ? ` (${formats})` : ''}`;
}

/** The magnifier glyph (the 'searching' request-phase mark) — currentColor, tokened by the puck CSS. */
function MagnifierGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="m14.7 14.7 4.8 4.8" />
    </svg>
  );
}

export function RequestSearchPuck({
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

  const state: PuckState = search.isPending
    ? 'searching'
    : fired?.kind === 'fired'
      ? 'fired'
      : fired?.kind === 'noop'
        ? 'noop'
        : fired?.kind === 'failed'
          ? 'failed'
          : 'idle';

  const title =
    state === 'fired' && fired?.kind === 'fired'
      ? firedTitle(fired)
      : state === 'noop' && fired?.kind === 'noop'
        ? (NOOP_COPY[fired.reason] ?? 'Nothing to search.')
        : state === 'failed' && fired?.kind === 'failed'
          ? `Search failed — ${fired.message}`
          : state === 'searching'
            ? 'Searching…'
            : 'Search again';

  return (
    <button
      type="button"
      className="gr-search-puck"
      data-testid="request-search-btn"
      data-state={state}
      disabled={search.isPending}
      aria-label={title}
      title={title}
      onClick={() => search.mutate({ requestId })}
    >
      <MagnifierGlyph />
    </button>
  );
}
