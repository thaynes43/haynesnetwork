// ADR-025 / DESIGN-011 — the Trash CURATION PIPELINE orchestrators. Batches are the deletion unit:
// createBatchFromPending snapshots the current pending set for one media kind into a curated batch;
// admins (and, in the window, users) rescue items (setBatchItemSaved); greenlightBatch promotes the
// batch into a Plex-visible "Leaving Soon" collection with a save window; sweepExpiredBatches deletes
// the survivors one item at a time when the window closes — EVERY ADR-023 safety layer (live
// Maintainerr exclusions + the watch/requester/tag/unevaluable guardian + the SAFE preflight audit)
// re-run at sweep time. Music is never batchable (R-87). Mirrors trash-flow.ts discipline: guarded
// mutations in inTransaction with their audit/ledger rows same-tx; external Maintainerr writes are
// protective-ordered (ADR-023 C-05); fresh-state re-derivation before anything destructive.
//
// STATE MACHINE (C-01): draft → admin_review → leaving_soon → deleted | cancelled. Only `leaving_soon`
// expires, and it is reached ONLY by greenlightBatch OR the audited skip-gate path (gate_skipped) —
// so a batch never deletes without the admin gate. Guarded UPDATEs carry the from-state in their
// WHERE, so a concurrent transition loses the race (TrashBatchStateError) instead of double-acting.
import {
  ledgerEvents,
  mediaItems,
  trashBatchItems,
  trashBatchSaves,
  trashBatches,
  users,
  TRASH_BATCH_OPEN_STATES,
  type DbClient,
  type TrashBatchItemState,
  type TrashBatchState,
  type TrashMediaKind,
} from '@hnet/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getAppSetting } from './app-settings';
import { inTransaction, resolveDb } from './db-client';
import {
  MaintainerrUnsafeError,
  NotFoundError,
  TrashBatchEmptyError,
  TrashBatchOpenError,
  TrashBatchStateError,
} from './errors';
import { isPostgresUniqueViolation } from './errors';
import { guardMaintainerrCall, type MaintainerrClientBundle } from './maintainerr-clients';
import {
  auditMaintainerr,
  classifyGuardian,
  listTrashPending,
  removeExclusion,
  saveExclusion,
  type TrashMedia,
  type TrashPendingItem,
} from './trash-flow';

const nowDate = () => new Date();
const OPEN_STATES = TRASH_BATCH_OPEN_STATES as readonly TrashBatchState[];

/** The Plex media-item `type` code Maintainerr expects for a collection (1 = movie, 2 = show). */
const plexCollectionType = (mediaKind: TrashMediaKind): number => (mediaKind === 'movie' ? 1 : 2);

/** The rolling "Leaving Soon" collection name per media kind (Q-09). */
const leavingSoonName = (mediaKind: TrashMediaKind): string =>
  mediaKind === 'movie' ? 'Leaving Soon — Movies' : 'Leaving Soon — TV';

// ---------------------------------------------------------------------------
// Ledger helpers (every transition/deletion writes its event same-tx)
// ---------------------------------------------------------------------------

interface TxLike {
  insert: DbClient['insert'];
  update: DbClient['update'];
  select: DbClient['select'];
}

