// DESIGN-010 D-09 — pure client helpers for the Trash section (safety-critical copy lives
// here so it is unit-testable). The guardian PREVIEW mirrors @hnet/domain classifyGuardian +
// the expedite 'all' loop's unactionable check (trash-flow.ts) so the Expedite Modal predicts
// the same deleted / protected / skipped partition the server enforces — the server verdict is
// always authoritative; this is the honest preview the confirm copy is built from.

/** The Maintainerr-managed protective *arr tag (mirrors @hnet/domain PROTECTED_TAG — the
 *  client can't import the server package; keep the literals in sync). */
export const PROTECTED_TAG = 'dnd';

/** The fine-grained Trash action grants (mirrors @hnet/db TRASH_ACTIONS — ADR-023 C-03 /
 *  ADR-025 C-01 for the two curation-pipeline grants). Keep in lockstep with @hnet/db. */
export const TRASH_ACTION_NAMES = [
  'save_exclude',
  'remove_exclude',
  'expedite_item',
  'expedite_all',
  'edit_rules',
  'restore_deleted',
  'save_leaving_soon',
  'manage_batches',
] as const;
export type TrashActionName = (typeof TRASH_ACTION_NAMES)[number];

/** Human labels for the per-action grant grid (/admin/roles) — destructive ones say so. The two
 *  Save grants are relabelled (owner-directed 2026-07-08) to make their SCOPE unmistakable: the
 *  first whitelists ANY flagged item at any time (a superset — it implies the second), the second is
 *  only the windowed Leaving-Soon rescue. ADR-025 errata / DESIGN-011 D-05. */
export const TRASH_ACTION_LABELS: Record<TrashActionName, string> = {
  save_exclude: 'Save items — anytime (whitelists any flagged item)',
  remove_exclude: 'Un-save items',
  expedite_item: 'Delete one item now — destructive',
  expedite_all: 'Delete the whole pending set now — destructive',
  edit_rules: 'Edit deletion rules (also needs Trash access = Edit)',
  restore_deleted: 'Restore recently deleted items',
  save_leaving_soon: 'Save items — during a Leaving-Soon window only',
  manage_batches: 'Manage curation batches — create / green-light / cancel / expire',
};

/** The minimal pending-item surface the guardian preview reads. */
export interface GuardianPreviewInput {
  maintainerrMediaId: string | null;
  mediaItemId: string | null;
  protectedByTag: boolean;
  recentlyWatched: boolean;
  requesters: readonly string[];
}

/**
 * Why an item survives (or not) an expedite — the CLIENT mirror of the server partition:
 * - `deletable`       — cold + positively evaluated ⇒ the server WILL delete it. A requested item
 *                       is deletable now (owner ruling 2026-07-09 — requested is informational only,
 *                       never an app-side keep); its requester rides the meta badge, not the verdict.
 * - `protected_*`     — kept deliberately (whitelist / watch guardian).
 * - `unverifiable`    — kept because it CANNOT be verified safe (no Maintainerr id, or unknown
 *                       to our ledger) ⇒ the server counts it as SKIPPED, never deleted.
 *                       NOT the same thing as protected — surface it distinctly (ADR-023 C-07b).
 */
export type GuardianPreview =
  'deletable' | 'protected_tag' | 'protected_watched' | 'unverifiable';

export function previewGuardian(item: GuardianPreviewInput): GuardianPreview {
  // The expedite 'all' loop skips unactionable items (no Maintainerr id) BEFORE the guardian.
  if (item.maintainerrMediaId === null) return 'unverifiable';
  if (item.protectedByTag) return 'protected_tag';
  if (item.recentlyWatched) return 'protected_watched';
  // Fail closed: unknown to our ledger ⇒ no watch signal ⇒ kept (skipped).
  if (item.mediaItemId === null) return 'unverifiable';
  return 'deletable';
}

export interface ExpeditePartition {
  /** Items the server will hand to Maintainerr's per-item delete handler. */
  deletable: number;
  /** Bytes freed by the deletable set (the honest "space reclaimed NOW" figure). */
  deletableBytes: number;
  /** Items the guardian keeps deliberately (tag / watched / requested). */
  protected: number;
  /** Items kept because they can't be verified safe — the server's skippedCount. */
  unverifiable: number;
}

