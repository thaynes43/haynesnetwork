// ADR-035 / DESIGN-010 amendment (2026-07-09) — the Trash candidate READ-MODEL. The live profile
// showed every Trash tab visit re-crawling Maintainerr's paged collection API (742 movies = 15
// serial 50-item pages ≈ 6–9 s cold, fired up to FOUR times concurrently by one tab load), so the
// USER-FACING pending reads now serve from a Postgres snapshot refreshed by the sync CronJobs and
// on demand. THE READ-MODEL IS DISPLAY-ONLY: Maintainerr stays the deletion system of record, and
// every destructive/mutating flow (expedite, batch create, sweep, guardian, exclusion writes)
// still reads the LIVE pending set through the guarded seams in trash-flow.ts / trash-batches.ts.
//
// This module is the SINGLE WRITER for `trash_candidates` + `trash_candidates_state` (the
// no-direct-state-writes guard enforces the package boundary). The snapshot is derived,
// rebuildable state — refreshes intentionally write no ledger audit rows (ADR-035 C-05).
import {
  trashCandidates,
  trashCandidatesState,
  TRASH_MEDIA_KINDS,
  type DbClient,
  type TrashMediaKind,
} from '@hnet/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { activeBatchStrategy, getAppSetting } from './app-settings';
import { compareByStrategy, type BatchStrategy } from './trash-strategy';
import type { MaintainerrClientBundle } from './maintainerr-clients';
import {
  bucketFlatPendingForMedia,
  fetchLiveExclusions,
  fetchMaintainerrPending,
  shapePendingItems,
  type FlatPending,
  type TrashMedia,
  type TrashPendingItem,
  type TrashPendingResult,
} from './trash-flow';

// ---------------------------------------------------------------------------
// Freshness policy (the serve-stale contract)
// ---------------------------------------------------------------------------

export interface CandidateFreshnessPolicy {
  /** A snapshot no older than this serves without touching Maintainerr at all. */
  maxAgeMs: number;
  /** Behaviour past maxAge: true ⇒ serve the stale snapshot NOW and refresh in the background
   *  (production — the wall paints instantly and survives a Maintainerr outage); false ⇒ refresh
   *  INLINE before serving (read-through equivalence for dev/e2e/vitest, where a stub-state change
   *  must be visible on the very next read — same determinism rationale as the retired page memo). */
  serveStale: boolean;
}

/** Production: candidates may be up to one missed sync-incremental tick stale (the CronJob runs
 *  every 15 min; the UI shows "as of N min ago" + a Refresh affordance, DESIGN-010 amendment).
 *  Non-production: maxAge 0 + inline ⇒ every read refreshes first (read-through equivalence). */
const defaultFreshness = (): CandidateFreshnessPolicy =>
  process.env.NODE_ENV === 'production'
    ? { maxAgeMs: 20 * 60_000, serveStale: true }
    : { maxAgeMs: 0, serveStale: false };

let freshness: CandidateFreshnessPolicy = defaultFreshness();

/** Test seam — override (or `null`-reset) the freshness policy. */
export function __setCandidateFreshnessForTests(policy: CandidateFreshnessPolicy | null): void {
  freshness = policy ?? defaultFreshness();
}

// ---------------------------------------------------------------------------
// Refresh (the single writer)
// ---------------------------------------------------------------------------

export interface TrashCandidatesRefreshReport {
  refreshedAt: string;
  durationMs: number;
  /** Per-kind snapshot sizes after the rebuild. */
  kinds: Array<{ mediaKind: TrashMediaKind; itemCount: number; totalSizeBytes: number }>;
}

/** One refresh crawls ALL collections (both kinds) — TV is small and a single atomic rebuild keeps
 *  the two kind snapshots + state rows consistent with one Maintainerr view. */
