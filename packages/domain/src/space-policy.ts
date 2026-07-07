// ADR-031 / DESIGN-014 (PLAN-014) — the SPACE-DRIVEN POLICY orchestrator. Propose-only, never
// autonomous deletion: when a physical media array is over its `space_targets` ceiling, PROPOSE a
// draft batch for the kind(s) that array backs (createBatchFromPending — the normal admin_review
// path). It NEVER greenlights and NEVER sweeps; the admin gate stays the human check. If the audited
// `trash_skip_admin_gate` is ON the proposed batch flows per that setting's own semantics (we do NOT
// special-case it — createBatchFromPending owns that path). Every proposal writes a `trash_space_policy`
// ledger event (the WHY: array/usedPct/target/candidates) + a `space_policy` notification (source
// 'trash') so Bulletin/Activity shows "policy proposed a batch".
//
// SAFETY / IDEMPOTENCE: one-open-per-kind already blocks duplicates — a refusal (TrashBatchOpenError)
// is handled gracefully (skipped, logged, no throw). A per-kind COOLDOWN blocks re-proposing within N
// days of the last policy-created batch for that kind (anti-spam while a batch is mid-window). An
// array is OPT-IN (its per-array `enabled` must be true) even when the policy is globally enabled.
import {
  ledgerEvents,
  trashBatches,
  TRASH_BATCH_OPEN_STATES,
  type DbClient,
  type TrashBatchState,
  type TrashMediaKind,
} from '@hnet/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  APP_SETTING_DEFAULTS,
  effectiveArrayPolicy,
  getAppSetting,
  type SpacePolicy,
} from './app-settings';
import { resolveDb } from './db-client';
import {
  createBatchFromPending,
  type CreateBatchResult,
} from './trash-batches';
import { TrashBatchEmptyError, TrashBatchOpenError } from './errors';
import type { MaintainerrClientBundle } from './maintainerr-clients';
import { getUtilization, STORAGE_ARRAYS, type UtilizationArrBundle } from './storage-metrics';
import { recordNotification } from './notifications';
import { listTrashPending, type TrashMedia, type TrashPendingItem } from './trash-flow';

const DAY_MS = 86_400_000;
const OPEN_STATES = TRASH_BATCH_OPEN_STATES as readonly TrashBatchState[];

/** The Trash media kind each *arr source maps to (music/Lidarr is never batchable — R-87, so it
 *  maps to nothing and the CephFS array proposes no batches). */
const ARR_TO_TRASH_KIND: Partial<Record<'radarr' | 'sonarr' | 'lidarr', TrashMediaKind>> = {
  radarr: 'movie',
  sonarr: 'tv',
};

/** The Trash kinds a physical array backs, derived from STORAGE_ARRAYS sources (deduped, ordered
 *  movie→tv). `haynestower` → [movie, tv] (Radarr+Sonarr share it); `cephfs` → [] (music). */
