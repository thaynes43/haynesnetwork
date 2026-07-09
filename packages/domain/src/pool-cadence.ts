// DESIGN-010/014 amendment (2026-07-09, build D) — the HONEST pool re-evaluation cadence. Maintainerr
// re-runs its rule handler on its OWN cron (the live install: `rules_handler_job_cron = "0 0-23/8 * * *"`
// → every 8 h). The pending walls surface it next to "candidates as of N min ago" so a member understands
// WHY a saved item can linger until the debounced refresh (or this cadence) fires. Fetched via the
// Maintainerr read client (GET /api/settings) and CACHED in-process (a cadence changes ~never); a fetch
// failure degrades gracefully to null (the label is simply omitted) and serves the last good value.
import type { MaintainerrClientBundle } from './maintainerr-clients';

export interface PoolRefreshCadence {
  /** The rule-handler interval in whole hours, or null when unknown/unparseable. */
  everyHours: number | null;
  /** The raw crontab string (for debugging/tooltip), or null when unavailable. */
  cron: string | null;
}

/**
 * Derive the whole-hour interval from a rule-handler crontab's HOUR field (index 1 of
 * `min hour dom month dow`). Handles the forms Maintainerr emits:
 *   - step form ("slash N", e.g. the star-slash-8 shorthand or `0-23/8`) -> the step (8 h)
 *     [the live install's default `0 0-23/8 * * *`];
 *   - every hour (`*`) -> 1 h;
 *   - a single/list of hours (`0`, `0,12`, `0,8,16`) -> 24 / count (a daily / 12 h / 8 h cadence).
 * Anything else (named ranges, seconds-precision crons) -> null (label omitted, never a wrong number).
 */
export function parseCronEveryHours(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  const hourField = parts[1];
  if (hourField === undefined || hourField === '') return null;

  const stepMatch = hourField.match(/\/(\d+)$/);
  if (stepMatch !== null) {
    const step = Number(stepMatch[1]);
    return Number.isInteger(step) && step > 0 && step <= 24 ? step : null;
  }
  if (hourField === '*') return 1;
  if (/^\d+(,\d+)*$/.test(hourField)) {
    const count = hourField.split(',').filter((h) => h !== '').length;
    return count > 0 ? Math.max(1, Math.round(24 / count)) : null;
  }
  return null;
}

const CADENCE_TTL_MS = 30 * 60_000; // a cron changes ~never; re-check at most twice an hour.
let cadenceCache: { at: number; value: PoolRefreshCadence } | null = null;

/**
 * The cached rule-handler cadence. Serves the in-process cache within the TTL; otherwise fetches
 * Maintainerr settings, parses `rules_handler_job_cron`, and refreshes the cache. On ANY failure it
 * serves the last good value if present, else `{ everyHours: null, cron: null }` — the wall label is
 * omitted, never wrong.
 */
export async function getPoolRefreshCadence(input: {
  maintainerr: Pick<MaintainerrClientBundle, 'read'>;
  now?: Date;
  force?: boolean;
}): Promise<PoolRefreshCadence> {
  const now = input.now?.getTime() ?? Date.now();
  if (!input.force && cadenceCache !== null && now - cadenceCache.at < CADENCE_TTL_MS) {
    return cadenceCache.value;
  }
  try {
    const settings = await input.maintainerr.read.getSettings();
    const cron = settings.rules_handler_job_cron ?? null;
    const value: PoolRefreshCadence = {
      cron,
      everyHours: cron !== null ? parseCronEveryHours(cron) : null,
    };
    cadenceCache = { at: now, value };
    return value;
  } catch {
    return cadenceCache?.value ?? { everyHours: null, cron: null };
  }
}

/** Test seam — drop the in-process cadence cache between tests. */
export function __resetPoolCadenceCacheForTests(): void {
  cadenceCache = null;
}
