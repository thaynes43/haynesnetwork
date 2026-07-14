// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the AGGREGATOR: merge every source adapter's
// LIVE items (each degrade-safe), join the durable failure ledger (fill the failure detail href), apply the
// per-viewer section gate, and compute the chip counts. Source-agnostic — adding the *arr/Kapowarr adapter
// is a one-line change to the adapter list the API hands in (DESIGN-030 D-08).
import { activityImportFailures, bookRequests, mediaItems, type DbClient } from '@hnet/db';
import { inArray, isNull, or } from 'drizzle-orm';
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
import { parseKapowarrActivityRef } from './kapowarr-adapter';

export interface ActivityCounts {
  total: number;
  stages: Record<ActivityStage, number>;
  /** Only kinds present in the gated set (populated-value-gated chips — DESIGN-030 D-02). */
  kinds: Partial<Record<ActivityKind, number>>;
}

/**
 * A source that could not be read this aggregation (its adapter threw — a missing env, an unreachable
 * upstream, a timeout). Carries the family `source`, the human `label` for the non-blocking notice, and a
 * `reason` (terse, non-secret). A source that returned [] is NOT here — that's available-with-nothing.
 */
export interface ActivityUnavailableSource {
  source: string;
  label: string;
  reason: string;
}

export interface ActivityListResult {
  items: ActivityItem[];
  counts: ActivityCounts;
  /** Sources that degraded this read (per-source failure isolation — one down never blanks the rest). */
  unavailable: ActivityUnavailableSource[];
}

/** A per-wall in-flight signal keyed by an adapter join key (books: the LL/GB bookId). */
export interface WallStage {
  stage: ActivityStage;
  progress: number | null;
}

