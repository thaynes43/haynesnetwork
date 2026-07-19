// ADR-071 owner ruling 2026-07-19 (DESIGN-035 D-16/D-17 amendment) — the BULK "Search Missing" leg
// for a movies/TV (arr-backed) collection. The owner asked for one control that force-searches ALL
// the still-missing members of a collection (from the drill header and, a page up, per-collection
// from the all-collections grid badge). Movies/TV have no app-side acquisition cron of their own
// (Kometa acquires on its schedule), so this simply FANS OUT the shipped per-item Radarr/Sonarr Force
// Search (runForceSearch) over the collection's resolved missing members, bounded by a sane per-call
// cap.
//
// GATING is EXACTLY the existing per-item movies/TV Force Search (PR #375 — study-and-reuse, no new
// grant): every member goes through runForceSearch → recordSearchRequest, which draws the shared
// per-requester hourly budget (admins bypass) and writes the audited 'search_requested' ledger event
// in the SAME transaction as the *arr command it authorizes (hard rule 6). So the bulk path adds NO
// new authority — it is N of the same audited, budget-checked, single-writer per-item searches the
// user could already fire one tile at a time. A non-admin who exhausts the shared budget mid-run
// stops cleanly (rateLimited=true); a single member's *arr error is counted, never fatal to the run.
//
// The caller (the ledger router) resolves the collection's missing member ids UNDER THE LIBRARY
// ACCESS GATE (THE INVARIANT — a caller can only search what they can see) and passes them in; this
// module owns only the cap + the per-item fan-out + the honest tally.
import type { DbClient } from '@hnet/db';
import { FixRateLimitError } from './errors';
import { runForceSearch } from './search-flow';
import type { ArrClientBundle } from './arr-clients';

/** Owner-tunable per-call bound on the bulk arr force-search fan-out (politeness — env-tunable). */
export const ARR_COLLECTION_FORCE_SEARCH_CAP = Number(
  process.env.ARR_COLLECTION_FORCE_SEARCH_CAP ?? 25,
);

export interface ForceSearchArrCollectionInput {
  db?: DbClient;
  arr: ArrClientBundle;
  requesterId: string;
  /** Admins bypass the shared per-requester hourly budget (same rule as the per-item path, D-17). */
  requesterIsAdmin?: boolean;
  /** The collection's resolved MISSING member ids (monitored, not on disk, live) — access-gated by
   *  the caller. Search order is the caller's (member/sort order). */
  mediaItemIds: readonly string[];
  /** Per-call cap (default ARR_COLLECTION_FORCE_SEARCH_CAP). */
  cap?: number;
}

export interface ForceSearchArrCollectionReport {
  /** Missing members found (pre-cap) — the "N missing" the confirm modal states. */
  candidates: number;
  /** Members this call actually force-searched (≤ cap). */
  searched: number;
  /** Members whose *arr search failed (e.g. a tombstoned/unresolved item) — counted, never fatal. */
  failed: number;
  /** True when a non-admin exhausted the shared hourly budget mid-run (the run stopped early). */
  rateLimited: boolean;
  /** The cap that bounded this run (surfaced so the UI can say "searched the first N"). */
  cap: number;
}

/**
 * Force-search a movies/TV collection's missing members in bulk. Fans out the shipped per-item Force
 * Search (runForceSearch) over `mediaItemIds`, capped. Each member's audit row + budget draw + *arr
 * command are runForceSearch's single-writer transaction — this loop adds nothing but the cap and the
 * tally. Never throws for a single member's *arr error (counted into `failed`); a non-admin hitting
 * the shared budget stops the run (`rateLimited`), because every remaining member would fail the same
 * way. Only an unexpected error (not FixRateLimitError) from a member propagates via the per-item
 * try/catch as a `failed` increment.
 */
export async function forceSearchArrCollection(
  input: ForceSearchArrCollectionInput,
): Promise<ForceSearchArrCollectionReport> {
  const cap = input.cap ?? ARR_COLLECTION_FORCE_SEARCH_CAP;
  const report: ForceSearchArrCollectionReport = {
    candidates: input.mediaItemIds.length,
    searched: 0,
    failed: 0,
    rateLimited: false,
    cap,
  };
  for (const mediaItemId of input.mediaItemIds.slice(0, cap)) {
    try {
      await runForceSearch({
        db: input.db,
        arr: input.arr,
        requesterId: input.requesterId,
        requesterIsAdmin: input.requesterIsAdmin,
        mediaItemId,
      });
      report.searched += 1;
    } catch (error) {
      if (error instanceof FixRateLimitError) {
        // The shared hourly budget is spent — every remaining member would fail identically. Stop.
        report.rateLimited = true;
        break;
      }
      // A single member's *arr/tombstone error must not abort the whole collection run.
      report.failed += 1;
    }
  }
  return report;
}
