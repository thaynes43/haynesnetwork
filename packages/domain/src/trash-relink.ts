import { and, eq, isNull, isNotNull, or, sql } from 'drizzle-orm';
import {
  mediaItems,
  trashCandidates,
  trashSaveIntents,
  type DbClient,
} from '@hnet/db';
import { resolveDb } from './db-client';
import { getAppSetting } from './app-settings';
import { fetchLiveExclusions, saveExclusion, PROTECTED_TAG } from './trash-flow';
import { requestPoolRefreshAfterSave } from './pool-refresh';
import type { MaintainerrClientBundle } from './maintainerr-clients';

/**
 * ADR-086 / DESIGN-048 D-03 — the RELINK RECONCILER, widened by ADR-099 D-5 into the keeper's
 * lost-exclusion repair.
 *
 * A Maintainerr exclusion is keyed on the Plex ratingKey. When a title's file is replaced, Plex
 * re-keys the item and Maintainerr's nightly `removeLeftoverExclusions()` deletes the dangling
 * exclusion, silently erasing the owner's Save. This reconciler notices a saved title back in a
 * Trash pool without its exclusion and re-applies it onto the key the title actually has.
 *
 * Properties that are load-bearing and must not be "simplified" away:
 *
 *  1. **Any key** (ADR-099 D-5, superseding ADR-086 D-4's changed-key-only carve-out). The owner's
 *     ruling is that a Save is forever ("if someone clicks save it's saved forever"): an exclusion
 *     Maintainerr lost under the SAME key is re-applied too (`reason: 'reapply'`), and the app's
 *     un-save is the one way to release a Save. A changed key is still recorded as `relink`.
 *  2. **Open, confirmed intents only.** Revocation is explicit (`revoked_at`); a title the owner
 *     un-saved is never resurrected. An intent whose exclusion was never applied yet is the keeper's
 *     first stage (`keepTrashSaves`), not a lapse.
 *  3. **Protective and idempotent.** Every write it makes is an exclusion the owner already asked
 *     for. That is why this ships enforcing rather than census-first (ADR-086 D-9) — but it still
 *     carries a kill switch, and it still reports what it would have done. The switch never gates a
 *     fresh Save's first application, and no deletion path waits on it: they read the intent.
 */
export interface TrashRelinkReport {
  /** Open, confirmed intents whose title is in a Trash pool (the lapse candidate set). */
  scanned: number;
  /** Exclusions re-applied onto a new key. */
  relinked: number;
  /** ADR-099 D-5 — exclusions Maintainerr lost under the SAME key, re-applied. */
  reapplied: number;
  /** Already excluded under the pooled key — intent re-pointed when the key changed, no Maintainerr write needed. */
  alreadyExcluded: number;
  failed: number;
  /** ADR-099 D-5 — of `scanned`, how many were pooled under the same key they were saved on (a lapse to re-apply, no
   *  longer only a census: ADR-086 D-4's carve-out is superseded). */
  sameKeyCensus: number;
  /** ADR-086 D-8 — `dnd`-tagged pool members with no open intent: stale tags, observed not swept. */
  staleTagCensus: number;
  /** ADR-086 D-13 — `trash_excluded` saves with no media item, which can never be relinked. */
  unlinkedSaves: number;
  /** Capped sample for the log/digest. */
  samples: Array<{ title: string; savedKey: string; poolKey: string; outcome: string }>;
  /** False when the kill switch is off — detection and census still ran, writes did not. */
  enforced: boolean;
  /** ADR-099 — the caller's time budget ran out before every candidate was handled; the next tick resumes. */
  stoppedEarly: boolean;
}

const SAMPLE_CAP = 10;

/**
 * The identity join: a candidate row belongs to a media item when the *arr kind and the external
 * id line up. `maintainerr_media_id IS NULL` means "listed but unactionable" (ADR-035), which is
 * NOT a re-key and must never be treated as one.
 */
const identityJoin = or(
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
);

