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
  mediaMetadata,
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
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getAppSetting, getFinalWarning } from './app-settings';
import { inTransaction, resolveDb } from './db-client';
// ADR-034 / DESIGN-015 (PLAN-016) — same-tx Pushover enqueue on batch lifecycle transitions.
import { computeEarliestSend, computeReminderSend, getNotifyWindow } from './notify-window';
import { enqueueOutbox } from './notify-outbox';
import {
  MaintainerrUnsafeError,
  NotFoundError,
  TrashBatchEmptyError,
  TrashBatchOpenError,
  TrashBatchStateError,
  TrashSaveNotOwnedError,
} from './errors';
import { isPostgresUniqueViolation } from './errors';
import { guardMaintainerrCall, type MaintainerrClientBundle } from './maintainerr-clients';
import {
  arrKindForTrashMedia,
  auditMaintainerr,
  classifyGuardian,
  isLeavingSoonCollectionTitle,
  LEAVING_SOON_COLLECTION_TITLES,
  listTrashPending,
  recordDeletionAudit,
  RECENTLY_WATCHED_WINDOW_DAYS,
  removeExclusion,
  resolveActorName,
  saveExclusion,
  type TrashMedia,
  type TrashPendingItem,
} from './trash-flow';
import { removeTrashCandidateRows } from './trash-candidates';
import { compareByStrategy, type BatchStrategy } from './trash-strategy';

const nowDate = () => new Date();
const OPEN_STATES = TRASH_BATCH_OPEN_STATES as readonly TrashBatchState[];

/**
 * ServarrAction.DO_NOTHING (verified `@maintainerr/contracts` v3.17.0, 2026-07-07 —
 * `packages/contracts/src/collections/servarr-action.ts`, enum position 4). This is the collection
 * aging worker's ONLY per-collection skip (`collection-worker.service.ts`: `if (arrAction ===
 * ServarrAction.DO_NOTHING) return false`). We create the Leaving-Soon collection with it so
 * Maintainerr's estate-wide worker NEVER touches it — WE own deletion via the windowed sweep. This
 * is load-bearing safety: `deleteAfterDays` cannot disable aging (it is `z.coerce.number()`, so a
 * `null` coerces to `0` → every member is immediately past its danger date), so arrAction is the
 * only lever. */
const MAINTAINERR_DO_NOTHING = 4;

/** The Maintainerr `MediaItemTypes` string a Leaving-Soon collection's `type` must carry (verified
 *  v3.17.0: `type: z.enum(MediaItemTypes)` — 'movie'|'show'|…; a numeric code is rejected 400). */
const leavingSoonPlexType = (mediaKind: TrashMediaKind): 'movie' | 'show' =>
  mediaKind === 'movie' ? 'movie' : 'show';

/** The rolling "Leaving Soon" collection name per media kind (Q-09). Shared with trash-flow's pending
 *  derivation (which skips these — they are not rule-collection sources). */
const leavingSoonName = (mediaKind: TrashMediaKind): string =>
  mediaKind === 'movie'
    ? LEAVING_SOON_COLLECTION_TITLES.movie
    : LEAVING_SOON_COLLECTION_TITLES.tv;

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
 * ADR-025 C-04 (Q-05) — drive the batch's "Leaving Soon" Plex collection through Maintainerr's
 * manual-collection surface (re-verified from v3.17.0 source 2026-07-07): `POST /api/collections`
 * with `visibleOnHome`/`visibleOnRecommended` true (Maintainerr pushes these to Plex Home +
 * Recommended) and `arrAction: DO_NOTHING` (4) — the collection worker's ONLY per-collection skip, so
 * Maintainerr NEVER ages/auto-deletes it; the windowed sweep is our per-item guarded loop (ADR-023
 * C-07a). NOT `deleteAfterDays: null` — that field is `z.coerce.number()`, so null coerces to 0 and
 * would make the estate worker delete the WHOLE collection on its next run; arrAction is the lever.
 *
 * v3.17.0's create handler returns NO body, so `createCollection` is a tolerant void write and we
 * RE-READ the id via `GET /api/collections` matching the exact title. Idempotent: if a collection
 * with our title already exists (a crash between create and the DB commit), reuse it (top up its
 * membership) instead of creating a duplicate. `type` is the STRING MediaItemTypes enum (a numeric
 * code is rejected 400). The target Plex `libraryId` is read from the items' source rule collection.
 * Returns the collection id (stored on the batch) or null when there is nothing to surface / no
 * library could be derived (the batch still green-lights).
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

  const title = leavingSoonName(input.mediaKind);
  const mediaServerIds = input.items.map((i) => i.maintainerrMediaId);

  // Idempotency: a collection with our exact title already exists (a retry after a crash) ⇒ reuse it,
  // topping up its membership, rather than creating a duplicate.
  const existing = collections.find(
    (c) => c.id !== null && c.id !== undefined && isLeavingSoonCollectionTitle(c.title) && c.title === title,
  );
  if (existing && existing.id !== null && existing.id !== undefined) {
    const existingId = existing.id;
    await guardMaintainerrCall('maintainerr POST /collections/add', () =>
      input.maintainerr.write.addToCollection(existingId, mediaServerIds),
    );
    return existingId;
  }

  // Create (void response), then re-read the new id by exact title.
  await guardMaintainerrCall('maintainerr POST /collections', () =>
    input.maintainerr.write.createCollection({
      collection: {
        title,
        description: 'Items leaving the server soon — save the ones you still want.',
        libraryId: String(libraryId),
        type: leavingSoonPlexType(input.mediaKind),
        isActive: true,
        arrAction: MAINTAINERR_DO_NOTHING, // the worker's ONLY skip — WE own deletion via the sweep
        manualCollection: false,
        visibleOnHome: true,
        visibleOnRecommended: true,
      },
      media: input.items.map((i) => ({ mediaServerId: i.maintainerrMediaId })),
    }),
  );
  const after = await guardMaintainerrCall('maintainerr GET /collections', () =>
    input.maintainerr.read.getCollections(),
  );
  const created = after.find(
    (c) => c.id !== null && c.id !== undefined && c.title === title,
  );
  return created?.id ?? null;
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