export function trashKindsForArray(arrayKey: string): TrashMediaKind[] {
  const desc = STORAGE_ARRAYS.find((a) => a.key === arrayKey);
  if (!desc) return [];
  const kinds: TrashMediaKind[] = [];
  for (const source of desc.sources) {
    const kind = ARR_TO_TRASH_KIND[source.arr];
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

/** Read the space-policy config, merged over its documented defaults so a partial/hand-edited jsonb
 *  row can never leave a required field undefined (fail-safe: missing `enabled` reads as false). */
export async function getSpacePolicy(db?: DbClient): Promise<SpacePolicy> {
  const stored = await getAppSetting(db, 'space_policy');
  const d = APP_SETTING_DEFAULTS.space_policy;
  return {
    enabled: stored?.enabled === true,
    cooldownDays: typeof stored?.cooldownDays === 'number' ? stored.cooldownDays : d.cooldownDays,
    minCandidates:
      typeof stored?.minCandidates === 'number' ? stored.minCandidates : d.minCandidates,
    perArray: stored?.perArray ?? {},
  };
}

// ---------------------------------------------------------------------------
// evaluateSpacePolicy — the `space-policy` sync mode's core
// ---------------------------------------------------------------------------

export type SpacePolicyOutcome =
  | 'proposed'
  | 'skipped_open_batch'
  | 'skipped_cooldown'
  | 'skipped_min_candidates'
  | 'skipped_empty'
  | 'error';

export interface SpacePolicyProposal {
  mediaKind: TrashMediaKind;
  outcome: SpacePolicyOutcome;
  /** The proposed batch (null when nothing was created). */
  batchId: string | null;
  /** Whether the audited skip-gate promoted the proposed batch straight to Leaving Soon. */
  gateSkipped: boolean;
  /** Actionable pending items considered for this kind, and their total size. */
  candidateCount: number;
  candidateBytes: number;
  /** When the cooldown blocks this kind, when it next becomes eligible (ISO); else null. */
  cooldownUntil: string | null;
  /** Human-readable rationale (for the CronJob log + the report). */
  reason: string;
}

export interface SpacePolicyArrayResult {
  key: string;
  label: string;
  usedPct: number | null;
  target: number | null;
  /** usedPct strictly greater than target (both present). */
  overTarget: boolean;
  /** The array is opted in (per-array enabled). */
  enabled: boolean;
  /** No source *arr could be read for this array this run. */
  unavailable: boolean;
  proposals: SpacePolicyProposal[];
}

export interface SpacePolicyReport {
  /** The policy's global enabled flag at run time (false ⇒ a no-op run, `arrays` empty). */
  enabled: boolean;
  ranAt: string; // ISO-8601
  /** Total batches actually proposed this run. */
  proposedCount: number;
  arrays: SpacePolicyArrayResult[];
}

/** The most recent policy proposal (trash_space_policy event) for a kind, or null. */
async function lastPolicyProposalAt(
  db: DbClient | undefined,
  mediaKind: TrashMediaKind,
): Promise<Date | null> {
  const [row] = await resolveDb(db)
    .select({ occurredAt: ledgerEvents.occurredAt })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.eventType, 'trash_space_policy'),
        sql`${ledgerEvents.payload}->>'mediaKind' = ${mediaKind}`,
      ),
    )
    .orderBy(desc(ledgerEvents.occurredAt))
    .limit(1);
  return row?.occurredAt ?? null;
}

/** Whether an OPEN batch (draft/admin_review/leaving_soon) already exists for a kind. */
async function hasOpenBatch(db: DbClient | undefined, mediaKind: TrashMediaKind): Promise<boolean> {
  const [row] = await resolveDb(db)
    .select({ id: trashBatches.id })
    .from(trashBatches)
    .where(and(eq(trashBatches.mediaKind, mediaKind), inArray(trashBatches.state, [...OPEN_STATES])))
    .limit(1);
  return row !== undefined;
}

/**
 * Evaluate the space-driven policy ONCE (the `space-policy` sync mode's body). Returns a report of
 * every array's over/under-target verdict and, for over-target opted-in arrays, one proposal outcome
 * per backing kind. Only PROPOSES (createBatchFromPending) — never greenlights, never deletes. Never
 * throws for a per-kind failure (records `outcome:'error'` in the report and moves on); it throws only
 * if the utilization/settings reads themselves fail.
 */
