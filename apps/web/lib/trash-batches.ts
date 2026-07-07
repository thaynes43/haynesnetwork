// ADR-025 / DESIGN-011 D-07 — pure client helpers for the Trash curation Batches area (the
// poster wall). The glyph language, tap-permission rules, and running counts live here so the
// safety-critical parts of the wall are unit-testable exactly like lib/trash.ts is for the
// pending walls. The server verdict is always authoritative — these mirror the wire contract
// (trash.batches.*), never re-implement it.

/** Mirrors @hnet/db TRASH_BATCH_STATES (keep in lockstep — the client can't import server pkgs). */
export const BATCH_STATES = [
  'draft',
  'admin_review',
  'leaving_soon',
  'deleted',
  'cancelled',
] as const;
export type BatchStateName = (typeof BATCH_STATES)[number];

/** Mirrors @hnet/db TRASH_BATCH_ITEM_STATES. */
export type BatchItemStateName = 'pending' | 'saved' | 'deleted' | 'skipped' | 'protected';

/** Lifecycle pill copy. */
export const BATCH_STATE_LABELS: Record<BatchStateName, string> = {
  draft: 'Draft',
  admin_review: 'Admin review',
  leaving_soon: 'Leaving Soon',
  deleted: 'Deleted',
  cancelled: 'Cancelled',
};

/** Lifecycle pill tone (matches the app badge families: accent=protective, danger=deletion). */
export function batchStateTone(state: BatchStateName): 'muted' | 'info' | 'warn' | 'danger' {
  switch (state) {
    case 'admin_review':
      return 'info';
    case 'leaving_soon':
      return 'warn';
    case 'deleted':
      return 'danger';
    default:
      return 'muted'; // draft (transient skip-gate leftover) + cancelled
  }
}

/** The rolling Plex collection name per kind (mirrors @hnet/domain LEAVING_SOON_COLLECTION_TITLES). */
export const LEAVING_SOON_NAMES: Record<'movie' | 'tv', string> = {
  movie: 'Leaving Soon — Movies',
  tv: 'Leaving Soon — TV',
};

/**
 * THE overlay language (the owner's "X over the title … click and it changes to a lock"):
 * - `x`      — pending, slated to delete (tap ⇒ rescue).
 * - `lock`   — saved/rescued (tap ⇒ un-save, permission-scoped).
 * - `eye`    — pending but recently watched: the sweep's guardian will keep it; not tappable
 *              toward the delete state (an X here would be dishonest — it cannot delete).
 * - `shield` — protected (dnd-tagged at snapshot time): already safe, inert.
 * - `skip`   — sweep kept it (guardian / unverifiable / live-excluded) — kept, NOT deliberately
 *              saved (skipped ≠ protected, ADR-023 C-07b).
 * - `gone`   — deleted by the sweep.
 */
export type WallGlyph = 'x' | 'lock' | 'eye' | 'shield' | 'skip' | 'gone';

export function wallGlyph(state: BatchItemStateName, recentlyWatched: boolean): WallGlyph {
  switch (state) {
    case 'saved':
      return 'lock';
    case 'protected':
      return 'shield';
    case 'skipped':
      return 'skip';
    case 'deleted':
      return 'gone';
    case 'pending':
      return recentlyWatched ? 'eye' : 'x';
  }
}

/** What the wall announces per glyph (title/aria copy; {title} interpolated by the caller). */
export const WALL_GLYPH_MEANING: Record<WallGlyph, string> = {
  x: 'slated to delete — tap to save it',
  lock: 'saved — it will be kept',
  eye: 'recently watched — the guardian keeps it',
  shield: 'protected — already safe from deletion',
  skip: 'kept — could not be verified safe, never deleted',
  gone: 'deleted',
};

export interface WallTapContext {
  batchState: BatchStateName;
  /** leaving_soon with `expiresAt` still in the future. */
  windowOpen: boolean;
  /** Maintainerr reachable — saves write a real exclusion, so unreachable ⇒ wall read-only. */
  reachable: boolean;
  /** Holds `manage_batches` (admin ⇒ yes). */
  canManage: boolean;
  /** Holds `save_leaving_soon` (the family grant; admin ⇒ yes). */
  canSaveWindow: boolean;
  viewerId: string;
}

/**
 * May this viewer interact with the wall AT ALL in the batch's current phase? Mirrors the server
 * gate (trash.batches.setItemSaved): admin_review ⇒ manage_batches; leaving_soon ⇒
 * save_leaving_soon — and only while the window is open. Terminal batches are always read-only.
 */
export function wallInteractive(ctx: WallTapContext): boolean {
  if (!ctx.reachable) return false;
  if (ctx.batchState === 'admin_review') return ctx.canManage;
  if (ctx.batchState === 'leaving_soon') return ctx.windowOpen && ctx.canSaveWindow;
  return false;
}

