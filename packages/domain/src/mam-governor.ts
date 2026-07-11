// ADR-054 / DESIGN-027 (PLAN-039) — the MAM compliance governor: the cap-aware torrent-fallback pacer +
// single-writer. The `mam-governor` sync mode counts UNSATISFIED torrents LOCALLY in qBittorrent (category
// `books-mam`, seeding_time < 72h + still-downloading — ZERO MyAnonaMouse API surface, per the compliance
// contract) and gates the LazyLibrarian MAM Torznab provider: near the rank cap (unsatisfied ≥ limit −
// buffer) it PAUSES the provider via LL's own changeProvider API; when headroom returns it RE-ENABLES it.
// Grabs self-pace to the cap with zero MAM-side behavior changes.
//
// SEAM CHOICE (ADR-054 C-01): toggle the MyAnonaMouse PROWLARR indexer's `enable` flag, NOT LazyLibrarian's
// own provider `enabled` — Prowlarr owns LL's provider entries via its LazyLibrarian application
// (syncLevel=fullSync), so a manual LL-side toggle is clobbered on the next sync (NOT durable). Disabling
// the Prowlarr indexer instead PROPAGATES `enabled=false` down to LL's Torznab_0 (verified live: ~6s), so
// LL stops querying the provider entirely — no failed Torznab searches, so LL's provider-failure blocklist
// is never tripped. The Prowlarr WRITE client (`@hnet/downloads/write`) is import-confined to this package.
//
// FAIL-CLOSED (plan item 3): a failed qBittorrent count is treated as AT-CAP — the gate closes. The state
// row + a transition-only Pushover (via the notification_outbox, enqueued in the SAME tx as the
// mam_gate_state upsert — ADR-034 C-01) are the audit trail; FIRST sight records a baseline and pages
// nothing (a deploy at 13/15 headroom writes state without paging — like evaluateSmartAlerts).
import {
  mamGateState,
  type DbClient,
  type MamGateStateRow,
  type NotifyOutboxEventType,
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import type { UnsatisfiedCounts } from '@hnet/downloads';
import { inTransaction, resolveDb } from './db-client';
import { enqueueOutbox } from './notify-outbox';
import { computeEarliestSend, getNotifyWindow } from './notify-window';

// ---------------------------------------------------------------------------
// Tuning — the ONE seam (owner ruling 2026-07-11; PLAN-040 makes it DB-backed)
// ---------------------------------------------------------------------------

/** New Member cap. Owner bumps at each MAM promotion (User 50 → PU 100 → VIP 150). */
export const MAM_UNSATISFIED_LIMIT_DEFAULT = 20;
/** Safety margin below the hard cap: the gate closes at limit − buffer so grabs already past LL when we
 *  pause can't push the true unsatisfied count over the limit. */
export const MAM_UNSATISFIED_BUFFER_DEFAULT = 5;
/** Headroom pinned at 0 for longer than this (hours) fires the `mam_gate_stuck` alert. */
export const MAM_ZERO_HEADROOM_ALERT_HOURS_DEFAULT = 48;

export interface MamGovernorTuning {
  /** MAM unsatisfied-torrent LIMIT for the account's rank. */
  limit: number;
  /** Slots reserved below the limit (the gate closes at limit − buffer). */
  buffer: number;
  /** Hours of pinned-at-0 headroom before the stuck alert fires. */
  zeroHeadroomAlertHours: number;
}

function parseIntEnv(raw: string | undefined, fallback: number, min: number): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * Resolve the governor's tuning knobs. THE SEAM (owner ruling 2026-07-11 / PLAN-040): the mode calls this
 * ONCE per run, so PLAN-040 can add an audited DB-backed `app_setting` override here — read the setting,
 * fall back to env, fall back to the defaults — WITHOUT reworking the mode. It is async precisely so that
 * DB path drops in with no signature change. v1: env-backed (`MAM_UNSATISFIED_LIMIT` /
 * `MAM_UNSATISFIED_BUFFER` / `MAM_ZERO_HEADROOM_ALERT_HOURS`). The buffer is clamped to `< limit` so a
 * mis-set buffer can never wedge the gate permanently closed.
 */
export async function resolveGovernorConfig(opts?: {
  env?: Record<string, string | undefined>;
  /** Reserved for PLAN-040's DB-backed override (unused in v1). */
  db?: DbClient;
}): Promise<MamGovernorTuning> {
  const env = opts?.env ?? process.env;
  const limit = parseIntEnv(env.MAM_UNSATISFIED_LIMIT, MAM_UNSATISFIED_LIMIT_DEFAULT, 1);
  const rawBuffer = parseIntEnv(env.MAM_UNSATISFIED_BUFFER, MAM_UNSATISFIED_BUFFER_DEFAULT, 0);
  const zeroHeadroomAlertHours = parseIntEnv(
    env.MAM_ZERO_HEADROOM_ALERT_HOURS,
    MAM_ZERO_HEADROOM_ALERT_HOURS_DEFAULT,
    1,
  );
  return { limit, buffer: Math.min(rawBuffer, Math.max(0, limit - 1)), zeroHeadroomAlertHours };
}

// ---------------------------------------------------------------------------
// Clients — the injected read (qB count) + read/write (LL gate) seam
// ---------------------------------------------------------------------------

/** The read surface the governor counts through (qBittorrent). Tests inject a stub. */
export interface MamCountReader {
  countUnsatisfied(category: string): Promise<UnsatisfiedCounts>;
}

/** The gate surface the governor reads + toggles (the MyAnonaMouse Prowlarr indexer). Tests inject a stub. */
export interface MamGateClient {
  /** Read the MAM indexer's current `enable` state. */
  getIndexerEnabled(indexerId: number): Promise<boolean>;
  /** Toggle the MAM indexer's `enable` flag (GET-then-PUT, only `enable` changed). */
  setIndexerEnabled(indexerId: number, enabled: boolean): Promise<void>;
}

export interface MamGovernorClients {
  qb: MamCountReader;
  prowlarr: MamGateClient;
}

/** The wiring identifiers (which qB category to count, which Prowlarr indexer to toggle). */
export interface MamGovernorTargets {
  category: string;
  indexerId: number;
}

// ---------------------------------------------------------------------------
// Pure decision helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Decide the DESIRED gate from the counts. Fail-closed: a failed count ⇒ closed. threshold = limit − buffer. */
export function computeDesiredGate(
  counts: Pick<UnsatisfiedCounts, 'unsatisfied'>,
  countOk: boolean,
  tuning: MamGovernorTuning,
): { desiredOpen: boolean; threshold: number } {
  const threshold = tuning.limit - tuning.buffer;
  const desiredOpen = countOk && counts.unsatisfied < threshold;
  return { desiredOpen, threshold };
}

export interface StuckDecision {
  zeroHeadroomSince: Date | null;
  pinnedAlertedAt: Date | null;
  stuckEvent: 'mam_gate_stuck' | null;
}

/**
 * The zero-headroom-stuck bookkeeping (headroom = limit − unsatisfied, pinned at 0 means unsatisfied ≥
 * the HARD limit — demand exceeds the ~rank-limit-per-72h throughput). Starts a timer when headroom first
 * hits 0, clears it when headroom returns, and fires `mam_gate_stuck` ONCE per episode after
 * `zeroHeadroomAlertHours`. A failed count can't assess headroom, so it carries the prior timer untouched.
 */
export function computeStuck(
  prev: Pick<MamGateStateRow, 'zeroHeadroomSince' | 'pinnedAlertedAt'> | undefined,
  counts: Pick<UnsatisfiedCounts, 'unsatisfied'>,
  countOk: boolean,
  tuning: MamGovernorTuning,
  now: Date,
): StuckDecision {
  if (!countOk) {
    return {
      zeroHeadroomSince: prev?.zeroHeadroomSince ?? null,
      pinnedAlertedAt: prev?.pinnedAlertedAt ?? null,
      stuckEvent: null,
    };
  }
  const atZero = counts.unsatisfied >= tuning.limit;
  if (!atZero) return { zeroHeadroomSince: null, pinnedAlertedAt: null, stuckEvent: null };
  const zeroHeadroomSince = prev?.zeroHeadroomSince ?? now;
  let pinnedAlertedAt = prev?.pinnedAlertedAt ?? null;
  let stuckEvent: 'mam_gate_stuck' | null = null;
  const elapsedMs = now.getTime() - zeroHeadroomSince.getTime();
  const alertMs = tuning.zeroHeadroomAlertHours * 60 * 60 * 1000;
  const alreadyAlerted = pinnedAlertedAt !== null && pinnedAlertedAt >= zeroHeadroomSince;
  if (elapsedMs >= alertMs && !alreadyAlerted) {
    stuckEvent = 'mam_gate_stuck';
    pinnedAlertedAt = now;
  }
  return { zeroHeadroomSince, pinnedAlertedAt, stuckEvent };
}

// ---------------------------------------------------------------------------
// evaluateMamGovernor — the single-writer
// ---------------------------------------------------------------------------

export interface MamGovernorReport {
  countOk: boolean;
  total: number;
  unsatisfied: number;
  downloading: number;
  seedingUnder72: number;
  limit: number;
  buffer: number;
  threshold: number;
  headroom: number;
  /** The gate state we RECORDED (what LazyLibrarian actually reflects after this run). */
  gateOpen: boolean;
  /** The prior recorded gate state (null on first run). */
  previousGateOpen: boolean | null;
  /** The gate the counts CALL for (before actuation availability). */
  desiredOpen: boolean;
  /** The MAM Prowlarr indexer's enable state as read this run (null if the read failed). */
  indexerEnabled: boolean | null;
  /** Whether we actually PUT the indexer this run. */
  actuated: boolean;
  /** The transition event enqueued (null when no transition / first-run baseline). */
  event: NotifyOutboxEventType | null;
  /** Whether the >48h zero-headroom stuck alert fired this run. */
  stuckAlerted: boolean;
  /** Outbox rows enqueued this run (transition + stuck). */
  enqueued: number;
  countError?: string;
  readError?: string;
  actuationError?: string;
}

/** Read the single gate-state row (id='mam'), or undefined on first run. */
export async function getMamGateState(db?: DbClient): Promise<MamGateStateRow | undefined> {
  const rows = await resolveDb(db)
    .select()
    .from(mamGateState)
    .where(eq(mamGateState.id, 'mam'))
    .limit(1);
  return rows[0];
}

/**
 * Run one governor pass: count unsatisfied torrents, decide the gate, idempotently actuate the LL provider
 * toward the decision, then in ONE transaction upsert mam_gate_state AND — on a gate transition or a >48h
 * zero-headroom episode — enqueue the notification_outbox row(s). The LL actuation (an EXTERNAL side-effect
 * that can't co-commit with a DB row) happens BEFORE the tx (the plex/authentik "apply then record"
 * ordering); the recorded gate state reflects what LL ACTUALLY is, so a transition is only ever recorded/
 * paged when the provider truly changed. Never throws for a client failure — inspect the report.
 */
export async function evaluateMamGovernor(input: {
  db?: DbClient;
  clients: MamGovernorClients;
  targets: MamGovernorTargets;
  tuning: MamGovernorTuning;
  now?: Date;
}): Promise<MamGovernorReport> {
  const { clients, targets, tuning } = input;
  const now = input.now ?? new Date();
  const window = await getNotifyWindow(input.db);
  const earliestSendAt = computeEarliestSend(now, window);

  const prev = await getMamGateState(input.db);

  // 1. COUNT (fail-closed on error).
  let countOk = true;
  let counts: UnsatisfiedCounts = { total: 0, downloading: 0, seedingUnder72: 0, unsatisfied: 0 };
  let countError: string | undefined;
  try {
    counts = await clients.qb.countUnsatisfied(targets.category);
  } catch (err) {
    countOk = false;
    countError = err instanceof Error ? err.message : String(err);
  }

  const { desiredOpen, threshold } = computeDesiredGate(counts, countOk, tuning);
  const headroom = countOk ? Math.max(0, tuning.limit - counts.unsatisfied) : (prev?.headroom ?? 0);

  // 2. READ the MAM indexer's current enable state (best-effort).
  let indexerEnabled: boolean | null = null;
  let readError: string | undefined;
  try {
    indexerEnabled = await clients.prowlarr.getIndexerEnabled(targets.indexerId);
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err);
  }

  // 3. ACTUATE toward desiredOpen — idempotent. Actuate when the known state differs, OR when the state is
  //    UNKNOWN (read failed) and we want it CLOSED (fail-closed enforcement; never blindly ENABLE).
  const knownDiffers = indexerEnabled !== null && indexerEnabled !== desiredOpen;
  const unknownWantClosed = indexerEnabled === null && !desiredOpen;
  let actuated = false;
  let actuationError: string | undefined;
  let appliedOpen: boolean;
  if (knownDiffers || unknownWantClosed) {
    try {
      await clients.prowlarr.setIndexerEnabled(targets.indexerId, desiredOpen);
      actuated = true;
      appliedOpen = desiredOpen;
    } catch (err) {
      actuationError = err instanceof Error ? err.message : String(err);
      // The toggle didn't take — record the last-known / fail-closed state, and DON'T page a transition.
      appliedOpen = indexerEnabled ?? prev?.gateOpen ?? false;
    }
  } else if (indexerEnabled !== null) {
    appliedOpen = indexerEnabled; // already matches desiredOpen
  } else {
    // Read failed AND desiredOpen is true (we don't force-enable on an unknown) — assume unchanged.
    appliedOpen = prev?.gateOpen ?? desiredOpen;
  }

  // Transition vs the prior recorded gate (first run ⇒ baseline, no page).
  let event: NotifyOutboxEventType | null = null;
  if (prev !== undefined && prev.gateOpen !== appliedOpen) {
    event = appliedOpen ? 'mam_gate_resumed' : 'mam_gate_paused';
  }

  // Zero-headroom stuck bookkeeping.
  const stuck = computeStuck(prev, counts, countOk, tuning, now);
  const lastEventType: NotifyOutboxEventType | null =
    stuck.stuckEvent ?? event ?? (prev?.lastEventType as NotifyOutboxEventType | null) ?? null;

  const payload = {
    unsatisfied: counts.unsatisfied,
    downloading: counts.downloading,
    seedingUnder72: counts.seedingUnder72,
    limit: tuning.limit,
    buffer: tuning.buffer,
    threshold,
    headroom,
    countOk,
    reason: countOk ? 'threshold' : 'count_failed',
  };

  await inTransaction(input.db, async (tx) => {
    if (event !== null) {
      await enqueueOutbox(tx, { eventType: event, payload, earliestSendAt });
    }
    if (stuck.stuckEvent !== null) {
      await enqueueOutbox(tx, { eventType: stuck.stuckEvent, payload, earliestSendAt });
    }
    await tx
      .insert(mamGateState)
      .values({
        id: 'mam',
        gateOpen: appliedOpen,
        countOk,
        unsatisfiedCount: countOk ? counts.unsatisfied : (prev?.unsatisfiedCount ?? 0),
        downloadingCount: countOk ? counts.downloading : (prev?.downloadingCount ?? 0),
        seedingUnder72Count: countOk ? counts.seedingUnder72 : (prev?.seedingUnder72Count ?? 0),
        limitValue: tuning.limit,
        bufferValue: tuning.buffer,
        threshold,
        headroom,
        zeroHeadroomSince: stuck.zeroHeadroomSince,
        pinnedAlertedAt: stuck.pinnedAlertedAt,
        lastEventType,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: mamGateState.id,
        set: {
          gateOpen: appliedOpen,
          countOk,
          unsatisfiedCount: countOk ? counts.unsatisfied : (prev?.unsatisfiedCount ?? 0),
          downloadingCount: countOk ? counts.downloading : (prev?.downloadingCount ?? 0),
          seedingUnder72Count: countOk ? counts.seedingUnder72 : (prev?.seedingUnder72Count ?? 0),
          limitValue: tuning.limit,
          bufferValue: tuning.buffer,
          threshold,
          headroom,
          zeroHeadroomSince: stuck.zeroHeadroomSince,
          pinnedAlertedAt: stuck.pinnedAlertedAt,
          lastEventType,
          updatedAt: now,
        },
      });
  });

  return {
    countOk,
    total: counts.total,
    unsatisfied: counts.unsatisfied,
    downloading: counts.downloading,
    seedingUnder72: counts.seedingUnder72,
    limit: tuning.limit,
    buffer: tuning.buffer,
    threshold,
    headroom,
    gateOpen: appliedOpen,
    previousGateOpen: prev?.gateOpen ?? null,
    desiredOpen,
    indexerEnabled,
    actuated,
    event,
    stuckAlerted: stuck.stuckEvent !== null,
    enqueued: (event !== null ? 1 : 0) + (stuck.stuckEvent !== null ? 1 : 0),
    ...(countError !== undefined ? { countError } : {}),
    ...(readError !== undefined ? { readError } : {}),
    ...(actuationError !== undefined ? { actuationError } : {}),
  };
}