/** Partition a pending set the way expediteDeletion scope 'all' will (preview for the Modal). */
export function partitionForExpedite(
  items: ReadonlyArray<GuardianPreviewInput & { sizeBytes: number }>,
): ExpeditePartition {
  const out: ExpeditePartition = { deletable: 0, deletableBytes: 0, protected: 0, unverifiable: 0 };
  for (const item of items) {
    const verdict = previewGuardian(item);
    if (verdict === 'deletable') {
      out.deletable += 1;
      out.deletableBytes += item.sizeBytes;
    } else if (verdict === 'unverifiable') {
      out.unverifiable += 1;
    } else {
      out.protected += 1;
    }
  }
  return out;
}

/**
 * F3 (2026-07-06 review) — what the Expedite modal does when a mutation FAILS. The key invariant is
 * `invalidate: true` on EVERY error code: a partial/failed run can leave the pending set (and thus
 * the confirm's deleted/protected/skipped partition) stale, so we always refetch and re-partition —
 * previously only the MAINTAINERR_UNSAFE branch did. An UNSAFE verdict shows the calm "nothing was
 * deleted — refreshed" state (no raw message); any other error surfaces its message.
 */
export interface ExpediteErrorAction {
  /** Always true — refetch pending + status so the confirm re-partitions against fresh data. */
  invalidate: true;
  /** Show the calm stale/"nothing deleted" panel (MAINTAINERR_UNSAFE) instead of an error banner. */
  stale: boolean;
  /** The banner message to show, or null when the stale panel replaces it. */
  message: string | null;
}

export function expediteErrorAction(
  appCode: string | null | undefined,
  message: string,
): ExpediteErrorAction {
  if (appCode === 'MAINTAINERR_UNSAFE') return { invalidate: true, stale: true, message: null };
  return { invalidate: true, stale: false, message };
}

/**
 * The pending WALL's overlay language (owner-directed 2026-07-07 — the Movies/TV pending wall now
 * shares the batch wall's fast tap-toggle: a poster tap flips `trash` ⇄ `shield`). One glyph per
 * tile, derived from the durable server signals + the session-local optimistic override. Keep the
 * keys in lockstep with `lib/trash-batches.ts` `WallGlyph` — both walls read as one system:
 * - `trash`   — slated for deletion (unprotected). Tap ⇒ save (the dnd-tag exclusion flow).
 * - `shield`  — saved by YOU this session (the optimistic echo of your own save). Tap ⇒ un-save.
 * - `check`   — protected by the *arr `dnd` tag or a live Maintainerr exclusion made OUTSIDE this
 *               session. Inert: the wall never un-saves someone else's protection (the
 *               /library/[id] guard panel keeps that power for remove_exclude holders).
 *
 * The person-shield `requested` glyph was RETIRED (owner ruling 2026-07-09 — "Maintainerr rules
 * decide what gets promoted; the app controls how much and when it's deleted"). A requester is
 * informational only now: it changes NO actionability — a requested candidate reads as its normal
 * glyph (the slated `trash`, or the `check`/`shield` when protected) and the requester attribution
 * moves OUT to the meta line as an info badge (a person icon + "Requested by <name>" — see the
 * RequestedByBadge component). It co-exists with the watch note.
 *
 * The corner is ALWAYS the action toggle (owner ruling 2026-07-09). The recently-watched `eye` glyph
 * was likewise RETIRED from the corner: a recently-watched item is a normal, fully-saveable tile, and
 * the watch fact rides the meta line (see `watchNote`). Slating a recently-watched item stays honest
 * — the guardian still keeps it at the SWEEP (a sweep-time protection).
 */
export type PendingWallGlyph = 'trash' | 'shield' | 'check';