export async function refreshTrashCandidates(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
}): Promise<TrashCandidatesRefreshReport> {
  const started = Date.now();
  // The crawl runs OUTSIDE the transaction (network I/O never holds row locks).
  const flat = await fetchMaintainerrPending(input.maintainerr);
  const byKind = TRASH_MEDIA_KINDS.map((kind) => ({
    kind,
    rows: bucketFlatPendingForMedia(flat, kind),
  }));
  const refreshedAt = new Date();

  await inTransaction(input.db, async (tx) => {
    // Serialize concurrent rebuilds (web on-demand vs. CronJob) — last completed crawl wins whole.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('trash_candidates'))`);
    await tx.delete(trashCandidates);
    for (const { kind, rows } of byKind) {
      // Chunked inserts (bounded parameter count; household scale is one chunk).
      for (let i = 0; i < rows.length; i += 500) {
        await tx.insert(trashCandidates).values(
          rows.slice(i, i + 500).map((f, j) => ({
            ord: i + j,
            mediaKind: kind,
            collectionId: f.collectionId,
            collectionTitle: f.collectionTitle,
            deleteAfterDays: f.deleteAfterDays,
            maintainerrMediaId: f.maintainerrMediaId,
            tmdbId: f.tmdbId,
            tvdbId: f.tvdbId,
            sizeBytes: f.sizeBytes,
            addDate: f.addDate,
          })),
        );
      }
      const totals = {
        refreshedAt,
        itemCount: rows.length,
        totalSizeBytes: rows.reduce((n, f) => n + f.sizeBytes, 0),
      };
      await tx
        .insert(trashCandidatesState)
        .values({ mediaKind: kind, ...totals })
        .onConflictDoUpdate({ target: trashCandidatesState.mediaKind, set: totals });
    }
  });

  return {
    refreshedAt: refreshedAt.toISOString(),
    durationMs: Date.now() - started,
    kinds: byKind.map(({ kind, rows }) => ({
      mediaKind: kind,
      itemCount: rows.length,
      totalSizeBytes: rows.reduce((n, f) => n + f.sizeBytes, 0),
    })),
  };
}

/** The deduped fire-and-forget refresh (a stale read in serve-stale mode, or a rule edit, kicks
 *  one). Failures are swallowed — the wall keeps serving the stale-but-honest snapshot ("as of N
 *  min ago") and the next stale read retries; the SafetyBanner reports Maintainerr health. */
let inflightRefresh: Promise<void> | null = null;
export function triggerCandidateRefresh(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
}): void {
  if (inflightRefresh !== null) return;
  inflightRefresh = refreshTrashCandidates(input)
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      inflightRefresh = null;
    });
}

/**
 * Drop the read-model rows for items an app flow JUST deleted (expedite / batch sweep), so the
 * wall reflects the deletion immediately instead of after the next refresh. State counts are
 * recomputed in the same transaction; `refreshed_at` is intentionally left untouched (the
 * snapshot's Maintainerr view is no fresher than it was). Read-model only — never a Maintainerr
 * write. No-op (no transaction) for an empty id list.
 */
export async function removeTrashCandidateRows(input: {
  db?: DbClient;
  maintainerrMediaIds: readonly string[];
}): Promise<{ removed: number }> {
  const ids = [...new Set(input.maintainerrMediaIds)];
  if (ids.length === 0) return { removed: 0 };
  return inTransaction(input.db, async (tx) => {
    const gone = await tx
      .delete(trashCandidates)
      .where(inArray(trashCandidates.maintainerrMediaId, ids))
      .returning({ id: trashCandidates.id });
    if (gone.length > 0) {
      await tx.execute(sql`
        UPDATE trash_candidates_state s SET
          item_count = (SELECT count(*) FROM trash_candidates c WHERE c.media_kind = s.media_kind),
          total_size_bytes = (SELECT coalesce(sum(c.size_bytes), 0) FROM trash_candidates c WHERE c.media_kind = s.media_kind)
      `);
    }
    return { removed: gone.length };
  });
}

// ---------------------------------------------------------------------------
// Snapshot read (freshness-aware)
// ---------------------------------------------------------------------------

interface CandidateSnapshot {
  flat: FlatPending[];
  refreshedAt: Date;
}

async function readCandidateState(
  db: ReturnType<typeof resolveDb>,
  media: TrashMedia,
): Promise<{ refreshedAt: Date; itemCount: number; totalSizeBytes: number } | undefined> {
  const [row] = await db
    .select()
    .from(trashCandidatesState)
    .where(eq(trashCandidatesState.mediaKind, media))
    .limit(1);
  return row;
}

