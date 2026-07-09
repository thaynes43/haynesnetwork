// ADR-034 / DESIGN-015 (PLAN-016) — pure client helpers for the /admin/storage Notifications card:
// the delivery-window (T-101) hour/tz formatting, validation, and the human "6 PM – 10 PM ET" summary.
// No React, no network — unit-tested in lib/__tests__/notify-window.test.ts.
import type { NotifyWindow } from '@hnet/domain';

/** A short IANA timezone list for the card's select (the default first). Extend as needed. */
export const NOTIFY_TZ_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'America/New_York', label: 'Eastern (America/New_York)' },
  { value: 'America/Chicago', label: 'Central (America/Chicago)' },
  { value: 'America/Denver', label: 'Mountain (America/Denver)' },
  { value: 'America/Los_Angeles', label: 'Pacific (America/Los_Angeles)' },
  { value: 'Europe/London', label: 'UK (Europe/London)' },
  { value: 'UTC', label: 'UTC' },
];

/** A short label for the tz (its select label, else the raw name). */
export function tzLabel(tz: string): string {
  return NOTIFY_TZ_OPTIONS.find((o) => o.value === tz)?.label ?? tz;
}

/** Format an hour (0..24) as a 12-hour clock label: 0/24 → "12 AM", 12 → "12 PM", 18 → "6 PM". */
export function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const period = h < 12 ? 'AM' : 'PM';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${period}`;
}

/** True when the window is deliverable: whole hours, in range, and start strictly before end. */
export function isValidWindow(startHour: number, endHour: number): boolean {
  return (
    Number.isInteger(startHour) &&
    Number.isInteger(endHour) &&
    startHour >= 0 &&
    startHour <= 23 &&
    endHour >= 1 &&
    endHour <= 24 &&
    startHour < endHour
  );
}

/** The human summary the card shows, e.g. "6 PM – 10 PM · Eastern (America/New_York)". */
export function describeWindow(w: NotifyWindow): string {
  return `${formatHour(w.startHour)} – ${formatHour(w.endHour)} · ${tzLabel(w.tz)}`;
}
