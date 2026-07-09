// ADR-025 C-06 / DESIGN-011 — the generic app-settings store (Q-06). A small audited key→jsonb
// table read/written through this single seam: `setAppSetting` upserts the row AND co-writes an
// `update_app_setting` permission_audit row in the SAME transaction (CLAUDE.md hard rule 6). Absent
// key ⇒ the documented default (APP_SETTING_DEFAULTS). First consumers are the Trash skip-gate and
// the default save-window; PLAN-010 (MOTD) + PLAN-013/014 (space target, tuning knobs) reuse it.
import {
  appSettings,
  permissionAudit,
  APP_SETTING_KEYS,
  type AppSettingKey,
  type DbClient,
  type MotdSeverity,
  type PlexServerSlug,
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import { NotFoundError } from './errors';
import { inTransaction, resolveDb } from './db-client';

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

/**
 * ADR-031 / DESIGN-014 (PLAN-014) — the space-driven-policy CONFIG. **Propose-only, DEFAULT OFF.**
 * When `enabled`, the hourly-ish `space-policy` sync mode reads getUtilization() and, for each
 * per-array-enabled array whose usedPct is over its `space_targets` ceiling AND has no open batch for
 * the backing kind(s), PROPOSES a draft batch (createBatchFromPending — the normal admin_review
 * path). It NEVER greenlights and NEVER deletes: the admin gate stays the human check. `cooldownDays`
 * blocks re-proposing for a kind within N days of its last policy-created batch (anti-spam while a
 * batch is mid-window); `minCandidates` skips a proposal when too few items are pending to be worth a
 * batch. Both have top-level defaults and optional per-array overrides.
 */
export interface SpacePolicy {
  enabled: boolean;
  /** Don't re-propose a kind within this many days of its last policy-created batch (default 7). */
  cooldownDays: number;
  /** Don't propose unless at least this many actionable items are pending (default 1). */
  minCandidates: number;
  /** Per-physical-array (STORAGE_ARRAYS key) opt-in + overrides. Absent/`enabled:false` ⇒ that array
   *  never proposes, even over target. */
  perArray: Record<string, SpacePolicyArrayConfig>;
  /**
   * DESIGN-011/014 amendment (2026-07-08) — cap the SIZE of a policy-proposed batch: free at least
   * this many bytes, largest-first (reclaim-targeted creation). ABSENT ⇒ propose ALL candidates
   * (today's behavior). No migration — a free-form jsonb key value; fail-safe to absent when the
   * stored value is non-numeric. */
  targetBytesPerBatch?: number;
}

/**
 * ADR-034 / DESIGN-015 (PLAN-016) — the DELIVERY WINDOW for Pushover batch-lifecycle pushes (T-101).
 * The owner's quiet-hours control: pushes only leave inside `[startHour, endHour)` in `tz`. Enqueue
 * computes each `notification_outbox` row's `earliest_send_at` against it. Stored as the `notify_window`
 * app_settings jsonb value; admin-set + audited through setAppSetting. Overnight windows (start >= end)
 * are out of scope (rejected at the zod edge).
 */
export interface NotifyWindow {
  /** Hour the window opens (0..23), local to `tz`. */
  startHour: number;
  /** Hour the window closes (1..24), local to `tz`; must be > startHour. */
  endHour: number;
  /** IANA timezone name the hours are read in (e.g. 'America/New_York'). */
  tz: string;
}

/** The delivery-window default — 6 PM to 10 PM Eastern (the owner's example). */
export const NOTIFY_WINDOW_DEFAULT: NotifyWindow = {
  startHour: 18,
  endHour: 22,
  tz: 'America/New_York',
};

/** The typed value shape per key — the jsonb column holds exactly these. */
export interface AppSettingValueMap {
  trash_skip_admin_gate: boolean;
  trash_default_window_days: number;
  motd: MotdRecord;
  space_targets: SpaceTargets;
  space_policy: SpacePolicy;
  notify_window: NotifyWindow;
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
  space_policy: { enabled: false, cooldownDays: 7, minCandidates: 1, perArray: {} },
  // ADR-034 — the delivery window defaults to 6 PM–10 PM Eastern (the owner's example). An object so
  // the getAppSetting typeof-guard treats it like motd; getNotifyWindow further per-field-guards it.
  notify_window: NOTIFY_WINDOW_DEFAULT,
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