interface AggregateLogger {
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** The `?from=` back-link key so a detail page reached from Activity returns to the Activity tab (+ its
 *  URL filters) — the closed-dictionary key added to lib/back-link.ts (never a raw URL). */
const ACTIVITY_FROM = 'activity';

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

/** Derive an item's failure-ledger source family from its id prefix (matches each adapter's `source`
 *  column: `arr` / `books` / `kapowarr`). The stable ref is self-describing, so the flat item list needs
 *  no per-adapter bookkeeping to rebuild the failure-href key. */
export function activityFamilyOf(id: string): 'arr' | 'books' | 'kapowarr' | null {
  if (id.startsWith('arr:')) return 'arr';
  if (id.startsWith('books:')) return 'books';
  if (id.startsWith('kapowarr:')) return 'kapowarr';
  return null;
}

/**
 * DESIGN-030 D-09 (owner CLICKABILITY ruling) — fill EVERY item's in-app `href` in place, not just failures:
 *  • a `failed` item → its failure-detail page (`/library/activity/<rowId>`), once the ledger row id is known;
 *  • a non-failed *arr item → its LEDGER detail (`/library/<mediaItemId>`), joined by (arr_kind, arr_item_id);
 *  • a non-failed book / audiobook item → its Wanted detail (`/library/books/wanted/<requestId>`), joined by
 *    ll_book_id;
 *  • a non-failed comic item → its Wanted detail, joined by kapowarr_volume_id.
 * Every link carries `?from=activity` so the detail page's Back returns to the Activity tab (its filters ride
 * the tab URL). A join MISS (an in-flight item the ledger/request tables don't yet know — e.g. a brand-new
 * grab not yet synced) leaves href null: an inert tile, the honest fallback (never a broken link). The pure
 * per-source adapters stay I/O-free; these joins live at the aggregator seam — the only layer with DB access,
 * exactly like the pre-existing failure-href join. Two bounded queries, each skipped when it has no candidates.
 */
export async function resolveActivityHrefs(db: DbClient, items: ActivityItem[]): Promise<void> {
  const failureHrefs = await loadFailureHrefs(db);

  // Collect the non-failed join candidates (a failure keeps its failure-detail href, resolved below).
  const arrItemIds = new Set<number>();
  const arrKeyById = new Map<string, string>(); // item.id -> `${arrKind}:${parentId}`
  const bookIdById = new Map<string, string>(); // item.id -> ll_book_id
  const volumeIdById = new Map<string, number>(); // item.id -> kapowarr volumeId
  for (const it of items) {
    if (it.stage === 'failed') continue;
    const arr = parseArrActivityRef(it.id);
    if (arr) {
      arrItemIds.add(arr.parentId);
      arrKeyById.set(it.id, `${arr.arrKind}:${arr.parentId}`);
      continue;
    }
    const book = /^books:ll:([^:]+):/.exec(it.id);
    if (book) {
      bookIdById.set(it.id, book[1]!);
      continue;
    }
    const kapo = parseKapowarrActivityRef(it.id);
    if (kapo) volumeIdById.set(it.id, kapo.volumeId);
  }

  // media_items detail hrefs, keyed `${arr_kind}:${arr_item_id}` (a numeric id can repeat across kinds).
  const arrHrefByKey = new Map<string, string>();
  if (arrItemIds.size > 0) {
    const rows = await db
      .select({ id: mediaItems.id, arrKind: mediaItems.arrKind, arrItemId: mediaItems.arrItemId })
      .from(mediaItems)
      .where(inArray(mediaItems.arrItemId, [...arrItemIds]));
    for (const r of rows) arrHrefByKey.set(`${r.arrKind}:${r.arrItemId}`, r.id);
  }

  // book_requests wanted-detail hrefs (one book id / volume id can map to several household requests — any
  // representative requestId opens the household Wanted detail).
  const bookIds = new Set(bookIdById.values());
  const volumeIds = new Set(volumeIdById.values());
  const requestByBookId = new Map<string, string>();
  const requestByVolumeId = new Map<string, string>();
  if (bookIds.size > 0 || volumeIds.size > 0) {
    const conds = [];
    if (bookIds.size > 0) conds.push(inArray(bookRequests.llBookId, [...bookIds]));
    if (volumeIds.size > 0) conds.push(inArray(bookRequests.kapowarrVolumeId, [...volumeIds].map(String)));
    const rows = await db
      .select({
        id: bookRequests.id,
        llBookId: bookRequests.llBookId,
        kapowarrVolumeId: bookRequests.kapowarrVolumeId,
      })
      .from(bookRequests)
      .where(conds.length === 1 ? conds[0]! : or(...conds));
    for (const r of rows) {
      if (r.llBookId != null && !requestByBookId.has(r.llBookId)) requestByBookId.set(r.llBookId, r.id);
      if (r.kapowarrVolumeId != null && !requestByVolumeId.has(r.kapowarrVolumeId)) {
        requestByVolumeId.set(r.kapowarrVolumeId, r.id);
      }
    }
  }

  for (const it of items) {
    if (it.stage === 'failed') {
      const family = activityFamilyOf(it.id);
      const rowId = family ? failureHrefs.get(`${family}:${it.id}`) : undefined;
      if (rowId != null) it.href = `/library/activity/${rowId}?from=${ACTIVITY_FROM}`;
      continue; // no ledger row yet → keep the adapter default (null)
    }
    const arrKey = arrKeyById.get(it.id);
    if (arrKey !== undefined) {
      const mediaId = arrHrefByKey.get(arrKey);
      if (mediaId != null) it.href = `/library/${mediaId}?from=${ACTIVITY_FROM}`;
      continue;
    }
    const bookId = bookIdById.get(it.id);
    if (bookId !== undefined) {
      const reqId = requestByBookId.get(bookId);
      if (reqId != null) it.href = `/library/books/wanted/${reqId}?from=${ACTIVITY_FROM}`;
      continue;
    }
    const volumeId = volumeIdById.get(it.id);
    if (volumeId !== undefined) {
      const reqId = requestByVolumeId.get(String(volumeId));
      if (reqId != null) it.href = `/library/books/wanted/${reqId}?from=${ACTIVITY_FROM}`;
    }
  }
}

/** A terse, non-secret one-line reason for a degraded source (the env-assertion class names the ABSENT
 *  variable, never its value — safe to surface). Clamped so a giant stack/message can't bloat the notice. */
export function describeSourceError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  const clean = msg.length > 0 ? msg : 'the source is unreachable';
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}