export function pendingWallGlyph(
  item: {
    protectedByTag: boolean;
    protectedByExclusion: boolean;
    recentlyWatched: boolean;
    requesters: readonly string[];
  },
  override: 'saved' | 'unsaved' | undefined,
): PendingWallGlyph {
  if (override === 'saved') return 'shield';
  // Protection made OUTSIDE this session (the dnd tag or a live foreign exclusion) is the inert
  // `check`; its un-protect lives on the /library guard panel. A requester no longer changes this
  // (it is informational only now) — a requested candidate is the ordinary slated `trash` until
  // protected. `recentlyWatched` no longer produces a corner glyph (the corner is the action; the
  // watch fact rides the meta line).
  if (override !== 'unsaved' && (item.protectedByTag || item.protectedByExclusion)) return 'check';
  return 'trash';
}

/** May THIS tile be tapped to toggle? Mirrors the wire gates the caller resolved (canSave /
 *  canUnsave already fold in reachability). `trash` saves (tap ⇒ add the exclusion); `shield`
 *  un-saves. `check` stays inert — protection made outside this session (a foreign exclusion / the
 *  dnd tag) reads as state, never a button. (There is no `eye` or person-shield glyph: recently-
 *  watched and requested items are ordinary, saveable tiles now.) */
export function pendingWallTappable(
  glyph: PendingWallGlyph,
  canSave: boolean,
  canUnsave: boolean,
): boolean {
  if (glyph === 'trash') return canSave;
  if (glyph === 'shield') return canUnsave;
  return false;
}

// ── cross-server watch visibility (DESIGN-010 D-12 amendment 2026-07-09, build C) ─────────────
// INFO, NOT protection. `lastWatchedAt`/`lastWatchedServer` are the harvested cross-server MAX
// last-watch instant (full history) + its estate server. Watch info NEVER occupies the action
// corner (owner ruling 2026-07-09 — the eye-corner bug fix): the corner is always the save/slate
// toggle, and BOTH watch states now live on the tile meta line:
//   • recently watched  ⇒ an INFO-tone eye + "Watched recently on <server>" (the guardian still
//     keeps it at the SWEEP, but the tile is a normal, saveable trash/requested tile).
//   • watched a while ago ⇒ the MUTED eye + "Last watched on <server> · <Mon YYYY>" (unchanged).
// It changes no guardian/keep semantics: the tile stays fully actionable (tap-save / slate /
// delete). Requested/person-shield still WIN the corner glyph; watch info lives on the meta line +
// tooltip so the two never collide.

/** Friendly estate-server labels for the watch-visibility line (slug → display name). */
export const WATCH_SERVER_LABELS: Record<string, string> = {
  haynesops: 'HaynesOps',
  hayneskube: 'HaynesKube',
  haynestower: 'HaynesTower',
};

/** Map a stored estate slug to its display label; an unknown slug renders verbatim (never blank). */
export function watchServerLabel(slug: string | null): string | null {
  if (slug === null || slug.trim() === '') return null;
  return WATCH_SERVER_LABELS[slug] ?? slug;
}

/** "Jul 2024" — the compact month+year of a watch instant, read in the app display tz. Bad ISO → null. */
export function formatWatchMonth(iso: string | null, tz: string = DISPLAY_TZ): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', year: 'numeric' });
}

/**
 * Whether an item qualifies for the MUTED "watched a while ago" meta note: it has a known last-watch
 * instant AND is not within the recently-watched window (a recently-watched item shows the INFO-tone
 * note instead — see `watchNote`). Retained as a standalone predicate; `watchNote` is the unified
 * entry point the wall tiles use.
 */
export function watchedLongAgo(item: {
  lastWatchedAt: string | null;
  recentlyWatched: boolean;
}): boolean {
  return item.lastWatchedAt !== null && !item.recentlyWatched;
}

/** "Watched recently on HaynesKube · Jul 2024" — the INFO-tone note for an item inside the
 *  recently-watched window (its corner is now the normal save toggle, so the watch fact lives on the
 *  meta line). Degrades exactly like `lastWatchedLabel`: no server ⇒ drop " on <server>"; bad/absent
 *  date ⇒ drop the month; both absent ⇒ a bare "Watched recently" (never blank — a recently-watched
 *  item always earns its note even when the cross-server instant hasn't been attributed yet). */
