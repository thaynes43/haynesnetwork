// ADR-054 / DESIGN-027 (PLAN-039) — the MAM compliance governor: the cap-aware torrent-fallback pacer +
// single-writer. The `mam-governor` sync mode counts UNSATISFIED torrents LOCALLY in qBittorrent (category
// `books-mam`, seeding_time < 72h + still-downloading — ZERO MyAnonaMouse API surface, per the compliance
// contract) and gates the LazyLibrarian MAM Torznab provider: near the rank cap (unsatisfied ≥ threshold =
// limit − buffer) it PAUSES the provider via the Prowlarr indexer seam; it only RE-ENABLES once unsatisfied
// drops back below a distinct, lower RESUME FLOOR. Grabs self-pace to the cap with zero MAM-side behavior.
//
// RESUME HYSTERESIS (ADR-077 / DESIGN-027 D-09, PLAN-061 — the 2026-07-23 gate-violation fix): pause and
// resume no longer share one threshold. A CLOSED gate reopens only when unsatisfied < resumeFloor (default
// limit − 2×buffer); in the DEAD BAND (resumeFloor ≤ unsatisfied < threshold) the gate HOLDS its current
// state. This kills the flap where a resume at threshold−1 immediately re-floods past the hard cap inside one
// 15-minute sampling interval (a queued LazyLibrarian backlog can fire ~100 MAM searches in 4 minutes). See
// `.agents/context/2026-07-23-mam-gate-violation-audit.md`. First sight (no state row) is treated as CLOSED.
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
  appSettings,
  mamGateState,
  notificationOutbox,
  type DbClient,
  type MamGateStateRow,
  type NotifyOutboxEventType,
} from '@hnet/db';
import { desc, eq, inArray } from 'drizzle-orm';
import type { UnsatisfiedCounts } from '@hnet/downloads';
import { setAppSetting } from './app-settings';
import { inTransaction, resolveDb } from './db-client';
import { GovernorConfigInvalidError } from './errors';
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
/**
 * ADR-082 C-01 — the default single-interval rise (`current − previous`) that, while the gate is OPEN and
 * the count sits in the dead band, PAUSES the gate immediately (the trend override). 15 sits below the
 * smallest measured burst onset (+17 — ADR-077's original figure) and above sampling noise.
 */
export const MAM_TREND_PAUSE_DELTA_DEFAULT = 15;
/** The governor's sampling cadence (the CronJob runs ~every 15 minutes — DESIGN-027 D-09). */
export const MAM_SAMPLE_INTERVAL_MS = 15 * 60 * 1000;
/**
 * ADR-082 C-02 — a previous sample older than this (2 sampling intervals) is treated as MISSING, so the
 * trend override never diffs against ancient data (a process gap / a run of failed counts). At/under this
 * the previous sample is fresh enough to compare.
 */
export const MAM_TREND_MAX_GAP_MS = 2 * MAM_SAMPLE_INTERVAL_MS;

export interface MamGovernorTuning {
  /** MAM unsatisfied-torrent LIMIT for the account's rank. */
  limit: number;
  /** Slots reserved below the limit (the gate PAUSES at limit − buffer). */
  buffer: number;
  /**
   * ADR-077 — the RESUME floor: a CLOSED gate only reopens when unsatisfied drops below this (distinct from,
   * and strictly less than, the pause threshold). Between the floor and the threshold is the DEAD BAND where
   * the gate holds. Default derived as limit − 2×buffer (one full observed reopen burst below the cap), so a
   * single burst after a resume peaks well under the hard limit and the next sample re-closes.
   */
  resumeFloor: number;
  /**
   * ADR-082 C-01 — the trend override delta. When the gate is OPEN and `unsatisfied` sits in the dead band,
   * a single-interval rise `current − previous ≥ trendPauseDelta` PAUSES the gate immediately (the exact
   * 07-25 hazard the symmetric dead-band hold missed). Close-only: it never opens the gate.
   */
  trendPauseDelta: number;
  /** Hours of pinned-at-0 headroom before the stuck alert fires. */
  zeroHeadroomAlertHours: number;
}

/** ADR-082 C-05 — where a resolved config value came from (the /admin provenance chip). */
export type ConfigSource = 'db' | 'env' | 'default';

/**
 * Parse an integer env var, returning null when it is unset/blank OR out of range (so the caller knows the
 * value did NOT come from env and can record the right provenance). Mirrors today's parse semantics (an
 * invalid value falls through to the next tier) while exposing "was it set?".
 */
