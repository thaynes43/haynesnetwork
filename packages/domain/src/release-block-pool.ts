// ADR-093 / DESIGN-052 D-11 / D-12 / Q-05 / Q-12 / Q-13 (PLAN-072 S6(e)) — the READ-ONLY report of what the Release
// Block would record for the pending Trash pool, BEFORE the sweep resumes.
//
// For each kind (movies, TV) it reads the pending pool (Maintainerr + the ledger join) and runs the same identity and
// term derivation the sweep runs before a delete (`identifyRelease`, D-11 / D-12), then counts: records by shape
// (group / exact / none), by confidence (verified / low_confidence), the fold-only terms (D-25bq: a real name matched
// only folded, which the *arr will not block), the renamed-only terms whose year window left out a namesake's year
// (D-25cr) and by identity source; records whose release
// group is unknown (Q-12); and the items D-11 would keep `release_unrecorded`, by reason, with their titles (our own
// library's titles, fine to print, D-21). The share of kept items is what Q-13 turns on.
//
// It WRITES NOTHING: no record, no profile, no batch item, no status row. It only reads Maintainerr, the ledger and
// the Radarr / Sonarr identity endpoints (moviefile / episodefile, history, the item GET). `release-block-seed.ts
// --pool` prints it.
import type { DbClient } from '@hnet/db';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';
import type { MaintainerrClientBundle } from './maintainerr-clients';
import {
  identifyRelease,
  type ReleaseBlockArrClients,
  type UnrecordedReason,
} from './release-block';
import { listTrashPending } from './trash-flow';
import { readDisplayWatchlistSnapshot } from './watchlist-registry';

export interface PoolReleaseKindReport {
  media: 'movie' | 'tv';
  /** Pending items in the pool. */
  pool: number;
  /** Items the derivation recorded (a movie or series with at least one record). */
  recordable: number;
  /** Items D-11 would keep `release_unrecorded`, per reason (`no_ledger_item`: no ledger row, which the guardian keeps
   *  `unevaluable` anyway; `read_failed`: an *arr read failed during the report). */
  unrecordable: Record<UnrecordedReason, number>;
  /** Of `pool`, the share kept `release_unrecorded` for want of a term (`no_term` + `gone`), 0..1. */
  unrecordedShare: number;
  /** Records by shape: `exact` counts the D-12 self-check falling back from the group form (or no group at all). */
  shape: { group: number; exact: number; none: number };
  confidence: { verified: number; low_confidence: number };
  /** D-25ad / D-25bq — records whose term matches a real release name of the record only in folded form: the *arr
   *  tests the raw title, so that name is NOT blocked. Since D-25dd the term writes the raw apostrophes, accents and
   *  `&`, so this counts only what the grammar cannot write (a decomposed accent inside a word, a doubled apostrophe).
   *  Counted within `confidence.low_confidence`; `foldOnlyShare` is its share of the records with a term (0..1). */
  foldOnly: number;
  foldOnlyShare: number;
  /** D-25cr — renamed-only records whose widened year window left out a year another title of the same name holds
   *  (The Killer 2024 next to The Killer 2023), with the titles and the years left out. */
  namesakeNarrowed: number;
  namesakes: Array<{ title: string; years: number[] }>;
  identitySource: Record<string, number>;
  /** Records with no release group (Q-12): only an exact name, or nothing, can block these. */
  nullGroup: number;
  /** The kept items' titles and reasons (library titles; never a person, D-21). */
  unrecorded: Array<{ title: string; reason: UnrecordedReason }>;
}

export interface PoolReleaseReport {
  kinds: PoolReleaseKindReport[];
}

/** PLAN-072 S6(e) — the read-only pool report (see the file header). */
export async function reportPoolReleaseIdentity(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
  arr: ReleaseBlockArrClients['read'];
  media?: ReadonlyArray<'movie' | 'tv'>;
  logger?: DomainLogger;
}): Promise<PoolReleaseReport> {
  const logger = input.logger ?? consoleDomainLogger;
  // The watchlist snapshot does not change an item's identity; the display snapshot (or none) is enough for a read.
  const watchlist = await readDisplayWatchlistSnapshot({ db: input.db });
  const kinds: PoolReleaseKindReport[] = [];
  for (const media of input.media ?? (['movie', 'tv'] as const)) {
    const pending = await listTrashPending({
      db: input.db,
      maintainerr: input.maintainerr,
      media,
      watchlist,
    });
    const report: PoolReleaseKindReport = {
      media,
      pool: pending.items.length,
      recordable: 0,
      unrecordable: { no_term: 0, gone: 0, no_ledger_item: 0, id_mismatch: 0, read_failed: 0 },
      unrecordedShare: 0,
      shape: { group: 0, exact: 0, none: 0 },
      confidence: { verified: 0, low_confidence: 0 },
      foldOnly: 0,
      foldOnlyShare: 0,
      namesakeNarrowed: 0,
      namesakes: [],
      identitySource: {},
      nullGroup: 0,
      unrecorded: [],
    };
    const keep = (title: string, reason: UnrecordedReason) => {
      report.unrecordable[reason] += 1;
      report.unrecorded.push({ title, reason });
    };
    for (const item of pending.items) {
      if (item.mediaItemId === null) {
        keep(item.title, 'no_ledger_item');
        continue;
      }
      let identity: Awaited<ReturnType<typeof identifyRelease>>;
      try {
        identity = await identifyRelease({ db: input.db, arr: input.arr, mediaItemId: item.mediaItemId });
      } catch (error) {
        logger.warn('[release-block] pool_identity_read_failed', {
          title: item.title,
          error: error instanceof Error ? error.message : String(error),
        });
        keep(item.title, 'read_failed');
        continue;
      }
      if (identity.status === 'unrecordable') {
        keep(item.title, identity.reason);
        continue;
      }
      report.recordable += 1;
      for (const d of identity.drafts) {
        report.shape[d.shape] += 1;
        if (d.termConfidence !== null) report.confidence[d.termConfidence] += 1;
        if (d.foldOnly === true) report.foldOnly += 1;
        if (d.namesakeYears && d.namesakeYears.length > 0) {
          report.namesakeNarrowed += 1;
          report.namesakes.push({ title: item.title, years: d.namesakeYears });
        }
        report.identitySource[d.identitySource] = (report.identitySource[d.identitySource] ?? 0) + 1;
        if (d.shape !== 'none' && d.releaseGroup === null) report.nullGroup += 1;
      }
    }
    const kept = report.unrecordable.no_term + report.unrecordable.gone;
    report.unrecordedShare = report.pool === 0 ? 0 : Math.round((kept / report.pool) * 1000) / 1000;
    const withTerm = report.shape.group + report.shape.exact;
    report.foldOnlyShare = withTerm === 0 ? 0 : Math.round((report.foldOnly / withTerm) * 1000) / 1000;
    kinds.push(report);
  }
  return { kinds };
}
