// ADR-025 C-06 / DESIGN-011 — the generic app-settings store (Q-06). A small audited key→jsonb
// table read/written through this single seam: `setAppSetting` upserts the row AND co-writes an
// `update_app_setting` permission_audit row in the SAME transaction (CLAUDE.md hard rule 6). Absent
// key ⇒ the documented default (APP_SETTING_DEFAULTS). First consumers are the Trash skip-gate and
// the default save-window; PLAN-010 (MOTD) + PLAN-013/014 (space target, tuning knobs) reuse it.
import {
  appSettings,
  permissionAudit,
  APP_SETTING_KEYS,
  TRASH_MEDIA_KINDS,
  type AppSettingKey,
  type DbClient,
  type MotdSeverity,
  type PlexServerSlug,
  type TrashMediaKind,
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import { NotFoundError } from './errors';
import { inTransaction, resolveDb } from './db-client';
import { type BatchStrategy } from './trash-strategy';

/**
 * ADR-027 / DESIGN-004 D-15 (PLAN-010) — the Message-of-the-Day record stored as the `motd`
 * app_settings jsonb value (Open decision #1: reuse the generic store, no bespoke table). Timestamps
 * ride as ISO-8601 strings (jsonb holds no Date; ISO is also the wire form — DESIGN-003 D-03).
 * `updatedBy` mirrors the row's `updated_by` column into the value so the whole record is
 * self-describing; the dismiss version (motd.ts) is driven off the row's `updated_at`.
 */
export interface MotdRecord {
  message: string;
  severity: MotdSeverity;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  updatedBy: string | null;
}

/** The MOTD default — disabled + empty, so an unset key renders no banner. */
export const MOTD_DEFAULT: MotdRecord = {
  message: '',
  severity: 'info',
  enabled: false,
  startsAt: null,
  endsAt: null,
  updatedBy: null,
};

/**
 * ADR-030 / DESIGN-013 (PLAN-013) — per-Plex-server space TARGETS: a percent-used ceiling per server
 * slug (the number utilization is judged against, e.g. "HaynesTower < 80%"). Stored as the
 * `space_targets` app_settings jsonb value; keyed by `plex_servers.slug` (the owner's mental model —
 * DESIGN-013 documents the slug→rootfolder-path map the utilization read resolves through). Sparse: an
 * absent slug ⇒ "no target set" for that server (the surface draws no reference line). Owned/displayed
 * here (013); acted on by PLAN-014 (Q-03 split). Values are 0..100 (validated at the zod edge).
 */
export type SpaceTargets = Partial<Record<PlexServerSlug, number>>;

/**
 * ADR-031 / DESIGN-014 (PLAN-014) — the per-physical-array knobs of the space-driven policy. All
 * optional overrides of the top-level `SpacePolicy` defaults; a `perArray` entry is what OPTS AN
 * ARRAY IN (its `enabled` must be true for that array to ever be proposed on).
 */
export interface SpacePolicyArrayConfig {
  /** This array participates in the policy (default false — an array is opt-in even when the policy
   *  is globally enabled, so turning the policy on can't surprise-propose on an array you forgot). */
  enabled: boolean;
  /** Override the top-level cooldown for this array (days). */
  cooldownDays?: number;
  /** Override the top-level minimum candidate count for this array. */
  minCandidates?: number;
}

/** The space-policy proposal MODES (DESIGN-014 amendment 2026-07-09, build A). */
export const SPACE_POLICY_MODES = ['over-target', 'continuous'] as const;
export type SpacePolicyMode = (typeof SPACE_POLICY_MODES)[number];

/**
 * DESIGN-014 amendment (2026-07-09, build A) — one composition cap. `enabled` gates it; `value` is the
 * cap (an item count for `maxItems`, or BYTES for `targetBytes`). Both caps on a kind combine — the
 * batch stops at the FIRST cap it hits (selectBatchCandidates). A disabled cap is ignored (its `value`
 * is retained so the admin's last number survives an off/on toggle).
 */
export interface SpacePolicyCap {
  enabled: boolean;
  value: number;
}

/** DESIGN-014 amendment (2026-07-09, build A) — the per-kind composition caps (both default OFF). */
export interface SpacePolicyKindCaps {
  /** Cap the number of items taken into a proposed batch. */
  maxItems: SpacePolicyCap;
  /** Free at least this many BYTES (largest/worst-rated-first greedy fill). */
  targetBytes: SpacePolicyCap;
  /**
   * DESIGN-014 amendment (2026-07-09, build D) — the batch-selection RANKING for this kind. Drives BOTH
   * the policy batch's greedy pick (buildKindTargeting → selectBatchCandidates) AND the pending walls'
   * "Next up" default sort, so the wall's top is the front of the deletion queue. Optional — absent ⇒
   * the owner default 'worst-rated' (see `activeBatchStrategy`).
   */
  strategy?: BatchStrategy;
}

/** The per-kind cap map — one entry per batchable Trash kind (movie, tv). */
export type SpacePolicyPerKind = Record<TrashMediaKind, SpacePolicyKindCaps>;

/**
 * ADR-031 / DESIGN-014 (PLAN-014) — the space-driven-policy CONFIG. **Propose-only, DEFAULT OFF.**
 * When `enabled`, the hourly-ish `space-policy` sync mode proposes a draft batch (createBatchFromPending
 * — the normal admin_review path) per backing kind. It NEVER greenlights and NEVER deletes: the admin
 * gate stays the human check. `cooldownDays` blocks re-proposing for a kind within N days of its last
 * policy-created batch (anti-spam while a batch is mid-window); `minCandidates` skips a proposal when
 * too few items are pending to be worth a batch. Both have top-level defaults and optional per-array
 * overrides.
 *
 * DESIGN-014 amendment (2026-07-09, build A):
 * - `mode` — 'over-target' (default; propose only for a per-array-enabled array whose usedPct is over
 *   its `space_targets` ceiling) or 'continuous' (propose for a per-array-enabled kind whenever there
 *   are ≥ minCandidates candidates and the cooldown has elapsed with no open batch — the disk target is
 *   NOT required; utilization is still read for reporting).
 * - `perKind` — per-kind composition caps (maxItems / targetBytes, each enable-checkboxed and
 *   combinable). Applied in BOTH modes to the policy-proposed batch (worst-rated-first) and pre-fill the
 *   manual "Start a batch" picker.
 */
export interface SpacePolicy {
  enabled: boolean;
  /** How proposals are triggered (default 'over-target'). */
  mode: SpacePolicyMode;
  /** Don't re-propose a kind within this many days of its last policy-created batch (default 7). */
  cooldownDays: number;
  /** Don't propose unless at least this many actionable items are pending (default 1). */
  minCandidates: number;
  /** Per-physical-array (STORAGE_ARRAYS key) opt-in + overrides. Absent/`enabled:false` ⇒ that array
   *  never proposes (over target in 'over-target' mode; ever in 'continuous' mode). */
  perArray: Record<string, SpacePolicyArrayConfig>;
  /** Per-kind composition caps (movie, tv). Always fully populated by getSpacePolicy (defaults + the
   *  graceful migration of the retired flat `targetBytesPerBatch` key). */
  perKind: SpacePolicyPerKind;
}

/** The default cap value floor for a targetBytes cap the admin newly enables (100 GiB). */
const DEFAULT_TARGET_BYTES = 100 * 1024 ** 3;
/** The default cap value for a maxItems cap the admin newly enables. */
const DEFAULT_MAX_ITEMS = 25;

/** A fresh, both-caps-OFF kind-caps object (retained default values for a later enable). */
export function defaultKindCaps(): SpacePolicyKindCaps {
  return {
    maxItems: { enabled: false, value: DEFAULT_MAX_ITEMS },
    targetBytes: { enabled: false, value: DEFAULT_TARGET_BYTES },
  };
}

/** A fresh per-kind map with every kind's caps OFF (the DEFAULT — no caps applied). */
export function defaultPerKind(): SpacePolicyPerKind {
  const out = {} as SpacePolicyPerKind;
  for (const kind of TRASH_MEDIA_KINDS) out[kind] = defaultKindCaps();
  return out;
}

/**
 * The effective reclaim targeting for one kind, derived from its ENABLED caps (both combine — the
 * batch stops at the first hit). Every field is typeof-guarded (ADR-031 fail-safe): a non-boolean
 * `enabled` reads as OFF, a non-numeric/≤0 `value` drops the cap. Returns `{}` (no targeting ⇒ ALL
 * candidates) when neither cap is on — never `NaN`/`Infinity` caps.
 */
export function effectiveKindTargeting(
  policy: SpacePolicy,
  kind: TrashMediaKind,
): { targetBytes?: number; maxItems?: number } {
  const caps = policy.perKind?.[kind];
  const out: { targetBytes?: number; maxItems?: number } = {};
  const tb = caps?.targetBytes;
  if (tb?.enabled === true && typeof tb.value === 'number' && tb.value > 0) out.targetBytes = tb.value;
  const mi = caps?.maxItems;
  if (mi?.enabled === true && typeof mi.value === 'number' && mi.value > 0) out.maxItems = mi.value;
  return out;
}

/**
 * DESIGN-014 amendment (2026-07-09, build D) — the ACTIVE batch-selection strategy for one kind: the
 * kind's configured `perKind[kind].strategy`, else the owner default 'worst-rated' (the same ranking
 * policy-proposed batches use — buildKindTargeting). Fail-safe: a hand-edited/garbage jsonb value that
 * isn't one of the two strategies reads as the default. This single resolver is mirrored by both the
 * policy batch pick (selectBatchCandidates) and the pending walls' "Next up" sort so the wall's top is
 * the front of the deletion queue. Accepts a partial policy (only `perKind` is read).
 */
export function activeBatchStrategy(
  policy: { perKind?: Partial<Record<TrashMediaKind, Partial<SpacePolicyKindCaps>>> } | null | undefined,
  kind: TrashMediaKind,
): BatchStrategy {
  const s = policy?.perKind?.[kind]?.strategy;
  return s === 'largest' || s === 'worst-rated' ? s : 'worst-rated';
}

/**
 * ADR-034 / DESIGN-015 (PLAN-016) — the DELIVERY WINDOW for Pushover batch-lifecycle pushes (T-101).
 * The owner's quiet-hours control: pushes only leave inside `[startHour, endHour)` in `tz`. Enqueue
 * computes each `notification_outbox` row's `earliest_send_at` against it. Stored as the `notify_window`
 * app_settings jsonb value; admin-set + audited through setAppSetting. Overnight windows (start >= end)
 * are out of scope (rejected at the zod edge).
 */
export interface NotifyWindow {
  /** Hour the window opens (0..23), local to `tz`. INCLUSIVE. */
  startHour: number;
  /**
   * Hour the window closes (1..24), local to `tz`; must be > startHour. EXCLUSIVE — the window is the
   * half-open interval `[startHour, endHour)`, so `endHour: 24` means "through 23:59:59.999" (an
   * all-day window that never gates). `endHour: 22` closes at 10 PM sharp (22:00 is already outside).
   */
  endHour: number;
  /** IANA timezone name the hours are read in (e.g. 'America/New_York'). */
  tz: string;
}

/**
 * The delivery-window default — ALL DAY, no gating (build-A owner change 2026-07-09). `[0, 24)` in
 * Eastern covers every hour, so out of the box every batch push leaves ASAP (computeEarliestSend
 * returns `now`); the admin can still narrow it to quiet-hours on /admin/storage. (Was 6 PM–10 PM
 * Eastern.) `endHour` is EXCLUSIVE, so `24` = through 23:59:59.999 — the widest window resolveWindow
 * accepts (`endHour <= 24`).
 */
export const NOTIFY_WINDOW_DEFAULT: NotifyWindow = {
  startHour: 0,
  endHour: 24,
  tz: 'America/New_York',
};

/**
 * DESIGN-010/014 amendment (2026-07-09, build D) — POOL REFRESH AFTER SAVE. When `enabled`, a save/
 * un-save on a pending wall enqueues a DEBOUNCED Maintainerr rule re-execution `delayMinutes` later so
 * shielded items leave the pending list quickly (rule runs are heavy — the helper text steers the delay
 * ≥ a few minutes). Stored as the `pool_refresh_after_save` app_settings jsonb value; admin-set + audited
 * through setAppSetting. Read fail-safe by `getPoolRefreshAfterSave` (a garbage jsonb row can't disable a
 * gate into a truthy string / yield a NaN delay).
 */
export interface PoolRefreshAfterSave {
  enabled: boolean;
  /** Minutes to wait after the LAST save before asking Maintainerr to re-evaluate (trailing debounce). */
  delayMinutes: number;
}

/** The floor/ceiling for a hand-set delay (a run is heavy — never sub-minute; a day is plenty of ceiling). */
export const POOL_REFRESH_DELAY_MIN = 1;
export const POOL_REFRESH_DELAY_MAX = 1440;

/** ON out of the box (the owner wants saved items to leave the list quickly), 5-minute debounce. */
export const POOL_REFRESH_AFTER_SAVE_DEFAULT: PoolRefreshAfterSave = {
  enabled: true,
  delayMinutes: 5,
};

/**
 * DESIGN-015 amendment (2026-07-09) — the CONFIGURABLE FINAL-WARNING push. When `enabled`, green-light
 * enqueues a `batch_final_warning` outbox row `hoursBefore` hours before the save window closes — a
 * "last call" ahead of the sweep, distinct from the day-before `batch_leaving_soon_reminder`. The lead
 * time is READ AT GREEN-LIGHT and frozen into the row's `earliest_send_at` (`expires_at − hoursBefore`);
 * a later setting change never moves already-enqueued rows. The enqueue is SKIPPED when that instant is
 * already past — i.e. the window is shorter than `hoursBefore` (see `promoteToLeavingSoon`). Stored as
 * the `final_warning` app_settings jsonb value; admin-set + audited through setAppSetting. Read fail-safe
 * by `getFinalWarning` (a garbage jsonb row can't disable the gate into a truthy string / yield a NaN
 * lead time).
 */
export interface FinalWarning {
  enabled: boolean;
  /** Hours before the window closes to send the last-call ping (clamped to [MIN, MAX] on read). */
  hoursBefore: number;
}

/** The floor/ceiling for a hand-set lead time (sub-hour is too tight to act on; a week is plenty). */
export const FINAL_WARNING_HOURS_MIN = 1;
export const FINAL_WARNING_HOURS_MAX = 168;

/** ON out of the box, 2 hours before close (the owner's example). */
export const FINAL_WARNING_DEFAULT: FinalWarning = {
  enabled: true,
  hoursBefore: 2,
};

/** The typed value shape per key — the jsonb column holds exactly these. */
export interface AppSettingValueMap {
  trash_skip_admin_gate: boolean;
  trash_default_window_days: number;
  motd: MotdRecord;
  space_targets: SpaceTargets;
  space_policy: SpacePolicy;
  notify_window: NotifyWindow;
  pool_refresh_after_save: PoolRefreshAfterSave;
  final_warning: FinalWarning;
  // ADR-037 C-06 (PLAN-017 Metrics) — the WAN link capacities (Mbps) the Metrics Overview charts
  // usage against. Numbers, like trash_default_window_days.
  upload_capacity_mbps: number;
  download_capacity_mbps: number;
  // ADR-045 (PLAN-026 Authentik role portal) — the owned-groups guardrail allowlist (Authentik group
  // NAMES the app may write membership for) + the role→group map (roleId → Authentik group name, so a
  // role rename doesn't orphan the group). Both jsonb; both objects so the getAppSetting typeof-guard
  // treats them like motd/space_targets.
  authentik_owned_groups: string[];
  authentik_group_map: Record<string, string>;
}

/** The documented default returned when a key has no row (never null — every key has a default). */
export const APP_SETTING_DEFAULTS: AppSettingValueMap = {
  trash_skip_admin_gate: false,
  trash_default_window_days: 21,
  motd: MOTD_DEFAULT,
  // No targets set out of the box — the utilization surface renders numbers with no reference line
  // until an admin sets one. `{}` (an object) so the getAppSetting typeof-guard treats it like motd.
  space_targets: {},
  // The space-driven policy is OFF out of the box (the owner's conservative-first instruction) — an
  // unset key proposes nothing. An object so the getAppSetting typeof-guard treats it like motd.
  // 'over-target' mode + no per-kind caps (propose ALL candidates) is the conservative default.
  space_policy: {
    enabled: false,
    mode: 'over-target',
    cooldownDays: 7,
    minCandidates: 1,
    perArray: {},
    perKind: defaultPerKind(),
  },
  // ADR-034 — the delivery window defaults to 6 PM–10 PM Eastern (the owner's example). An object so
  // the getAppSetting typeof-guard treats it like motd; getNotifyWindow further per-field-guards it.
  notify_window: NOTIFY_WINDOW_DEFAULT,
  // DESIGN-010/014 amendment (2026-07-09, build D) — pool refresh after save (ON, 5-min debounce). An
  // object so the getAppSetting typeof-guard treats it like motd; getPoolRefreshAfterSave per-field-guards.
  pool_refresh_after_save: POOL_REFRESH_AFTER_SAVE_DEFAULT,
  // DESIGN-015 amendment (2026-07-09) — the configurable final-warning push (ON, 2 hours before close).
  // An object so the getAppSetting typeof-guard treats it like motd; getFinalWarning per-field-guards.
  final_warning: FINAL_WARNING_DEFAULT,
  // ADR-037 C-06 (PLAN-017 Metrics) — the WAN capacity denominators for the Overview meters. Upload
  // seeds 300 Mbps (the owner's practical Plex outbound cap). Download seeds 2256 Mbps — the LIVE
  // provider figure (2026-07-10 recon); PROVISIONAL, owner to confirm (DESIGN-016 Q-02). Numbers, so
  // the getAppSetting typeof-guard falls back safely if a hand-edited jsonb row is the wrong type.
  upload_capacity_mbps: 300,
  download_capacity_mbps: 2256,
  // ADR-045 (PLAN-026) — the owned-groups allowlist SHIPS as ['family'] (the Phase-1 seeded tier); an
  // auto-created synced tier appends its group here. The role→group map ships empty ({}) — the seeded
  // Family role resolves to 'family' by the name.toLowerCase() convention with no explicit entry.
  authentik_owned_groups: ['family'],
  authentik_group_map: {},
};

/**
 * Resolve the effective cooldown/minCandidates for one array (its override, else the policy default).
 * The per-array overrides are typeof-guarded exactly like the top-level fields (getSpacePolicy) so a
 * hand-edited wrong-type jsonb value (e.g. a string `cooldownDays`) fails SAFE to the policy default —
 * never passing through to yield `now < NaN` (a NaN comparison is always false, which would silently
 * DISABLE the cooldown). `enabled` is already strict (`=== true`), so a non-boolean reads as opted-out.
 */
export function effectiveArrayPolicy(
  policy: SpacePolicy,
  arrayKey: string,
): { enabled: boolean; cooldownDays: number; minCandidates: number } {
  const perArray = policy.perArray?.[arrayKey];
  return {
    enabled: perArray?.enabled === true,
    cooldownDays:
      typeof perArray?.cooldownDays === 'number' ? perArray.cooldownDays : policy.cooldownDays,
    minCandidates:
      typeof perArray?.minCandidates === 'number' ? perArray.minCandidates : policy.minCandidates,
  };
}

/**
 * Read one setting, falling back to its documented default when unset. A read (unguarded). The
 * value is validated shallowly against the default's runtime type so a hand-edited/garbage jsonb
 * row can never flip a boolean gate into a truthy string, etc. — fail to the SAFE default.
 */
export async function getAppSetting<K extends AppSettingKey>(
  db: DbClient | undefined,
  key: K,
): Promise<AppSettingValueMap[K]> {
  const executor = resolveDb(db);
  const [row] = await executor
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key));
  const fallback = APP_SETTING_DEFAULTS[key];
  if (!row) return fallback;
  return typeof row.value === typeof fallback ? (row.value as AppSettingValueMap[K]) : fallback;
}

