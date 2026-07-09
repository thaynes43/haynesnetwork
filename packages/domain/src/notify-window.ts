// ADR-034 / DESIGN-015 (PLAN-016) — the DELIVERY-WINDOW math (T-101). Timezone-correct WITHOUT a
// dependency, via Intl.DateTimeFormat offset probing. The owner's quiet-hours window is expressed as
// `{ startHour, endHour, tz }`; enqueue computes each notification_outbox row's `earliest_send_at`
// against it once (so "quiet hours" are DATA, not a resident timer). Notify windows are evening hours,
// far from DST transitions, so the single-correction offset probe is robust.
import { NOTIFY_WINDOW_DEFAULT, getAppSetting, type NotifyWindow } from './app-settings';
import type { DbClient } from '@hnet/db';

const DAY_MS = 86_400_000;

/** Wall-clock components of `instant` in `tz` (24-hour). */
function zonedParts(
  instant: Date,
  tz: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(instant)) if (p.type !== 'literal') map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/** The offset (tz − UTC) in ms at `instant`. */
function tzOffsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

/** Add `n` calendar days to a (year, month, day) triple, rolling over months/years correctly. */
function addCalendarDays(
  year: number,
  month: number,
  day: number,
  n: number,
): { year: number; month: number; day: number } {
  const t = new Date(Date.UTC(year, month - 1, day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/**
 * Convert a wall-clock hour on a given calendar date in `tz` to the corresponding UTC instant.
 * Double-pass: probe the zone offset at the guessed instant, then re-probe at the corrected instant so
 * a DST boundary between the two is honored.
 */
export function zonedHourToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
): Date {
  const guessUtc = Date.UTC(year, month - 1, day, hour);
  const offset1 = tzOffsetMs(new Date(guessUtc), tz);
  const result1 = guessUtc - offset1;
  const offset2 = tzOffsetMs(new Date(result1), tz);
  if (offset2 === offset1) return new Date(result1);
  return new Date(guessUtc - offset2);
}

/** A valid IANA zone name (Intl accepts it), else the default zone. */
function safeTz(tz: unknown): string {
  if (typeof tz === 'string' && tz.length > 0) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch {
      /* fall through to default */
    }
  }
  return NOTIFY_WINDOW_DEFAULT.tz;
}

/**
 * Coerce a possibly-partial/garbage stored value into a valid window (per-field fallback to the
 * default). Enforces `0 <= startHour < endHour <= 24`; any violation reverts BOTH hours to the default
 * pair, so the window can never become empty/inverted (which would strand every push).
 */
export function resolveWindow(value: Partial<NotifyWindow> | null | undefined): NotifyWindow {
  const d = NOTIFY_WINDOW_DEFAULT;
  const startHour =
    typeof value?.startHour === 'number' && Number.isInteger(value.startHour)
      ? value.startHour
      : d.startHour;
  const endHour =
    typeof value?.endHour === 'number' && Number.isInteger(value.endHour)
      ? value.endHour
      : d.endHour;
  const valid = startHour >= 0 && endHour <= 24 && startHour < endHour;
  return {
    startHour: valid ? startHour : d.startHour,
    endHour: valid ? endHour : d.endHour,
    tz: safeTz(value?.tz),
  };
}

/** Read the delivery window, merged over its default + fail-safe validated (like getSpacePolicy). */
export async function getNotifyWindow(db?: DbClient): Promise<NotifyWindow> {
  const stored = await getAppSetting(db, 'notify_window');
  return resolveWindow(stored);
}

/**
 * The earliest instant a notification raised at `now` may be delivered, per the window:
 *   - inside `[startHour, endHour)` in `tz` ⇒ `now` (send ASAP);
 *   - before it opens today       ⇒ today at `startHour` in `tz`;
 *   - at/after it closes          ⇒ tomorrow at `startHour` in `tz`.
 */
export function computeEarliestSend(now: Date, window: NotifyWindow): Date {
  const { startHour, endHour, tz } = resolveWindow(window);
  const p = zonedParts(now, tz);
  if (p.hour >= startHour && p.hour < endHour) return now;
  if (p.hour < startHour) return zonedHourToUtc(tz, p.year, p.month, p.day, startHour);
  const t = addCalendarDays(p.year, p.month, p.day, 1);
  return zonedHourToUtc(tz, t.year, t.month, t.day, startHour);
}

/**
 * The earliest instant for the "day before it leaves" reminder: window-open (`startHour` in `tz`) on
 * the tz-calendar date of `expiresAt` minus one day. If that instant is already in the past (a window
 * shorter than ~1 day), clamp forward to the next window-open so the reminder still lands in-window
 * rather than being lost (DESIGN-015 D-03 / ADR-034 C-06).
 */
export function computeReminderSend(expiresAt: Date, window: NotifyWindow, now: Date): Date {
  const { startHour, tz } = resolveWindow(window);
  const e = zonedParts(expiresAt, tz);
  const dayBefore = addCalendarDays(e.year, e.month, e.day, -1);
  const reminder = zonedHourToUtc(tz, dayBefore.year, dayBefore.month, dayBefore.day, startHour);
  if (reminder.getTime() <= now.getTime()) return computeEarliestSend(now, window);
  return reminder;
}

export { DAY_MS as NOTIFY_DAY_MS };