export async function evaluateSpacePolicy(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  arr: UtilizationArrBundle;
  actorId?: string | null;
  now?: Date;
}): Promise<SpacePolicyReport> {
  const now = input.now ?? new Date();
  const actorId = input.actorId ?? null;
  const policy = await getSpacePolicy(input.db);

  // Globally off ⇒ a cheap no-op (don't even read utilization). DEFAULT OFF (conservative-first).
  if (!policy.enabled) {
    return { enabled: false, ranAt: now.toISOString(), proposedCount: 0, arrays: [] };
  }

  const utilization = await getUtilization({ db: input.db, arr: input.arr });
  const arrays: SpacePolicyArrayResult[] = [];
  let proposedCount = 0;

  for (const util of utilization) {
    const arrCfg = effectiveArrayPolicy(policy, util.key);
    const overTarget =
      util.usedPct !== null && util.target !== null && util.usedPct > util.target;
    const result: SpacePolicyArrayResult = {
      key: util.key,
      label: util.label,
      usedPct: util.usedPct,
      target: util.target,
      overTarget,
      enabled: arrCfg.enabled,
      unavailable: util.unavailable,
      proposals: [],
    };

    // Skip unless: opted in, reachable, has a target, and is actually over it. (Not opted in / under
    // target / unavailable / no target ⇒ no proposals; the array still appears in the report.)
    if (!arrCfg.enabled || util.unavailable || util.target === null || !overTarget) {
      arrays.push(result);
      continue;
    }

    for (const mediaKind of trashKindsForArray(util.key)) {
      const proposal = await proposeForKind({
        db: input.db,
        maintainerr: input.maintainerr,
        actorId,
        now,
        mediaKind,
        arrayKey: util.key,
        arrayLabel: util.label,
        usedPct: util.usedPct,
        target: util.target,
        cooldownDays: arrCfg.cooldownDays,
        minCandidates: arrCfg.minCandidates,
      });
      if (proposal.outcome === 'proposed') proposedCount += 1;
      result.proposals.push(proposal);
    }
    arrays.push(result);
  }

  return { enabled: true, ranAt: now.toISOString(), proposedCount, arrays };
}