function parseIntEnvOpt(raw: string | undefined, min: number): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= min ? n : null;
}

/**
 * ADR-077 — derive the default resume floor: `limit − 2×buffer`, clamped to the valid range
 * `0 ≤ floor < threshold` (threshold = limit − buffer). Observed reopen bursts add +15..+17 unsatisfied per
 * 15-minute interval, so seating the floor one full burst below the cap means one post-resume burst peaks
 * under the hard limit and the next sample re-closes the gate. Never returns a value ≥ threshold (which would
 * make resume == pause and re-introduce the flap) nor a negative floor (a mis-set buffer can only clamp it).
 */
export function deriveResumeFloor(limit: number, buffer: number, threshold: number): number {
  return Math.max(0, Math.min(limit - 2 * buffer, threshold - 1));
}

/**
 * ADR-077 — resolve `MAM_RESUME_FLOOR` (an ABSOLUTE unsatisfied count). A valid override is `0 ≤ floor <
 * threshold`; unset/blank yields null (fall through, no warning); a present-but-invalid value (out of range,
 * negative, unparseable) yields null AND logs one warning via `warn`.
 */
function resolveResumeFloorOpt(
  raw: string | undefined,
  threshold: number,
  warn?: (message: string, fields?: Record<string, unknown>) => void,
): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (Number.isFinite(n) && n >= 0 && n < threshold) return n;
  warn?.('MAM_RESUME_FLOOR invalid (need 0 <= floor < threshold); using the derived default', {
    raw: raw.trim(),
    threshold,
  });
  return null;
}

/**
 * ADR-082 C-03 — the DB-backed audited governor knobs. Stored as the `mam_governor_config` app_settings
 * jsonb value; written ONLY through `setMamGovernorConfig` (which validates C-04 first) so an unsatisfiable
 * floor can never be stored. Absent row ⇒ resolution falls back to env/defaults (zero-change deploy).
 */
export interface MamGovernorConfig {
  limit: number;
  buffer: number;
  resumeFloor: number;
  trendPauseDelta: number;
}

/** The code-default governor config — exactly today's env-free behavior (20/5, derived floor 10, delta 15). */
export const MAM_GOVERNOR_CONFIG_DEFAULT: MamGovernorConfig = {
  limit: MAM_UNSATISFIED_LIMIT_DEFAULT,
  buffer: MAM_UNSATISFIED_BUFFER_DEFAULT,
  resumeFloor: deriveResumeFloor(
    MAM_UNSATISFIED_LIMIT_DEFAULT,
    MAM_UNSATISFIED_BUFFER_DEFAULT,
    MAM_UNSATISFIED_LIMIT_DEFAULT - MAM_UNSATISFIED_BUFFER_DEFAULT,
  ),
  trendPauseDelta: MAM_TREND_PAUSE_DELTA_DEFAULT,
};

/**
 * ADR-082 C-04 — validate a governor config against the invariants ADR-077 only checked at runtime. Returns
 * a human-readable message for the FIRST violated invariant, or null when valid. Enforced at BOTH the API
 * zod edge and the domain writer (defense in depth), so a mis-set combination can never be stored and the
 * governor can never wedge on an unsatisfiable floor (the ADR-077 C-03 hazard class).
 */
export function governorConfigError(cfg: {
  limit: number;
  buffer: number;
  resumeFloor: number;
  trendPauseDelta: number;
}): string | null {
  const { limit, buffer, resumeFloor, trendPauseDelta } = cfg;
  if (
    !Number.isInteger(limit) ||
    !Number.isInteger(buffer) ||
    !Number.isInteger(resumeFloor) ||
    !Number.isInteger(trendPauseDelta)
  ) {
    return 'Every governor knob must be a whole number.';
  }
  if (limit > 200) return 'The unsatisfied limit cannot exceed the MAM hard cap of 200.';
  if (buffer < 0) return 'The buffer cannot be negative.';
  const edge = limit - buffer;
  if (edge <= 0) return 'The pause edge (limit minus buffer) must be greater than 0.';
  if (resumeFloor < 0) return 'The resume floor cannot be negative.';
  if (resumeFloor >= edge) return 'The resume floor must be below the pause edge (limit minus buffer).';
  if (trendPauseDelta < 1) return 'The trend pause delta must be at least 1.';
  return null;
}