export function recentlyWatchedLabel(
  lastWatchedAt: string | null,
  lastWatchedServer: string | null,
  tz: string = DISPLAY_TZ,
): string {
  const server = watchServerLabel(lastWatchedServer);
  const month = formatWatchMonth(lastWatchedAt, tz);
  const where = server === null ? '' : ` on ${server}`;
  const when = month === null ? '' : `${server === null ? ' ' : ' · '}${month}`;
  return `Watched recently${where}${when}`;
}

/** The tile meta note's shape: the visible/tooltip label, its tone, and whether it is the recent
 *  (info) or long-ago (muted) state. */
export interface WatchNote {
  label: string;
  tone: 'info' | 'muted';
  recent: boolean;
}

/**
 * The unified cross-server watch-visibility note for a wall tile (DESIGN-010 D-12 build C — watch
 * info NEVER occupies the action corner). Both watch states resolve to a meta-line note:
 *  • recentlyWatched ⇒ the INFO-tone "Watched recently on <server>" (always present — the corner is
 *    now the normal save toggle, so this is the ONLY place the watch fact shows).
 *  • watched a while ago ⇒ the MUTED "Last watched on <server> · <Mon YYYY>".
 * Null only when there is no watch signal at all (never watched). The visible chip is an eye whose
 * TONE carries the state at a glance; the full label rides the tooltip / aria (tile geometry keeps
 * the meta line to one fixed-height row — ADR-015).
 */
export function watchNote(
  item: { lastWatchedAt: string | null; lastWatchedServer: string | null; recentlyWatched: boolean },
  tz: string = DISPLAY_TZ,
): WatchNote | null {
  if (item.recentlyWatched) {
    return {
      label: recentlyWatchedLabel(item.lastWatchedAt, item.lastWatchedServer, tz),
      tone: 'info',
      recent: true,
    };
  }
  const label = lastWatchedLabel(item.lastWatchedAt, item.lastWatchedServer, tz);
  return label === null ? null : { label, tone: 'muted', recent: false };
}

/** "Last watched on HaynesKube · Jul 2024" (server known) / "Last watched Jul 2024" (server unknown)
 *  / "Last watched on HaynesKube" (date unparseable). Null when there is no last-watch instant. */
export function lastWatchedLabel(
  lastWatchedAt: string | null,
  lastWatchedServer: string | null,
  tz: string = DISPLAY_TZ,
): string | null {
  if (lastWatchedAt === null) return null;
  const server = watchServerLabel(lastWatchedServer);
  const month = formatWatchMonth(lastWatchedAt, tz);
  const where = server === null ? '' : ` on ${server}`;
  const when = month === null ? '' : `${server === null ? ' ' : ' · '}${month}`;
  return `Last watched${where}${when}`;
}

// ── deadline countdown (DESIGN-011/014 amendment 2026-07-09, build A — tz-correct + hour-level) ──
// Day words and countdowns are computed in the app's DISPLAY timezone (America/New_York), never the
// browser's and never a raw UTC ms-diff. The pre-2026-07-09 ms-ceil mislabeled a batch that expires
// 11:04 PM ET *today* as "tomorrow" (a >12h gap ceils to 1 day); a CALENDAR-day comparison in ET reads
// it as "today". Under 48h the countdown drops to hour precision ("closes today 11:04 PM · in 15h").

/** The app's canonical display timezone — every user-facing deadline is localized to Eastern. */
export const DISPLAY_TZ = 'America/New_York';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Below this many ms left, the countdown switches from day-level to hour-level (48h). */
const HOUR_LEVEL_MS = 48 * HOUR_MS;

/** The (y, m, d) calendar date of an instant read in `tz` (via en-CA YYYY-MM-DD parts). null on NaN. */
function zonedDateParts(date: Date, tz: string): { y: number; m: number; d: number } | null {
  if (Number.isNaN(date.getTime())) return null;
  const map: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const y = Number(map.year);
  const m = Number(map.month);
  const d = Number(map.day);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return { y, m, d };
}

