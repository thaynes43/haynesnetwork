// ADR-031 / DESIGN-014 (PLAN-014); ADR-073 (2026-07-18) — the SPACE-DRIVEN POLICY orchestrator. The
// AUTONOMOUS engine: when a physical media array is over its `space_targets` ceiling (or always, in
// 'continuous' mode), PROPOSE AND PROMOTE a batch for the kind(s) that array backs
// (createBatchFromPending with `autoPromote` — straight to leaving_soon with the save window). It still
// NEVER sweeps: only the windowed sweep reclaims. The owner ruling (2026-07-18) is that the machine
// keeps moving unattended — reclaim → promote immediately, no cooldown, no admin-review gate before the
// batch goes up. Every proposal writes a `trash_space_policy` ledger event (the WHY:
// array/usedPct/target/candidates) + a `space_policy` notification (source 'trash').
//
// SAFETY / IDEMPOTENCE (ADR-073): the only pacing is one-open-per-kind + the save window — while a
// leaving_soon batch is mid-window the slot is taken, so no duplicate is proposed. There is NO cooldown.
// SELF-HEAL: a batch a prior run left stuck (draft/admin_review, system-created — e.g. from before this
// fix, or a run that died between create and promote) is PROMOTED to leaving_soon on the next tick, so
// the cycle can never wedge in a "no batch" state. An array is OPT-IN (its per-array `enabled` must be
// true) even when the policy is globally enabled.
import {
  ledgerEvents,
  trashBatches,
  TRASH_BATCH_OPEN_STATES,
  TRASH_MEDIA_KINDS,
  type DbClient,
  type TrashBatchState,
  type TrashMediaKind,
} from '@hnet/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  APP_SETTING_DEFAULTS,
  SPACE_POLICY_MODES,
  activeBatchStrategy,
  defaultPerKind,
  effectiveArrayPolicy,
  effectiveKindTargeting,
  getAppSetting,
  type SpacePolicy,
  type SpacePolicyCap,
  type SpacePolicyKindCaps,
  type SpacePolicyMode,
  type SpacePolicyPerKind,
} from './app-settings';
import { resolveDb } from './db-client';
import {
  createBatchFromPending,
  promoteOpenPolicyBatch,
  type BatchTargeting,
  type CreateBatchResult,
} from './trash-batches';
import { TrashBatchEmptyError, TrashBatchOpenError } from './errors';
import type { MaintainerrClientBundle } from './maintainerr-clients';
import { getUtilization, STORAGE_ARRAYS, type UtilizationArrBundle } from './storage-metrics';
import { recordNotification } from './notifications';
import { listTrashPending, type TrashMedia, type TrashPendingItem } from './trash-flow';

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

/** One cap, per-field guarded (fail-safe): non-boolean `enabled` ⇒ OFF; non-finite/≤0 `value` ⇒ the
 *  fallback's value (so a garbage jsonb value can never yield a `NaN`/`Infinity` cap). */
function resolveCap(raw: unknown, fallback: SpacePolicyCap): SpacePolicyCap {
  const r = raw as Partial<SpacePolicyCap> | null | undefined;
  const valueOk = typeof r?.value === 'number' && Number.isFinite(r.value) && r.value > 0;
  return { enabled: r?.enabled === true, value: valueOk ? (r!.value as number) : fallback.value };
}

/**
 * Resolve the per-kind caps, fail-safe. When the stored value carries the NEW `perKind` shape it is
 * authoritative (per-field guarded over the defaults). When it does not, the retired flat
 * `targetBytesPerBatch` key (DESIGN-011/014 2026-07-08) is MIGRATED gracefully — read as a movie+tv
 * `targetBytes` cap (enabled). Absent both ⇒ every kind's caps OFF (propose ALL candidates).
 */
function resolvePerKind(stored: SpacePolicy | undefined): SpacePolicyPerKind {
  const out = defaultPerKind();
  const storedPerKind = stored?.perKind as
    | Partial<Record<TrashMediaKind, Partial<SpacePolicyKindCaps>>>
    | null
    | undefined;
  if (storedPerKind !== null && typeof storedPerKind === 'object') {
    for (const kind of TRASH_MEDIA_KINDS) {
      const sk = storedPerKind[kind];
      if (sk !== null && typeof sk === 'object') {
        // DESIGN-014 amendment (build D) — preserve a valid per-kind `strategy` fail-safe (only the two
        // known rankings survive; anything else drops so activeBatchStrategy falls back to the default).
        const strat = (sk as { strategy?: unknown }).strategy;
        out[kind] = {
          maxItems: resolveCap(sk.maxItems, out[kind].maxItems),
          targetBytes: resolveCap(sk.targetBytes, out[kind].targetBytes),
          ...(strat === 'largest' || strat === 'worst-rated' ? { strategy: strat } : {}),
        };
      }
    }
    return out;
  }
  // No new-shape perKind — graceful migration of the retired flat targetBytesPerBatch key.
  const legacy = (stored as { targetBytesPerBatch?: unknown } | undefined)?.targetBytesPerBatch;
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0) {
    for (const kind of TRASH_MEDIA_KINDS) out[kind].targetBytes = { enabled: true, value: legacy };
  }
  return out;
}