/**
 * ADR-082 C-03 — read the stored governor config, or null when no row exists. A stored row that somehow
 * fails validation (a hand-edit) reads as null too, so the governor falls back to env/defaults rather than
 * wedging on an unsatisfiable value (fail-safe — the ADR-077 C-03 hazard class).
 */
export async function getMamGovernorConfig(db?: DbClient): Promise<MamGovernorConfig | null> {
  const [row] = await resolveDb(db)
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, 'mam_governor_config'));
  if (!row) return null;
  const v = row.value as Partial<MamGovernorConfig> | null;
  if (v === null || typeof v !== 'object') return null;
  const cfg = {
    limit: v.limit as number,
    buffer: v.buffer as number,
    resumeFloor: v.resumeFloor as number,
    trendPauseDelta: v.trendPauseDelta as number,
  };
  return governorConfigError(cfg) === null ? cfg : null;
}

/**
 * ADR-082 C-03/C-04 — the single writer for the governor config: VALIDATE the invariants (throwing
 * GovernorConfigInvalidError so a bad combination is unstorable), then upsert via the audited setAppSetting
 * single-writer (an `update_app_setting` permission_audit row in the SAME transaction — hard rule 6).
 */
export async function setMamGovernorConfig(input: {
  db?: DbClient;
  config: MamGovernorConfig;
  actorId: string | null;
}): Promise<{ changed: boolean }> {
  const message = governorConfigError(input.config);
  if (message !== null) throw new GovernorConfigInvalidError(message);
  const { limit, buffer, resumeFloor, trendPauseDelta } = input.config;
  const res = await setAppSetting({
    db: input.db,
    key: 'mam_governor_config',
    value: { limit, buffer, resumeFloor, trendPauseDelta },
    actorId: input.actorId,
  });
  return { changed: res.changed };
}

/** ADR-082 C-05 — the per-value provenance of a resolved config (which tier each knob came from). */
export interface GovernorConfigProvenance {
  limit: ConfigSource;
  buffer: ConfigSource;
  resumeFloor: ConfigSource;
  trendPauseDelta: ConfigSource;
  zeroHeadroomAlertHours: ConfigSource;
}

export interface GovernorConfigResolution {
  tuning: MamGovernorTuning;
  provenance: GovernorConfigProvenance;
}

/**
 * ADR-082 C-03/C-05 — resolve the governor's tuning knobs with per-value provenance. Resolution order per
 * knob is **DB row → env → code default** (the ADR-080 precedent), so no DB row ⇒ exactly today's env/
 * default behavior (zero-change deploy). Best-effort DB read (C-08): a DB failure at resolution time falls
 * back to env/defaults for RESOLUTION only (the tick already needs the DB for state). When no `db` is
 * passed the DB tier is skipped entirely (pure callers / unit tests). The buffer is clamped `< limit` so a
 * mis-set buffer can never wedge the gate closed; the resume floor is derived `limit − 2×buffer` unless a
 * valid DB/`MAM_RESUME_FLOOR` value overrides it.
 */