/** Append a `trash_batch_transition` ledger event (batch-scoped — mediaItemId null). */
async function writeTransitionEvent(
  tx: TxLike,
  input: {
    batchId: string;
    mediaKind: TrashMediaKind;
    from: TrashBatchState | null;
    to: TrashBatchState;
    actorId: string | null;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(ledgerEvents).values({
    mediaItemId: null,
    eventType: 'trash_batch_transition',
    source: 'maintainerr',
    occurredAt: nowDate(),
    requestedByUserId: input.actorId,
    payload: {
      batchId: input.batchId,
      mediaKind: input.mediaKind,
      from: input.from,
      to: input.to,
      ...(input.extra ?? {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Leaving-Soon Plex collection (Q-05) — Maintainerr manual collection
// ---------------------------------------------------------------------------

/**
 * ADR-025 C-05 (Q-05) — drive the batch's "Leaving Soon" Plex collection through Maintainerr's
 * manual-collection surface (verified from v3.17.0 source): `POST /api/collections` with
 * `visibleOnHome`/`visibleOnRecommended` true (Maintainerr pushes these to Plex Home + Recommended)
 * and `deleteAfterDays: null` (Maintainerr NEVER ages/auto-deletes these — the windowed sweep is our
 * per-item guarded loop, reaffirming ADR-023 C-07a). The target Plex `libraryId` is read from the
 * items' source rule collection. Returns the created collection's id (stored on the batch) or null
 * when there is nothing to surface / no library could be derived (the batch still green-lights).
 */
async function driveLeavingSoonCollection(input: {
  maintainerr: MaintainerrClientBundle;
  mediaKind: TrashMediaKind;
  items: Array<{ maintainerrMediaId: string; collectionId: number | null }>;
}): Promise<number | null> {
  if (input.items.length === 0) return null;
  // Derive the Plex libraryId from a source rule collection the items came from.
  const sourceCollectionIds = new Set(
    input.items.map((i) => i.collectionId).filter((c): c is number => c !== null),
  );
  const collections = await guardMaintainerrCall('maintainerr GET /collections', () =>
    input.maintainerr.read.getCollections(),
  );
  const source = collections.find(
    (c) => c.id !== null && c.id !== undefined && sourceCollectionIds.has(c.id),
  );
  const libraryId = source?.libraryId ?? null;
  if (libraryId === null || libraryId === undefined) return null;

  const created = await guardMaintainerrCall('maintainerr POST /collections', () =>
    input.maintainerr.write.createCollection({
      collection: {
        title: leavingSoonName(input.mediaKind),
        description: 'Items leaving the server soon — save the ones you still want.',
        libraryId: String(libraryId),
        type: plexCollectionType(input.mediaKind),
        isActive: true,
        arrAction: 0,
        deleteAfterDays: null, // WE delete via the windowed sweep — never Maintainerr's aging worker
        manualCollection: false,
        visibleOnHome: true,
        visibleOnRecommended: true,
      },
      media: input.items.map((i) => ({ mediaServerId: i.maintainerrMediaId })),
    }),
  );
  return created.id;
}

// ---------------------------------------------------------------------------
// Live-exclusion safety seam (mirrors trash-flow's fetchLiveExclusions)
// ---------------------------------------------------------------------------

/** Which of `ids` are CURRENTLY excluded (whitelisted) in Maintainerr — protected, never deleted.
 *  Read per id by mediaServerId (Maintainerr returns [] with no params). Fail-closed via the guard. */
async function fetchLiveExclusions(
  maintainerr: MaintainerrClientBundle,
  ids: readonly string[],
): Promise<Set<string>> {
  const excluded = new Set<string>();
  for (const id of ids) {
    const rows = await guardMaintainerrCall('maintainerr GET /rules/exclusion', () =>
      maintainerr.read.getExclusions({ mediaServerId: id }),
    );
    if (rows.length > 0) excluded.add(id);
  }
  return excluded;
}

// ---------------------------------------------------------------------------
// createBatchFromPending — snapshot the pending set into a curated batch
// ---------------------------------------------------------------------------

export interface CreateBatchResult {
  batchId: string;
  state: TrashBatchState;
  mediaKind: TrashMediaKind;
  itemCount: number;
  gateSkipped: boolean;
  expiresAt: string | null;
}

/**
 * ADR-025 (Q-01 manual-first) — snapshot the current pending set for one media kind into a new
 * batch. Refuses if an OPEN batch already exists for that kind (one live batch per kind). Items with
 * no Maintainerr id are unactionable and dropped from the snapshot; a tag-protected item is
 * snapshotted as `protected` (never a delete candidate). When the audited `trash_skip_admin_gate`
 * setting is ON, the batch is auto-green-lit straight to `leaving_soon` (draft → leaving_soon,
 * `gate_skipped = true`, system-audited) — otherwise it lands in `admin_review` for poster curation.
 */
export async function createBatchFromPending(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  mediaKind: TrashMediaKind;
  actorId: string | null;
}): Promise<CreateBatchResult> {
  const skipGate = await getAppSetting(input.db, 'trash_skip_admin_gate');

  // Snapshot the live pending set (mediaKind is movie|tv — music is structurally excluded, R-87).
  const pending = await listTrashPending({
    db: input.db,
    maintainerr: input.maintainerr,
    media: input.mediaKind as TrashMedia,
  });
  const actionable = pending.items.filter(
    (p): p is TrashPendingItem & { maintainerrMediaId: string } => p.maintainerrMediaId !== null,
  );
  if (actionable.length === 0) {
    throw new TrashBatchEmptyError(
      `No actionable pending ${input.mediaKind} items to batch (nothing pending, or no Maintainerr ids).`,
    );
  }

  // Pre-flight the one-open-batch-per-kind rule (the DB partial-unique index is the true guard).
  const db = resolveDb(input.db);
  const [openBatch] = await db
    .select({ id: trashBatches.id })
    .from(trashBatches)
    .where(and(eq(trashBatches.mediaKind, input.mediaKind), inArray(trashBatches.state, [...OPEN_STATES])));
  if (openBatch) {
    throw new TrashBatchOpenError(
      `An open ${input.mediaKind} batch already exists (${openBatch.id}). Green-light, cancel, or expire it first.`,
    );
  }

  const initialState: TrashBatchState = skipGate ? 'draft' : 'admin_review';

  let batchId: string;
  try {
    batchId = await inTransaction(input.db, async (tx) => {
      const [batch] = await tx
        .insert(trashBatches)
        .values({ mediaKind: input.mediaKind, state: initialState, createdBy: input.actorId })
        .returning({ id: trashBatches.id });
      if (!batch) throw new Error('trash_batches insert returned no row');

      await tx.insert(trashBatchItems).values(
        actionable.map((p) => ({
          batchId: batch.id,
          maintainerrMediaId: p.maintainerrMediaId,
          collectionId: p.collectionId,
          mediaItemId: p.mediaItemId,
          title: p.title,
          year: p.year,
          tmdbId: p.tmdbId,
          tvdbId: p.tvdbId,
          sizeBytes: p.sizeBytes,
          posterSource: p.posterSource,
          // A tag-protected (dnd) item is already whitelisted — snapshot it as `protected`, never a
          // delete candidate. Everything else is `pending` (re-evaluated fresh at sweep time).
          state: (p.protectedByTag ? 'protected' : 'pending') as TrashBatchItemState,
        })),
      );

      await writeTransitionEvent(tx, {
        batchId: batch.id,
        mediaKind: input.mediaKind,
        from: null,
        to: initialState,
        actorId: input.actorId,
        extra: { itemCount: actionable.length },
      });
      return batch.id;
    });
  } catch (err) {
    if (isPostgresUniqueViolation(err)) {
      throw new TrashBatchOpenError(
        `An open ${input.mediaKind} batch already exists (concurrent create).`,
      );
    }
    throw err;
  }

  if (!skipGate) {
    return {
      batchId,
      state: 'admin_review',
      mediaKind: input.mediaKind,
      itemCount: actionable.length,
      gateSkipped: false,
      expiresAt: null,
    };
  }

  // Skip-gate: auto-green-light straight to leaving_soon (audited gate_skipped, system attribution).
  const windowDays = await getAppSetting(input.db, 'trash_default_window_days');
  const promoted = await promoteToLeavingSoon({
    db: input.db,
    maintainerr: input.maintainerr,
    batchId,
    mediaKind: input.mediaKind,
    fromState: 'draft',
    gateSkipped: true,
    windowDays,
    actorId: input.actorId,
  });
  return {
    batchId,
    state: 'leaving_soon',
    mediaKind: input.mediaKind,
    itemCount: actionable.length,
    gateSkipped: true,
    expiresAt: promoted.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// greenlightBatch / promoteToLeavingSoon
// ---------------------------------------------------------------------------

export interface PromoteResult {
  expiresAt: string;
  windowDays: number;
  collectionId: number | null;
}

/**
 * The shared admin_review|draft → leaving_soon promotion. Drives the Leaving-Soon collection FIRST
 * (external — ADR-023 C-05 protective ordering: a crash must not leave a green-lit batch whose Plex
 * collection was never created), then flips the state + sets the window in a guarded UPDATE (the
 * from-state in the WHERE loses a concurrent transition race) with its transition event same-tx.
 */
async function promoteToLeavingSoon(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  batchId: string;
  mediaKind: TrashMediaKind;
  fromState: 'draft' | 'admin_review';
  gateSkipped: boolean;
  windowDays: number;
  actorId: string | null;
}): Promise<PromoteResult> {
  const db = resolveDb(input.db);
  // The frozen `pending` snapshot the users will rescue from = the collection's initial members.
  const items = await db
    .select({
      maintainerrMediaId: trashBatchItems.maintainerrMediaId,
      collectionId: trashBatchItems.collectionId,
    })
    .from(trashBatchItems)
    .where(and(eq(trashBatchItems.batchId, input.batchId), eq(trashBatchItems.state, 'pending')));

  const collectionId = await driveLeavingSoonCollection({
    maintainerr: input.maintainerr,
    mediaKind: input.mediaKind,
    items,
  });

  const now = nowDate();
  const expiresAt = new Date(now.getTime() + input.windowDays * 86_400_000);

  await inTransaction(input.db, async (tx) => {
    const updated = await tx
      .update(trashBatches)
      .set({
        state: 'leaving_soon',
        greenlitAt: now,
        greenlitBy: input.actorId,
        gateSkipped: input.gateSkipped,
        windowDays: input.windowDays,
        expiresAt,
        maintainerrCollectionId: collectionId,
      })
      .where(and(eq(trashBatches.id, input.batchId), eq(trashBatches.state, input.fromState)))
      .returning({ id: trashBatches.id });
    if (updated.length === 0) {
      throw new TrashBatchStateError(
        `Batch ${input.batchId} is not in '${input.fromState}' — cannot green-light (already moved?).`,
      );
    }
    await writeTransitionEvent(tx, {
      batchId: input.batchId,
      mediaKind: input.mediaKind,
      from: input.fromState,
      to: 'leaving_soon',
      actorId: input.actorId,
      extra: {
        gateSkipped: input.gateSkipped,
        windowDays: input.windowDays,
        expiresAt: expiresAt.toISOString(),
        maintainerrCollectionId: collectionId,
      },
    });
  });

  return { expiresAt: expiresAt.toISOString(), windowDays: input.windowDays, collectionId };
}

/**
 * ADR-025 — the admin green-light: admin_review → leaving_soon, sets the save window (windowDays
 * override or the `trash_default_window_days` default, Q-10) and drives the Leaving-Soon collection.
 */
export async function greenlightBatch(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  batchId: string;
  windowDays?: number;
  actorId: string | null;
}): Promise<PromoteResult & { state: 'leaving_soon' }> {
  const batch = await loadBatch(input.db, input.batchId);
  if (batch.state !== 'admin_review') {
    throw new TrashBatchStateError(
      `Batch ${input.batchId} is '${batch.state}', not 'admin_review' — cannot green-light.`,
    );
  }
  const windowDays =
    input.windowDays ?? (await getAppSetting(input.db, 'trash_default_window_days'));
  const promoted = await promoteToLeavingSoon({
    db: input.db,
    maintainerr: input.maintainerr,
    batchId: input.batchId,
    mediaKind: batch.mediaKind,
    fromState: 'admin_review',
    gateSkipped: false,
    windowDays,
    actorId: input.actorId,
  });
  return { ...promoted, state: 'leaving_soon' };
}

// ---------------------------------------------------------------------------
// cancelBatch
// ---------------------------------------------------------------------------

/** ADR-025 — the abort lever: any non-terminal batch → cancelled; releases the Leaving-Soon collection. */
export async function cancelBatch(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  batchId: string;
  actorId: string | null;
}): Promise<{ state: 'cancelled' }> {
  const batch = await loadBatch(input.db, input.batchId);
  if (!OPEN_STATES.includes(batch.state)) {
    throw new TrashBatchStateError(
      `Batch ${input.batchId} is '${batch.state}' (terminal) — cannot cancel.`,
    );
  }
  // Release the Leaving-Soon collection first (external) — a crash leaves the batch open to retry.
  if (batch.maintainerrCollectionId !== null) {
    await guardMaintainerrCall('maintainerr POST /collections/removeCollection', () =>
      input.maintainerr.write.removeCollection(batch.maintainerrCollectionId as number),
    );
  }
  await inTransaction(input.db, async (tx) => {
    const updated = await tx
      .update(trashBatches)
      .set({ state: 'cancelled', cancelledAt: nowDate() })
      .where(and(eq(trashBatches.id, input.batchId), eq(trashBatches.state, batch.state)))
      .returning({ id: trashBatches.id });
    if (updated.length === 0) {
      throw new TrashBatchStateError(`Batch ${input.batchId} moved before it could be cancelled.`);
    }
    await writeTransitionEvent(tx, {
      batchId: input.batchId,
      mediaKind: batch.mediaKind,
      from: batch.state,
      to: 'cancelled',
      actorId: input.actorId,
    });
  });
  return { state: 'cancelled' };
}

// ---------------------------------------------------------------------------
// setBatchItemSaved — the ONE writer for the admin + user rescue exercise
// ---------------------------------------------------------------------------

/**
 * ADR-025 (Q-03) — flip one item pending ⇄ saved. A save is PERMANENT protection: it establishes the
 * Maintainerr GLOBAL exclusion (external-first, protective ordering, reused from trash-flow's
 * saveExclusion) AND records the `trash_batch_saves` tuning row (the PLAN-014 dataset) + pulls the
 * item out of the Leaving-Soon collection. Phase-gated: admin flips require `admin_review` (or
 * `leaving_soon` — admins may keep curating); user flips require `leaving_soon` with the window still
 * open (the API layer gates on the `save_leaving_soon` action). Idempotent — no-op on a redundant flip.
 */
export async function setBatchItemSaved(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  batchId: string;
  itemId: string;
  saved: boolean;
  actorId: string | null;
}): Promise<{ changed: boolean; state: TrashBatchItemState }> {
  const db = resolveDb(input.db);
  const batch = await loadBatch(input.db, input.batchId);
  // Saves are only meaningful while curating (admin_review) or during the open window (leaving_soon).
  if (batch.state !== 'admin_review' && batch.state !== 'leaving_soon') {
    throw new TrashBatchStateError(
      `Batch ${input.batchId} is '${batch.state}' — items can only be saved in admin_review or leaving_soon.`,
    );
  }
  if (batch.state === 'leaving_soon' && batch.expiresAt !== null && batch.expiresAt.getTime() <= Date.now()) {
    throw new TrashBatchStateError(
      `The save window for batch ${input.batchId} has closed — items can no longer be rescued.`,
    );
  }

  const [item] = await db
    .select()
    .from(trashBatchItems)
    .where(and(eq(trashBatchItems.id, input.itemId), eq(trashBatchItems.batchId, input.batchId)));
  if (!item) throw new NotFoundError(`Batch item ${input.itemId} not found in batch ${input.batchId}`);

  // Idempotency: only pending↔saved flips do anything. protected/deleted/skipped are inert.
  if (input.saved && item.state === 'saved') return { changed: false, state: 'saved' };
  if (!input.saved && item.state !== 'saved') return { changed: false, state: item.state };
  if (input.saved && item.state !== 'pending') {
    // protected/deleted/skipped — nothing to rescue.
    return { changed: false, state: item.state };
  }

  if (input.saved) {
    // 1) Protect FIRST (external): global Maintainerr exclusion + trash_excluded event (Q-03 permanent).
    await saveExclusion({
      db: input.db,
      maintainerr: input.maintainerr,
      maintainerrMediaId: item.maintainerrMediaId,
      mediaItemId: item.mediaItemId,
      actorId: input.actorId,
      reason: 'batch_save',
    });
    // 2) Remove it from the visible Leaving-Soon collection (best-effort external).
    if (batch.maintainerrCollectionId !== null) {
      await guardMaintainerrCall('maintainerr POST /collections/remove', () =>
        input.maintainerr.write.removeFromCollection(batch.maintainerrCollectionId as number, [
          item.maintainerrMediaId,
        ]),
      );
    }
    // 3) State + the tuning save-event row, same tx.
    await inTransaction(input.db, async (tx) => {
      await tx
        .update(trashBatchItems)
        .set({ state: 'saved', savedBy: input.actorId, savedAt: nowDate() })
        .where(eq(trashBatchItems.id, input.itemId));
      await tx
        .insert(trashBatchSaves)
        .values({ batchItemId: input.itemId, userId: input.actorId, action: 'save' });
    });
    return { changed: true, state: 'saved' };
  }

  // Un-save: release the exclusion (external-first) + re-add to Leaving-Soon + record the unsave.
  await removeExclusion({
    db: input.db,
    maintainerr: input.maintainerr,
    maintainerrMediaId: item.maintainerrMediaId,
    mediaItemId: item.mediaItemId,
    actorId: input.actorId,
  });
  if (batch.maintainerrCollectionId !== null) {
    await guardMaintainerrCall('maintainerr POST /collections/add', () =>
      input.maintainerr.write.addToCollection(batch.maintainerrCollectionId as number, [
        item.maintainerrMediaId,
      ]),
    );
  }
  await inTransaction(input.db, async (tx) => {
    await tx
      .update(trashBatchItems)
      .set({ state: 'pending', savedBy: null, savedAt: null })
      .where(eq(trashBatchItems.id, input.itemId));
    await tx
      .insert(trashBatchSaves)
      .values({ batchItemId: input.itemId, userId: input.actorId, action: 'unsave' });
  });
  return { changed: true, state: 'pending' };
}

// ---------------------------------------------------------------------------
// sweepExpiredBatches — the windowed, guarded, per-item deletion
// ---------------------------------------------------------------------------

export interface BatchSweepResult {
  batchId: string;
  mediaKind: TrashMediaKind;
  deletedCount: number;
  skippedCount: number;
  savedCount: number;
  protectedCount: number;
  handleErrors: number;
}

export interface SweepReport {
  batchesSwept: number;
  batches: BatchSweepResult[];
}

/**
 * ADR-025 (Q-02) — the batch-expiry sweep (the `trash-batch-sweep` sync mode). Acts ONLY on
 * `leaving_soon` batches whose window has expired. Fail closed: the SAFE preflight audit (ADR-023
 * C-04) is re-run once up front and the WHOLE sweep refuses on an unsafe install. Per batch, each
 * still-`pending` item is re-evaluated against FRESH pending data + LIVE Maintainerr exclusions +
 * the guardian; survivors delete one at a time (NEVER /collections/handle — C-07a), with the
 * deletion snapshot (Q-08) + `deleted` state + `trash_expedited` intent event written same-tx BEFORE
 * the per-item handle call. Guardian-kept / stale / live-excluded items land `skipped`. When
 * `batchId` is given (the manual "Expire now" trigger) only that batch is swept (and must be
 * leaving_soon + expired).
 */
export async function sweepExpiredBatches(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  actorId?: string | null;
  watchWindowDays?: number;
  batchId?: string;
}): Promise<SweepReport> {
  const actorId = input.actorId ?? null;
  // Fail closed on an unsafe install — refuse the whole sweep (ADR-023 C-04).
  const audit = await auditMaintainerr({ maintainerr: input.maintainerr });
  if (!audit.safe) {
    throw new MaintainerrUnsafeError(
      `Maintainerr is not in a safe state to sweep expired batches (reachable=${audit.reachable}, ` +
        `integrations ${JSON.stringify(audit.integrations)}). Refusing.`,
      { integrations: audit.integrations as unknown as Record<string, boolean>, reachable: audit.reachable },
    );
  }

  const db = resolveDb(input.db);
  const now = nowDate();
  const candidates = await db
    .select({ id: trashBatches.id, mediaKind: trashBatches.mediaKind, expiresAt: trashBatches.expiresAt })
    .from(trashBatches)
    .where(
      input.batchId !== undefined
        ? eq(trashBatches.id, input.batchId)
        : eq(trashBatches.state, 'leaving_soon'),
    );

  const results: BatchSweepResult[] = [];
  for (const c of candidates) {
    if (input.batchId !== undefined) {
      // Manual trigger: validate it is genuinely a leaving_soon + expired batch.
      const [full] = await db.select().from(trashBatches).where(eq(trashBatches.id, c.id));
      if (!full || full.state !== 'leaving_soon') {
        throw new TrashBatchStateError(
          `Batch ${c.id} is not in 'leaving_soon' — cannot expire.`,
        );
      }
      if (full.expiresAt !== null && full.expiresAt.getTime() > Date.now()) {
        throw new TrashBatchStateError(
          `Batch ${c.id}'s save window has not closed yet (expires ${full.expiresAt.toISOString()}).`,
        );
      }
    } else {
      // Scheduled: only sweep windows that have actually closed.
      if (c.expiresAt === null || c.expiresAt.getTime() > now.getTime()) continue;
    }
    results.push(
      await expireOneBatch({
        db: input.db,
        maintainerr: input.maintainerr,
        batchId: c.id,
        mediaKind: c.mediaKind,
        actorId,
        watchWindowDays: input.watchWindowDays,
      }),
    );
  }

  return { batchesSwept: results.length, batches: results };
}

async function expireOneBatch(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  batchId: string;
  mediaKind: TrashMediaKind;
  actorId: string | null;
  watchWindowDays?: number;
}): Promise<BatchSweepResult> {
  const db = resolveDb(input.db);

  // FRESH pending re-derivation — the guardian re-runs against live data, never the frozen snapshot.
  const pending = await listTrashPending({
    db: input.db,
    maintainerr: input.maintainerr,
    media: input.mediaKind as TrashMedia,
    watchWindowDays: input.watchWindowDays,
  });
  const freshById = new Map(
    pending.items
      .filter((p): p is TrashPendingItem & { maintainerrMediaId: string } => p.maintainerrMediaId !== null)
      .map((p) => [p.maintainerrMediaId, p]),
  );

  // Only still-`pending` items are delete candidates; saved/protected/skipped/deleted are settled.
  const candidates = await db
    .select()
    .from(trashBatchItems)
    .where(and(eq(trashBatchItems.batchId, input.batchId), eq(trashBatchItems.state, 'pending')));

  const liveExcluded = await fetchLiveExclusions(
    input.maintainerr,
    candidates.map((c) => c.maintainerrMediaId),
  );

  let deletedCount = 0;
  let skippedCount = 0;
  let handleErrors = 0;

  for (const item of candidates) {
    const fresh = freshById.get(item.maintainerrMediaId);
    // Gone from Maintainerr's pending set, or currently live-excluded (saved/dnd synced) ⇒ keep.
    if (!fresh || liveExcluded.has(item.maintainerrMediaId)) {
      await markItemSkipped(input.db, item.id);
      skippedCount += 1;
      continue;
    }
    const verdict = classifyGuardian(fresh);
    if (verdict.keep) {
      // dnd / recently-watched / requester / unevaluable — never deleted (C-07b). Skip, no whitelist:
      // a repeat next batch is the intended stronger tuning signal (Q-03), Save is the permanent lever.
      await markItemSkipped(input.db, item.id);
      skippedCount += 1;
      continue;
    }
    // Cold + positively evaluated ⇒ delete this one item. Intent event + terminal state + deletion
    // snapshot committed BEFORE the per-item handle (Fix D-09 intent-first discipline, Q-08 snapshot).
    await inTransaction(input.db, async (tx) => {
      await tx.insert(ledgerEvents).values({
        mediaItemId: item.mediaItemId,
        eventType: 'trash_expedited',
        source: 'maintainerr',
        occurredAt: nowDate(),
        requestedByUserId: input.actorId,
        payload: {
          scope: 'batch',
          batchId: input.batchId,
          collectionId: fresh.collectionId,
          maintainerrMediaId: item.maintainerrMediaId,
        },
      });
      await tx
        .update(trashBatchItems)
        .set({
          state: 'deleted',
          deletedAt: nowDate(),
          deletedSizeBytes: fresh.sizeBytes,
          deletedResolution: fresh.resolution,
          deletedImdbRating: fresh.imdbRating === null ? null : fresh.imdbRating.toString(),
          deletedTmdbRating: fresh.tmdbRating === null ? null : fresh.tmdbRating.toString(),
        })
        .where(eq(trashBatchItems.id, item.id));
    });
    // The destructive per-item handle. A failure is tolerated per-item (intent + snapshot are durable);
    // Maintainerr's own systems reconcile a genuinely-missed delete. Never aborts the batch.
    try {
      await guardMaintainerrCall('maintainerr POST /collections/media/handle', () =>
        input.maintainerr.write.handleCollectionMedia(fresh.collectionId, item.maintainerrMediaId),
      );
    } catch {
      handleErrors += 1;
    }
    deletedCount += 1;
  }

  // Tally the settled states + close the batch (guarded UPDATE + transition event same-tx).
  const finalCounts = await countItemStates(input.db, input.batchId);
  await inTransaction(input.db, async (tx) => {
    const updated = await tx
      .update(trashBatches)
      .set({ state: 'deleted', deletedAt: nowDate() })
      .where(and(eq(trashBatches.id, input.batchId), eq(trashBatches.state, 'leaving_soon')))
      .returning({ id: trashBatches.id });
    if (updated.length === 0) {
      throw new TrashBatchStateError(`Batch ${input.batchId} moved before the sweep could close it.`);
    }
    await writeTransitionEvent(tx, {
      batchId: input.batchId,
      mediaKind: input.mediaKind,
      from: 'leaving_soon',
      to: 'deleted',
      actorId: input.actorId,
      extra: { deletedCount, skippedCount, handleErrors, counts: finalCounts },
    });
  });

  return {
    batchId: input.batchId,
    mediaKind: input.mediaKind,
    deletedCount,
    skippedCount,
    savedCount: finalCounts.saved ?? 0,
    protectedCount: finalCounts.protected ?? 0,
    handleErrors,
  };
}

async function markItemSkipped(db: DbClient | undefined, itemId: string): Promise<void> {
  await resolveDb(db)
    .update(trashBatchItems)
    .set({ state: 'skipped' })
    .where(eq(trashBatchItems.id, itemId));
}

// ---------------------------------------------------------------------------
// Reads — batch list / detail / save stats
// ---------------------------------------------------------------------------

interface LoadedBatch {
  id: string;
  mediaKind: TrashMediaKind;
  state: TrashBatchState;
  maintainerrCollectionId: number | null;
  expiresAt: Date | null;
}

async function loadBatch(db: DbClient | undefined, batchId: string): Promise<LoadedBatch> {
  const [row] = await resolveDb(db)
    .select({
      id: trashBatches.id,
      mediaKind: trashBatches.mediaKind,
      state: trashBatches.state,
      maintainerrCollectionId: trashBatches.maintainerrCollectionId,
      expiresAt: trashBatches.expiresAt,
    })
    .from(trashBatches)
    .where(eq(trashBatches.id, batchId));
  if (!row) throw new NotFoundError(`Batch ${batchId} not found`);
  return row;
}

/** Per-batch item-state tally (pending/saved/deleted/skipped/protected) + total + reclaimed bytes. */
async function countItemStates(
  db: DbClient | undefined,
  batchId: string,
): Promise<Record<string, number>> {
  const rows = await resolveDb(db)
    .select({ state: trashBatchItems.state, n: sql<number>`count(*)::int` })
    .from(trashBatchItems)
    .where(eq(trashBatchItems.batchId, batchId))
    .groupBy(trashBatchItems.state);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = r.n;
  return out;
}

export interface BatchCounts {
  pending: number;
  saved: number;
  deleted: number;
  skipped: number;
  protected: number;
  total: number;
}

function toCounts(raw: Record<string, number>): BatchCounts {
  const pending = raw.pending ?? 0;
  const saved = raw.saved ?? 0;
  const deleted = raw.deleted ?? 0;
  const skipped = raw.skipped ?? 0;
  const protectedCount = raw.protected ?? 0;
  return {
    pending,
    saved,
    deleted,
    skipped,
    protected: protectedCount,
    total: pending + saved + deleted + skipped + protectedCount,
  };
}

export interface BatchSummary {
  id: string;
  mediaKind: TrashMediaKind;
  state: TrashBatchState;
  windowDays: number;
  gateSkipped: boolean;
  greenlitAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  deletedAt: string | null;
  cancelledAt: string | null;
  counts: BatchCounts;
  /** bytes freed by this batch's actually-deleted items (deletion snapshot, PLAN-013 source). */
  reclaimedBytes: number;
}

/** ADR-025 — the batch list (newest first), optionally filtered by media kind. Read-only. */
export async function listBatches(input: {
  db?: DbClient;
  mediaKind?: TrashMediaKind;
  limit?: number;
}): Promise<BatchSummary[]> {
  const db = resolveDb(input.db);
  const batches = await db
    .select()
    .from(trashBatches)
    .where(input.mediaKind !== undefined ? eq(trashBatches.mediaKind, input.mediaKind) : undefined)
    .orderBy(desc(trashBatches.createdAt))
    .limit(input.limit ?? 50);
  if (batches.length === 0) return [];

  const ids = batches.map((b) => b.id);
  const countRows = await db
    .select({
      batchId: trashBatchItems.batchId,
      state: trashBatchItems.state,
      n: sql<number>`count(*)::int`,
      reclaimed: sql<number>`coalesce(sum(${trashBatchItems.deletedSizeBytes}), 0)::bigint`,
    })
    .from(trashBatchItems)
    .where(inArray(trashBatchItems.batchId, ids))
    .groupBy(trashBatchItems.batchId, trashBatchItems.state);
  const rawByBatch = new Map<string, Record<string, number>>();
  const reclaimedByBatch = new Map<string, number>();
  for (const r of countRows) {
    const raw = rawByBatch.get(r.batchId) ?? {};
    raw[r.state] = r.n;
    rawByBatch.set(r.batchId, raw);
    if (r.state === 'deleted') {
      reclaimedByBatch.set(r.batchId, (reclaimedByBatch.get(r.batchId) ?? 0) + Number(r.reclaimed));
    }
  }

  return batches.map((b) => ({
    id: b.id,
    mediaKind: b.mediaKind,
    state: b.state,
    windowDays: b.windowDays,
    gateSkipped: b.gateSkipped,
    greenlitAt: b.greenlitAt?.toISOString() ?? null,
    expiresAt: b.expiresAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
    deletedAt: b.deletedAt?.toISOString() ?? null,
    cancelledAt: b.cancelledAt?.toISOString() ?? null,
    counts: toCounts(rawByBatch.get(b.id) ?? {}),
    reclaimedBytes: reclaimedByBatch.get(b.id) ?? 0,
  }));
}

export interface BatchDetailItem {
  id: string;
  maintainerrMediaId: string;
  mediaItemId: string | null;
  collectionId: number | null;
  title: string;
  year: number | null;
  tmdbId: number | null;
  tvdbId: number | null;
  sizeBytes: number;
  posterSource: string | null;
  state: TrashBatchItemState;
  savedBy: string | null;
  savedAt: string | null;
}

export interface BatchDetail extends BatchSummary {
  items: BatchDetailItem[];
}

/** ADR-025 — one batch with its poster-grid item list (the review/Leaving-Soon wall source). */
export async function getBatchDetail(input: {
  db?: DbClient;
  batchId: string;
}): Promise<BatchDetail> {
  const db = resolveDb(input.db);
  const [b] = await db.select().from(trashBatches).where(eq(trashBatches.id, input.batchId));
  if (!b) throw new NotFoundError(`Batch ${input.batchId} not found`);

  const items = await db
    .select()
    .from(trashBatchItems)
    .where(eq(trashBatchItems.batchId, input.batchId))
    .orderBy(desc(trashBatchItems.sizeBytes));

  const raw: Record<string, number> = {};
  let reclaimedBytes = 0;
  for (const it of items) {
    raw[it.state] = (raw[it.state] ?? 0) + 1;
    if (it.state === 'deleted') reclaimedBytes += it.deletedSizeBytes ?? 0;
  }

  return {
    id: b.id,
    mediaKind: b.mediaKind,
    state: b.state,
    windowDays: b.windowDays,
    gateSkipped: b.gateSkipped,
    greenlitAt: b.greenlitAt?.toISOString() ?? null,
    expiresAt: b.expiresAt?.toISOString() ?? null,
    createdAt: b.createdAt.toISOString(),
    deletedAt: b.deletedAt?.toISOString() ?? null,
    cancelledAt: b.cancelledAt?.toISOString() ?? null,
    counts: toCounts(raw),
    reclaimedBytes,
    items: items.map((it) => ({
      id: it.id,
      maintainerrMediaId: it.maintainerrMediaId,
      mediaItemId: it.mediaItemId,
      collectionId: it.collectionId,
      title: it.title,
      year: it.year,
      tmdbId: it.tmdbId,
      tvdbId: it.tvdbId,
      sizeBytes: it.sizeBytes,
      posterSource: it.posterSource,
      state: it.state,
      savedBy: it.savedBy,
      savedAt: it.savedAt?.toISOString() ?? null,
    })),
  };
}

export interface BatchSaveStats {
  batchId: string;
  totalSaves: number;
  totalUnsaves: number;
  netSaved: number;
  byUser: Array<{ userId: string | null; displayName: string | null; saves: number; unsaves: number }>;
}

/** ADR-025 (Q-07) — the tuning-data summary for a batch: save/unsave totals + a per-user breakdown. */
export async function getBatchSaveStats(input: {
  db?: DbClient;
  batchId: string;
}): Promise<BatchSaveStats> {
  const db = resolveDb(input.db);
  const rows = await db
    .select({
      userId: trashBatchSaves.userId,
      displayName: users.displayName,
      action: trashBatchSaves.action,
      n: sql<number>`count(*)::int`,
    })
    .from(trashBatchSaves)
    .innerJoin(trashBatchItems, eq(trashBatchItems.id, trashBatchSaves.batchItemId))
    .leftJoin(users, eq(users.id, trashBatchSaves.userId))
    .where(eq(trashBatchItems.batchId, input.batchId))
    .groupBy(trashBatchSaves.userId, users.displayName, trashBatchSaves.action);

  let totalSaves = 0;
  let totalUnsaves = 0;
  const byUserMap = new Map<
    string,
    { userId: string | null; displayName: string | null; saves: number; unsaves: number }
  >();
  for (const r of rows) {
    const key = r.userId ?? 'system';
    const entry =
      byUserMap.get(key) ?? { userId: r.userId, displayName: r.displayName, saves: 0, unsaves: 0 };
    if (r.action === 'save') {
      entry.saves += r.n;
      totalSaves += r.n;
    } else {
      entry.unsaves += r.n;
      totalUnsaves += r.n;
    }
    byUserMap.set(key, entry);
  }

  return {
    batchId: input.batchId,
    totalSaves,
    totalUnsaves,
    netSaved: totalSaves - totalUnsaves,
    byUser: [...byUserMap.values()],
  };
}
