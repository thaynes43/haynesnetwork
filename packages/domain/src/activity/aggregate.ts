// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the AGGREGATOR: merge every source adapter's
// LIVE items (each degrade-safe), join the durable failure ledger (fill the failure detail href), apply the
// per-viewer section gate, and compute the chip counts. Source-agnostic — adding the *arr/Kapowarr adapter
// is a one-line change to the adapter list the API hands in (DESIGN-030 D-08).
import { activityImportFailures, type DbClient } from '@hnet/db';
import { and, eq, isNull } from 'drizzle-orm';
import { resolveDb } from '../db-client';
import {
  ACTIVITY_KINDS,
  ACTIVITY_STAGES,
  type ActivityItem,
  type ActivityKind,
  type ActivitySection,
  type ActivitySourceAdapter,
  type ActivityStage,
  type ActivityWall,
} from './contract';
import { parseArrActivityRef } from './arr-adapter';

export interface ActivityCounts {
  total: number;
  stages: Record<ActivityStage, number>;
  /** Only kinds present in the gated set (populated-value-gated chips — DESIGN-030 D-02). */
  kinds: Partial<Record<ActivityKind, number>>;
}

export interface ActivityListResult {
  items: ActivityItem[];
  counts: ActivityCounts;
}

/** A per-wall in-flight signal keyed by an adapter join key (books: the LL/GB bookId). */
export interface WallStage {
  stage: ActivityStage;
  progress: number | null;
}

interface AggregateLogger {
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Read the OPEN failure ledger into a `${source}:${sourceRef}` → row-id map (the detail-href join). */
async function loadFailureHrefs(db: DbClient): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: activityImportFailures.id,
      source: activityImportFailures.source,
      sourceRef: activityImportFailures.sourceRef,
    })
    .from(activityImportFailures)
    .where(isNull(activityImportFailures.resolvedAt));
  const map = new Map<string, string>();
  for (const r of rows) map.set(`${r.source}:${r.sourceRef}`, r.id);
  return map;
}

/**
 * Aggregate all source adapters into one gated, counted, ledger-joined activity list. Each adapter is
 * awaited independently; a source that throws is logged + skipped (degrade one source, never the whole
 * read). A `failed` item whose ledger row exists gets its failure-detail href; a not-yet-scanned failure
 * shows as failed with no link until the next `activity-scan` writes its row.
 */
export async function aggregateActivity(input: {
  db?: DbClient;
  adapters: ActivitySourceAdapter[];
  /** The sections the viewer may see (e.g. ['books'] when books ≥ read_only). Universal (null) items always pass. */
  visibleSections: ActivitySection[];
  logger?: AggregateLogger;
}): Promise<ActivityListResult> {
  const db = resolveDb(input.db);
  const hrefByKey = await loadFailureHrefs(db);
  const visible = new Set<ActivitySection>(input.visibleSections);

  const collected: ActivityItem[] = [];
  for (const adapter of input.adapters) {
    let items: ActivityItem[];
    try {
      items = await adapter.list();
    } catch (err) {
      input.logger?.warn?.('activity: source degraded', {
        source: adapter.source,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const item of items) {
      const withHref =
        item.stage === 'failed'
          ? { ...item, href: hrefByKey.get(`${adapter.source}:${item.id}`) != null ? `/library/activity/${hrefByKey.get(`${adapter.source}:${item.id}`)}` : item.href }
          : item;
      collected.push(withHref);
    }
  }

  const gated = collected.filter((it) => it.section === null || visible.has(it.section));
  gated.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0));
  return { items: gated, counts: computeActivityCounts(gated) };
}

/** Compute the stage + kind chip counts over an item set (pure; stages zero-filled, kinds populated-only). */
export function computeActivityCounts(items: readonly ActivityItem[]): ActivityCounts {
  const stages = Object.fromEntries(ACTIVITY_STAGES.map((s) => [s, 0])) as Record<ActivityStage, number>;
  const kinds: Partial<Record<ActivityKind, number>> = {};
  for (const it of items) {
    stages[it.stage] += 1;
    kinds[it.kind] = (kinds[it.kind] ?? 0) + 1;
  }
  return { total: items.length, stages, kinds };
}

/**
 * Build the per-wall in-flight signal map the wall posters badge from (DESIGN-030 D-03). For the books
 * family the join key is the LL/GB bookId (the same id the Wanted tiles carry as `llBookId`). Only
 * IN-FLIGHT stages (searching/downloading/importing/failed) produce a badge — a completed item's poster is
 * just the on-disk book. Returns `{ [wall]: { [key]: WallStage } }`.
 */
export function activityWallStages(items: readonly ActivityItem[]): Record<string, Record<string, WallStage>> {
  const out: Record<string, Record<string, WallStage>> = {};
  for (const it of items) {
    if (it.wall === null || it.stage === 'completed') continue;
    const key = wallJoinKey(it);
    if (key === null) continue;
    (out[it.wall] ??= {})[key] = { stage: it.stage, progress: it.progress };
  }
  return out;
}

/**
 * The wall-badge join key for an item — the id each wall's posters carry. Books items encode
 * `books:ll:<bookId>:<format>` → the bookId; *arr items encode `arr:<kind>:<parentId>[:<child>]` → the
 * wall parent (movieId / seriesId / artistId, the `media_items.arr_item_id` the movies/tv/music posters
 * key by). Each family adds its own parse here (DESIGN-030 D-08 step 3) — the fan-out seam.
 */
function wallJoinKey(it: ActivityItem): string | null {
  const books = /^books:ll:([^:]+):/.exec(it.id);
  if (books) return books[1] ?? null;
  const arr = parseArrActivityRef(it.id);
  if (arr) return String(arr.parentId);
  return null;
}

/** The canonical wall list (for the fan-out; unused directly but keeps the type surface documented). */
export const ACTIVITY_WALLS: readonly ActivityWall[] = [
  'movies',
  'tv',
  'music',
  'books',
  'audiobooks',
  'comics',
];

export { ACTIVITY_KINDS, ACTIVITY_STAGES };
