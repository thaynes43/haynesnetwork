// ADR-031 / DESIGN-014 (PLAN-014) — the RULES-TUNING REPORT (the save-stats consumer). REPORT, NOT
// auto-tune: it turns the curation pipeline's outcomes (trash_batch_saves ⊕ trash_batch_items ⊕
// media_metadata) into per-resolution / per-rating-band / per-collection rescue-vs-delete stats — the
// data the OWNER reads to tune the Maintainerr rules by hand. It NEVER mutates a rule (out of scope,
// documented). It also computes the skip-admin-gate GRADUATION readiness (ADR-025 C-08 / ADR-031
// C-05): over the most recent policy-proposed COMPLETED batches, the aggregate save-rate + restores of
// swept items against the suggested bar the owner may flip the audited skip-gate on.
//
// SAVE-RATE definition (the one number graduation uses, documented): rescued / (rescued + deleted) —
// of the items the rules proposed that reached a keep-or-delete verdict, the fraction a human actively
// RESCUED. Guardian-`skipped` items (recently-watched/requester/dnd) are excluded from the ratio's
// denominator (they weren't human rescues nor deletions) but reported alongside. High save-rate ⇒ the
// rules are too aggressive; near-zero with drain on target ⇒ a graduation candidate.
import {
  ledgerEvents,
  mediaMetadata,
  trashBatchItems,
  trashBatches,
  type DbClient,
  type TrashMediaKind,
} from '@hnet/db';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { resolveDb } from './db-client';

/** The suggested graduation bar (ADR-031 C-05). Indicative — the owner ratifies the actual flip. */
export const GRADUATION_THRESHOLDS = {
  minCompletedBatches: 3,
  maxSaveRatePct: 10,
  maxRestores: 0,
} as const;

/** The rating bands the report buckets IMDb-scale ratings into (0–10). `unknown` = no rating on file. */
export const RATING_BANDS = ['8.0+', '7.0–7.9', '5.0–6.9', '<5.0', 'unknown'] as const;
export type RatingBand = (typeof RATING_BANDS)[number];

export function ratingBand(rating: number | null): RatingBand {
  if (rating === null || Number.isNaN(rating)) return 'unknown';
  if (rating >= 8) return '8.0+';
  if (rating >= 7) return '7.0–7.9';
  if (rating >= 5) return '5.0–6.9';
  return '<5.0';
}

export interface TuningStats {
  /** rescued + deleted + skipped (the candidate items that reached a verdict; protected/pending excluded). */
  proposed: number;
  rescued: number; // ended `saved` (a human rescue — a labelled false positive)
  deleted: number; // ended `deleted` (the sweep removed it)
  skipped: number; // guardian-kept (recently-watched/requester/dnd/unevaluable) — not a human rescue
  /** rescued / (rescued + deleted) × 100, one decimal; null when nothing reached delete-or-rescue. */
  saveRatePct: number | null;
}

export interface TuningCell extends TuningStats {
  key: string;
  label: string;
}

export interface GraduationBatch {
  batchId: string;
  mediaKind: TrashMediaKind;
  deletedAt: string | null;
  rescued: number;
  deleted: number;
  skipped: number;
  saveRatePct: number | null;
  /** Restores (trash_restored) of items THIS batch swept — a guardian near-miss signal. */
  restores: number;
}

export interface GraduationReadiness {
  thresholds: typeof GRADUATION_THRESHOLDS;
  /** All policy-proposed batches that reached `deleted` (a completed sweep). */
  completedPolicyBatches: number;
  /** The most recent completed policy batches (up to `minCompletedBatches`), newest first. */
  recent: GraduationBatch[];
  /** Aggregate rescue/delete over `recent` (the numbers graduation is judged on). */
  aggregate: TuningStats;
  /** Restores of items swept by `recent` batches. */
  restoresOfSwept: number;
  /** Whether the recent window clears the suggested bar (enough batches, low save-rate, no restores). */
  meetsCriteria: boolean;
}