/** How much space one batch should aim to free (DESIGN-011 amendment 2026-07-08 — reclaim-targeted
 *  creation). Absent ⇒ the batch snapshots ALL current candidates (today's behavior). */
export interface BatchTargeting {
  /** Free at LEAST this many bytes: rank the deletable candidates by `strategy` and take greedily
   *  until the running total crosses it (the crossing item is INCLUDED — we never split a title). */
  targetBytes?: number;
  /** Hard cap on the number of items taken (an independent stop condition — whichever hits first). */
  maxItems?: number;
  /** The greedy ranking (default 'largest'; policy batches pass 'worst-rated'). */
  strategy?: BatchStrategy;
}

type ActionableItem = TrashPendingItem & { maintainerrMediaId: string };

/**
 * DESIGN-011 amendment (2026-07-08) — the reclaim-targeted candidate pick. With no targeting the
 * batch is EVERY actionable candidate (unchanged default). With a `targetBytes`/`maxItems` cap the
 * candidates are ranked by `strategy` and taken GREEDILY until the target/cap is met:
 *   - `largest`      → sizeBytes desc (free the most with the fewest deletions);
 *   - `worst-rated`  → rating asc with UNRATED FIRST (imdbRating ?? tmdbRating; a null rating is
 *                      treated as the worst), ties broken by size desc.
 * The crossing item is always INCLUDED (we never split a title below one item), so a target smaller
 * than the first item still yields one item. Only tag-UNPROTECTED items free space, so a targeted
 * batch is exactly the chosen deletable subset — tag-protected (`dnd`) items free nothing and are
 * left out of a targeted batch (they are still snapshotted `protected` in an untargeted one).
 */
export function selectBatchCandidates(
  actionable: readonly ActionableItem[],
  targeting?: BatchTargeting,
): ActionableItem[] {
  const capped =
    targeting !== undefined &&
    (targeting.targetBytes !== undefined || targeting.maxItems !== undefined);
  if (!capped) return [...actionable];

  const strategy = targeting?.strategy ?? 'largest';
  const deletable = actionable.filter((p) => !p.protectedByTag);
  // DESIGN-014 amendment (2026-07-09, build D) — the ranking is the SHARED compareByStrategy so the
  // pending walls' "Next up" default sort orders identically (the top of the wall = the front of the
  // deletion queue). Keep this call the single ordering seam.
  const ranked = [...deletable].sort((a, b) => compareByStrategy(a, b, strategy));

  const out: ActionableItem[] = [];
  let total = 0;
  for (const item of ranked) {
    out.push(item);
    total += item.sizeBytes;
    const hitTarget = targeting?.targetBytes !== undefined && total >= targeting.targetBytes;
    const hitCap = targeting?.maxItems !== undefined && out.length >= targeting.maxItems;
    if (hitTarget || hitCap) break;
  }
  return out;
}

/**
 * ADR-025 (Q-01 manual-first) — snapshot the current pending set for one media kind into a new
 * batch. Refuses if an OPEN batch already exists for that kind (one live batch per kind). Items with
 * no Maintainerr id are unactionable and dropped from the snapshot; a tag-protected item is
 * snapshotted as `protected` (never a delete candidate). When the audited `trash_skip_admin_gate`
 * setting is ON, the batch is auto-green-lit straight to `leaving_soon` (draft → leaving_soon,
 * `gate_skipped = true`, attributed to the creating admin) — otherwise it lands in `admin_review` for
 * poster curation.
 */