/**
 * Wrap a source FACTORY + label into an adapter whose `list()` also absorbs CONSTRUCTION. The env-built
 * adapters assert their config at construction time (a missing `SABNZBD_API_KEY` throws there, BEFORE
 * `list()`), so building them eagerly would throw OUTSIDE the aggregator's per-source try/catch and blank
 * the whole read (the prod incident). Deferring `resolve()` into `list()` moves that throw INSIDE the
 * isolation boundary — the aggregator degrades just that source. Pure: no I/O until `list()`.
 */
export function lazyActivityAdapter(input: {
  source: string;
  label: string;
  resolve: () => ActivitySourceAdapter;
}): ActivitySourceAdapter {
  return {
    source: input.source,
    label: input.label,
    async list() {
      // resolve() may throw (env assertion) — that now happens inside list(), so the aggregator isolates it.
      return input.resolve().list();
    },
  };
}

/**
 * Aggregate all source adapters into one gated, counted, ledger-joined activity list. Each adapter is
 * awaited INDEPENDENTLY: a source that throws (missing env, unreachable upstream, timeout) is logged and
 * recorded as an `unavailable` marker (source + label + terse reason) while the OTHER sources' items still
 * flow — one down never blanks the read. A source that returns [] is available-with-nothing (NOT
 * unavailable). A `failed` item whose ledger row exists gets its failure-detail href; a not-yet-scanned
 * failure shows as failed with no link until the next `activity-scan` writes its row.
 */
export async function aggregateActivity(input: {
  db?: DbClient;
  adapters: ActivitySourceAdapter[];
  /** The sections the viewer may see (e.g. ['books'] when books ≥ read_only). Universal (null) items always pass. */
  visibleSections: ActivitySection[];
  logger?: AggregateLogger;
  /** Fill each item's click-through `href` (D-09). Default true; the `wallStages`/`itemStatus` reads that
   *  never render an ActivityCard pass `false` to skip the (bounded) ledger/request join queries. */
  resolveHrefs?: boolean;
}): Promise<ActivityListResult> {
  const db = resolveDb(input.db);
  const visible = new Set<ActivitySection>(input.visibleSections);

  const collected: ActivityItem[] = [];
  const unavailable: ActivityUnavailableSource[] = [];
  for (const adapter of input.adapters) {
    let items: ActivityItem[];
    try {
      items = await adapter.list();
    } catch (err) {
      const reason = describeSourceError(err);
      input.logger?.warn?.('activity: source degraded', { source: adapter.source, error: reason });
      unavailable.push({ source: adapter.source, label: adapter.label ?? adapter.source, reason });
      continue;
    }
    // Shallow-copy so href resolution mutates aggregator-owned objects, never the adapter's return value.
    for (const item of items) collected.push({ ...item });
  }

  const gated = collected.filter((it) => it.section === null || visible.has(it.section));
  if (input.resolveHrefs !== false) await resolveActivityHrefs(db, gated);
  gated.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0));
  return { items: gated, counts: computeActivityCounts(gated), unavailable };
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
 * key by); Kapowarr items encode `kapowarr:<volumeId>` → the volume id the comics-wall posters carry. Each
 * family adds its own parse here (DESIGN-030 D-08 step 3) — the fan-out seam.
 */
function wallJoinKey(it: ActivityItem): string | null {
  const books = /^books:ll:([^:]+):/.exec(it.id);
  if (books) return books[1] ?? null;
  const arr = parseArrActivityRef(it.id);
  if (arr) return String(arr.parentId);
  const kapowarr = parseKapowarrActivityRef(it.id);
  if (kapowarr) return String(kapowarr.volumeId);
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
