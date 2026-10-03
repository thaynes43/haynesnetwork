import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { mediaItems, trashCandidates, trashSaveIntents, type DbClient } from '@hnet/db';
import { resolveDb } from './db-client';
import type { MaintainerrClientBundle } from './maintainerr-clients';
import { applySaveIntentExclusion, KEEPER_APPLY_DEADLINE_MS } from './trash-save-enforcement';
import { relinkSaveIntents, type TrashRelinkReport } from './trash-relink';
import { tidySavedFromLeavingSoon } from './trash-batches';
import { requestPoolRefreshAfterSave } from './pool-refresh';

/**
 * ADR-099 D-3 / D-5 / D-6 — THE SAVE KEEPER: the recurring half of "if someone clicks save it's saved forever".
 *
 * A Save is recorded first (the open save intent, and the batch row on the batch wall) and is protection on its own:
 * every deletion path reads it. The keeper makes Maintainerr agree with it, on the incremental sync's 15-minute tick,
 * after the candidate refresh (so its pool join reads this tick's snapshot):
 *
 *  1. **Apply what is pending.** Every open intent whose exclusion was never read back (Maintainerr was busy or down
 *     when the Save was tapped) gets the exclusion written and read back, on the key the title has in a Trash pool
 *     right now when it has one, else the key it was saved on. Oldest first. A Maintainerr that does not answer in
 *     time ends this stage for the tick (it is running its rules; the next tick retries); an error on one title is
 *     recorded on its intent and the stage moves on.
 *  2. **Repair what Maintainerr lost** (`relinkSaveIntents`, ADR-086 widened by D-5): a saved title back in a pool
 *     without its exclusion, under a new key (a re-key and the nightly prune) or the same one, gets it re-applied.
 *  3. **Tidy Leaving Soon** (`tidySavedFromLeavingSoon`): a saved poster still in an open batch's collection leaves it.
 *
 * Each stage is isolated: one failing never skips the next, and nothing here fails the sync run (the caller logs the
 * report). Nothing here can delete anything; every write is protective and idempotent.
 */
export interface TrashSaveKeeperReport {
  /** Stage 1 — open intents with no confirmed exclusion when the tick started. */
  pending: number;
  /** Stage 1 — exclusions applied (written, or found already there) and read back. */
  applied: number;
  /** Stage 1 — un-saved while being applied; the exclusion written was taken back off. */
  revoked: number;
  /** Stage 1 — still pending after this tick (an error, or Maintainerr busy). */
  stillPending: number;
  /** Stage 1 — stopped early because Maintainerr did not answer in time. */
  busy: boolean;
  /** Stage 1 — capped sample of pending titles, for the log. */
  pendingSamples: Array<{ title: string; key: string; outcome: string; attempts: number }>;
  /** Stage 2 — the lost-exclusion repair's own report; null when it threw (see `relinkError`). */
  relink: TrashRelinkReport | null;
  relinkError?: string;
  /** Stage 3 — saved posters removed from open Leaving-Soon collections; null when it threw (see `tidyError`). */
  leavingSoonRemoved: number | null;
  tidyError?: string;
  /** Stage 1's own failure (a database fault), when it threw. */
  applyError?: string;
}

/** How many pending intents one tick works through at most (a backlog clears over a few ticks). */
const APPLY_BATCH_LIMIT = 50;
/** How long stages 2 and 3 may each keep starting new work in one tick. */
const KEEPER_STAGE_BUDGET_MS = 120_000;
const SAMPLE_CAP = 10;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function keepTrashSaves(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  /** Per-intent Maintainerr budget (tests shorten it). */
  applyDeadlineMs?: number;
}): Promise<TrashSaveKeeperReport> {
  const report: TrashSaveKeeperReport = {
    pending: 0,
    applied: 0,
    revoked: 0,
    stillPending: 0,
    busy: false,
    pendingSamples: [],
    relink: null,
    leavingSoonRemoved: null,
  };

  try {
    await applyPendingSaves(input, report);
  } catch (err) {
    report.applyError = message(err);
  }
  // Stages 2 and 3 read Maintainerr per title / per page; a Maintainerr busy with its rules must not hold the sync
  // tick for long, so each stage gets a time budget. It is cooperative, not a race: a stage starts no new title or
  // batch once its budget is spent, and always finishes the one in hand, so an exclusion is never written without
  // its audit row and nothing outlives the sync run. The rest resumes next tick.
  try {
    report.relink = await relinkSaveIntents({
      db: input.db,
      maintainerr: input.maintainerr,
      deadlineAt: Date.now() + KEEPER_STAGE_BUDGET_MS,
    });
  } catch (err) {
    report.relinkError = message(err);
  }
  try {
    report.leavingSoonRemoved = (
      await tidySavedFromLeavingSoon({
        db: input.db,
        maintainerr: input.maintainerr,
        deadlineAt: Date.now() + KEEPER_STAGE_BUDGET_MS,
      })
    ).removed;
  } catch (err) {
    report.tidyError = message(err);
  }
  return report;
}