/** Read the whole known settings map (defaults merged over stored rows) — the admin settings read. */
export async function getAppSettings(db?: DbClient): Promise<AppSettingValueMap> {
  const executor = resolveDb(db);
  const rows = await executor
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...APP_SETTING_DEFAULTS };
  for (const key of APP_SETTING_KEYS) {
    const stored = byKey.get(key);
    if (stored !== undefined && typeof stored === typeof APP_SETTING_DEFAULTS[key]) {
      (out as Record<string, unknown>)[key] = stored;
    }
  }
  return out;
}

export interface SetAppSettingInput<K extends AppSettingKey> {
  db?: DbClient;
  key: K;
  value: AppSettingValueMap[K];
  actorId: string | null;
}

/**
 * The single writer for an app setting: upsert the key AND write an `update_app_setting`
 * permission_audit row (before/after) in ONE transaction. Unknown keys are rejected defensively
 * beneath the zod edge. Returns whether the value actually changed.
 */
export async function setAppSetting<K extends AppSettingKey>(
  input: SetAppSettingInput<K>,
): Promise<{ changed: boolean; before: AppSettingValueMap[K]; after: AppSettingValueMap[K] }> {
  if (!APP_SETTING_KEYS.includes(input.key)) {
    throw new NotFoundError(`Unknown app setting '${input.key}'`);
  }
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, input.key))
      .for('update');
    const fallback = APP_SETTING_DEFAULTS[input.key];
    const before =
      existing && typeof existing.value === typeof fallback
        ? (existing.value as AppSettingValueMap[K])
        : fallback;

    await tx
      .insert(appSettings)
      .values({ key: input.key, value: input.value, updatedBy: input.actorId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: input.value, updatedBy: input.actorId, updatedAt: new Date() },
      });

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_app_setting',
      detail: { key: input.key, before, after: input.value },
    });

    return { changed: before !== input.value, before, after: input.value };
  });
}