export async function createBatchFromPending(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  mediaKind: TrashMediaKind;
  actorId: string | null;
  /** How this batch was posted (for the "batch created" push copy/attribution). Defaults 'manual';
   *  the space policy passes 'policy' (ADR-031 reuses this writer). */
  source?: 'manual' | 'policy';
  /** DESIGN-011 amendment (2026-07-08) — reclaim-targeted creation. Absent ⇒ ALL candidates. When
   *  set, the snapshot is the greedily-chosen deletable subset (see `selectBatchCandidates`). */
  targeting?: BatchTargeting;
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

  // DESIGN-011 amendment — reclaim-targeted pick (absent targeting ⇒ ALL candidates, unchanged).
  const selected = selectBatchCandidates(actionable, input.targeting);
  if (selected.length === 0) {
    throw new TrashBatchEmptyError(
      `No deletable pending ${input.mediaKind} items match the target (all remaining candidates are protected).`,
    );
  }

  // Pre-flight the one-open-batch-per-kind rule (the DB partial-unique index is the true guard).
  const db = resolveDb(input.db);
  const [openBatch] = await db
    .select({ id: trashBatches.id, state: trashBatches.state })
    .from(trashBatches)
    .where(and(eq(trashBatches.mediaKind, input.mediaKind), inArray(trashBatches.state, [...OPEN_STATES])));
  if (openBatch) {
    // Name the blocking batch's id AND state so a stuck `draft`/`admin_review` is obvious (the footgun
    // is an admin not realising which batch — and in which phase — is holding the one-open slot).
    throw new TrashBatchOpenError(
      `An open ${input.mediaKind} batch already exists (${openBatch.id}, state '${openBatch.state}'). ` +
        `Green-light, cancel, or expire it first.`,
    );
  }

  const initialState: TrashBatchState = skipGate ? 'draft' : 'admin_review';

  // ADR-034 — the "batch posted" Pushover push. Read the window + compute earliest_send_at BEFORE the
  // tx (a stale-by-seconds read is harmless); the outbox row is enqueued INSIDE the tx so it commits
  // with the batch (never lost, never phantom). Fires for BOTH manual and space-policy-proposed
  // batches (both flow through here). A skip-gate batch also pings 'leaving_soon' from the promotion
  // below — two intentional pings (created → leaving soon), delivered together inside the window.
  const totalBytes = selected.reduce((n, p) => n + (p.sizeBytes ?? 0), 0);
  const createdEarliest = computeEarliestSend(nowDate(), await getNotifyWindow(input.db));

  let batchId: string;
  try {
    batchId = await inTransaction(input.db, async (tx) => {
      const [batch] = await tx
        .insert(trashBatches)
        .values({ mediaKind: input.mediaKind, state: initialState, createdBy: input.actorId })
        .returning({ id: trashBatches.id });
      if (!batch) throw new Error('trash_batches insert returned no row');

      await tx.insert(trashBatchItems).values(
        selected.map((p) => {
          // A tag-protected (dnd) item is already whitelisted in Maintainerr — snapshot it as
          // `protected`, never a delete candidate. Everything else snapshots as `pending` and is
          // re-evaluated fresh at sweep time.
          //
          // ADR-025/DESIGN-011 errata (2026-07-09) — the requester auto-save was REMOVED. Owner ruling:
          // "Maintainerr rules decide what gets promoted; the app controls how much and when it's
          // deleted." A requester is informational only now: a requester-carrying item snapshots per
          // its real state (pending unless tag-protected), with NO system auto-save. Its attribution
          // rides the wall meta badge; the recently-watched keep still protects it at the SWEEP.
          const state: TrashBatchItemState = p.protectedByTag ? 'protected' : 'pending';
          return {
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
            state,
            // No system auto-saves exist any more — saved_reason/saved_at stay NULL at creation; a
            // human rescue sets them later via setBatchItemSaved.
            savedReason: null,
            savedAt: null,
          };
        }),
      );

      await writeTransitionEvent(tx, {
        batchId: batch.id,
        mediaKind: input.mediaKind,
        from: null,
        to: initialState,
        actorId: input.actorId,
        extra: { itemCount: selected.length },
      });

      // Same-tx: enqueue the "batch posted" push (ADR-034 C-01).
      await enqueueOutbox(tx, {
        eventType: 'batch_created',
        earliestSendAt: createdEarliest,
        payload: {
          batchId: batch.id,
          mediaKind: input.mediaKind,
          itemCount: selected.length,
          totalBytes,
          source: input.source ?? 'manual',
        },
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
      itemCount: selected.length,
      gateSkipped: false,
      expiresAt: null,
    };
  }

  // Skip-gate: auto-green-light straight to leaving_soon (audited gate_skipped, attributed to the
  // creating admin — greenlitBy = actorId).
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
    itemCount: selected.length,
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
      sizeBytes: trashBatchItems.sizeBytes,
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

  // ADR-034 — the "Leaving Soon" push + the day-before-expiry reminder. Window/earliest computed
  // BEFORE the tx; the two outbox rows are enqueued INSIDE it (commit with the transition).
  const window = await getNotifyWindow(input.db);
  const leavingEarliest = computeEarliestSend(now, window);
  const reminderEarliest = computeReminderSend(expiresAt, window, now);
  const pendingCount = items.length;
  const pendingBytes = items.reduce((n, it) => n + (it.sizeBytes ?? 0), 0);

  // DESIGN-015 amendment (2026-07-09) — the CONFIGURABLE last-call ping. `hoursBefore` (N) is read HERE,
  // at green-light, and frozen into `earliest_send_at = expires_at − N hours` (a later setting change
  // never moves this row). The row is enqueued ONLY when that instant is still in the future — which is
  // exactly "the window is longer than N hours" (expiresAt = now + windowDays·24h, so
  // `expiresAt − N ≤ now` ⟺ the window is ≤ N hours). NOT run through the delivery window: a last call
  // is deadline-relative, not quiet-hours-shiftable (it must land before the sweep, never after).
  const finalWarning = await getFinalWarning(input.db);
  const finalWarningEarliest = new Date(expiresAt.getTime() - finalWarning.hoursBefore * 3_600_000);
  const enqueueFinalWarning =
    finalWarning.enabled && finalWarningEarliest.getTime() > now.getTime();

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

    const leavingPayload = {
      batchId: input.batchId,
      mediaKind: input.mediaKind,
      pendingCount,
      pendingBytes,
      expiresAt: expiresAt.toISOString(),
    };
    // The immediate "Leaving Soon" notice (next in-window) + the day-before-expiry reminder.
    await enqueueOutbox(tx, {
      eventType: 'batch_leaving_soon',
      earliestSendAt: leavingEarliest,
      payload: leavingPayload,
    });
    await enqueueOutbox(tx, {
      eventType: 'batch_leaving_soon_reminder',
      earliestSendAt: reminderEarliest,
      payload: leavingPayload,
    });
    // The configurable "last call" N hours before close — skipped when it'd already be past (a window
    // shorter than N hours) or the setting is off.
    if (enqueueFinalWarning) {
      await enqueueOutbox(tx, {
        eventType: 'batch_final_warning',
        earliestSendAt: finalWarningEarliest,
        payload: leavingPayload,
      });
    }
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
 *
 * DESIGN-011 D-05 ownership rule: un-saving DURING the open `leaving_soon` window is owner-or-manager
 * only — a `save_leaving_soon` holder may release ONLY their own rescue (`saved_by === actorId`);
 * releasing another family member's rescue needs `manage_batches`/admin (`callerCanManage`). This is
 * SERVER-authoritative (the poster wall scopes it client-side, but a `save_leaving_soon` holder could
 * otherwise unlock anyone's save). The manager rules for `admin_review` are unchanged — that phase is
 * already `manage_batches`-gated at the API, so `callerCanManage` is irrelevant there.
 */
export async function setBatchItemSaved(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  batchId: string;
  itemId: string;
  saved: boolean;
  actorId: string | null;
  /** Whether the caller holds `manage_batches`/admin (the API resolves this off the session). Governs
   *  ONLY the `leaving_soon` un-save ownership gate below; defaults false (fail closed). */
  callerCanManage?: boolean;
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

  // DESIGN-011 D-05 — un-save ownership gate. Reaching here on an un-save means item.state==='saved'.
  // While the window is OPEN (leaving_soon), a family member holding only `save_leaving_soon` may
  // release ONLY their OWN rescue; releasing another member's save needs `manage_batches`/admin. Fail
  // closed BEFORE any external Maintainerr write. (admin_review un-saves are already manage_batches-
  // gated at the API — the manager rules there are unchanged.) Every `saved` row is a HUMAN rescue now
  // (system requested auto-saves were removed — ADR-025 errata 2026-07-09), so the rule is uniform.
  if (
    !input.saved &&
    batch.state === 'leaving_soon' &&
    !input.callerCanManage &&
    item.savedBy !== input.actorId
  ) {
    throw new TrashSaveNotOwnedError(
      `Only the family member who saved "${item.title}" — or a batch manager — can un-save it while it is Leaving Soon.`,
    );
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
    // 3) State + the tuning save-event row, same tx. A human save is an ordinary rescue (the filled
    //    shield); saved_reason stays NULL (the removed 'requested' auto-save never applies).
    await inTransaction(input.db, async (tx) => {
      await tx
        .update(trashBatchItems)
        .set({ state: 'saved', savedBy: input.actorId, savedAt: nowDate(), savedReason: null })
        .where(eq(trashBatchItems.id, input.itemId));
      await tx
        .insert(trashBatchSaves)
        .values({ batchItemId: input.itemId, userId: input.actorId, action: 'save' });
    });
    return { changed: true, state: 'saved' };
  }

  // Un-save: release the exclusion (external-first) + re-add to Leaving-Soon + record the unsave.
  // ADR-025 errata (2026-07-09) — the `requested_override` semantics were REMOVED: there is no system
  // requested auto-save to override any more (owner ruling — requested is informational only), so an
  // un-save is always the plain release of a human rescue back to the slated `pending` state.
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
      .set({ state: 'pending', savedBy: null, savedAt: null, savedReason: null })
      .where(eq(trashBatchItems.id, input.itemId));
    await tx
      .insert(trashBatchSaves)
      .values({ batchItemId: input.itemId, userId: input.actorId, action: 'unsave' });
  });
  return { changed: true, state: 'pending' };
}

// ---------------------------------------------------------------------------
// unprotectBatchItem — un-protect a `protected` (exclusion-held) batch-wall item
// ---------------------------------------------------------------------------

/**
 * ADR-025 errata (2026-07-09) — un-protect a `protected` batch-wall item that is held by a live
 * Maintainerr exclusion (a `dnd` tag / cross-session whitelist frozen into the snapshot as `protected`,
 * e.g. a legacy pre-0026 batch item). The wall's `check` glyph was INERT, stranding such an item as
 * both un-savable and un-deletable (the owner-reported "Kept 1" Baldwins). Tapping it now removes the
 * exclusion through the SAME guarded seam the live wall uses (removeExclusion — external-first + the
 * audited `trash_excluded` 'unsave' event) and frees the row to plain `pending` (the slated trash-can).
 *
 * This flow is about EXCLUSIONS, not requesters: it was formerly landing a requester-carrying item on a
 * `saved` person-shield, but the requester auto-save was removed (owner ruling 2026-07-09 — requested is
 * informational only), so a freed row always lands `pending` regardless of requesters. Phase-gated
 * exactly like setBatchItemSaved (admin_review / open leaving_soon only). Idempotent: a non-`protected`
 * item is an inert no-op. The UPDATE is guarded (`AND state='protected'`) so a concurrent transition
 * loses the race rather than double-acting.
 */
export async function unprotectBatchItem(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  batchId: string;
  itemId: string;
  actorId: string | null;
}): Promise<{ changed: boolean; state: TrashBatchItemState }> {
  const db = resolveDb(input.db);
  const batch = await loadBatch(input.db, input.batchId);
  if (batch.state !== 'admin_review' && batch.state !== 'leaving_soon') {
    throw new TrashBatchStateError(
      `Batch ${input.batchId} is '${batch.state}' — items can only be un-protected in admin_review or leaving_soon.`,
    );
  }
  if (
    batch.state === 'leaving_soon' &&
    batch.expiresAt !== null &&
    batch.expiresAt.getTime() <= Date.now()
  ) {
    throw new TrashBatchStateError(
      `The save window for batch ${input.batchId} has closed — items can no longer be curated.`,
    );
  }

  const [item] = await db
    .select()
    .from(trashBatchItems)
    .where(and(eq(trashBatchItems.id, input.itemId), eq(trashBatchItems.batchId, input.batchId)));
  if (!item) throw new NotFoundError(`Batch item ${input.itemId} not found in batch ${input.batchId}`);

  // Only a `protected` item is un-protectable; saved/pending/skipped/deleted are inert here (the wall
  // never taps them into this path — mirror setBatchItemSaved's idempotent no-op contract).
  if (item.state !== 'protected') return { changed: false, state: item.state };

  // 1) Remove the standing exclusion FIRST (external, protective ordering) — the shared audited seam.
  await removeExclusion({
    db: input.db,
    maintainerr: input.maintainerr,
    maintainerrMediaId: item.maintainerrMediaId,
    mediaItemId: item.mediaItemId,
    actorId: input.actorId,
  });
  // 2) Surface it back into the visible Leaving-Soon collection (it was hidden while protected).
  if (batch.maintainerrCollectionId !== null) {
    await guardMaintainerrCall('maintainerr POST /collections/add', () =>
      input.maintainerr.write.addToCollection(batch.maintainerrCollectionId as number, [
        item.maintainerrMediaId,
      ]),
    );
  }

  // 3) Free the row to slated `pending` (guarded on state='protected' — a concurrent flip loses the
  //    race). Requesters no longer land it `saved` (requested is informational only now).
  const claimed = await inTransaction(input.db, async (tx) => {
    const updated = await tx
      .update(trashBatchItems)
      .set({ state: 'pending', savedBy: null, savedAt: null, savedReason: null })
      .where(and(eq(trashBatchItems.id, input.itemId), eq(trashBatchItems.state, 'protected')))
      .returning({ id: trashBatchItems.id });
    return updated.length > 0;
  });
  if (!claimed) {
    const [now] = await db
      .select({ state: trashBatchItems.state })
      .from(trashBatchItems)
      .where(eq(trashBatchItems.id, input.itemId));
    return { changed: false, state: now?.state ?? item.state };
  }
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
  /** Items that changed state (typically a concurrent Save) between candidate-select and the guarded
   *  item-write — neither deleted nor re-skipped by this sweep (F2 save-race). */
  raceSkipped: number;
  /** True when the circuit breaker tripped (N consecutive handle failures): the batch was left
   *  `leaving_soon` with partial results; the next sweep resumes the remaining `pending` items (F3). */
  aborted: boolean;
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
 * the per-item handle call. The per-item state flip is a GUARDED UPDATE (`AND state='pending'`): an
 * item Saved mid-sweep loses the race and is never deleted (F2 → `raceSkipped`). Guardian-kept /
 * stale / live-excluded items land `skipped`. After 3 CONSECUTIVE handle failures the batch's sweep
 * aborts (F3 → `aborted`), leaving it `leaving_soon` for the next sweep to resume. When `batchId` is
 * given (the manual "Expire now" trigger) only that batch is swept (and must be leaving_soon +
 * expired) — UNLESS `forceOverride` is set (DESIGN-011 amendment 2026-07-08, owner-directed): an
 * admin/`manage_batches` override may sweep a `leaving_soon` batch whose window has NOT closed yet.
 * The override bypasses ONLY the `expires_at <= now` gate — every per-item safety layer (guardian
 * keeps, live exclusions, saved items, the circuit breaker, the deletion snapshot) is unchanged. A
 * forced sweep is AUDITED: the batch close transition event + the `batch_swept` push carry
 * `forcedEarly: true` + the actor (`forcedBy`). `forceOverride` applies only with `batchId` (the
 * manual procedure) — the scheduled path ignores it and still only sweeps genuinely-closed windows.
 */
export async function sweepExpiredBatches(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  actorId?: string | null;
  watchWindowDays?: number;
  batchId?: string;
  /** Manual "Expire now" ADMIN OVERRIDE — sweep a leaving_soon batch whose window is still open
   *  (bypasses only the expiry gate; audited `forcedEarly`). Only honored alongside `batchId`. */
  forceOverride?: boolean;
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
    let forcedEarly = false;
    if (input.batchId !== undefined) {
      // Manual trigger: validate it is genuinely a leaving_soon batch.
      const [full] = await db.select().from(trashBatches).where(eq(trashBatches.id, c.id));
      if (!full || full.state !== 'leaving_soon') {
        throw new TrashBatchStateError(
          `Batch ${c.id} is not in 'leaving_soon' — cannot expire.`,
        );
      }
      const windowOpen = full.expiresAt !== null && full.expiresAt.getTime() > Date.now();
      if (windowOpen && input.forceOverride !== true) {
        // Window still open and no override ⇒ refuse (today's behavior).
        throw new TrashBatchStateError(
          `Batch ${c.id}'s save window has not closed yet (expires ${full.expiresAt!.toISOString()}).`,
        );
      }
      // The override actually did something only when the window was genuinely still open.
      forcedEarly = windowOpen && input.forceOverride === true;
    } else {
      // Scheduled: only sweep windows that have actually closed (forceOverride is ignored here).
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
        forcedEarly,
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
  /** DESIGN-011 amendment — this batch was force-expired mid-window (audited on the close event/push). */
  forcedEarly?: boolean;
}): Promise<BatchSweepResult> {
  const db = resolveDb(input.db);
  // Deletion-audit attribution (Recently Deleted "By" + the Activity notification), resolved once.
  const actorName = await resolveActorName(input.db, input.actorId);
  const sweepArrKind = arrKindForTrashMedia(input.mediaKind as TrashMedia);

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

  // F3 — mid-loop circuit breaker: after this many CONSECUTIVE per-item handle failures, abort the
  // sweep of THIS batch (Maintainerr is likely mid-outage). The batch stays `leaving_soon` with the
  // partial results honestly recorded; the next sweep resumes the remaining `pending` items.
  const HANDLE_FAILURE_LIMIT = 3;

  let deletedCount = 0;
  // ADR-035 — the handled ids, dropped from the candidate read-model after the sweep so the wall
  // never re-shows a just-deleted item while waiting for the next snapshot refresh.
  const sweptMediaIds: string[] = [];
  let reclaimedBytes = 0; // ADR-034 — summed for the batch_swept push (frozen deletion-snapshot size)
  let skippedCount = 0;
  let handleErrors = 0;
  let raceSkipped = 0;
  let consecutiveHandleFailures = 0;
  let aborted = false;

  for (const item of candidates) {
    const fresh = freshById.get(item.maintainerrMediaId);
    // Gone from Maintainerr's pending set, or currently live-excluded (saved/dnd synced) ⇒ keep.
    if (!fresh || liveExcluded.has(item.maintainerrMediaId)) {
      if (await markItemSkipped(input.db, item.id)) skippedCount += 1;
      else raceSkipped += 1; // saved between candidate-select and skip-write — leave it 'saved'
      continue;
    }
    const verdict = classifyGuardian(fresh);
    if (verdict.keep) {
      // dnd / recently-watched / unevaluable — never deleted (C-07b). Skip, no whitelist: a repeat
      // next batch is the intended stronger tuning signal (Q-03), Save is the permanent lever.
      //
      // ADR-025 errata (2026-07-09) — a requester is NO LONGER a keep (owner ruling — requested is
      // informational only), so a requested item is cold here and falls through to deletion below
      // unless another guard (saves/exclusions/recently-watched) protects it. The old
      // `requested_override` exception is gone (there is nothing to override any more).
      if (await markItemSkipped(input.db, item.id)) skippedCount += 1;
      else raceSkipped += 1;
      continue;
    }
    // Cold + positively evaluated ⇒ delete this one item. F2 — the state flip is a GUARDED UPDATE
    // (`... AND state='pending'`): if a concurrent Save flipped the row between the candidate-select
    // above and this write, it claims 0 rows and we ABORT this item's delete (no intent event, no
    // handle) — a saved item must never be deleted. Intent event + terminal state + deletion snapshot
    // land same-tx AFTER the claim so nothing is written when the claim loses (D-09 intent-first).
    const claimed = await inTransaction(input.db, async (tx) => {
      const updated = await tx
        .update(trashBatchItems)
        .set({
          state: 'deleted',
          deletedAt: nowDate(),
          deletedSizeBytes: fresh.sizeBytes,
          deletedResolution: fresh.resolution,
          deletedImdbRating: fresh.imdbRating === null ? null : fresh.imdbRating.toString(),
          deletedTmdbRating: fresh.tmdbRating === null ? null : fresh.tmdbRating.toString(),
        })
        .where(and(eq(trashBatchItems.id, item.id), eq(trashBatchItems.state, 'pending')))
        .returning({ id: trashBatchItems.id });
      if (updated.length === 0) return false; // saved/changed mid-sweep — do not delete
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
      // Same-tx deletion audit: tombstone the media_item so Recently Deleted surfaces this swept
      // deletion (with actor) immediately, and write the app-sourced Activity notification — the batch
      // sweep deletes via the same per-item handle Maintainerr never webhooks back.
      await recordDeletionAudit(tx, {
        mediaItemId: item.mediaItemId,
        title: fresh.title,
        sizeBytes: fresh.sizeBytes,
        tmdbId: fresh.tmdbId,
        tvdbId: fresh.tvdbId,
        arrKind: sweepArrKind,
        actorId: input.actorId,
        actorName,
        scope: 'batch',
        // PLAN-013 — mirror the frozen deletion snapshot into the Activity notification payload too.
        resolution: fresh.resolution,
        imdbRating: fresh.imdbRating,
        tmdbRating: fresh.tmdbRating,
      });
      return true;
    });
    if (!claimed) {
      raceSkipped += 1; // the item was Saved just in time — never deleted, never handled
      continue;
    }
    deletedCount += 1; // the row is durably 'deleted' (intent-first) whether or not the handle lands
    sweptMediaIds.push(item.maintainerrMediaId);
    reclaimedBytes += fresh.sizeBytes ?? 0;
    // The destructive per-item handle. A single failure is tolerated (intent + snapshot are durable;
    // Maintainerr reconciles a genuinely-missed delete), but N consecutive failures trip the breaker.
    try {
      await guardMaintainerrCall('maintainerr POST /collections/media/handle', () =>
        input.maintainerr.write.handleCollectionMedia(fresh.collectionId, item.maintainerrMediaId),
      );
      consecutiveHandleFailures = 0;
    } catch {
      handleErrors += 1;
      consecutiveHandleFailures += 1;
      if (consecutiveHandleFailures >= HANDLE_FAILURE_LIMIT) {
        aborted = true;
        break;
      }
    }
  }

  // ADR-035 — read-model cleanup for everything this sweep durably deleted (abort included: those
  // items' intents are committed, so they must not re-surface as candidates).
  await removeTrashCandidateRows({ db: input.db, maintainerrMediaIds: sweptMediaIds });

  const finalCounts = await countItemStates(input.db, input.batchId);
  // F3 — on a circuit-breaker abort, DO NOT close the batch: leave it `leaving_soon` so the next sweep
  // resumes the remaining `pending` items (deleted/skipped items are excluded by their state).
  if (aborted) {
    return {
      batchId: input.batchId,
      mediaKind: input.mediaKind,
      deletedCount,
      skippedCount,
      savedCount: finalCounts.saved ?? 0,
      protectedCount: finalCounts.protected ?? 0,
      handleErrors,
      raceSkipped,
      aborted: true,
    };
  }

  // ADR-034 — the "batch swept" summary push (only on a clean close, never on a breaker abort). Window
  // computed before the close tx; the outbox row commits with the terminal transition.
  const sweptEarliest = computeEarliestSend(nowDate(), await getNotifyWindow(input.db));

  // Tally the settled states + close the batch (guarded UPDATE + transition event same-tx).
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
      extra: {
        deletedCount,
        skippedCount,
        raceSkipped,
        handleErrors,
        counts: finalCounts,
        // DESIGN-011 amendment — an audited admin override that expired the batch mid-window.
        ...(input.forcedEarly ? { forcedEarly: true, forcedBy: input.actorId } : {}),
      },
    });
    await enqueueOutbox(tx, {
      eventType: 'batch_swept',
      earliestSendAt: sweptEarliest,
      payload: {
        batchId: input.batchId,
        mediaKind: input.mediaKind,
        deletedCount,
        reclaimedBytes,
        ...(input.forcedEarly ? { forcedEarly: true, forcedBy: input.actorId } : {}),
      },
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
    raceSkipped,
    aborted: false,
  };
}

/** F2 — a GUARDED skip: only flips a still-`pending` item to `skipped`. Returns whether it claimed the
 *  row; false means a concurrent Save changed it mid-sweep (leave it 'saved', never overwrite). */
async function markItemSkipped(db: DbClient | undefined, itemId: string): Promise<boolean> {
  const updated = await resolveDb(db)
    .update(trashBatchItems)
    .set({ state: 'skipped' })
    .where(and(eq(trashBatchItems.id, itemId), eq(trashBatchItems.state, 'pending')))
    .returning({ id: trashBatchItems.id });
  return updated.length > 0;
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
  /** bytes STILL slated — the frozen size of the batch's `pending` (not-yet-saved) items. The
   *  Trash Overview card's "frees X" for an open batch (DESIGN-010 amendment 2026-07-08); the
   *  companion of reclaimedBytes for a batch that has not yet swept. */
  pendingBytes: number;
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
      // The frozen snapshot size — summed per state so the `pending` row yields the "still-slated"
      // bytes the Overview card's "frees X" reads for an open batch (DESIGN-010 amendment).
      slatedBytes: sql<number>`coalesce(sum(${trashBatchItems.sizeBytes}), 0)::bigint`,
    })
    .from(trashBatchItems)
    .where(inArray(trashBatchItems.batchId, ids))
    .groupBy(trashBatchItems.batchId, trashBatchItems.state);
  const rawByBatch = new Map<string, Record<string, number>>();
  const reclaimedByBatch = new Map<string, number>();
  const pendingBytesByBatch = new Map<string, number>();
  for (const r of countRows) {
    const raw = rawByBatch.get(r.batchId) ?? {};
    raw[r.state] = r.n;
    rawByBatch.set(r.batchId, raw);
    if (r.state === 'deleted') {
      reclaimedByBatch.set(r.batchId, (reclaimedByBatch.get(r.batchId) ?? 0) + Number(r.reclaimed));
    }
    if (r.state === 'pending') {
      pendingBytesByBatch.set(r.batchId, Number(r.slatedBytes));
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
    pendingBytes: pendingBytesByBatch.get(b.id) ?? 0,
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
  // Poster-wall display join (DESIGN-011 D-05/D-07 — read-only media_metadata enrichment): the
  // caption rating and the "recently watched ⇒ the guardian keeps it" eye overlay. Both are live
  // reads (not part of the frozen snapshot); recentlyWatched mirrors listTrashPending's window so
  // the wall's eye matches what the sweep's guardian will actually protect.
  imdbRating: number | null;
  tmdbRating: number | null;
  recentlyWatched: boolean;
  /** DESIGN-010 D-12 — cross-server watch VISIBILITY (info, not protection): the MAX last-watch
   *  instant across all three Tautulli histories + its estate slug. The batch wall shows a muted
   *  "watched a while ago" indicator when set but NOT recentlyWatched; it never changes actionability. */
  lastWatchedAt: string | null;
  lastWatchedServer: string | null;
  /** The ledger's known requesters — INFO ONLY now (owner ruling 2026-07-09 — requested is no longer
   *  an app-side keep). A non-empty list drives the wall's "Requested by <name>" meta badge; it does
   *  NOT change the tile glyph or actionability. */
  requesters: string[];
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

  // Left-join media_metadata for the wall's display fields (rating caption + the recently-watched
  // eye). Items unknown to our ledger (media_item_id NULL) simply get nulls/false.
  const rows = await db
    .select({
      item: trashBatchItems,
      imdbRating: mediaMetadata.imdbRating,
      tmdbRating: mediaMetadata.tmdbRating,
      lastViewedAt: mediaMetadata.lastViewedAt,
      lastWatchedAt: mediaMetadata.lastWatchedAt,
      lastWatchedServer: mediaMetadata.lastWatchedServer,
      requesters: mediaMetadata.requesters,
    })
    .from(trashBatchItems)
    .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, trashBatchItems.mediaItemId))
    .where(eq(trashBatchItems.batchId, input.batchId))
    .orderBy(desc(trashBatchItems.sizeBytes));

  const watchedCutoff = Date.now() - RECENTLY_WATCHED_WINDOW_DAYS * 86_400_000;
  /** Drizzle numeric columns arrive as strings — normalize (0 stays 0; the UI collapses it). */
  const numOrNull = (v: string | null): number | null => (v === null ? null : Number(v));

  const raw: Record<string, number> = {};
  let reclaimedBytes = 0;
  let pendingBytes = 0;
  for (const { item: it } of rows) {
    raw[it.state] = (raw[it.state] ?? 0) + 1;
    if (it.state === 'deleted') reclaimedBytes += it.deletedSizeBytes ?? 0;
    if (it.state === 'pending') pendingBytes += it.sizeBytes;
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
    pendingBytes,
    items: rows.map(({ item: it, imdbRating, tmdbRating, lastViewedAt, lastWatchedAt, lastWatchedServer, requesters }) => ({
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
      // The requester reclassification-on-read was REMOVED (ADR-025 errata 2026-07-09 — requested is
      // informational only; there is no person-shield to reclassify a `saved` row into). The vestigial
      // saved_reason / requested_override columns are left in place (harmless) but no longer read here.
      imdbRating: numOrNull(imdbRating),
      tmdbRating: numOrNull(tmdbRating),
      recentlyWatched: lastViewedAt !== null && lastViewedAt.getTime() >= watchedCutoff,
      lastWatchedAt: lastWatchedAt?.toISOString() ?? null,
      lastWatchedServer: lastWatchedServer ?? null,
      requesters: requesters ?? [],
    })),
  };
}