async function proposeForKind(input: {
  db?: DbClient;
  maintainerr: MaintainerrClientBundle;
  actorId: string | null;
  now: Date;
  mediaKind: TrashMediaKind;
  arrayKey: string;
  arrayLabel: string;
  usedPct: number | null;
  target: number | null;
  cooldownDays: number;
  minCandidates: number;
}): Promise<SpacePolicyProposal> {
  const base = {
    mediaKind: input.mediaKind,
    batchId: null as string | null,
    gateSkipped: false,
    candidateCount: 0,
    candidateBytes: 0,
    cooldownUntil: null as string | null,
  };

  // 1. Idempotence: one-open-per-kind already blocks a duplicate. Skip gracefully (no error).
  if (await hasOpenBatch(input.db, input.mediaKind)) {
    return {
      ...base,
      outcome: 'skipped_open_batch',
      reason: `An open ${input.mediaKind} batch already exists — leaving it for the admin.`,
    };
  }

  // 2. Cooldown: don't re-propose within N days of the last policy-created batch for this kind.
  const lastAt = await lastPolicyProposalAt(input.db, input.mediaKind);
  if (lastAt !== null) {
    const eligibleAt = new Date(lastAt.getTime() + input.cooldownDays * DAY_MS);
    if (input.now.getTime() < eligibleAt.getTime()) {
      return {
        ...base,
        outcome: 'skipped_cooldown',
        cooldownUntil: eligibleAt.toISOString(),
        reason: `In cooldown for ${input.mediaKind} until ${eligibleAt.toISOString()} (last proposal ${lastAt.toISOString()}).`,
      };
    }
  }

  // 3. Min-candidates: don't propose unless enough is pending to be worth a batch. Read the pending
  //    set once for the count + total bytes (createBatchFromPending re-snapshots fresh when it runs).
  let actionable: Array<TrashPendingItem & { maintainerrMediaId: string }> = [];
  try {
    const pending = await listTrashPending({
      db: input.db,
      maintainerr: input.maintainerr,
      media: input.mediaKind as TrashMedia,
    });
    actionable = pending.items.filter(
      (p): p is TrashPendingItem & { maintainerrMediaId: string } => p.maintainerrMediaId !== null,
    );
  } catch (err) {
    return {
      ...base,
      outcome: 'error',
      reason: `Could not read pending ${input.mediaKind}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const candidateBytes = actionable.reduce((n, p) => n + (p.sizeBytes ?? 0), 0);
  base.candidateCount = actionable.length;
  base.candidateBytes = candidateBytes;
  if (actionable.length < input.minCandidates) {
    return {
      ...base,
      outcome: actionable.length === 0 ? 'skipped_empty' : 'skipped_min_candidates',
      reason: `Only ${actionable.length} actionable ${input.mediaKind} pending (min ${input.minCandidates}).`,
    };
  }

  // 4. Propose: the NORMAL createBatchFromPending path (admin_review, or the skip-gate's own
  //    audited flow if trash_skip_admin_gate is ON — not special-cased here).
  let created: CreateBatchResult;
  try {
    created = await createBatchFromPending({
      db: input.db,
      maintainerr: input.maintainerr,
      mediaKind: input.mediaKind,
      actorId: input.actorId,
    });
  } catch (err) {
    if (err instanceof TrashBatchOpenError) {
      // Lost a race with a concurrent create — treat exactly like the pre-check skip.
      return { ...base, outcome: 'skipped_open_batch', reason: err.message };
    }
    if (err instanceof TrashBatchEmptyError) {
      return { ...base, outcome: 'skipped_empty', reason: err.message };
    }
    return {
      ...base,
      outcome: 'error',
      reason: `createBatchFromPending failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 5. Record the WHY: a trash_space_policy ledger event + a space_policy notification (source
  //    'trash'). Attribution records for Bulletin/Activity + the tuning report's graduation join.
  //    Best-effort (intent-first, like the rest of the pipeline): the batch is the durable outcome, so
  //    a rare attribution-write failure must not abort the run — the proposal still reports 'proposed'.
  let attributionNote = '';
  try {
    await recordSpacePolicyProposal({
      db: input.db,
      batchId: created.batchId,
      mediaKind: input.mediaKind,
      arrayKey: input.arrayKey,
      arrayLabel: input.arrayLabel,
      usedPct: input.usedPct,
      target: input.target,
      candidateCount: created.itemCount,
      candidateBytes,
      gateSkipped: created.gateSkipped,
      actorId: input.actorId,
      occurredAt: input.now,
    });
  } catch (err) {
    attributionNote = ` (attribution write failed: ${err instanceof Error ? err.message : String(err)})`;
  }

  return {
    ...base,
    batchId: created.batchId,
    gateSkipped: created.gateSkipped,
    candidateCount: created.itemCount,
    outcome: 'proposed',
    reason:
      `Proposed a ${input.mediaKind} batch of ${created.itemCount} item(s) — ${input.arrayLabel} is ` +
      `${input.usedPct}% used vs a ${input.target}% target` +
      (created.gateSkipped ? ' (skip-gate ON — straight to Leaving Soon).' : ' (awaiting admin review).') +
      attributionNote,
  };
}

/** Write the trash_space_policy ledger event + the space_policy notification for one proposal. */
async function recordSpacePolicyProposal(input: {
  db?: DbClient;
  batchId: string;
  mediaKind: TrashMediaKind;
  arrayKey: string;
  arrayLabel: string;
  usedPct: number | null;
  target: number | null;
  candidateCount: number;
  candidateBytes: number;
  gateSkipped: boolean;
  actorId: string | null;
  occurredAt: Date;
}): Promise<void> {
  const kindLabel = input.mediaKind === 'movie' ? 'Movies' : 'TV';
  const payload = {
    batchId: input.batchId,
    mediaKind: input.mediaKind,
    array: input.arrayKey,
    arrayLabel: input.arrayLabel,
    usedPct: input.usedPct,
    target: input.target,
    candidateCount: input.candidateCount,
    candidateBytes: input.candidateBytes,
    gateSkipped: input.gateSkipped,
  };

  // Batch-scoped ledger event (mediaItemId null) — the durable WHY the tuning report joins on.
  await resolveDb(input.db)
    .insert(ledgerEvents)
    .values({
      mediaItemId: null,
      eventType: 'trash_space_policy',
      source: 'maintainerr',
      occurredAt: input.occurredAt,
      requestedByUserId: input.actorId,
      payload,
    });

  // The Activity/Bulletin notification (source 'trash' — the app is the event source).
  await recordNotification({
    db: input.db,
    source: 'trash',
    type: 'space_policy',
    title: `Space policy proposed a ${kindLabel} batch`,
    body:
      `${input.arrayLabel} is ${input.usedPct}% used (target ${input.target}%). Proposed ` +
      `${input.candidateCount} ${kindLabel} item${input.candidateCount === 1 ? '' : 's'} for ` +
      (input.gateSkipped ? 'Leaving Soon (skip-gate ON).' : 'admin review.'),
    occurredAt: input.occurredAt,
    payload,
  });
}

// ---------------------------------------------------------------------------
// getSpacePolicyStatus — the admin card's status read (ledger-derived)
// ---------------------------------------------------------------------------

export interface SpacePolicyProposalRecord {
  batchId: string;
  mediaKind: TrashMediaKind;
  arrayKey: string | null;
  usedPct: number | null;
  target: number | null;
  proposedAt: string; // ISO-8601
  gateSkipped: boolean;
}

export interface SpacePolicyKindStatus {
  mediaKind: TrashMediaKind;
  hasOpenBatch: boolean;
  lastProposal: SpacePolicyProposalRecord | null;
  cooldownDays: number;
  /** lastProposal.proposedAt + cooldownDays, or null when eligible now (no prior proposal / elapsed). */
  nextEligibleAt: string | null;
}

export interface SpacePolicyStatus {
  policy: SpacePolicy;
  /** The most recent proposal across every kind (the card's "last proposal" line), or null. */
  lastProposalAt: string | null;
  kinds: SpacePolicyKindStatus[];
  /** The most recent proposals (newest first, capped) for the card's history line. */
  recentProposals: SpacePolicyProposalRecord[];
}

function toProposalRecord(row: {
  occurredAt: Date;
  payload: Record<string, unknown>;
}): SpacePolicyProposalRecord {
  const p = row.payload ?? {};
  return {
    batchId: String(p.batchId ?? ''),
    mediaKind: (p.mediaKind === 'movie' ? 'movie' : 'tv') as TrashMediaKind,
    arrayKey: p.array != null ? String(p.array) : null,
    usedPct: typeof p.usedPct === 'number' ? p.usedPct : null,
    target: typeof p.target === 'number' ? p.target : null,
    proposedAt: row.occurredAt.toISOString(),
    gateSkipped: p.gateSkipped === true,
  };
}

/**
 * The space-policy admin card's status read: the effective config, the last proposal (per kind + the
 * global newest), each kind's open-batch + cooldown/next-eligible state, and a short proposal history.
 * A pure DB read (ledger + batches) — the live over/under-target readout comes from storage.utilization
 * which the page already loads (no *arr read here). ISO strings on the wire.
 */
export async function getSpacePolicyStatus(input: {
  db?: DbClient;
  now?: Date;
}): Promise<SpacePolicyStatus> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const policy = await getSpacePolicy(input.db);

  const rows = await db
    .select({ occurredAt: ledgerEvents.occurredAt, payload: ledgerEvents.payload })
    .from(ledgerEvents)
    .where(eq(ledgerEvents.eventType, 'trash_space_policy'))
    .orderBy(desc(ledgerEvents.occurredAt))
    .limit(20);
  const records = rows.map((r) => toProposalRecord(r as { occurredAt: Date; payload: Record<string, unknown> }));

  const kinds: SpacePolicyKindStatus[] = [];
  for (const mediaKind of ['movie', 'tv'] as const) {
    const arrCfg = effectiveArrayPolicy(policy, 'haynestower'); // both movie+tv live on haynestower
    const last = records.find((r) => r.mediaKind === mediaKind) ?? null;
    let nextEligibleAt: string | null = null;
    if (last !== null) {
      const eligible = new Date(Date.parse(last.proposedAt) + arrCfg.cooldownDays * DAY_MS);
      nextEligibleAt = eligible.getTime() > now.getTime() ? eligible.toISOString() : null;
    }
    kinds.push({
      mediaKind,
      hasOpenBatch: await hasOpenBatch(input.db, mediaKind),
      lastProposal: last,
      cooldownDays: arrCfg.cooldownDays,
      nextEligibleAt,
    });
  }

  return {
    policy,
    lastProposalAt: records[0]?.proposedAt ?? null,
    kinds,
    recentProposals: records.slice(0, 10),
  };
}