/**
 * Whole CALENDAR days from `now`→`iso`, both read in `tz` (0 ⇒ today, 1 ⇒ tomorrow, negative ⇒ past).
 * Null-safe. The tz-correct replacement for the old ms-ceil that mislabeled a same-calendar-day-but-
 * later time (e.g. a batch expiring 11:04 PM ET today) as "tomorrow".
 */
export function daysUntil(
  iso: string | null,
  now: Date = new Date(),
  tz: string = DISPLAY_TZ,
): number | null {
  if (iso === null) return null;
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;
  const a = zonedDateParts(now, tz);
  const b = zonedDateParts(target, tz);
  if (a === null || b === null) return null;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

/** ADR-035 — the candidate-snapshot honesty line: "candidates as of just now / N min ago /
 *  N h ago" (the wall serves a read-model refreshed by sync + on demand, never a live crawl).
 *  Bad/absent ISO → null (the slot renders empty; never a bogus age). */
export function candidatesAsOfLabel(iso: string | null, now: Date = new Date()): string | null {
  if (iso === null) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const mins = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (mins < 1) return 'candidates as of just now';
  if (mins < 60) return `candidates as of ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  return `candidates as of ${hours} h ago`;
}

/** The days-left pill copy: "in 12 days" / "tomorrow" / "today" / "overdue". */
export function daysLeftLabel(days: number | null): string {
  if (days === null) return 'no date';
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** Urgency tone for the days-left pill: danger ≤ 3 days (or overdue), warn ≤ 7, muted after. */
export function daysLeftTone(days: number | null): 'danger' | 'warn' | 'muted' {
  if (days === null) return 'muted';
  if (days <= 3) return 'danger';
  if (days <= 7) return 'warn';
  return 'muted';
}

/** "Jul 21" — month+day of `iso` read in `tz` (no year; the compact deadline form). Bad ISO → as-is. */
export function formatDeadlineDay(iso: string, tz: string = DISPLAY_TZ): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
}

/** "11:04 PM" — hour+minute of `iso` read in `tz`. Bad ISO → as-is. */
export function formatDeadlineTime(iso: string, tz: string = DISPLAY_TZ): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
}

// DESIGN-011 amendment (2026-07-09) — the deployed batch-sweep CronJob runs hourly at :45 (`45 * * * *`,
// haynes-ops kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml → sync-trash-batch-sweep).
// This constant MIRRORS that minute so the UI can name the exact sweep time ("deletes at 11:45 PM")
// instead of a vague "the next sweep". Env-overridable via NEXT_PUBLIC_SWEEP_CRON_MINUTE for non-prod
// experiments — but the override and the CronJob schedule MUST move together, or the UI lies about when a
// batch actually deletes (coupling documented in DESIGN-011 D-08). A garbage/out-of-range override
// fails safe to 45. Minute-of-hour is timezone-invariant for whole-hour-offset zones (ET), so the slot
// math needs no tz for the minute; only the DISPLAY of the clock time is tz-localized (the #134 tz fix).
function readSweepMinute(): number {
  const raw = process.env.NEXT_PUBLIC_SWEEP_CRON_MINUTE;
  const n = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 59 ? n : 45;
}
export const SWEEP_CRON_MINUTE = readSweepMinute();

/**
 * The next sweep instant — the next occurrence of minute `:SWEEP_CRON_MINUTE` at or after `after`.
 * Call with `after = max(now, expiresAt)` so a closed window names the upcoming sweep and an open one
 * names the sweep just past its deadline. `setUTCMinutes` lands in the same hour; if that instant is
 * strictly before `after` the sweep for this hour already passed, so roll one hour forward. Equality
 * (`after` sits exactly on a :minute slot — the exactly-:45 edge) KEEPS that slot: the sweep at that
 * instant deletes it.
 */
export function nextSweepSlot(after: Date, minute: number = SWEEP_CRON_MINUTE): Date {
  const slot = new Date(after.getTime());
  slot.setUTCSeconds(0, 0);
  slot.setUTCMinutes(minute);
  if (slot.getTime() < after.getTime()) slot.setUTCHours(slot.getUTCHours() + 1);
  return slot;
}

/** True once a leaving-soon window has closed (its `expiresAt` is at/inside `now`). Null/garbage ⇒
 *  false. A pure wrapper so callers never do an impure `Date.now()` in a React render body. */
export function windowClosed(expiresAtIso: string | null, now: Date = new Date()): boolean {
  if (expiresAtIso === null) return false;
  const t = Date.parse(expiresAtIso);
  return !Number.isNaN(t) && t <= now.getTime();
}

/**
 * The clock time ("11:45 PM" ET) of the next sweep at or after `max(now, expiresAt)`, formatted in `tz`
 * (tz-correct per the #134 fix). Null on a garbage/absent deadline — the caller falls back to vague copy.
 */
export function sweepTimeLabel(
  expiresAtIso: string | null,
  now: Date = new Date(),
  tz: string = DISPLAY_TZ,
): string | null {
  if (expiresAtIso === null) return null;
  const exp = Date.parse(expiresAtIso);
  if (Number.isNaN(exp)) return null;
  const after = new Date(Math.max(now.getTime(), exp));
  return formatDeadlineTime(nextSweepSlot(after).toISOString(), tz);
}

/** Whole hours remaining until `iso` (rounded, floored at 1 while still future), else null. */
export function hoursUntil(iso: string | null, now: Date = new Date()): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const ms = t - now.getTime();
  if (ms <= 0) return null;
  return Math.max(1, Math.round(ms / HOUR_MS));
}

export interface DeadlineCountdown {
  /** WHEN it closes: "today 11:04 PM" / "tomorrow 7:35 AM" (<48h) or "Jul 21" (48h+); '' when no date. */
  whenLabel: string;
  /** The relative pill: "in 15h" (<48h) / "in 9 days" / "tomorrow" / "today" / "overdue" / "no date". */
  relLabel: string;
  /** Pill tone (danger ≤3 days / overdue / <48h; warn ≤7; muted after). */
  tone: 'danger' | 'warn' | 'muted';
  /** True when the hour-level (<48h) form is in use — the caller joins whenLabel · relLabel with a "·". */
  hourLevel: boolean;
  /** Calendar days remaining in `tz` (null when no/garbage date). */
  days: number | null;
}

/**
 * The tz-correct, hour-aware deadline countdown for a leaving-soon window. Under 48h it uses hour
 * precision with a today/tomorrow day word ("today 11:04 PM · in 15h"); at 48h+ it uses the calendar-day
 * label ("Jul 21" + "in 9 days"). All day words are CALENDAR comparisons in `tz` (America/New_York).
 */
export function deadlineCountdown(
  iso: string | null,
  now: Date = new Date(),
  tz: string = DISPLAY_TZ,
): DeadlineCountdown {
  const days = daysUntil(iso, now, tz);
  if (iso === null || days === null) {
    return { whenLabel: '', relLabel: 'no date', tone: 'muted', hourLevel: false, days: null };
  }
  const ms = Date.parse(iso) - now.getTime();
  if (ms > 0 && ms < HOUR_LEVEL_MS) {
    const hrs = hoursUntil(iso, now) ?? 1;
    const dayWord = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : formatDeadlineDay(iso, tz);
    return {
      whenLabel: `${dayWord} ${formatDeadlineTime(iso, tz)}`,
      relLabel: `in ${hrs}h`,
      tone: 'danger', // anything under 48h is within the ≤3-day danger band
      hourLevel: true,
      days,
    };
  }
  return {
    whenLabel: formatDeadlineDay(iso, tz),
    relLabel: daysLeftLabel(days),
    tone: daysLeftTone(days),
    hourLevel: false,
    days,
  };
}

/** "Reclaiming 4.0 GB across 3 items" — the filter-aware footer line. */
export function reclaimLabel(
  totalBytes: number,
  count: number,
  formatBytes: (b: number) => string,
): string {
  if (count === 0) return 'Nothing pending';
  return `Reclaiming ${formatBytes(totalBytes)} across ${count} item${count === 1 ? '' : 's'}`;
}

// ── the Overview landing + tab count badges (DESIGN-010 amendment 2026-07-08) ────────────────
// Pure derivations for the new default Trash tab: one card per kind (Movies, TV) that aggregates
// what's slated BEFORE you navigate, plus the small count pill on the Movies/TV tab labels. Tone is
// safety-critical copy, so it lives here (unit-tested), mirroring the wire — never re-deriving it.

/** The open-batch facts the card/badge tone reads (a subset of the trash.overview batch shape). */
export interface OverviewBatchLike {
  state: string;
  expiresAt: string | null;
  pendingCount: number;
}

/** The per-kind card/badge input (mirrors one trash.overview `kinds[]` entry). */
export interface OverviewKindLike {
  slatedCount: number;
  /** false ⇒ the live candidate count is unknown (Maintainerr down, no open batch) — not zero. */
  live: boolean;
  batch: OverviewBatchLike | null;
}

export type OverviewTone = 'neutral' | 'info' | 'warn' | 'danger';

/**
 * The kind card's state tone: neutral with no batch, info during admin review, warn once a
 * Leaving-Soon window is open, danger when that window has ≤3 days left (mirrors daysLeftTone's
 * danger threshold). Draft (a transient skip-gate leftover) reads as admin-review.
 */
export function overviewCardTone(batch: OverviewBatchLike | null, now: Date = new Date()): OverviewTone {
  if (batch === null) return 'neutral';
  if (batch.state === 'leaving_soon') {
    const days = daysUntil(batch.expiresAt, now);
    return days !== null && days <= 3 ? 'danger' : 'warn';
  }
  if (batch.state === 'admin_review' || batch.state === 'draft') return 'info';
  return 'neutral';
}

/** The lifecycle line on the card when a batch is open: "Admin review — 18 items" /
 *  "Leaving Soon — window closes Jul 21 (in 9 days)" / (<48h) "Leaving Soon — window closes today
 *  11:04 PM · in 15h". Deadlines are tz-correct (America/New_York). Empty string when no batch open. */
export function overviewDeadlineLabel(
  batch: OverviewBatchLike | null,
  now: Date = new Date(),
  tz: string = DISPLAY_TZ,
): string {
  if (batch === null) return '';
  if (batch.state === 'leaving_soon') {
    if (batch.expiresAt === null) return 'Leaving Soon';
    // Window already closed (awaiting the sweep) — name the sweep time, not a stale past deadline
    // (aligned with the batch countdown banner; DESIGN-011 amendment 2026-07-09).
    if (Date.parse(batch.expiresAt) <= now.getTime()) {
      const sweep = sweepTimeLabel(batch.expiresAt, now, tz);
      return sweep !== null
        ? `Leaving Soon — window closed · deletes at ${sweep}`
        : 'Leaving Soon — window closed';
    }
    const c = deadlineCountdown(batch.expiresAt, now, tz);
    return c.hourLevel
      ? `Leaving Soon — window closes ${c.whenLabel} · ${c.relLabel}`
      : `Leaving Soon — window closes ${c.whenLabel} (${c.relLabel})`;
  }
  if (batch.state === 'admin_review' || batch.state === 'draft') {
    return `Admin review — ${batch.pendingCount} item${batch.pendingCount === 1 ? '' : 's'}`;
  }
  return '';
}

/**
 * The Movies/TV tab count badge: suppressed at zero (or an unknown live count), warn while a
 * Leaving-Soon window is open, danger at ≤3 days left, else a muted informational pill. The count is
 * the SAME number the kind card shows (slatedCount).
 */
export interface OverviewBadge {
  show: boolean;
  count: number;
  tone: 'muted' | 'warn' | 'danger';
}

export function overviewBadge(kind: OverviewKindLike, now: Date = new Date()): OverviewBadge {
  // `slatedCount` is 0 whenever the live read failed (live:false), so `> 0` also suppresses unknowns.
  const show = kind.slatedCount > 0;
  let tone: 'muted' | 'warn' | 'danger' = 'muted';
  if (kind.batch?.state === 'leaving_soon') {
    const days = daysUntil(kind.batch.expiresAt, now);
    tone = days !== null && days <= 3 ? 'danger' : 'warn';
  }
  return { show, count: kind.slatedCount, tone };
}
