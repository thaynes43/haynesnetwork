'use client';

// ADR-071 / DESIGN-035 D-16 (owner ruling 2026-07-19) — the books/audiobooks/comics COLLECTION-DRILL
// Wanted-tile Force Search badge, the twin of the Movies/TV drill tile (library-client.tsx). It renders
// the SAME sealed @hnet/ui <MediaAction forceSearch presentation="badge"> puck and reuses the identical
// testId ("collection-wanted-forcesearch"), so the affordance cannot drift in verb/gating/look between
// walls (the action-anatomy guard). This thin app-side wrapper supplies ONLY the books per-want mutation
// wiring — books.searchPairingWant, the books-gated leg for OWNERLESS collection/pairing system wants.
// Non-destructive, one-click, no confirm (hard rule 8); the overlay is absolutely positioned, so it
// never reflows the grid (ADR-015).
import { MediaAction } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';

export function CollectionWantForceSearch({
  requestId,
  title,
  onDone,
}: {
  requestId: string;
  title: string;
  onDone?: () => void;
}) {
  const search = trpc.books.searchPairingWant.useMutation({ onSettled: () => onDone?.() });
  return (
    <MediaAction
      action="forceSearch"
      presentation="badge"
      disabled={search.isPending}
      onFire={() => search.mutate({ requestId })}
      testId="collection-wanted-forcesearch"
      ariaLabel={`Force search ${title}`}
    />
  );
}
