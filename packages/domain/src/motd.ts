// ADR-027 / DESIGN-004 D-15 (PLAN-010) — Message-of-the-Day: the optional single admin-set dashboard
// banner broadcast to every authed user. It REUSES the generic audited app_settings store (Open
// decision #1) rather than a bespoke table — the record lives under the `motd` key and every write
// goes through `setAppSetting`, which co-writes an `update_app_setting` permission_audit row in the
// SAME transaction (CLAUDE.md hard rule 6 / T-39). This module is the domain seam: the reader applies
// the enabled + time-window predicate; the writers compose/clear the record.
import { appSettings, type DbClient, type MotdSeverity } from '@hnet/db';
import { eq } from 'drizzle-orm';
import { resolveDb } from './db-client';
import { getAppSetting, setAppSetting, MOTD_DEFAULT, type MotdRecord } from './app-settings';

/** The max stored MOTD length (matches the API zod bound; enforced defensively at the writer too).
 *  DESIGN-004 D-17 raised this 280 → 500: the message is now a markdown subset and a single
 *  `[text](https://…)` link's URL would otherwise eat a third of the budget. */
export const MOTD_MAX_LENGTH = 500;

/**
 * The wire shape `motd.getActive` returns to the dashboard: the display fields plus a `version`
 * string the client dismiss-key is bound to. Editing/re-enabling the MOTD bumps the row's
 * `updated_at`, which changes the version, so a previously-dismissed banner re-shows (ADR-027).
 */
export interface ActiveMotd {
  message: string;
  severity: MotdSeverity;
  startsAt: string | null;
  endsAt: string | null;
  version: string;
}

/** Coerce an arbitrary jsonb value into a MotdRecord, falling back per-field to the SAFE default
 *  (defense in depth — a hand-edited/garbage row can never enable a banner or pick a bad severity). */
function coerceMotd(value: unknown): MotdRecord {
  if (typeof value !== 'object' || value === null) return MOTD_DEFAULT;
  const v = value as Record<string, unknown>;
  const severity: MotdSeverity = v.severity === 'warning' ? 'warning' : 'info';
  return {
    message: typeof v.message === 'string' ? v.message : '',
    severity,
    enabled: v.enabled === true,
    startsAt: typeof v.startsAt === 'string' ? v.startsAt : null,
    endsAt: typeof v.endsAt === 'string' ? v.endsAt : null,
    updatedBy: typeof v.updatedBy === 'string' ? v.updatedBy : null,
  };
}

/** A stable, short dismiss version derived from the row's `updated_at` plus a content hash — so any
 *  edit (which bumps updated_at AND usually the content) yields a new version. Pure + testable. */
export function motdVersion(
  updatedAt: Date,
  record: Pick<MotdRecord, 'message' | 'severity'>,
): string {
  const basis = `${updatedAt.getTime()}|${record.severity}|${record.message}`;
  let hash = 5381;
  for (let i = 0; i < basis.length; i++) hash = ((hash << 5) + hash + basis.charCodeAt(i)) >>> 0;
  return `${updatedAt.getTime().toString(36)}-${hash.toString(36)}`;
}

/**
 * The active-window predicate (ADR-027): a MOTD is active when it is `enabled`, has a non-empty
 * message, and — if a window is set — `now` is at/after `startsAt` (INCLUSIVE start) and strictly
 * before `endsAt` (EXCLUSIVE end). Pure, so the resolution matrix is unit-tested directly.
 */
export function isMotdActive(record: MotdRecord, now: Date): boolean {
  if (!record.enabled || record.message.trim() === '') return false;
  if (record.startsAt !== null && now.getTime() < new Date(record.startsAt).getTime()) return false;
  if (record.endsAt !== null && now.getTime() >= new Date(record.endsAt).getTime()) return false;
  return true;
}

/** Read the raw stored MOTD record (admin compose-form prefill). Unset ⇒ MOTD_DEFAULT. Read-only. */
export async function getMotd(db?: DbClient): Promise<MotdRecord> {
  return coerceMotd(await getAppSetting(db, 'motd'));
}

/**
 * The dashboard read: return the ACTIVE MOTD (enabled + within window) as a wire shape, or `null`.
 * Reads the row directly so `updated_at` is available for the dismiss version. No audit (read-only).
 */
export async function getActiveMotd(
  db?: DbClient,
  now: Date = new Date(),
): Promise<ActiveMotd | null> {
  const executor = resolveDb(db);
  const [row] = await executor
    .select({ value: appSettings.value, updatedAt: appSettings.updatedAt })
    .from(appSettings)
    .where(eq(appSettings.key, 'motd'));
  if (!row) return null;
  const record = coerceMotd(row.value);
  if (!isMotdActive(record, now)) return null;
  return {
    message: record.message,
    severity: record.severity,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    version: motdVersion(row.updatedAt, record),
  };
}

export interface SetMotdInput {
  db?: DbClient;
  message: string;
  severity: MotdSeverity;
  enabled: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  actorId: string | null;
}

/**
 * Compose/enable the MOTD: upsert the `motd` app_settings row AND write an `update_app_setting`
 * permission_audit row in ONE transaction (delegated to `setAppSetting` — the shared single-writer).
 * Message is trimmed + clamped to MOTD_MAX_LENGTH; the optional window is coerced. Returns the record.
 */
export async function setMotd(input: SetMotdInput): Promise<MotdRecord> {
  const value: MotdRecord = {
    message: input.message.trim().slice(0, MOTD_MAX_LENGTH),
    severity: input.severity,
    enabled: input.enabled,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    updatedBy: input.actorId,
  };
  await setAppSetting({ db: input.db, key: 'motd', value, actorId: input.actorId });
  return value;
}

/**
 * Clear the MOTD: flip `enabled=false` (preserving the message so a re-enable is one edit away) and
 * write an audited `update_app_setting` row in the same tx. The banner disappears immediately.
 */
export async function clearMotd(input: {
  db?: DbClient;
  actorId: string | null;
}): Promise<MotdRecord> {
  const current = await getMotd(input.db);
  const value: MotdRecord = { ...current, enabled: false, updatedBy: input.actorId };
  await setAppSetting({ db: input.db, key: 'motd', value, actorId: input.actorId });
  return value;
}