/**
 * DESIGN-010/014 amendment (2026-07-09, build D) — read `pool_refresh_after_save`, per-field fail-safe
 * (mirrors getSpacePolicy discipline): a non-boolean `enabled` reads as the default (ON — the owner
 * wants saved items to leave the list, and a garbage row must never SILENTLY disable the nicety); a
 * non-finite / out-of-range `delayMinutes` clamps to [POOL_REFRESH_DELAY_MIN, POOL_REFRESH_DELAY_MAX]
 * around the 5-minute default. So a hand-edited jsonb row can never yield a `NaN`/sub-minute delay.
 */
export async function getPoolRefreshAfterSave(db?: DbClient): Promise<PoolRefreshAfterSave> {
  const stored = await getAppSetting(db, 'pool_refresh_after_save');
  const d = POOL_REFRESH_AFTER_SAVE_DEFAULT;
  const enabled = typeof stored?.enabled === 'boolean' ? stored.enabled : d.enabled;
  const raw = stored?.delayMinutes;
  const delayMinutes =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(POOL_REFRESH_DELAY_MAX, Math.max(POOL_REFRESH_DELAY_MIN, Math.round(raw)))
      : d.delayMinutes;
  return { enabled, delayMinutes };
}

/**
 * DESIGN-015 amendment (2026-07-09) — read `final_warning`, per-field fail-safe (mirrors
 * getPoolRefreshAfterSave discipline): a non-boolean `enabled` reads as the default (ON); a non-finite /
 * out-of-range `hoursBefore` clamps to [FINAL_WARNING_HOURS_MIN, FINAL_WARNING_HOURS_MAX] around the
 * 2-hour default. So a hand-edited jsonb row can never yield a `NaN`/sub-hour lead time nor a truthy-
 * string enable.
 */
