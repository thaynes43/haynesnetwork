'use client';

// PLAN-048 / ADR-059 / DESIGN-030 D-10 — the Activity LIVE-status client half (the Fix `useActionProgress` /
// `ActionLiveChip` analog). A detail page fires a retry / re-search, then polls `activity.itemStatus` for THAT
// item and renders a reserved-slot PhaseChip that walks the stage (failed → searching → downloading % →
// importing → done) so the user SEES the item move — the exact Fix feel, one system. The poll is adaptive
// (fast while downloading) and STOPS on landing/clear (never a runaway loop), mirroring the Fix cadence.
import { PhaseChip } from '@hnet/ui';
import { trpc } from '@/lib/trpc-client';
import type { CardActivityStage } from '@/components/cards';
import {
  activityPollIntervalMs,
  activityStagePhase,
  isTerminalActivityStage,
} from '@/lib/activity-progress';

export interface ActivityLiveStatus {
  /** The item is still in some in-flight/failed/completed stage. False ⇒ it cleared out of the live read. */
  present: boolean;
  stage: CardActivityStage | null;
  progress: number | null;
  /** The first answer is still loading (no stage to show yet). */
  pending: boolean;
}

interface ItemStatusData {
  present: boolean;
  stage: CardActivityStage | null;
  progress: number | null;
}

/**
 * Poll the LIVE stage of one in-flight item (`activity.itemStatus`). `enabled:false` disables entirely (no
 * query, no poll). The interval is adaptive — fast while the item is downloading, relaxed otherwise — and
 * STOPS once the item lands (`completed`) or clears (`present:false`); a `failed` item keeps polling so a
 * fired retry is seen to move it off the failed stage.
 */
export function useActivityItemStatus(itemId: string | null, enabled: boolean): ActivityLiveStatus {
  const on = enabled && itemId !== null && itemId !== '';
  const q = trpc.activity.itemStatus.useQuery(
    { itemId: itemId ?? '' },
    {
      enabled: on,
      refetchOnWindowFocus: true,
      staleTime: 0,
      refetchInterval: (query) => {
        const data = query.state.data as ItemStatusData | undefined;
        if (!data) return activityPollIntervalMs({ hasDownloading: false });
        if (!data.present || isTerminalActivityStage(data.stage)) return false;
        return activityPollIntervalMs({ hasDownloading: data.stage === 'downloading' });
      },
    },
  );
  const data = q.data as ItemStatusData | undefined;
  return {
    present: data?.present ?? false,
    stage: data?.stage ?? null,
    progress: data?.progress ?? null,
    pending: on && q.isPending,
  };
}

/** The reserved-slot live chip for an item's current stage — the Fix `ActionLiveChip` analog for Activity. */
export function ActivityStageChip({
  status,
  className,
}: {
  status: ActivityLiveStatus;
  className?: string;
}) {
  if (status.pending) {
    return <PhaseChip phase="checking" label="Checking…" tone="neutral" pulse meter className={className} />;
  }
  if (!status.present || status.stage === null) {
    // Not (or no longer) in the live read — it imported/cleared. The honest "done" terminal (holds still).
    return <PhaseChip phase="cleared" label="Done" tone="success" className={className} />;
  }
  const p = activityStagePhase(status.stage, status.progress);
  return (
    <PhaseChip
      phase={p.phase}
      label={p.label}
      tone={p.tone}
      progressPct={p.progressPct}
      meter={p.meter}
      pulse={p.pulse}
      className={className}
    />
  );
}