export interface BatchSaveStats {
  batchId: string;
  /** Items CURRENTLY held saved (net) — identical to `counts.saved` + the poster wall. */
  totalSaves: number;
  /** Items rescued at some point but NOT currently saved (net churn) — released, attributed to the
   *  last releaser. Disjoint from the saved set (an item is in exactly one, or neither). */
  totalUnsaves: number;
  /** The net rescued count. Equals `totalSaves` — each item contributes at most one net save. */
  netSaved: number;
  byUser: Array<{ userId: string | null; displayName: string | null; saves: number; unsaves: number }>;
}

/**
 * ADR-025 (Q-07) — the "who rescued what" summary for a batch, in NET semantics: a saver's tally is
 * their CURRENT net effect, never a raw count of save/unsave events. Repeatedly saving+unsaving a
 * title no longer inflates anything — save→unsave→save is 1 net save; save→unsave is 0; a two-user
 * tug-of-war lands on the FINAL holder only.
 *
 * Two disjoint, net-by-construction sources (the raw `trash_batch_saves` log stays intact as the
 * PLAN-014 tuning DATASET / audit trail — it is not the count):
 *   - saves   → current item state (`trash_batch_items.state = 'saved'`, grouped by `saved_by`). This
 *               is the SAME source as `counts.saved` and the poster wall, so the card can never drift
 *               from what the owner sees on the grid.
 *   - unsaves → the audit log's LATEST event per still-un-saved item (`state <> 'saved'`, DISTINCT ON
 *               newest first). An item currently saved has a `save` as its latest event and is excluded
 *               here, so the two sets never overlap (no double count). Every row this returns is a
 *               net-released item (its latest flip was an un-save — the only way to leave `saved`),
 *               credited to whoever released it last.
 */