export async function relinkSaveIntents(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  /** ADR-099 — epoch ms after which no new candidate is started (the keeper's stage budget). A candidate already
   *  started always finishes, so its exclusion and its audit row are never split; unset ⇒ no budget. */
  deadlineAt?: number;
}): Promise<TrashRelinkReport> {
  const db = resolveDb(input.db);
  const enforced = await getAppSetting(input.db, 'trash_relink_enabled');

  const report: TrashRelinkReport = {
    scanned: 0,
    relinked: 0,
    reapplied: 0,
    alreadyExcluded: 0,
    failed: 0,
    sameKeyCensus: 0,
    staleTagCensus: 0,
    unlinkedSaves: 0,
    samples: [],
    enforced,
    stoppedEarly: false,
  };

  // ---- Stage 1: detect. Pure SQL against the ADR-035 snapshot — zero Maintainerr calls. ----
  const candidates = await db
    .select({
      intentId: trashSaveIntents.id,
      mediaItemId: trashSaveIntents.mediaItemId,
      mediaKind: trashSaveIntents.mediaKind,
      savedKey: trashSaveIntents.maintainerrMediaId,
      poolKey: trashCandidates.maintainerrMediaId,
      title: mediaItems.title,
    })
    .from(trashSaveIntents)
    .innerJoin(mediaItems, eq(mediaItems.id, trashSaveIntents.mediaItemId))
    .innerJoin(trashCandidates, identityJoin)
    .where(
      and(
        isNull(trashSaveIntents.revokedAt),
        // ADR-099 D-5 — confirmed intents only; one never applied yet is the keeper's first stage. And ANY key: the
        // same-key carve-out of ADR-086 D-4 is superseded (a Save is forever; un-save is the release).
        isNotNull(trashSaveIntents.exclusionConfirmedAt),
        isNotNull(trashCandidates.maintainerrMediaId),
      ),
    );

  report.scanned = candidates.length;
  report.sameKeyCensus = candidates.filter((c) => c.poolKey === c.savedKey).length;
  report.staleTagCensus = await countStaleTags(db);
  report.unlinkedSaves = await countUnlinkedSaves(db);

  if (candidates.length === 0) return report;

  // ---- Stage 2: verify live. Only saved titles in a pool pay a Maintainerr read. ----
  const poolKeys = candidates
    .map((c) => c.poolKey)
    .filter((k): k is string => k !== null);
  const liveExcluded = await fetchLiveExclusions(input.maintainerr, poolKeys);

  // ---- Stage 3: relink. ----
  const kindsTouched = new Set<'movie' | 'tv'>();
  for (const c of candidates) {
    if (c.poolKey === null) continue;
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      report.stoppedEarly = true;
      break;
    }
    const already = liveExcluded.has(c.poolKey);
    const sameKey = c.poolKey === c.savedKey;
    // Same key and still excluded: Maintainerr simply has not re-run its rules since the Save. Nothing to do.
    if (sameKey && already) continue;

    if (!enforced) {
      pushSample(
        report,
        c.title,
        c.savedKey,
        c.poolKey,
        already ? 'would-repoint' : sameKey ? 'would-reapply' : 'would-relink',
      );
      continue;
    }

    try {
      // saveExclusion owns BOTH the Maintainerr write and the intent/ledger transaction, including
      // the already-excluded path (which re-points the intent without a duplicate audit row). We do
      // not re-implement any of that here — one writer, one ordering discipline (ADR-023 C-05).
      const res = await saveExclusion({
        db: input.db,
        maintainerr: input.maintainerr,
        maintainerrMediaId: c.poolKey,
        mediaItemId: c.mediaItemId,
        actorId: null,
        reason: sameKey ? 'reapply' : 'relink',
      });
      if (res.alreadyExcluded) {
        report.alreadyExcluded += 1;
        pushSample(report, c.title, c.savedKey, c.poolKey, 'repointed');
      } else if (sameKey) {
        report.reapplied += 1;
        kindsTouched.add(c.mediaKind);
        pushSample(report, c.title, c.savedKey, c.poolKey, 'reapplied');
      } else {
        report.relinked += 1;
        kindsTouched.add(c.mediaKind);
        pushSample(report, c.title, c.savedKey, c.poolKey, 'relinked');
      }
    } catch {
      // One bad item must not abort the sweep; the next tick retries it.
      report.failed += 1;
      pushSample(report, c.title, c.savedKey, c.poolKey, 'failed');
    }
  }

  // Reuse the existing debounced backstop so Maintainerr drops the re-protected item from the pool.
  // `scheduleTimer: false` — this runs in the sync CronJob, which exits; the in-process timer would
  // die with it. The durable marker plus the next tick's drain is the whole mechanism here.
  for (const kind of kindsTouched) {
    try {
      await requestPoolRefreshAfterSave({
        db: input.db,
        maintainerr: input.maintainerr,
        kind,
        actorId: null,
        scheduleTimer: false,
      });
    } catch {
      // Best-effort: the pool simply clears on Maintainerr's own next rule run instead.
    }
  }

  return report;
}

function pushSample(
  report: TrashRelinkReport,
  title: string,
  savedKey: string,
  poolKey: string,
  outcome: string,
): void {
  if (report.samples.length < SAMPLE_CAP) {
    report.samples.push({ title, savedKey, poolKey, outcome });
  }
}

/**
 * ADR-086 D-8 census — pool members carrying the Maintainerr-managed `dnd` tag with no open intent.
 * These are the tags left behind when an exclusion was pruned (the un-tag cannot resolve the *arr
 * item from a dead ratingKey). Stripping a protective tag is the one hard-to-reverse action in this
 * area, so it stays a count until the owner rules on it.
 */
async function countStaleTags(db: ReturnType<typeof resolveDb>): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(trashCandidates)
    .innerJoin(mediaItems, identityJoin)
    .where(
      and(
        sql`${mediaItems.arrTags} ? ${PROTECTED_TAG}`,
        sql`NOT EXISTS (SELECT 1 FROM ${trashSaveIntents} tsi
                        WHERE tsi.media_item_id = ${mediaItems.id} AND tsi.revoked_at IS NULL)`,
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * ADR-086 D-13 census — saves recorded against no media item. They have no durable identity, so
 * they cannot be relinked by construction. Counted so the gap stays visible rather than implied.
 */
async function countUnlinkedSaves(db: ReturnType<typeof resolveDb>): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM ledger_events
    WHERE event_type = 'trash_excluded'
      AND media_item_id IS NULL
      AND payload->>'action' = 'save'
  `);
  const first = (rows as unknown as { rows?: Array<{ n: number }> }).rows?.[0];
  return first?.n ?? 0;
}