export async function getFinalWarning(db?: DbClient): Promise<FinalWarning> {
  const stored = await getAppSetting(db, 'final_warning');
  const d = FINAL_WARNING_DEFAULT;
  const enabled = typeof stored?.enabled === 'boolean' ? stored.enabled : d.enabled;
  const raw = stored?.hoursBefore;
  const hoursBefore =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(FINAL_WARNING_HOURS_MAX, Math.max(FINAL_WARNING_HOURS_MIN, Math.round(raw)))
      : d.hoursBefore;
  return { enabled, hoursBefore };
}

/**
 * ADR-045 (PLAN-026) — read the owned-groups guardrail allowlist, fail-safe. Only string entries are
 * kept and each is lowercased + de-duped (group names are case-normalized). A garbage jsonb row (not an
 * array) reads as the shipped default (['family']) so the guardrail can never silently widen to "any
 * group". This is the ONLY source of truth for which Authentik groups a membership write may touch.
 */
export async function getAuthentikOwnedGroups(db?: DbClient): Promise<string[]> {
  const stored = await getAppSetting(db, 'authentik_owned_groups');
  const raw = Array.isArray(stored) ? stored : APP_SETTING_DEFAULTS.authentik_owned_groups;
  const names = raw.filter((g): g is string => typeof g === 'string').map((g) => g.toLowerCase());
  return [...new Set(names)];
}

/**
 * ADR-045 (PLAN-026) — read the roleId → Authentik-group-name map, fail-safe. Non-string entries are
 * dropped; a garbage jsonb row reads as {}. Callers resolve a role's group via
 * `map[roleId] ?? role.name.toLowerCase()` (the naming convention is the fallback).
 */
export async function getAuthentikGroupMap(db?: DbClient): Promise<Record<string, string>> {
  const stored = await getAppSetting(db, 'authentik_group_map');
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const out: Record<string, string> = {};
  for (const [roleId, name] of Object.entries(stored)) {
    if (typeof name === 'string' && name.length > 0) out[roleId] = name.toLowerCase();
  }
  return out;
}