/** Read the space-policy config, merged over its documented defaults so a partial/hand-edited jsonb
 *  row can never leave a required field undefined (fail-safe: missing `enabled` reads as false). */
export async function getSpacePolicy(db?: DbClient): Promise<SpacePolicy> {
  const stored = await getAppSetting(db, 'space_policy');
  const d = APP_SETTING_DEFAULTS.space_policy;
  const mode = (SPACE_POLICY_MODES as readonly string[]).includes(stored?.mode as string)
    ? (stored!.mode as SpacePolicyMode)
    : d.mode;
  return {
    enabled: stored?.enabled === true,
    mode,
    minCandidates:
      typeof stored?.minCandidates === 'number' ? stored.minCandidates : d.minCandidates,
    perArray: stored?.perArray ?? {},
    // DESIGN-014 amendment (2026-07-09, build A) — per-kind caps, migrating the retired flat key.
    perKind: resolvePerKind(stored),
  };
}

/**
 * The reclaim targeting for a policy-proposed batch of `mediaKind` — the kind's ENABLED caps
 * (maxItems / targetBytes, whichever the greedy fill hits FIRST), taken WORST-RATED-FIRST (policy
 * batches trim the least-loved titles by default; DESIGN-014 amendment 2026-07-09, build A). Returns
 * undefined when neither cap is on ⇒ createBatchFromPending snapshots ALL candidates (the default).
 */
export function buildKindTargeting(
  policy: SpacePolicy,
  mediaKind: TrashMediaKind,
): BatchTargeting | undefined {
  const caps = effectiveKindTargeting(policy, mediaKind);
  if (caps.targetBytes === undefined && caps.maxItems === undefined) return undefined;
  // DESIGN-014 amendment (build D) — the ranking comes from the shared resolver (the kind's configured
  // strategy, else the owner default 'worst-rated'), so the policy pick and the wall's "Next up" sort
  // stay identical. Default-unchanged: an unset per-kind strategy still yields 'worst-rated' as before.
  return { ...caps, strategy: activeBatchStrategy(policy, mediaKind) };
}

// ---------------------------------------------------------------------------
// evaluateSpacePolicy — the `space-policy` sync mode's core
// ---------------------------------------------------------------------------

export type SpacePolicyOutcome =
  | 'proposed'
  | 'promoted'
  | 'skipped_open_batch'
  | 'skipped_under_target'
  | 'skipped_min_candidates'
  | 'skipped_empty'
  | 'error';