/** Read one kind's flat snapshot, honoring the freshness policy: fresh ⇒ serve; stale + serve-stale
 *  ⇒ serve now and refresh in the background; stale + inline (non-prod) or NEVER REFRESHED ⇒
 *  refresh first (an inline refresh failure propagates — same surface as the old read-through). */
export async function readCandidateSnapshot(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
  media: TrashMedia;
}): Promise<CandidateSnapshot> {
  const db = resolveDb(input.db);
  let state = await readCandidateState(db, input.media);
  const age = state === undefined ? Infinity : Date.now() - state.refreshedAt.getTime();
  if (state === undefined || (age > freshness.maxAgeMs && !freshness.serveStale)) {
    await refreshTrashCandidates({ db: input.db, maintainerr: input.maintainerr });
    state = await readCandidateState(db, input.media);
    if (state === undefined) throw new Error('trash_candidates_state missing after refresh');
  } else if (age > freshness.maxAgeMs) {
    triggerCandidateRefresh({ db: input.db, maintainerr: input.maintainerr });
  }
  const rows = await db
    .select()
    .from(trashCandidates)
    .where(eq(trashCandidates.mediaKind, input.media))
    .orderBy(trashCandidates.ord);
  return {
    refreshedAt: state.refreshedAt,
    flat: rows.map((r) => ({
      collectionId: r.collectionId,
      collectionTitle: r.collectionTitle,
      deleteAfterDays: r.deleteAfterDays,
      collectionKind: r.mediaKind,
      maintainerrMediaId: r.maintainerrMediaId,
      tmdbId: r.tmdbId,
      tvdbId: r.tvdbId,
      sizeBytes: r.sizeBytes,
      addDate: r.addDate,
    })),
  };
}

// ---------------------------------------------------------------------------
// The user-facing pending reads (page / candidate list / count) — snapshot-backed
// ---------------------------------------------------------------------------

/**
 * The wire sort fields the pending wall offers (mirrors the client sort bar). DESIGN-010/014 amendment
 * (2026-07-09, build D): the dead 'scheduled' ("Deletes ↑") sort is RETIRED — Maintainerr's per-item
 * countdown is defused (deleteAfterDays 9999), so a delete date is meaningless. It is replaced by
 * 'strategy' ("Next up"), the NEW DEFAULT, which mirrors the active batch-selection strategy (see
 * comparePending / activeBatchStrategy) so the top of the wall is the front of the deletion queue.
 */
export type TrashPendingSortField = 'strategy' | 'title' | 'size' | 'rating';
export interface TrashPendingSort {
  field: TrashPendingSortField;
  dir: 'asc' | 'desc';
}

/** The facet filters the pending wall's chips narrow by (OR within a field, AND across fields). */
export interface TrashPendingFilters {
  query?: string;
  genres?: string[];
  resolutions?: string[];
  requesters?: string[];
  sourceCollections?: string[];
  ratingMin?: number;
  ratingMax?: number;
}

/** The distinct facet values across a set (drives the chip menus without shipping the whole set). */
export interface TrashPendingFacets {
  genres: string[];
  resolutions: string[];
  requesters: string[];
  sourceCollections: string[];
}

/** The Expedite-all preview partition computed server-side over the WHOLE kind set (mirrors the
 *  client previewGuardian) so the confirm modal is honest without loading every tile. */
export interface TrashExpeditePreview {
  deletable: number;
  deletableBytes: number;
  protected: number;
  unverifiable: number;
}

export interface TrashPendingPage {
  /** The page slice, in the requested sort order, with page-scoped `protectedByExclusion`. */
  items: TrashPendingItem[];
  /** Opaque forward cursor (an offset into the shaped set); null when this is the last page. */
  nextCursor: number | null;
  /** TRUE total for the kind AFTER any excludeMaintainerrIds (the honest counts-bar number). */
  total: number;
  /** Total bytes of that same set (unfiltered). */
  totalSizeBytes: number;
  /** Count after the filters/search are applied. */
  filteredCount: number;
  /** Bytes after the filters/search are applied. */
  filteredSizeBytes: number;
  /** ADR-035 — when the candidate snapshot this page serves from was last rebuilt (the walls'
   *  "candidates as of N min ago" honesty line + Refresh affordance). */
  refreshedAt: string;
  /** First-page-only extras (null on later pages to keep payloads lean): the facet menus, the
   *  Expedite-all preview, and the full actionable-id snapshot the confirm pins the run to. */
  facets: TrashPendingFacets | null;
  expeditePreview: TrashExpeditePreview | null;
  allActionableIds: string[] | null;
}