export async function resolveGovernorConfigResolution(opts?: {
  env?: Record<string, string | undefined>;
  db?: DbClient;
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}): Promise<GovernorConfigResolution> {
  const env = opts?.env ?? process.env;

  let dbCfg: MamGovernorConfig | null = null;
  if (opts?.db !== undefined) {
    try {
      dbCfg = await getMamGovernorConfig(opts.db);
    } catch (err) {
      opts.warn?.('mam_governor_config DB read failed; falling back to env/defaults for resolution', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // limit: DB → env → default.
  const envLimit = parseIntEnvOpt(env.MAM_UNSATISFIED_LIMIT, 1);
  const limit = dbCfg ? dbCfg.limit : (envLimit ?? MAM_UNSATISFIED_LIMIT_DEFAULT);
  const limitSource: ConfigSource = dbCfg ? 'db' : envLimit !== null ? 'env' : 'default';

  // buffer: DB → env → default, clamped < limit (a mis-set buffer can't wedge the gate — ADR-054).
  const envBuffer = parseIntEnvOpt(env.MAM_UNSATISFIED_BUFFER, 0);
  const rawBuffer = dbCfg ? dbCfg.buffer : (envBuffer ?? MAM_UNSATISFIED_BUFFER_DEFAULT);
  const bufferSource: ConfigSource = dbCfg ? 'db' : envBuffer !== null ? 'env' : 'default';
  const buffer = Math.min(rawBuffer, Math.max(0, limit - 1));
  const threshold = limit - buffer;

  // resumeFloor: DB → env (MAM_RESUME_FLOOR, validated 0 ≤ floor < threshold) → derived default.
  const derivedFloor = deriveResumeFloor(limit, buffer, threshold);
  let resumeFloor: number;
  let floorSource: ConfigSource;
  if (dbCfg && dbCfg.resumeFloor < threshold) {
    resumeFloor = dbCfg.resumeFloor;
    floorSource = 'db';
  } else {
    const envFloor = resolveResumeFloorOpt(env.MAM_RESUME_FLOOR, threshold, opts?.warn);
    if (envFloor !== null) {
      resumeFloor = envFloor;
      floorSource = 'env';
    } else {
      resumeFloor = derivedFloor;
      floorSource = 'default';
    }
  }

  // trendPauseDelta: DB → env → default.
  const envDelta = parseIntEnvOpt(env.MAM_TREND_PAUSE_DELTA, 1);
  const trendPauseDelta = dbCfg ? dbCfg.trendPauseDelta : (envDelta ?? MAM_TREND_PAUSE_DELTA_DEFAULT);
  const trendSource: ConfigSource = dbCfg ? 'db' : envDelta !== null ? 'env' : 'default';

  // zeroHeadroomAlertHours: env → default (never a DB knob — not part of ADR-082's config).
  const envZero = parseIntEnvOpt(env.MAM_ZERO_HEADROOM_ALERT_HOURS, 1);
  const zeroHeadroomAlertHours = envZero ?? MAM_ZERO_HEADROOM_ALERT_HOURS_DEFAULT;
  const zeroSource: ConfigSource = envZero !== null ? 'env' : 'default';

  return {
    tuning: { limit, buffer, resumeFloor, trendPauseDelta, zeroHeadroomAlertHours },
    provenance: {
      limit: limitSource,
      buffer: bufferSource,
      resumeFloor: floorSource,
      trendPauseDelta: trendSource,
      zeroHeadroomAlertHours: zeroSource,
    },
  };
}

/**
 * Resolve the governor's tuning knobs. THE SEAM (owner ruling 2026-07-11 / PLAN-040): the mode calls this
 * ONCE per run. ADR-082 makes it DB-backed — resolution is DB row → env → code default behind this SAME
 * async call, so the CronJob picks up an audited config change with no redeploy. Thin wrapper over
 * `resolveGovernorConfigResolution` for callers that only need the tuning (the orchestrator).
 */
export async function resolveGovernorConfig(opts?: {
  env?: Record<string, string | undefined>;
  db?: DbClient;
  /** Sink for the one-off `MAM_RESUME_FLOOR` invalid-override / DB-read warnings (the CronJob's JSON logger). */
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}): Promise<MamGovernorTuning> {
  return (await resolveGovernorConfigResolution(opts)).tuning;
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

/**
 * Decide the DESIRED gate from the counts WITH resume hysteresis (ADR-077). Pause and resume use two distinct
 * levels: an OPEN gate closes at/above `threshold = limit − buffer`; a CLOSED gate reopens only below the
 * lower `resumeFloor`. In the DEAD BAND (`resumeFloor ≤ unsatisfied < threshold`) the gate HOLDS `priorOpen`,
 * so a resume can't happen at threshold−1 and immediately re-flood. `priorOpen` is the current recorded gate
 * state; first sight (no state row) passes `false` (conservative: reopening requires < floor). Fail-closed: a
 * failed count ⇒ closed regardless of the prior state.
 */
export function computeDesiredGate(
  counts: Pick<UnsatisfiedCounts, 'unsatisfied'>,
  countOk: boolean,
  tuning: MamGovernorTuning,
  priorOpen: boolean,
): { desiredOpen: boolean; threshold: number; resumeFloor: number } {
  const threshold = tuning.limit - tuning.buffer;
  const resumeFloor = tuning.resumeFloor;
  let desiredOpen: boolean;
  if (!countOk) {
    desiredOpen = false; // fail-closed
  } else if (priorOpen) {
    desiredOpen = counts.unsatisfied < threshold; // OPEN holds until it reaches the pause threshold
  } else {
    desiredOpen = counts.unsatisfied < resumeFloor; // CLOSED holds until it drops below the resume floor
  }
  return { desiredOpen, threshold, resumeFloor };
}

/** ADR-082 C-01/C-02 — a previous observed sample (the last GOOD count + when it was observed). */
export interface GateTrendSample {
  count: number;
  observedAt: Date;
}

export interface TrendOverride {
  /** The single-interval rise vs the previous sample, or null when there is no usable previous sample. */
  delta: number | null;
  /** Whether the trend override FIRES a dead-band pause this tick. */
  fires: boolean;
}

/**
 * ADR-082 C-01 — the trend-aware dead-band override. The symmetric dead-band hold (ADR-077) is insensitive
 * to direction, so it can hold the gate OPEN into a fast climb (the 07-25 hazard: 166 inside 160..179,
 * +58 in one interval). This overrides the hold in the fail-safe direction only: when the gate is OPEN, the
 * count sits in the dead band, and it ROSE `≥ trendPauseDelta` since the previous sample, PAUSE now.
 *
 * Close-only (never opens): it fires only when `priorOpen` and the base decision is still open, so a trend
 * pause cannot re-open until the count drains below the floor (no new flap mode). C-02: the delta is against
 * the PRIOR RUN's persisted sample; a first run (no previous) or a gap > 2 sampling intervals disables it.
 */
export function computeTrendOverride(input: {
  unsatisfied: number;
  countOk: boolean;
  priorOpen: boolean;
  /** The base (hysteresis) decision from `computeDesiredGate` — the override only bites when it holds open. */
  baseDesiredOpen: boolean;
  tuning: MamGovernorTuning;
  previous: GateTrendSample | null;
  now: Date;
}): TrendOverride {
  const { unsatisfied, countOk, priorOpen, baseDesiredOpen, tuning, previous, now } = input;
  const threshold = tuning.limit - tuning.buffer;
  const inDeadBand = unsatisfied >= tuning.resumeFloor && unsatisfied < threshold;
  const fresh =
    previous !== null && now.getTime() - previous.observedAt.getTime() <= MAM_TREND_MAX_GAP_MS;
  const delta = fresh ? unsatisfied - previous!.count : null;
  const fires =
    countOk &&
    priorOpen && // close-only: the override only pauses an OPEN gate
    baseDesiredOpen && // the edge hasn't already paused it (dead band, not ≥ threshold)
    inDeadBand &&
    delta !== null &&
    delta >= tuning.trendPauseDelta;
  return { delta, fires };
}

/**
 * ADR-082 C-01/C-05 — the reason a run resolved the gate the way it did (recorded in the outbox payload +
 * the per-run log; the /admin panel shows the last transitions' reasons). `edge` = reached the pause
 * threshold; `trend` = the dead-band trend override fired; `floor` = dropped below the resume floor
 * (resume); `count_failed` = fail-closed; `hold` = the dead band held / steady state (no transition).
 */
export type MamGateReason = 'edge' | 'trend' | 'floor' | 'count_failed' | 'hold';

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
  /** ADR-077 — the resume floor: a CLOSED gate reopens only when unsatisfied drops below this (< threshold). */
  resumeFloor: number;
  /** ADR-082 C-01 — the trend override delta in effect this run. */
  trendPauseDelta: number;
  headroom: number;
  /** ADR-082 C-05 — the reason this run resolved the gate (edge/trend/floor/count_failed/hold). */
  reason: MamGateReason;
  /** ADR-082 C-02 — the prior good sample the trend diffed against (null on first run / a stale gap). */
  previousUnsatisfied: number | null;
  /** ADR-082 C-01 — the single-interval delta this run computed (null when there was no usable previous). */
  delta: number | null;
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

  // ADR-077 — thread the PRIOR recorded gate state into the decision so the dead band can hold. First sight
  // (no state row) is treated as CLOSED (conservative: reopening then requires unsatisfied < resumeFloor).
  const priorOpen = prev?.gateOpen ?? false;
  const base = computeDesiredGate(counts, countOk, tuning, priorOpen);
  const { threshold, resumeFloor } = base;

  // ADR-082 C-01/C-02 — the trend override rides on TOP of the hysteresis decision. It reads the PRIOR RUN's
  // persisted good sample (last_observed_*, updated only on a good count so a fail-closed tick never poisons
  // the baseline) and, if the count ROSE ≥ trendPauseDelta while OPEN in the dead band, pauses now (the
  // 07-25 hazard the symmetric hold missed). First run / a > 2-interval gap ⇒ no previous ⇒ no override.
  const previousSample: GateTrendSample | null =
    prev?.lastObservedCount != null && prev?.lastObservedAt != null
      ? { count: prev.lastObservedCount, observedAt: prev.lastObservedAt }
      : null;
  const trend = computeTrendOverride({
    unsatisfied: counts.unsatisfied,
    countOk,
    priorOpen,
    baseDesiredOpen: base.desiredOpen,
    tuning,
    previous: previousSample,
    now,
  });
  const desiredOpen = trend.fires ? false : base.desiredOpen;
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

  // ADR-082 C-05 — the decision reason (edge/trend/floor/count_failed/hold), recorded on the payload + log
  // so the /admin panel can attribute each transition. `trend` is checked first so a trend pause reads as
  // its own cause even though it also crosses no threshold; a resume (was CLOSED, now open) is `floor`.
  let reason: MamGateReason;
  if (!countOk) reason = 'count_failed';
  else if (trend.fires) reason = 'trend';
  else if (priorOpen && !desiredOpen) reason = 'edge';
  else if (!priorOpen && desiredOpen) reason = 'floor';
  else reason = 'hold';

  const previousUnsatisfied = countOk ? (previousSample?.count ?? null) : null;
  const delta = countOk ? trend.delta : null;

  const payload = {
    unsatisfied: counts.unsatisfied,
    downloading: counts.downloading,
    seedingUnder72: counts.seedingUnder72,
    limit: tuning.limit,
    buffer: tuning.buffer,
    threshold,
    resumeFloor,
    trendPauseDelta: tuning.trendPauseDelta,
    headroom,
    countOk,
    reason,
    previousUnsatisfied,
    delta,
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
        // ADR-082 C-02 — persist the good sample (updated only on countOk) as the NEXT run's trend baseline,
        // and the delta this run computed for the /admin panel. A failed count carries them untouched.
        lastObservedCount: countOk ? counts.unsatisfied : (prev?.lastObservedCount ?? null),
        lastObservedAt: countOk ? now : (prev?.lastObservedAt ?? null),
        lastDelta: countOk ? trend.delta : (prev?.lastDelta ?? null),
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
          lastObservedCount: countOk ? counts.unsatisfied : (prev?.lastObservedCount ?? null),
          lastObservedAt: countOk ? now : (prev?.lastObservedAt ?? null),
          lastDelta: countOk ? trend.delta : (prev?.lastDelta ?? null),
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
    resumeFloor,
    trendPauseDelta: tuning.trendPauseDelta,
    headroom,
    reason,
    previousUnsatisfied,
    delta,
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

// ---------------------------------------------------------------------------
// getMamGovernorStatus — the /admin governor-visibility read (ADR-082 C-05)
// ---------------------------------------------------------------------------

/** ADR-082 C-05 — a resolved config knob plus WHERE it resolved from (the /admin provenance chip). */
export interface GovernorConfigValue {
  value: number;
  source: ConfigSource;
}

/** ADR-082 C-05 — one recent gate transition (derived from the notification_outbox trail). */
export interface GovernorTransitionRecord {
  /** The transition event: mam_gate_paused | mam_gate_resumed | mam_gate_stuck. */
  event: NotifyOutboxEventType;
  /** The reason recorded on the payload (edge/trend/floor/count_failed/hold), or null on an older row. */
  reason: MamGateReason | null;
  unsatisfied: number | null;
  threshold: number | null;
  resumeFloor: number | null;
  /** When the row was enqueued (the transition instant), ISO-8601. */
  at: string;
}

export interface MamGovernorGateState {
  gateOpen: boolean;
  countOk: boolean;
  unsatisfied: number;
  downloading: number;
  seedingUnder72: number;
  headroom: number;
  limit: number;
  buffer: number;
  threshold: number;
  resumeFloor: number;
  trendPauseDelta: number;
  /** Whether the current count sits in the dead band [resumeFloor, threshold) against the resolved config. */
  inDeadBand: boolean;
  lastEventType: string | null;
  /** The prior good sample the last run diffed against (null when unknown), derived from the persisted delta. */
  previousUnsatisfied: number | null;
  /** The single-interval delta the last run recorded (null when there was no usable previous sample). */
  lastDelta: number | null;
  /** The last governor run (the state row's updated_at), ISO-8601. */
  lastRunAt: string;
}

export interface MamGovernorStatus {
  /** The recorded gate state, or null before the governor's first run (no state row yet). */
  gate: MamGovernorGateState | null;
  /** The resolved config the governor uses each tick, with per-value provenance (db/env/default). */
  config: {
    limit: GovernorConfigValue;
    buffer: GovernorConfigValue;
    resumeFloor: GovernorConfigValue;
    trendPauseDelta: GovernorConfigValue;
    zeroHeadroomAlertHours: GovernorConfigValue;
  };
  /** The most recent gate transitions (newest first), reason-tagged, from the outbox trail. */
  transitions: GovernorTransitionRecord[];
}

const GOVERNOR_TRANSITION_EVENTS: NotifyOutboxEventType[] = [
  'mam_gate_paused',
  'mam_gate_resumed',
  'mam_gate_stuck',
];

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * ADR-082 C-05 — the /admin governor panel's single read: the recorded gate state (live counts + the last
 * run's delta), the resolved config WITH per-value provenance (what the next tick will use — DB row → env →
 * default), and the last N gate transitions with their reasons (from the notification_outbox trail, which
 * IS the governor's audit surface — mam-gate-state.ts). A pure read; resolves config against THIS process's
 * env (the app deployment), which is the same tier order the CronJob uses.
 */
export async function getMamGovernorStatus(input?: {
  db?: DbClient;
  env?: Record<string, string | undefined>;
  limit?: number;
}): Promise<MamGovernorStatus> {
  const db = input?.db;
  const historyLimit = input?.limit ?? 10;
  const resolution = await resolveGovernorConfigResolution({ db, env: input?.env });
  const t = resolution.tuning;
  const p = resolution.provenance;
  const threshold = t.limit - t.buffer;

  const row = await getMamGateState(db);
  const gate: MamGovernorGateState | null = row
    ? {
        gateOpen: row.gateOpen,
        countOk: row.countOk,
        unsatisfied: row.unsatisfiedCount,
        downloading: row.downloadingCount,
        seedingUnder72: row.seedingUnder72Count,
        headroom: row.headroom,
        limit: t.limit,
        buffer: t.buffer,
        threshold,
        resumeFloor: t.resumeFloor,
        trendPauseDelta: t.trendPauseDelta,
        inDeadBand: row.unsatisfiedCount >= t.resumeFloor && row.unsatisfiedCount < threshold,
        lastEventType: row.lastEventType,
        // The prior sample the last run diffed against = current − the persisted delta (when both known).
        previousUnsatisfied:
          row.lastDelta != null ? row.unsatisfiedCount - row.lastDelta : null,
        lastDelta: row.lastDelta ?? null,
        lastRunAt: row.updatedAt.toISOString(),
      }
    : null;

  const outboxRows = await resolveDb(db)
    .select({
      eventType: notificationOutbox.eventType,
      payload: notificationOutbox.payload,
      createdAt: notificationOutbox.createdAt,
    })
    .from(notificationOutbox)
    .where(inArray(notificationOutbox.eventType, GOVERNOR_TRANSITION_EVENTS))
    .orderBy(desc(notificationOutbox.createdAt))
    .limit(historyLimit);

  const transitions: GovernorTransitionRecord[] = outboxRows.map((r) => {
    const pl = (r.payload ?? {}) as Record<string, unknown>;
    const reason = pl.reason;
    return {
      event: r.eventType,
      reason:
        reason === 'edge' ||
        reason === 'trend' ||
        reason === 'floor' ||
        reason === 'count_failed' ||
        reason === 'hold'
          ? reason
          : null,
      unsatisfied: numOrNull(pl.unsatisfied),
      threshold: numOrNull(pl.threshold),
      resumeFloor: numOrNull(pl.resumeFloor),
      at: r.createdAt.toISOString(),
    };
  });

  return {
    gate,
    config: {
      limit: { value: t.limit, source: p.limit },
      buffer: { value: t.buffer, source: p.buffer },
      resumeFloor: { value: t.resumeFloor, source: p.resumeFloor },
      trendPauseDelta: { value: t.trendPauseDelta, source: p.trendPauseDelta },
      zeroHeadroomAlertHours: { value: t.zeroHeadroomAlertHours, source: p.zeroHeadroomAlertHours },
    },
    transitions,
  };
}