async function applyPendingSaves(
  input: { db?: DbClient; maintainerr: MaintainerrClientBundle; applyDeadlineMs?: number },
  report: TrashSaveKeeperReport,
): Promise<void> {
  const db = resolveDb(input.db);
  const rows = await db
    .select({
      intentId: trashSaveIntents.id,
      mediaKind: trashSaveIntents.mediaKind,
      savedKey: trashSaveIntents.maintainerrMediaId,
      attempts: trashSaveIntents.applyAttempts,
      poolKey: trashCandidates.maintainerrMediaId,
      title: mediaItems.title,
    })
    .from(trashSaveIntents)
    .innerJoin(mediaItems, eq(mediaItems.id, trashSaveIntents.mediaItemId))
    // The title's key in a Trash pool right now, when it is in one (same identity join as the relink, ADR-086 D-4).
    .leftJoin(
      trashCandidates,
      or(
        and(
          eq(mediaItems.arrKind, 'radarr'),
          eq(trashCandidates.mediaKind, 'movie'),
          eq(trashCandidates.tmdbId, mediaItems.tmdbId),
        ),
        and(
          eq(mediaItems.arrKind, 'sonarr'),
          eq(trashCandidates.mediaKind, 'tv'),
          eq(trashCandidates.tvdbId, mediaItems.tvdbId),
        ),
      ),
    )
    .where(and(isNull(trashSaveIntents.revokedAt), isNull(trashSaveIntents.exclusionConfirmedAt)))
    .orderBy(asc(trashSaveIntents.savedAt));

  // One row per intent (a title pooled twice would join twice); the first pooled key wins.
  const seen = new Set<string>();
  const intents = rows.filter((r) => (seen.has(r.intentId) ? false : (seen.add(r.intentId), true)));
  report.pending = intents.length;

  const kindsApplied = new Set<'movie' | 'tv'>();
  for (const intent of intents.slice(0, APPLY_BATCH_LIMIT)) {
    const key = intent.poolKey ?? intent.savedKey;
    const outcome = await applySaveIntentExclusion({
      db: input.db,
      maintainerr: input.maintainerr,
      intentId: intent.intentId,
      maintainerrMediaId: key,
      deadlineMs: input.applyDeadlineMs ?? KEEPER_APPLY_DEADLINE_MS,
    });
    if (report.pendingSamples.length < SAMPLE_CAP) {
      report.pendingSamples.push({ title: intent.title, key, outcome, attempts: intent.attempts });
    }
    if (outcome === 'applied') {
      report.applied += 1;
      kindsApplied.add(intent.mediaKind);
    } else if (outcome === 'revoked') {
      report.revoked += 1;
    } else if (outcome === 'busy') {
      // Maintainerr is holding writes (its rule run): stop queueing calls behind it; the next tick resumes.
      report.busy = true;
      break;
    }
  }
  report.stillPending = intents.length - report.applied - report.revoked;

  // Reuse the debounced pool refresh so Maintainerr drops the newly excluded titles from its pool on a rule run soon,
  // not up to eight hours later. `scheduleTimer: false`: this runs in the sync CronJob, which exits.
  for (const kind of kindsApplied) {
    try {
      await requestPoolRefreshAfterSave({
        db: input.db,
        maintainerr: input.maintainerr,
        kind,
        actorId: null,
        scheduleTimer: false,
      });
    } catch {
      // Best-effort: the pool clears on Maintainerr's own next rule run instead.
    }
  }
}
