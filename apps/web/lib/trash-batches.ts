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
 * THE overlay language (owner-directed 2026-07-07 — the same fast tap-toggle on BOTH the pending
 * candidates wall and the batch curation wall: a poster tap flips `trash` ⇄ `shield`):
 * - `trash`  — slated to delete (tap ⇒ save/rescue). The default for a cold candidate.
 * - `shield` — saved/rescued by a user (tap ⇒ un-save, permission-scoped). The deliberate,
 *              deepens-color flip.
 * - `check`  — protected OUTSIDE this action (dnd-tagged at snapshot / a live exclusion made
 *              elsewhere): already safe, inert (a shield-check, distinct from the filled save).
 * - `eye`    — pending but recently watched: the sweep's guardian will keep it; not tappable
 *              toward the delete state (a trash-can here would be dishonest — it cannot delete).
 * - `skip`   — sweep kept it (guardian / unverifiable / live-excluded) — kept, NOT deliberately
 *              saved (skipped ≠ protected, ADR-023 C-07b).
 * - `gone`   — deleted by the sweep.
 */
export type WallGlyph = 'trash' | 'shield' | 'check' | 'eye' | 'skip' | 'gone';

export function wallGlyph(state: BatchItemStateName, recentlyWatched: boolean): WallGlyph {
  switch (state) {
    case 'saved':
      return 'shield';
    case 'protected':
      return 'check';
    case 'skipped':
      return 'skip';
    case 'deleted':
      return 'gone';
    case 'pending':
      return recentlyWatched ? 'eye' : 'trash';
  }
}

/** What the wall announces per glyph (title/aria copy; {title} interpolated by the caller). */
export const WALL_GLYPH_MEANING: Record<WallGlyph, string> = {
  trash: 'slated to delete — tap to save it',
  shield: 'saved — it will be kept',
  check: 'protected — already safe from deletion',
  eye: 'recently watched — the guardian keeps it',
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
 * Is THIS tile tappable? A `trash` tile is always tappable (a save is protective). A saved
 * `shield` is un-tappable back to `trash` by batch managers anywhere they may curate; during the
 * family window a saver may undo their OWN save (savedBy === viewer, or a save this session just
 * made — savedBy null until the refetch lands) but not someone else's (the server contract would
 * allow it; the wall keeps the family flow polite — a manager can always release a foreign save).
 * check/eye/skip/gone are inert: there is nothing honest a tap could do (changed:false anyway).
 */
export function tileTappable(
  ctx: WallTapContext,
  glyph: WallGlyph,
  savedBy: string | null,
): boolean {
  if (!wallInteractive(ctx)) return false;
  if (glyph === 'trash') return true;
  if (glyph === 'shield') {
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
  /** trash tiles — pending and not guardian-watched (what the wall shows as slated). */
  slated: number;
  slatedBytes: number;
  /** shield (saved) tiles. */
  rescued: number;
  /** eye + check + skip tiles — kept without being a deliberate save. */
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
      case 'trash':
        out.slated += 1;
        out.slatedBytes += item.sizeBytes;
        break;
      case 'shield':
        out.rescued += 1;
        break;
      case 'gone':
        out.deleted += 1;
        break;
      default:
        out.kept += 1; // eye / check / skip
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
    return `These delete ${daysLeftLabel} — tap anything you want to keep.`;
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