const ratingOf = (i: TrashPendingItem): number | null => {
  const imdb = i.imdbRating !== null && i.imdbRating > 0 ? i.imdbRating : null;
  const tmdb = i.tmdbRating !== null && i.tmdbRating > 0 ? i.tmdbRating : null;
  return imdb ?? tmdb;
};

/**
 * Comparator over the wire sort fields, tie-broken by a stable per-item key. The 'strategy' ("Next up")
 * field defers to the SHARED compareByStrategy (identical to selectBatchCandidates' ranking) for the
 * resolved kind `strategy` — worst-rated = rating asc with UNRATED FIRST, ties size desc; largest = size
 * desc — so the wall's top is the front of the deletion queue. Title/Size/Rating keep the generic
 * nulls-LAST numeric ordering (an item with no size/rating sinks regardless of direction).
 */
function comparePending(
  a: TrashPendingItem,
  b: TrashPendingItem,
  sort: TrashPendingSort,
  strategy: BatchStrategy,
): number {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const num = (x: number | null, y: number | null): number => {
    if (x === null && y === null) return 0;
    if (x === null) return 1; // nulls last regardless of direction
    if (y === null) return -1;
    return (x - y) * sign;
  };
  let primary = 0;
  switch (sort.field) {
    case 'strategy':
      // asc = the strategy order (front of the deletion queue first); desc reverses it. The strategy
      // ranking already fully orders (incl. its own size/title tiebreak), so a 0 here is a true tie.
      primary = compareByStrategy(a, b, strategy) * sign;
      break;
    case 'title':
      primary = a.title.localeCompare(b.title) * sign;
      break;
    case 'size':
      primary = num(a.sizeBytes, b.sizeBytes);
      break;
    case 'rating':
      primary = num(ratingOf(a), ratingOf(b));
      break;
  }
  if (primary !== 0) return primary;
  // Stable tiebreak so offset paging never overlaps/skips within equal keys.
  return stableKey(a).localeCompare(stableKey(b));
}

const stableKey = (i: TrashPendingItem): string =>
  `${i.collectionId}:${i.maintainerrMediaId ?? ''}:${i.title}`;

function matchesFilters(item: TrashPendingItem, f: TrashPendingFilters): boolean {
  const q = f.query?.trim().toLowerCase();
  if (q !== undefined && q !== '' && !item.title.toLowerCase().includes(q)) return false;
  if (f.genres && f.genres.length > 0 && !f.genres.some((g) => item.genres.includes(g)))
    return false;
  if (
    f.resolutions &&
    f.resolutions.length > 0 &&
    (item.resolution === null || !f.resolutions.includes(item.resolution))
  )
    return false;
  if (
    f.requesters &&
    f.requesters.length > 0 &&
    !f.requesters.some((r) => item.requesters.includes(r))
  )
    return false;
  if (
    f.sourceCollections &&
    f.sourceCollections.length > 0 &&
    !f.sourceCollections.some((c) => item.sourceCollections.includes(c))
  )
    return false;
  if (f.ratingMin !== undefined || f.ratingMax !== undefined) {
    const r = ratingOf(item);
    if (r === null) return false;
    if (f.ratingMin !== undefined && r < f.ratingMin) return false;
    if (f.ratingMax !== undefined && r > f.ratingMax) return false;
  }
  return true;
}