export interface SpacePolicyProposal {
  mediaKind: TrashMediaKind;
  outcome: SpacePolicyOutcome;
  /** The proposed/promoted batch (null when nothing was created or healed). */
  batchId: string | null;
  /** Whether the batch was promoted straight to Leaving Soon (always true for the autonomous engine —
   *  ADR-073; false only for a skipped outcome). */
  gateSkipped: boolean;
  /** Actionable pending items considered for this kind, and their total size. */
  candidateCount: number;
  candidateBytes: number;
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

interface OpenBatchRow {
  id: string;
  state: TrashBatchState;
  /** null ⇒ system/policy-created (the autonomous engine ran with a null actor). */
  createdBy: string | null;
}

/** The OPEN batch (draft/admin_review/leaving_soon) for a kind, or null. One-open-per-kind guarantees
 *  at most one. Carries `state` + `createdBy` so the caller can SELF-HEAL a stuck system batch. */
async function findOpenBatch(
  db: DbClient | undefined,
  mediaKind: TrashMediaKind,
): Promise<OpenBatchRow | null> {
  const [row] = await resolveDb(db)
    .select({ id: trashBatches.id, state: trashBatches.state, createdBy: trashBatches.createdBy })
    .from(trashBatches)
    .where(and(eq(trashBatches.mediaKind, mediaKind), inArray(trashBatches.state, [...OPEN_STATES])))
    .limit(1);
  return row ?? null;
}

/** Whether an OPEN batch (draft/admin_review/leaving_soon) already exists for a kind. */
async function hasOpenBatch(db: DbClient | undefined, mediaKind: TrashMediaKind): Promise<boolean> {
  return (await findOpenBatch(db, mediaKind)) !== null;
}

/**
 * Evaluate the space-driven policy ONCE (the `space-policy` sync mode's body). Returns a report of
 * every array's over/under-target verdict and, for each opted-in array, one outcome per backing kind:
 * a stuck open system batch is HEALED (promoted to leaving_soon), else a new batch is PROPOSED AND
 * PROMOTED (createBatchFromPending with autoPromote) when the mode/target allows it (ADR-073 — the
 * autonomous engine completes the cycle unattended; it still never deletes, only the sweep reclaims).
 * Never throws for a per-kind failure (records `outcome:'error'` and moves on); it throws only if the
 * utilization/settings reads themselves fail.
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

    // An OPT-OUT array is never touched — not even to self-heal — so turning the policy on can't
    // surprise-act on an array you forgot. Opted-in arrays ALWAYS run proposeForKind (which self-heals a
    // stuck batch regardless of target, and proposes a NEW batch only when the mode/target allows).
    if (!arrCfg.enabled) {
      arrays.push(result);
      continue;
    }

    // Whether a NEW batch may be proposed here (DESIGN-014 amendment 2026-07-09, build A):
    //  - 'over-target' (default): reachable, has a target, AND actually over it.
    //  - 'continuous': always (opted in is enough — candidates come from Maintainerr, not the disk read).
    // Self-heal of an ALREADY-open stuck batch is independent of this gate (ADR-073 — a mid-cycle death
    // under target must still converge).
    const canProposeNew =
      policy.mode === 'continuous'
        ? true
        : !util.unavailable && util.target !== null && overTarget;

    for (const mediaKind of trashKindsForArray(util.key)) {
      const proposal = await proposeForKind({
        db: input.db,
        maintainerr: input.maintainerr,
        actorId,
        now,
        mode: policy.mode,
        mediaKind,
        arrayKey: util.key,
        arrayLabel: util.label,
        usedPct: util.usedPct,
        target: util.target,
        canProposeNew,
        minCandidates: arrCfg.minCandidates,
        // Per-kind composition caps (maxItems / targetBytes, whichever hits first), worst-rated-first
        // for policy batches (the owner default — take the least-loved titles). Absent caps ⇒ ALL.
        targeting: buildKindTargeting(policy, mediaKind),
      });
      if (proposal.outcome === 'proposed' || proposal.outcome === 'promoted') proposedCount += 1;
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
  mode: SpacePolicyMode;
  mediaKind: TrashMediaKind;
  arrayKey: string;
  arrayLabel: string;
  usedPct: number | null;
  target: number | null;
  /** Whether a NEW batch may be proposed here (mode/target gate). Self-heal of a stuck open batch runs
   *  regardless of this. */
  canProposeNew: boolean;
  minCandidates: number;
  /** DESIGN-014 amendment — per-kind composition caps (maxItems/targetBytes, worst-rated-first);
   *  absent ⇒ ALL candidates. */
  targeting?: BatchTargeting;
}): Promise<SpacePolicyProposal> {
  const base = {
    mediaKind: input.mediaKind,
    batchId: null as string | null,
    gateSkipped: false,
    candidateCount: 0,
    candidateBytes: 0,
  };

  // 1. Open batch: one-open-per-kind. SELF-HEAL (ADR-073) a system-created batch a prior run left stuck
  //    in draft/admin_review (created before this fix, or a run that died between create and promote) —
  //    promote it to leaving_soon so the cycle can never wedge in a "no batch" state. A leaving_soon
  //    batch is healthy (mid save window) — leave it. A MANUAL batch (createdBy set) is the admin's to
  //    curate — never auto-promoted.
  const open = await findOpenBatch(input.db, input.mediaKind);
  if (open !== null) {
    const isSystem = open.createdBy === null;
    if (isSystem && (open.state === 'draft' || open.state === 'admin_review')) {
      try {
        await promoteOpenPolicyBatch({
          db: input.db,
          maintainerr: input.maintainerr,
          batchId: open.id,
          actorId: input.actorId,
        });
      } catch (err) {
        return {
          ...base,
          batchId: open.id,
          outcome: 'error',
          reason: `Could not auto-promote stuck ${input.mediaKind} batch ${open.id}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return {
        ...base,
        batchId: open.id,
        gateSkipped: true,
        outcome: 'promoted',
        reason: `Self-healed a stuck ${input.mediaKind} batch (${open.state}) straight to Leaving Soon.`,
      };
    }
    return {
      ...base,
      batchId: open.id,
      outcome: 'skipped_open_batch',
      reason: `An open ${input.mediaKind} batch already exists (${open.state}) — leaving it.`,
    };
  }

  // 2. No open batch: propose a NEW one only when the mode/target gate allows (over-target under its
  //    ceiling proposes nothing; continuous always may). Self-heal above already ran.
  if (!input.canProposeNew) {
    return {
      ...base,
      outcome: 'skipped_under_target',
      reason: `${input.arrayLabel} is not over target (${input.usedPct ?? '?'}% vs ${input.target ?? '?'}%) — nothing proposed.`,
    };
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

  // 4. Propose AND PROMOTE: the autonomous createBatchFromPending path (ADR-073 — autoPromote drives the
  //    batch straight to leaving_soon with the save window, gate_skipped + system attribution, so the
  //    machine completes the cycle unattended). Still never deletes — only the sweep reclaims.
  let created: CreateBatchResult;
  try {
    created = await createBatchFromPending({
      db: input.db,
      maintainerr: input.maintainerr,
      mediaKind: input.mediaKind,
      actorId: input.actorId,
      source: 'policy', // ADR-034 — the "batch posted" push records it was the space policy
      autoPromote: true, // ADR-073 — the unattended engine promotes its own batch (no admin-review gate)
      // DESIGN-014 amendment (2026-07-09, build A) — optionally cap the proposed batch by the kind's
      // enabled composition caps (maxItems/targetBytes, worst-rated-first); absent ⇒ all candidates.
      // The min-candidates gate above still measures the full pending pool.
      ...(input.targeting !== undefined ? { targeting: input.targeting } : {}),
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
      mode: input.mode,
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

  // Mode-aware rationale: over-target names the ceiling it crossed; continuous names the mode (the disk
  // target isn't the trigger, and in continuous mode usedPct/target can be null when the *arr was down).
  const rationale =
    input.mode === 'continuous'
      ? `continuous mode${input.usedPct !== null ? ` — ${input.arrayLabel} is ${input.usedPct}% used` : ` (${input.arrayLabel})`}`
      : `${input.arrayLabel} is ${input.usedPct}% used vs a ${input.target}% target`;
  return {
    ...base,
    batchId: created.batchId,
    gateSkipped: created.gateSkipped,
    candidateCount: created.itemCount,
    outcome: 'proposed',
    reason:
      `Proposed a ${input.mediaKind} batch of ${created.itemCount} item(s) — ${rationale} ` +
      '(promoted straight to Leaving Soon — the save window is now open).' +
      attributionNote,
  };
}

/** Write the trash_space_policy ledger event + the space_policy notification for one proposal. */
async function recordSpacePolicyProposal(input: {
  db?: DbClient;
  batchId: string;
  mode: SpacePolicyMode;
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
    mode: input.mode,
    array: input.arrayKey,
    arrayLabel: input.arrayLabel,
    usedPct: input.usedPct,
    target: input.target,
    candidateCount: input.candidateCount,
    candidateBytes: input.candidateBytes,
    gateSkipped: input.gateSkipped,
  };
  // Mode-aware lead: over-target cites the crossed ceiling; continuous cites the mode (usedPct/target
  // may be null when the *arr disk read was unavailable).
  const lead =
    input.mode === 'continuous'
      ? `Continuous mode${input.usedPct !== null ? ` — ${input.arrayLabel} is ${input.usedPct}% used` : ` (${input.arrayLabel})`}.`
      : `${input.arrayLabel} is ${input.usedPct}% used (target ${input.target}%).`;

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
      `${lead} Proposed ` +
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
 * global newest), each kind's open-batch state, and a short proposal history. A pure DB read (ledger +
 * batches) — the live over/under-target readout comes from storage.utilization which the page already
 * loads (no *arr read here). ISO strings on the wire.
 */
export async function getSpacePolicyStatus(input: {
  db?: DbClient;
  now?: Date;
}): Promise<SpacePolicyStatus> {
  const db = resolveDb(input.db);
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
    const last = records.find((r) => r.mediaKind === mediaKind) ?? null;
    kinds.push({
      mediaKind,
      hasOpenBatch: await hasOpenBatch(input.db, mediaKind),
      lastProposal: last,
    });
  }

  return {
    policy,
    lastProposalAt: records[0]?.proposedAt ?? null,
    kinds,
    recentProposals: records.slice(0, 10),
  };
}