export interface TuningReport {
  /** Across every candidate item ever curated (the whole tuning dataset). */
  overall: TuningStats;
  byResolution: TuningCell[]; // ordered by proposed desc
  byRatingBand: TuningCell[]; // ordered by the RATING_BANDS order
  /** Q-02 (rule-attribution fidelity): a batch item traces to its SOURCE COLLECTION id, not always the
   *  exact proposing rule-group — so this is COLLECTION-grain (the closest rule proxy). */
  byCollection: TuningCell[]; // ordered by proposed desc
  graduation: GraduationReadiness;
}

const CANDIDATE_STATES = ['saved', 'deleted', 'skipped'] as const;

function saveRate(rescued: number, deleted: number): number | null {
  const denom = rescued + deleted;
  if (denom === 0) return null;
  return Math.round((rescued / denom) * 1000) / 10;
}

function emptyStats(): { rescued: number; deleted: number; skipped: number } {
  return { rescued: 0, deleted: 0, skipped: 0 };
}

function tally(
  acc: { rescued: number; deleted: number; skipped: number },
  state: string,
): void {
  if (state === 'saved') acc.rescued += 1;
  else if (state === 'deleted') acc.deleted += 1;
  else if (state === 'skipped') acc.skipped += 1;
}

function toStats(acc: { rescued: number; deleted: number; skipped: number }): TuningStats {
  return {
    proposed: acc.rescued + acc.deleted + acc.skipped,
    rescued: acc.rescued,
    deleted: acc.deleted,
    skipped: acc.skipped,
    saveRatePct: saveRate(acc.rescued, acc.deleted),
  };
}

/**
 * The rules-tuning report. Reads only — no rule mutation (out of scope). Aggregates every candidate
 * item's outcome (saved/deleted/skipped) by resolution, rating band, and source collection, and
 * computes the skip-gate graduation readiness over the recent policy-proposed completed batches.
 */