function pendingFacets(items: readonly TrashPendingItem[]): TrashPendingFacets {
  const g = new Set<string>();
  const res = new Set<string>();
  const req = new Set<string>();
  const col = new Set<string>();
  for (const i of items) {
    for (const v of i.genres) g.add(v);
    if (i.resolution !== null) res.add(i.resolution);
    for (const v of i.requesters) req.add(v);
    for (const v of i.sourceCollections) col.add(v);
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return {
    genres: sorted(g),
    resolutions: sorted(res),
    requesters: sorted(req),
    sourceCollections: sorted(col),
  };
}

/** Partition the way expediteDeletion scope 'all' will (mirrors the client previewGuardian). */
function partitionPendingForExpedite(items: readonly TrashPendingItem[]): TrashExpeditePreview {
  const out: TrashExpeditePreview = { deletable: 0, deletableBytes: 0, protected: 0, unverifiable: 0 };
  for (const i of items) {
    if (i.maintainerrMediaId === null) {
      out.unverifiable += 1;
    } else if (i.protectedByTag) {
      out.protected += 1;
    } else if (i.recentlyWatched) {
      out.protected += 1;
    } else if (i.requesters.length > 0) {
      out.protected += 1;
    } else if (i.mediaItemId === null) {
      out.unverifiable += 1;
    } else {
      out.deletable += 1;
      out.deletableBytes += i.sizeBytes;
    }
  }
  return out;
}

/** Snapshot rows → shaped wire items (the same ledger/metadata join the live read uses, so
 *  title/tags/watch/requester facets are as fresh as the media sync even between refreshes). */
async function materializeSnapshotPending(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
  media: TrashMedia;
  watchWindowDays?: number;
}): Promise<TrashPendingResult & { refreshedAt: Date }> {
  const snap = await readCandidateSnapshot(input);
  const shaped = await shapePendingItems({
    db: input.db,
    media: input.media,
    flat: snap.flat,
    watchWindowDays: input.watchWindowDays,
  });
  return { ...shaped, refreshedAt: snap.refreshedAt };
}

/**
 * DESIGN-010 D-02 (owner-directed 2026-07-09; ADR-035 snapshot-backed) — the PAGINATED pending
 * read. Serves the kind's set from the candidate snapshot (freshness-policed above), optionally
 * drops `excludeMaintainerrIds` (the open batch's members — the "Potential in future batches"
 * strip), applies filter/search/sort server-side, slices the requested page, and cross-checks LIVE
 * Maintainerr exclusions for THAT PAGE ONLY (protection state stays real-time). The first page
 * also carries the facet menus, the Expedite-all preview, and the full actionable-id snapshot.
 */
export async function listTrashPendingPage(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
  media: TrashMedia;
  watchWindowDays?: number;
  filters?: TrashPendingFilters;
  sort?: TrashPendingSort;
  limit: number;
  offset: number;
  /** Exclude these Maintainerr ids from the whole read (the future-batch strip omits batch members). */
  excludeMaintainerrIds?: readonly string[];
}): Promise<TrashPendingPage> {
  const base = await materializeSnapshotPending(input);
  // DESIGN-014 amendment (build D) — mirror the ACTIVE batch-selection strategy for this kind so the
  // default 'strategy' ("Next up") sort orders the wall exactly like the next batch's pick would. Read
  // the raw space_policy setting (fail-safe resolver); default 'worst-rated' when unset.
  const strategy = activeBatchStrategy(
    await getAppSetting(input.db, 'space_policy'),
    input.media as TrashMediaKind,
  );
  const sort: TrashPendingSort = input.sort ?? { field: 'strategy', dir: 'asc' };

  const exclude =
    input.excludeMaintainerrIds && input.excludeMaintainerrIds.length > 0
      ? new Set(input.excludeMaintainerrIds)
      : null;
  const universe =
    exclude === null
      ? base.items
      : base.items.filter(
          (i) => i.maintainerrMediaId === null || !exclude.has(i.maintainerrMediaId),
        );

  const total = universe.length;
  const totalSizeBytes = universe.reduce((n, i) => n + i.sizeBytes, 0);

  const filters = input.filters ?? {};
  const filtered = universe.filter((i) => matchesFilters(i, filters));
  const filteredCount = filtered.length;
  const filteredSizeBytes = filtered.reduce((n, i) => n + i.sizeBytes, 0);

  const sorted = [...filtered].sort((a, b) => comparePending(a, b, sort, strategy));
  const offset = Math.max(0, input.offset);
  const slice = sorted.slice(offset, offset + input.limit);
  const nextCursor = offset + input.limit < filteredCount ? offset + input.limit : null;

  // Page-scoped LIVE-exclusion cross-check — ≤ limit reads, never one per item in the entire kind
  // set; kept LIVE (not snapshotted) so a just-saved item shows Protected on the very next paint.
  // (F1/D-08/D-09 semantics preserved for the visible page.)
  const liveExcluded = await fetchLiveExclusions(
    input.maintainerr,
    slice.map((i) => i.maintainerrMediaId).filter((id): id is string => id !== null),
  );
  const items = slice.map((i) => ({
    ...i,
    protectedByExclusion:
      i.maintainerrMediaId !== null && liveExcluded.has(i.maintainerrMediaId),
  }));

  const firstPage = offset === 0;
  return {
    items,
    nextCursor,
    total,
    totalSizeBytes,
    filteredCount,
    filteredSizeBytes,
    refreshedAt: base.refreshedAt.toISOString(),
    facets: firstPage ? pendingFacets(universe) : null,
    expeditePreview: firstPage ? partitionPendingForExpedite(universe) : null,
    allActionableIds: firstPage
      ? universe
          .map((i) => i.maintainerrMediaId)
          .filter((id): id is string => id !== null)
      : null,
  };
}

