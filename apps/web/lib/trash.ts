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

/** Human labels for the per-action grant grid (/admin/roles) — destructive ones say so. */
export const TRASH_ACTION_LABELS: Record<TrashActionName, string> = {
  save_exclude: 'Save (whitelist) items',
  remove_exclude: 'Un-save items',
  expedite_item: 'Expedite one item — destructive',
  expedite_all: 'Expedite the whole pending set — destructive',
  edit_rules: 'Edit deletion rules (also needs Trash access = Edit)',
  restore_deleted: 'Restore recently deleted items',
  save_leaving_soon: 'Rescue items during the Leaving-Soon window',
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
 * The pending WALL's shield-corner language (2026-07-07 — the Movies/TV pending tables became
 * poster walls riding the Batches wall grammar; DESIGN-010 D-09 amendment). One corner glyph
 * per tile, derived from the durable server signals + the session-local optimistic override:
 * - `check`   — protected by the *arr `dnd` tag or a live Maintainerr exclusion made OUTSIDE
 *               this session. Inert: the wall never un-saves someone else's protection (the
 *               /library/[id] guard panel keeps that power for remove_exclude holders).
 * - `shield`  — saved by YOU this session (the optimistic echo of your own save). Tap ⇒ un-save.
 * - `outline` — unprotected. Tap ⇒ save (the existing dnd-tag exclusion flow).
 */
export type PendingShieldGlyph = 'check' | 'shield' | 'outline';

export function pendingShieldGlyph(
  item: { protectedByTag: boolean; protectedByExclusion: boolean },
  override: 'saved' | 'unsaved' | undefined,
): PendingShieldGlyph {
  if (override === 'saved') return 'shield';
  if (override !== 'unsaved' && (item.protectedByTag || item.protectedByExclusion)) return 'check';
  return 'outline';
}

/** May THIS shield corner be tapped? Mirrors the wire gates the caller resolved (canSave /
 *  canUnsave already fold in reachability). `check` is always inert — protection made outside
 *  this session reads as state, never as a button. */
export function pendingShieldTappable(
  glyph: PendingShieldGlyph,
  canSave: boolean,
  canUnsave: boolean,
): boolean {
  if (glyph === 'outline') return canSave;
  if (glyph === 'shield') return canUnsave;
  return false;
}

/** Whole days until an ISO instant (ceil): 0 ⇒ today, negative ⇒ overdue. Null-safe. */
export function daysUntil(iso: string | null, now: Date = new Date()): number | null {
  if (iso === null) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - now.getTime()) / 86_400_000);
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

/** "Reclaiming 4.0 GB across 3 items" — the filter-aware footer line. */
export function reclaimLabel(
  totalBytes: number,
  count: number,
  formatBytes: (b: number) => string,
): string {
  if (count === 0) return 'Nothing pending';
  return `Reclaiming ${formatBytes(totalBytes)} across ${count} item${count === 1 ? '' : 's'}`;
}
