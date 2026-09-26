// ADR-093 / DESIGN-052 D-11 / D-12 / Q-05 / Q-12 / Q-13 (PLAN-072 S6(e)) — the READ-ONLY report of what the Release
// Block would record for the pending Trash pool, BEFORE the sweep resumes.
//
// For each kind (movies, TV) it reads the pending pool (Maintainerr + the ledger join) and runs the same identity and
// term derivation the sweep runs before a delete (`identifyRelease`, D-11 / D-12), then counts: records by shape
// (group / exact / none), by confidence (verified / low_confidence) and by identity source; records whose release
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
      unrecordable: { no_term: 0, gone: 0, no_ledger_item: 0, read_failed: 0 },
      unrecordedShare: 0,
      shape: { group: 0, exact: 0, none: 0 },
      confidence: { verified: 0, low_confidence: 0 },
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
        report.identitySource[d.identitySource] = (report.identitySource[d.identitySource] ?? 0) + 1;
        if (d.shape !== 'none' && d.releaseGroup === null) report.nullGroup += 1;
      }
    }
    const kept = report.unrecordable.no_term + report.unrecordable.gone;
    report.unrecordedShare = report.pool === 0 ? 0 : Math.round((kept / report.pool) * 1000) / 1000;
    kinds.push(report);
  }
  return { kinds };
}
