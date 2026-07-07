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
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import { NotFoundError } from './errors';
import { inTransaction, resolveDb } from './db-client';

/** The typed value shape per key — the jsonb column holds exactly these. */
export interface AppSettingValueMap {
  trash_skip_admin_gate: boolean;
  trash_default_window_days: number;
}

/** The documented default returned when a key has no row (never null — every key has a default). */
export const APP_SETTING_DEFAULTS: AppSettingValueMap = {
  trash_skip_admin_gate: false,
  trash_default_window_days: 21,
};

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
