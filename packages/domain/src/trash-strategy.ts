// DESIGN-014 amendment (2026-07-09, build D) — the SHARED batch-selection ordering. `selectBatchCandidates`
// (the greedy reclaim pick) and the pending walls' "Next up" default sort MUST rank identically so the
// TOP of a wall is the front of the deletion queue. Both call `compareByStrategy` here (a pure, low-level
// module with no imports, so trash-batches ⇄ trash-candidates never form an import cycle around it).
//
// The two strategies mirror the space-policy `strategy` (worst-rated is the owner default for policy
// batches; largest is the "biggest files first" alternative):
//   - worst-rated → rating ASCENDING on `imdbRating ?? tmdbRating` with UNRATED (null) FIRST (a null
//                   rating is the worst — sift it to the top), ties broken by size DESC, then title;
//   - largest     → size DESC, then title (the shared deterministic tiebreak).

/** The batch-selection / wall-sort ranking. `worst-rated` is the space-policy owner default. */
export type BatchStrategy = 'worst-rated' | 'largest';

export const BATCH_STRATEGIES = ['worst-rated', 'largest'] as const;

/** The item fields the ranking reads (a structural subset both TrashPendingItem and the batch
 *  ActionableItem satisfy). Ratings are the RAW *arr/metadata numbers — 0 is a real (very low)
 *  rating, not "unrated"; only `null` is unrated. */
export interface StrategyRankItem {
  imdbRating: number | null;
  tmdbRating: number | null;
  sizeBytes: number;
  title: string;
}

/**
 * The single source of truth for the strategy ordering (see the module header). Returns a negative
 * number when `a` should sort before `b`. For `worst-rated`, an unrated item (`imdbRating ?? tmdbRating`
 * === null) is treated as the WORST and sorts first; equal/both-fall-through items break by size DESC,
 * then title. For `largest`, size DESC then title. Deterministic (title is the final tiebreak).
 */
export function compareByStrategy(
  a: StrategyRankItem,
  b: StrategyRankItem,
  strategy: BatchStrategy,
): number {
  if (strategy === 'worst-rated') {
    const ra = a.imdbRating ?? a.tmdbRating;
    const rb = b.imdbRating ?? b.tmdbRating;
    if (ra === null && rb !== null) return -1; // unrated is the worst — take it first
    if (ra !== null && rb === null) return 1;
    if (ra !== null && rb !== null && ra !== rb) return ra - rb;
  }
  // largest, and the shared tie-break: bigger frees more, then title for determinism.
  if (a.sizeBytes !== b.sizeBytes) return b.sizeBytes - a.sizeBytes;
  return a.title.localeCompare(b.title);
}
