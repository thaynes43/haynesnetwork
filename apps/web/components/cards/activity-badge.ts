// PLAN-048 / ADR-059 / DESIGN-030 D-03 — the ONE way an Activity STAGE becomes a caption badge, shared by
// MediaCard / BookCard (the wall in-flight badge) and ActivityCard (the Activity grid tile). Keeping the
// mapping here makes the in-flight signal identical BY CONSTRUCTION across every surface (the ADR-058
// discipline) — tokens-only via the shared `.badge--*` tones, so a stage change recolors, never reflows
// (ADR-015). The stage union mirrors @hnet/domain ActivityStage (kept local so the card package stays
// self-contained; the strings match exactly).
import type { CardBadge, PosterBadgeTone } from './poster-card-body';

export type CardActivityStage = 'searching' | 'downloading' | 'importing' | 'failed' | 'completed';

/** The typed in-flight prop MediaCard/BookCard/ActivityCard accept. */
export interface InFlightBadge {
  stage: CardActivityStage;
  /** 0..100 for `downloading` — rendered as "34%"; ignored otherwise. */
  progress?: number | null;
}

const STAGE_META: Record<CardActivityStage, { label: string; tone: PosterBadgeTone }> = {
  searching: { label: 'Searching', tone: 'muted' },
  downloading: { label: 'Downloading', tone: 'info' },
  importing: { label: 'Importing', tone: 'info' },
  failed: { label: 'Stuck', tone: 'danger' },
  completed: { label: 'Just added', tone: 'ok' },
};

/** The stages that are actively "in flight" — they pulse the badge dot (the Fix PhaseChip "alive" cue). */
const IN_FLIGHT: ReadonlySet<CardActivityStage> = new Set(['searching', 'downloading', 'importing']);

/** Map an in-flight stage (+ progress) to the shared caption badge. A downloading badge carries the live
 *  filling mini-meter + %; every in-flight stage pulses its dot — so an Activity/wall tile progresses in
 *  place exactly like the Fix dialog (DESIGN-030 D-10), recoloring/refilling without reflow (ADR-015). */
export function activityStageBadge(input: InFlightBadge): CardBadge {
  const meta = STAGE_META[input.stage];
  const hasPct = input.stage === 'downloading' && input.progress != null;
  const pct = hasPct ? Math.round(input.progress as number) : null;
  return {
    label: pct != null ? `${pct}%` : meta.label,
    tone: meta.tone,
    title: pct != null ? `${meta.label} — ${pct}%` : meta.label,
    pulse: IN_FLIGHT.has(input.stage),
    progressPct: pct,
  };
}

const FAILURE_LABELS: Record<string, string> = {
  stranded_import: 'Stranded',
  postprocess_failed: 'Import failed',
  download_failed: 'Download failed',
  import_blocked: 'Blocked',
};

/** The optional second badge for a failed item — the failure class (danger tone). */
export function activityFailureBadge(failureKind: string | null | undefined): CardBadge | null {
  if (!failureKind) return null;
  return { label: FAILURE_LABELS[failureKind] ?? 'Failed', tone: 'danger', title: failureKind };
}