export async function getTuningReport(input: { db?: DbClient; now?: Date }): Promise<TuningReport> {
  const db = resolveDb(input.db);

  // Every candidate item + its (frozen-at-delete, else live media_metadata) resolution/rating and its
  // batch's kind/state. The frozen deleted_* wins for swept items (accurate to the delete moment).
  const rows = await db
    .select({
      state: trashBatchItems.state,
      batchId: trashBatchItems.batchId,
      collectionId: trashBatchItems.collectionId,
      mediaItemId: trashBatchItems.mediaItemId,
      deletedResolution: trashBatchItems.deletedResolution,
      deletedImdbRating: trashBatchItems.deletedImdbRating,
      metaResolution: mediaMetadata.resolution,
      metaImdbRating: mediaMetadata.imdbRating,
      mediaKind: trashBatches.mediaKind,
      batchState: trashBatches.state,
      batchDeletedAt: trashBatches.deletedAt,
    })
    .from(trashBatchItems)
    .innerJoin(trashBatches, eq(trashBatches.id, trashBatchItems.batchId))
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, trashBatchItems.mediaItemId))
    .where(inArray(trashBatchItems.state, [...CANDIDATE_STATES]));

  // Policy-proposed batches (a trash_space_policy event carries the batchId).
  const policyRows = await db
    .select({ batchId: sql<string>`${ledgerEvents.payload}->>'batchId'` })
    .from(ledgerEvents)
    .where(eq(ledgerEvents.eventType, 'trash_space_policy'));
  const policyBatchIds = new Set(policyRows.map((r) => r.batchId).filter(Boolean));

  // Restored media items (trash_restored) — the near-miss set for the graduation restore count.
  const restoredRows = await db
    .select({ mediaItemId: ledgerEvents.mediaItemId })
    .from(ledgerEvents)
    .where(and(eq(ledgerEvents.eventType, 'trash_restored'), isNotNull(ledgerEvents.mediaItemId)));
  const restoredSet = new Set(restoredRows.map((r) => r.mediaItemId).filter((v): v is string => v !== null));

  // ---- breakdowns ----
  const overall = emptyStats();
  const byRes = new Map<string, { rescued: number; deleted: number; skipped: number }>();
  const byBand = new Map<string, { rescued: number; deleted: number; skipped: number }>();
  const byColl = new Map<string, { rescued: number; deleted: number; skipped: number }>();
  // per completed policy batch
  const policyBatch = new Map<
    string,
    {
      mediaKind: TrashMediaKind;
      deletedAt: Date | null;
      rescued: number;
      deleted: number;
      skipped: number;
      restores: number;
    }
  >();

  for (const r of rows) {
    tally(overall, r.state);

    const resolution = r.deletedResolution ?? r.metaResolution ?? 'unknown';
    const resAcc = byRes.get(resolution) ?? emptyStats();
    tally(resAcc, r.state);
    byRes.set(resolution, resAcc);

    const ratingStr = r.deletedImdbRating ?? r.metaImdbRating;
    const band = ratingBand(ratingStr === null || ratingStr === undefined ? null : Number(ratingStr));
    const bandAcc = byBand.get(band) ?? emptyStats();
    tally(bandAcc, r.state);
    byBand.set(band, bandAcc);

    const collKey = r.collectionId === null ? 'none' : String(r.collectionId);
    const collAcc = byColl.get(collKey) ?? emptyStats();
    tally(collAcc, r.state);
    byColl.set(collKey, collAcc);

    // Graduation: only COMPLETED (`deleted`) policy batches count.
    if (policyBatchIds.has(r.batchId) && r.batchState === 'deleted') {
      const pb =
        policyBatch.get(r.batchId) ??
        { mediaKind: r.mediaKind, deletedAt: r.batchDeletedAt, ...emptyStats(), restores: 0 };
      tally(pb, r.state);
      if (r.state === 'deleted' && r.mediaItemId !== null && restoredSet.has(r.mediaItemId)) {
        pb.restores += 1;
      }
      policyBatch.set(r.batchId, pb);
    }
  }

  const toCells = (
    m: Map<string, { rescued: number; deleted: number; skipped: number }>,
    label: (k: string) => string,
  ): TuningCell[] =>
    [...m.entries()].map(([key, acc]) => ({ key, label: label(key), ...toStats(acc) }));

  const byResolution = toCells(byRes, (k) => k).sort((a, b) => b.proposed - a.proposed);
  const byRatingBand = toCells(byBand, (k) => k).sort(
    (a, b) => RATING_BANDS.indexOf(a.key as RatingBand) - RATING_BANDS.indexOf(b.key as RatingBand),
  );
  const byCollection = toCells(byColl, (k) => (k === 'none' ? 'No collection' : `Collection ${k}`)).sort(
    (a, b) => b.proposed - a.proposed,
  );

  // ---- graduation readiness ----
  const completed = [...policyBatch.entries()]
    .map(([batchId, pb]) => ({ batchId, ...pb }))
    .sort((a, b) => (b.deletedAt?.getTime() ?? 0) - (a.deletedAt?.getTime() ?? 0));
  const recent = completed.slice(0, GRADUATION_THRESHOLDS.minCompletedBatches);
  const recentGrad: GraduationBatch[] = recent.map((b) => ({
    batchId: b.batchId,
    mediaKind: b.mediaKind,
    deletedAt: b.deletedAt?.toISOString() ?? null,
    rescued: b.rescued,
    deleted: b.deleted,
    skipped: b.skipped,
    saveRatePct: saveRate(b.rescued, b.deleted),
    restores: b.restores,
  }));
  const aggAcc = recent.reduce(
    (acc, b) => {
      acc.rescued += b.rescued;
      acc.deleted += b.deleted;
      acc.skipped += b.skipped;
      return acc;
    },
    emptyStats(),
  );
  const aggregate = toStats(aggAcc);
  const restoresOfSwept = recent.reduce((n, b) => n + b.restores, 0);
  const meetsCriteria =
    completed.length >= GRADUATION_THRESHOLDS.minCompletedBatches &&
    aggregate.saveRatePct !== null &&
    aggregate.saveRatePct <= GRADUATION_THRESHOLDS.maxSaveRatePct &&
    restoresOfSwept <= GRADUATION_THRESHOLDS.maxRestores;

  return {
    overall: toStats(overall),
    byResolution,
    byRatingBand,
    byCollection,
    graduation: {
      thresholds: GRADUATION_THRESHOLDS,
      completedPolicyBatches: completed.length,
      recent: recentGrad,
      aggregate,
      restoresOfSwept,
      meetsCriteria,
    },
  };
}
