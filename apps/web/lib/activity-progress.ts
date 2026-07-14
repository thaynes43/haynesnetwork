// PLAN-048 / ADR-059 / DESIGN-030 D-10 — the Activity LIVE-PROGRESS pure helpers (the Fix-feedback idiom
// carried to the Activity surfaces). Kept framework-free so the adaptive-cadence + stage→PhaseChip mapping
// are unit-tested without React. The cadence mirrors the Fix action-feedback loop (components/action-progress
// FAST_POLL_MS / SLOW_POLL_MS) so the whole app "feels" like one system — the owner judges consistency here.
import type { PhaseTone } from '@hnet/ui';
import type { CardActivityStage } from '@/components/cards';

/** Bytes are moving → poll fast so the % visibly ticks (matches the Fix dialog's FAST_POLL_MS). */
export const ACTIVITY_FAST_POLL_MS = 2_500;
/** Searching / importing / idle → relaxed (matches the Fix dialog's SLOW_POLL_MS; the #278 Activity default). */
export const ACTIVITY_SLOW_POLL_MS = 5_000;

/**
 * The Activity list's ADAPTIVE poll interval: fast while ANY item is actively downloading (so the download %
 * animates), relaxed otherwise. A pure function of the current stage set — the panel derives `hasDownloading`
 * from its rendered items and hands it here (no React in the decision, so it is exhaustively unit-tested).
 */
export function activityPollIntervalMs(input: { hasDownloading: boolean }): number {
  return input.hasDownloading ? ACTIVITY_FAST_POLL_MS : ACTIVITY_SLOW_POLL_MS;
}

/** True once a stage has LANDED — the after-fire live watch stops here and the chip holds still. `failed` is
 *  deliberately NOT terminal: after a retry/re-search we keep watching the item move OFF the failed stage. */
export function isTerminalActivityStage(stage: CardActivityStage | null): boolean {
  return stage === 'completed';
}

/** The PhaseChip descriptor for a live Activity stage — the reserved-slot chip the detail pages render while
 *  an item moves (identical vocabulary to the Fix `ActionLiveChip`). */
export interface ActivityStagePhase {
  phase: string;
  label: string;
  tone: PhaseTone;
  /** 0–100 while downloading — the determinate mini-meter fill; undefined otherwise. */
  progressPct?: number;
  /** Non-terminal "alive" cue (the pulsing dot). */
  pulse: boolean;
  /** Render the mini-meter track (determinate when a pct exists, indeterminate shimmer while in flight). */
  meter: boolean;
}

const STAGE_PHASE: Record<CardActivityStage, { label: string; tone: PhaseTone; pulse: boolean }> = {
  searching: { label: 'Searching', tone: 'neutral', pulse: true },
  downloading: { label: 'Downloading', tone: 'info', pulse: true },
  importing: { label: 'Importing', tone: 'info', pulse: true },
  failed: { label: 'Stuck', tone: 'danger', pulse: false },
  completed: { label: 'Landed', tone: 'success', pulse: false },
};

/** Map a live stage (+ progress) to the PhaseChip vocabulary — the Fix-idiom chip the detail live slot shows.
 *  Downloading carries the determinate % meter; searching/importing show an indeterminate sliver + pulse;
 *  the terminals (completed/failed) hold still. */
export function activityStagePhase(
  stage: CardActivityStage,
  progress: number | null,
): ActivityStagePhase {
  const meta = STAGE_PHASE[stage];
  const pct =
    stage === 'downloading' && progress != null
      ? Math.max(0, Math.min(100, Math.round(progress)))
      : undefined;
  const inFlight = stage === 'searching' || stage === 'downloading' || stage === 'importing';
  return {
    phase: stage,
    label: pct != null ? `Downloading ${pct}%` : meta.label,
    tone: meta.tone,
    progressPct: pct,
    pulse: meta.pulse,
    meter: inFlight,
  };
}