/**
 * Is THIS tile tappable? X is always tappable (a save is protective). A lock is un-tappable back
 * to X by batch managers anywhere they may curate; during the family window a saver may undo
 * their OWN lock (savedBy === viewer, or a lock this session just made — savedBy null until the
 * refetch lands) but not someone else's (the server contract would allow it; the wall keeps the
 * family flow polite — a manager can always release a foreign lock). eye/shield/skip/gone are
 * inert: there is nothing honest a tap could do (the server would answer changed:false anyway).
 */
export function tileTappable(
  ctx: WallTapContext,
  glyph: WallGlyph,
  savedBy: string | null,
): boolean {
  if (!wallInteractive(ctx)) return false;
  if (glyph === 'x') return true;
  if (glyph === 'lock') {
    if (ctx.canManage) return true;
    return savedBy === null || savedBy === ctx.viewerId;
  }
  return false;
}

export interface WallCountInput {
  state: BatchItemStateName;
  recentlyWatched: boolean;
  sizeBytes: number;
}

export interface WallCounts {
  /** X tiles — pending and not guardian-watched (what the wall shows as slated). */
  slated: number;
  slatedBytes: number;
  /** lock tiles. */
  rescued: number;
  /** eye + shield + skip tiles — kept without being a deliberate save. */
  kept: number;
  /** gone tiles. */
  deleted: number;
}

/** The running header numbers — derived from the SAME glyph mapping the tiles use, so the
 *  header always agrees with what the wall shows. */
export function wallCounts(items: ReadonlyArray<WallCountInput>): WallCounts {
  const out: WallCounts = { slated: 0, slatedBytes: 0, rescued: 0, kept: 0, deleted: 0 };
  for (const item of items) {
    switch (wallGlyph(item.state, item.recentlyWatched)) {
      case 'x':
        out.slated += 1;
        out.slatedBytes += item.sizeBytes;
        break;
      case 'lock':
        out.rescued += 1;
        break;
      case 'gone':
        out.deleted += 1;
        break;
      default:
        out.kept += 1; // eye / shield / skip
    }
  }
  return out;
}

/**
 * The countdown banner copy (leaving_soon). Family phrasing when the viewer can actually save;
 * plain when they are read-only; the closed state is calm and explains what happens next.
 */
export function countdownCopy(daysLeftLabel: string, windowOpen: boolean, canSave: boolean): string {
  if (!windowOpen) {
    return 'The save window has closed — the remaining items delete on the next sweep.';
  }
  if (canSave) {
    return `These delete ${daysLeftLabel} — tap the ✕ on anything you want to keep.`;
  }
  return `These delete ${daysLeftLabel}.`;
}

/** One batch's slice of the SweepReport wire shape (trash.batches.expire → SweepReport.batches[n]). */
export interface SweepBatchResult {
  deletedCount: number;
  skippedCount: number;
  savedCount: number;
  protectedCount: number;
  handleErrors: number;
  raceSkipped: number;
  aborted: boolean;
}

export interface SweepReportRow {
  key: 'deleted' | 'skipped' | 'saved' | 'protected' | 'raceSkipped' | 'handleErrors';
  label: string;
  count: number;
  tone: 'danger' | 'warn' | 'ok' | 'muted';
}

/**
 * The Expire report lines, in display order, from a SweepReport batch entry. raceSkipped and
 * handleErrors rows only render when non-zero (they are exceptional); the four partition rows
 * always render so 0s are explicit (a "0 deleted" is information, not noise). The `aborted`
 * flag is handled separately by the caller (it is a banner, not a count).
 */
export function sweepReportRows(result: SweepBatchResult): SweepReportRow[] {
  const rows: SweepReportRow[] = [
    {
      key: 'deleted',
      label: 'deleted',
      count: result.deletedCount,
      tone: result.deletedCount > 0 ? 'danger' : 'muted',
    },
    {
      key: 'saved',
      label: 'rescued',
      count: result.savedCount,
      tone: result.savedCount > 0 ? 'ok' : 'muted',
    },
    {
      key: 'protected',
      label: 'protected',
      count: result.protectedCount,
      tone: result.protectedCount > 0 ? 'ok' : 'muted',
    },
    {
      key: 'skipped',
      label: 'skipped',
      count: result.skippedCount,
      tone: result.skippedCount > 0 ? 'warn' : 'muted',
    },
  ];
  if (result.raceSkipped > 0) {
    rows.push({
      key: 'raceSkipped',
      label: 'saved mid-run',
      count: result.raceSkipped,
      tone: 'ok',
    });
  }
  if (result.handleErrors > 0) {
    rows.push({
      key: 'handleErrors',
      label: 'delete calls failed',
      count: result.handleErrors,
      tone: 'warn',
    });
  }
  return rows;
}