export async function getBatchSaveStats(input: {
  db?: DbClient;
  batchId: string;
}): Promise<BatchSaveStats> {
  const db = resolveDb(input.db);

  // Net SAVES — current HUMAN holders, straight from item state. This is the "who rescued what" HUMAN
  // tuning dataset (PLAN-014 labelled false positives). System requested auto-saves were removed
  // (ADR-025 errata 2026-07-09 — nothing auto-saves now), so every current `saved` row is a human
  // rescue; the `saved_reason IS DISTINCT FROM 'requested'` guard is retained defensively to keep any
  // legacy pre-errata auto-save row from inflating a tally (a machine keep is not a rescue).
  const savedRows = await db
    .select({
      userId: trashBatchItems.savedBy,
      displayName: users.displayName,
      n: sql<number>`count(*)::int`,
    })
    .from(trashBatchItems)
    .leftJoin(users, eq(users.id, trashBatchItems.savedBy))
    .where(
      and(
        eq(trashBatchItems.batchId, input.batchId),
        eq(trashBatchItems.state, 'saved'),
        sql`${trashBatchItems.savedReason} IS DISTINCT FROM 'requested'`,
      ),
    )
    .groupBy(trashBatchItems.savedBy, users.displayName);

  // Net UNSAVES — one row per still-released item (its latest audit event, which is always an un-save
  // once the item is no longer 'saved'); attributed to the last releaser.
  const releasedRows = await db
    .selectDistinctOn([trashBatchSaves.batchItemId], {
      userId: trashBatchSaves.userId,
      displayName: users.displayName,
    })
    .from(trashBatchSaves)
    .innerJoin(trashBatchItems, eq(trashBatchItems.id, trashBatchSaves.batchItemId))
    .leftJoin(users, eq(users.id, trashBatchSaves.userId))
    .where(and(eq(trashBatchItems.batchId, input.batchId), ne(trashBatchItems.state, 'saved')))
    .orderBy(trashBatchSaves.batchItemId, desc(trashBatchSaves.createdAt), desc(trashBatchSaves.id));

  const byUserMap = new Map<
    string,
    { userId: string | null; displayName: string | null; saves: number; unsaves: number }
  >();
  const entryFor = (userId: string | null, displayName: string | null) => {
    const key = userId ?? 'system';
    let entry = byUserMap.get(key);
    if (entry === undefined) {
      entry = { userId, displayName, saves: 0, unsaves: 0 };
      byUserMap.set(key, entry);
    } else if (entry.displayName === null && displayName !== null) {
      entry.displayName = displayName;
    }
    return entry;
  };

  let totalSaves = 0;
  for (const r of savedRows) {
    entryFor(r.userId, r.displayName).saves += r.n;
    totalSaves += r.n;
  }

  let totalUnsaves = 0;
  for (const r of releasedRows) {
    entryFor(r.userId, r.displayName).unsaves += 1;
    totalUnsaves += 1;
  }

  return {
    batchId: input.batchId,
    totalSaves,
    totalUnsaves,
    netSaved: totalSaves,
    byUser: [...byUserMap.values()],
  };
}
