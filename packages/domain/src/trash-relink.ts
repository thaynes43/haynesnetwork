import { and, eq, isNull, isNotNull, ne, or, sql } from 'drizzle-orm';
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
 * ADR-086 / DESIGN-048 D-03 — the RELINK RECONCILER.
 *
 * A Maintainerr exclusion is keyed on the Plex ratingKey. When a title's file is replaced, Plex
 * re-keys the item and Maintainerr's nightly `removeLeftoverExclusions()` deletes the dangling
 * exclusion, silently erasing the owner's Save. This reconciler notices that an open save intent
 * now points at a stale key, and re-applies the exclusion onto the key the title actually has.
 *
 * Three properties that are load-bearing and must not be "simplified" away:
 *
 *  1. **Changed-key ONLY** (ADR-086 D-4). An item pooled under the very key we already excluded,
 *     with the exclusion gone, is essentially only reachable by a human removing it in
 *     Maintainerr's own UI. Re-applying there would fight a deliberate action, so those are
 *     COUNTED and reported, never acted on.
 *  2. **Open intents only.** Revocation is explicit (`revoked_at`); a title the owner un-saved is
 *     never resurrected.
 *  3. **Protective and idempotent.** Every write it makes is an exclusion the owner already asked
 *     for. That is why this ships enforcing rather than census-first (ADR-086 D-9) — but it still
 *     carries a kill switch, and it still reports what it would have done.
 */
export interface TrashRelinkReport {
  /** Open intents whose pooled key differs from the recorded key (the relink candidate set). */
  scanned: number;
  /** Exclusions re-applied onto a new key. */
  relinked: number;
  /** Already excluded under the new key — intent re-pointed, no Maintainerr write needed. */
  alreadyExcluded: number;
  failed: number;
  /** ADR-086 D-4 — open intents pooled under the SAME key with no exclusion: human un-exclusions. */
  sameKeyCensus: number;
  /** ADR-086 D-8 — `dnd`-tagged pool members with no open intent: stale tags, observed not swept. */
  staleTagCensus: number;
  /** ADR-086 D-13 — `trash_excluded` saves with no media item, which can never be relinked. */
  unlinkedSaves: number;
  /** Capped sample for the log/digest. */
  samples: Array<{ title: string; savedKey: string; poolKey: string; outcome: string }>;
  /** False when the kill switch is off — detection and census still ran, writes did not. */
  enforced: boolean;
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
}): Promise<TrashRelinkReport> {
  const db = resolveDb(input.db);
  const enforced = await getAppSetting(input.db, 'trash_relink_enabled');

  const report: TrashRelinkReport = {
    scanned: 0,
    relinked: 0,
    alreadyExcluded: 0,
    failed: 0,
    sameKeyCensus: 0,
    staleTagCensus: 0,
    unlinkedSaves: 0,
    samples: [],
    enforced,
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
        isNotNull(trashCandidates.maintainerrMediaId),
        // ADR-086 D-4 — THIS clause is the same-key carve-out. Removing it turns the reconciler
        // into something that overrides deliberate human un-exclusions.
        ne(trashCandidates.maintainerrMediaId, trashSaveIntents.maintainerrMediaId),
      ),
    );

  report.scanned = candidates.length;
  report.sameKeyCensus = await countSameKeyLapses(db);
  report.staleTagCensus = await countStaleTags(db);
  report.unlinkedSaves = await countUnlinkedSaves(db);

  if (candidates.length === 0) return report;

  // ---- Stage 2: verify live. Only the differing set pays a Maintainerr read. ----
  const poolKeys = candidates
    .map((c) => c.poolKey)
    .filter((k): k is string => k !== null);
  const liveExcluded = await fetchLiveExclusions(input.maintainerr, poolKeys);

  // ---- Stage 3: relink. ----
  const kindsTouched = new Set<'movie' | 'tv'>();
  for (const c of candidates) {
    if (c.poolKey === null) continue;
    const already = liveExcluded.has(c.poolKey);

    if (!enforced) {
      pushSample(report, c.title, c.savedKey, c.poolKey, already ? 'would-repoint' : 'would-relink');
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
        reason: 'relink',
      });
      if (res.alreadyExcluded) {
        report.alreadyExcluded += 1;
        pushSample(report, c.title, c.savedKey, c.poolKey, 'repointed');
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
 * ADR-086 D-4 census — open intents whose pooled key MATCHES the recorded key. If such an item is
 * on the wall at all, its exclusion is gone, and since the app only ever removes an exclusion
 * through an audited un-save (which also revokes the intent), a human did it in Maintainerr. We
 * report the count so the owner can decide whether that shape is worth handling; we do not act.
 */
async function countSameKeyLapses(db: ReturnType<typeof resolveDb>): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(trashSaveIntents)
    .innerJoin(mediaItems, eq(mediaItems.id, trashSaveIntents.mediaItemId))
    .innerJoin(trashCandidates, identityJoin)
    .where(
      and(
        isNull(trashSaveIntents.revokedAt),
        eq(trashCandidates.maintainerrMediaId, trashSaveIntents.maintainerrMediaId),
      ),
    );
  return rows[0]?.n ?? 0;
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