/** One actionable candidate — the minimal shape the Start-a-batch preview + count header read. */
export interface TrashPendingCandidate {
  maintainerrMediaId: string;
  mediaItemId: string | null;
  title: string;
  year: number | null;
  posterSource: string | null;
  sizeBytes: number;
  imdbRating: number | null;
  tmdbRating: number | null;
  protectedByTag: boolean;
}

/**
 * The full actionable-candidate list for a kind (a Maintainerr id present) + the TRUE candidate
 * count. Backs the admin Start-a-batch target preview and the "N candidates" header without the
 * per-item live-exclusion cost or shipping poster-heavy tiles. Snapshot-backed (ADR-035) — the
 * batch CREATE itself re-picks from a FRESH live crawl (createBatchFromPending), so this preview
 * being ≤ one refresh stale never steers a deletion.
 */
export async function listTrashPendingCandidates(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
  media: TrashMedia;
  watchWindowDays?: number;
}): Promise<{ candidates: TrashPendingCandidate[]; count: number; refreshedAt: string }> {
  const base = await materializeSnapshotPending(input);
  const candidates = base.items
    .filter((i): i is TrashPendingItem & { maintainerrMediaId: string } => i.maintainerrMediaId !== null)
    .map((i) => ({
      maintainerrMediaId: i.maintainerrMediaId,
      mediaItemId: i.mediaItemId,
      title: i.title,
      year: i.year,
      posterSource: i.posterSource,
      sizeBytes: i.sizeBytes,
      imdbRating: i.imdbRating,
      tmdbRating: i.tmdbRating,
      protectedByTag: i.protectedByTag,
    }));
  return { candidates, count: candidates.length, refreshedAt: base.refreshedAt.toISOString() };
}

/**
 * DESIGN-010 amendment — the CHEAP per-kind count + reclaimable bytes for the Overview cards/
 * badges: one `trash_candidates_state` row (ADR-035), no crawl, no ledger join. A never-refreshed
 * install refreshes inline once; a failure there propagates so the Overview can degrade the kind
 * to `live: false` exactly as before.
 */
export async function countTrashPending(input: {
  db?: DbClient;
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
  media: TrashMedia;
}): Promise<{ count: number; totalSizeBytes: number; refreshedAt: string }> {
  const db = resolveDb(input.db);
  let state = await readCandidateState(db, input.media);
  const age = state === undefined ? Infinity : Date.now() - state.refreshedAt.getTime();
  if (state === undefined || (age > freshness.maxAgeMs && !freshness.serveStale)) {
    await refreshTrashCandidates({ db: input.db, maintainerr: input.maintainerr });
    state = await readCandidateState(db, input.media);
    if (state === undefined) throw new Error('trash_candidates_state missing after refresh');
  } else if (age > freshness.maxAgeMs) {
    triggerCandidateRefresh({ db: input.db, maintainerr: input.maintainerr });
  }
  return {
    count: state.itemCount,
    totalSizeBytes: state.totalSizeBytes,
    refreshedAt: state.refreshedAt.toISOString(),
  };
}
