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
 * - `deletable`       — cold + positively evaluated ⇒ the server WILL delete it.
 * - `protected_*`     — kept deliberately (whitelist / watch / requester guardian).
 * - `unverifiable`    — kept because it CANNOT be verified safe (no Maintainerr id, or unknown
 *                       to our ledger) ⇒ the server counts it as SKIPPED, never deleted.
 *                       NOT the same thing as protected — surface it distinctly (ADR-023 C-07b).
 */
export type GuardianPreview =
  'deletable' | 'protected_tag' | 'protected_watched' | 'protected_requested' | 'unverifiable';

export function previewGuardian(item: GuardianPreviewInput): GuardianPreview {
  // The expedite 'all' loop skips unactionable items (no Maintainerr id) BEFORE the guardian.
  if (item.maintainerrMediaId === null) return 'unverifiable';
  if (item.protectedByTag) return 'protected_tag';
  if (item.recentlyWatched) return 'protected_watched';
  if (item.requesters.length > 0) return 'protected_requested';
  // Fail closed: unknown to our ledger ⇒ no watch/requester signal ⇒ kept (skipped).
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
 * - `eye`     — recently watched: the guardian keeps it regardless, so a save is pointless; inert
 *               (mirrors the batch wall — a trash-can here would be dishonest, it cannot delete).
 * - `requested` — a personal requester is on record but the item is NOT yet excluded: its own
 *               person-shield glyph (distinct from the `check` exclusion). Owner ruling (2026-07-09,
 *               build B): a requested item is NEVER inert on the live wall — the person-shield is a
 *               normal save-toggle (tap ⇒ save = add the exclusion). Once excluded it reads as the
 *               ordinary `shield`/`check` (tap ⇒ un-save where permitted). "Person-shield when no
 *               exclusion, shield when both."
 */
export type PendingWallGlyph = 'trash' | 'shield' | 'check' | 'eye' | 'requested';

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
  const requested = item.requesters.length > 0;
  // The Maintainerr-managed dnd TAG is a DELIBERATE hard protection (its un-protect lives on the
  // /library guard panel); it stays the inert `check` even for a requester item — the owner's build-B
  // "never inert" ruling targets the reversible save-exclusion, not the hard tag.
  if (override !== 'unsaved' && item.protectedByTag) return 'check';
  if (override !== 'unsaved' && item.protectedByExclusion) {
    // A LIVE (reversible) exclusion: a requester item that is ALSO excluded reads as the ordinary save
    // shield ("shield when both") — never inert, so it can be un-saved like any other save; a
    // non-requester exclusion made elsewhere stays the inert `check`.
    return requested ? 'shield' : 'check';
  }
  if (override !== 'unsaved' && item.recentlyWatched) return 'eye';
  // A requester with no exclusion: the person-shield — a live, tappable save-toggle (tap ⇒ save),
  // NOT the old inert marker. Ranks AFTER tag/exclusion + watched to mirror the guardian precedence.
  if (override !== 'unsaved' && requested) return 'requested';
  return 'trash';
}

/** May THIS tile be tapped to toggle? Mirrors the wire gates the caller resolved (canSave /
 *  canUnsave already fold in reachability). `trash` and `requested` (the person-shield) both save
 *  (tap ⇒ add the exclusion); `shield` un-saves. `check` / `eye` stay inert — protection made
 *  outside this session (a foreign exclusion, or the watch guardian's automatic keep) reads as
 *  state, never a button. */
export function pendingWallTappable(
  glyph: PendingWallGlyph,
  canSave: boolean,
  canUnsave: boolean,
): boolean {
  if (glyph === 'trash' || glyph === 'requested') return canSave;
  if (glyph === 'shield') return canUnsave;
  return false;
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
