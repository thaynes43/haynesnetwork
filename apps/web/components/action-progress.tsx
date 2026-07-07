'use client';

// ADR-028 / DESIGN-005 D-20/D-21 — the client half of the action-feedback contract:
// poll `fix.progress` / `fix.searchProgress` while a progress surface is mounted AND
// the phase is non-terminal (stop on terminal/unmount — never a polling storm), and
// render the live phase as a compact chip (button slots, table rows) or the full
// dialog block (big meter + plain-language copy + retry + per-child roll-up).
import { useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc-client';
import { PhaseChip, ProgressMeter } from '@hnet/ui';
import {
  ACTION_PHASE_LABELS,
  actionPhaseCopy,
  actionPhaseTone,
  formatEta,
  isTerminalActionPhase,
  type ActionScope,
  type ArrKindName,
} from '@/lib/media';

/** The D-21 wire shape both progress queries return. */
export interface ActionProgressData {
  phase: string;
  progressPct?: number;
  etaSeconds?: number;
  perChild?: { childId: number; label: string; phase: string; progressPct?: number }[];
  message?: string;
}

/** fix.searchProgress input — the same grain shape fix.forceSearch takes. */
export interface SearchProgressInput {
  mediaItemId: string;
  scope?: ActionScope;
  targetChildId?: number;
  seasonNumber?: number;
}

/** What to poll: a fix row's progress, or the latest force-search on a grain. */
export type ProgressSource =
  | { kind: 'fix'; fixRequestId: string }
  | { kind: 'search'; input: SearchProgressInput };

// D-20 poll cadence (judgment call recorded in the plan): bytes are moving →
// 2.5 s; waiting on a search/queue → 5 s (8 s for the My Fixes table rows);
// terminal → stop. The interval is re-derived from the freshest data each tick.
const FAST_POLL_MS = 2_500;
export const SLOW_POLL_MS = 5_000;
export const TABLE_POLL_MS = 8_000;

const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';

interface PollableQueryState {
  state: { data?: ActionProgressData; error?: { data?: { code?: string } | null } | null };
}

function nextPollMs(query: PollableQueryState, slowMs: number): number | false {
  // A vanished anchor (e.g. the search event aged out) has nothing to poll.
  if (query.state.error?.data?.code === 'NOT_FOUND') return false;
  const data = query.state.data;
  if (data && isTerminalActionPhase(data.phase)) return false;
  const phase = data?.phase;
  return phase === 'grabbed' || phase === 'downloading' || phase === 'importing'
    ? FAST_POLL_MS
    : slowMs;
}

export interface UseActionProgressResult {
  progress: ActionProgressData | null;
  /** True while the FIRST answer is still loading (no phase to show yet). */
  pending: boolean;
  /** The status check itself failed (e.g. the *arr is unreachable) — transient, keeps retrying. */
  checkFailed: boolean;
}

/**
 * Poll the progress source. `source: null` disables entirely (no query, no poll).
 * `onTerminal` fires once per terminal transition (refresh hooks — e.g. re-arming
 * the Fix button state on the item).
 */
export function useActionProgress(
  source: ProgressSource | null,
  opts?: { slowMs?: number; onTerminal?: (phase: string) => void },
): UseActionProgressResult {
  const slowMs = opts?.slowMs ?? SLOW_POLL_MS;

  const fixQuery = trpc.fix.progress.useQuery(
    { fixRequestId: source?.kind === 'fix' ? source.fixRequestId : PLACEHOLDER_UUID },
    {
      enabled: source?.kind === 'fix',
      refetchInterval: (query) => nextPollMs(query as unknown as PollableQueryState, slowMs),
      refetchOnWindowFocus: false,
      staleTime: 0,
      retry: false,
    },
  );
  const searchQuery = trpc.fix.searchProgress.useQuery(
    source?.kind === 'search' ? source.input : { mediaItemId: PLACEHOLDER_UUID },
    {
      enabled: source?.kind === 'search',
      refetchInterval: (query) => nextPollMs(query as unknown as PollableQueryState, slowMs),
      refetchOnWindowFocus: false,
      staleTime: 0,
      retry: false,
    },
  );

  const active = source?.kind === 'fix' ? fixQuery : source?.kind === 'search' ? searchQuery : null;
  const progress = (active?.data as ActionProgressData | undefined) ?? null;

  // Fire onTerminal once per ENTRY into a terminal phase — a later non-terminal
  // observation (e.g. a retry re-opened the window) re-arms it.
  const lastPhase = useRef<string | null>(null);
  const onTerminal = opts?.onTerminal;
  const phase = progress?.phase ?? null;
  useEffect(() => {
    if (phase === null) return;
    const wasTerminal = lastPhase.current !== null && isTerminalActionPhase(lastPhase.current);
    lastPhase.current = phase;
    if (isTerminalActionPhase(phase) && !wasTerminal) onTerminal?.(phase);
  }, [phase, onTerminal]);

  return {
    progress,
    pending: source !== null && active !== null && active.data === undefined && !active.error,
    checkFailed: source !== null && active !== null && active.error !== null && !active.data,
  };
}

/** The compact one-line chip for a live progress state (button slots, table rows). */
export function ActionLiveChip({
  progress,
  pending,
  checkFailed,
  className,
}: UseActionProgressResult & { className?: string }) {
  if (checkFailed) {
    return (
      <PhaseChip
        phase="unknown"
        label="Status check failed"
        tone="warning"
        title="Could not reach the manager — retrying"
        className={className}
      />
    );
  }
  if (pending || progress === null) {
    return (
      <PhaseChip phase="checking" label="Checking…" tone="neutral" pulse className={className} />
    );
  }
  const terminal = isTerminalActionPhase(progress.phase);
  return (
    <PhaseChip
      phase={progress.phase}
      label={ACTION_PHASE_LABELS[progress.phase] ?? progress.phase}
      tone={actionPhaseTone(progress.phase)}
      progressPct={progress.phase === 'downloading' ? progress.progressPct : undefined}
      meter={!terminal}
      pulse={!terminal}
      title={progress.message}
      className={className}
    />
  );
}

/** The meter detail line: "62% · ~4 min left" while downloading, quiet otherwise. */
function meterDetail(progress: ActionProgressData): string {
  if (progress.phase === 'downloading') {
    const pct = progress.progressPct !== undefined ? `${Math.round(progress.progressPct)}%` : '';
    const eta =
      progress.etaSeconds !== undefined && formatEta(progress.etaSeconds) !== ''
        ? `${formatEta(progress.etaSeconds)} left`
        : '';
    return [pct, eta].filter((s) => s !== '').join(' · ');
  }
  if (progress.phase === 'completed') return '100%';
  return '';
}

/** Meter percent per phase: real bytes while downloading; full on import/complete;
 *  indeterminate (undefined) while searching/queued/grabbed; empty on the quiet terminals. */
function meterPct(progress: ActionProgressData): number | undefined {
  switch (progress.phase) {
    case 'downloading':
      return progress.progressPct ?? undefined;
    case 'importing':
      return progress.progressPct ?? 100;
    case 'completed':
      return 100;
    case 'nothing_found':
    case 'stalled':
    case 'failed':
      return progress.progressPct ?? 0;
    default:
      return undefined; // searching / queued / grabbed — shimmer, no false zero
  }
}

export interface ActionProgressBlockProps extends UseActionProgressResult {
  kind: ArrKindName;
  /** Re-issue the action on the never-stuck terminals (stalled/nothing_found/failed). */
  onRetry?: () => void;
  retryLabel?: string;
  retryPending?: boolean;
}

/**
 * The dialog-size live view: chip headline, the Seerr-style meter, the plain-language
 * copy, a reserved retry slot, and the expandable per-child roll-up. The block keeps a
 * reserved min-height (`.action-progress`) so a non-terminal → terminal swap never
 * reflows the dialog (ADR-015 / hard rule 9).
 */
export function ActionProgressBlock({
  progress,
  pending,
  checkFailed,
  kind,
  onRetry,
  retryLabel = 'Search again',
  retryPending = false,
}: ActionProgressBlockProps) {
  const phase = progress?.phase ?? null;
  const terminal = phase !== null && isTerminalActionPhase(phase);
  const canRetry =
    onRetry !== undefined &&
    (phase === 'stalled' || phase === 'nothing_found' || phase === 'failed');

  return (
    <div className="action-progress" data-live-phase={phase ?? 'checking'}>
      <div className="action-progress__head">
        <ActionLiveChip progress={progress} pending={pending} checkFailed={checkFailed} />
      </div>
      <ProgressMeter
        pct={progress !== null && !checkFailed ? meterPct(progress) : undefined}
        tone={progress !== null && !checkFailed ? actionPhaseTone(progress.phase) : 'neutral'}
        detail={progress !== null && !checkFailed ? meterDetail(progress) : ''}
        label="Download progress"
      />
      <p className="action-progress__copy" aria-live="polite">
        {checkFailed
          ? 'Could not check the status — the manager may be busy. Retrying…'
          : progress === null
            ? 'Checking status…'
            : actionPhaseCopy({
                phase: progress.phase,
                kind,
                progressPct: progress.progressPct,
                etaSeconds: progress.etaSeconds,
                message: progress.message,
              })}
      </p>
      {/* The retry slot is ALWAYS rendered (reserved height) — it fills in on the
          never-stuck terminals instead of appearing and pushing the dialog taller. */}
      <div className="action-progress__retry">
        {canRetry ? (
          <button type="button" className="btn sm" disabled={retryPending} onClick={onRetry}>
            {retryPending ? 'Starting…' : retryLabel}
          </button>
        ) : null}
      </div>
      {progress?.perChild !== undefined && progress.perChild.length > 0 ? (
        <details className="rollup" open={!terminal}>
          <summary className="rollup__summary">
            Each {kind === 'lidarr' ? 'album' : 'episode'} ({progress.perChild.length})
          </summary>
          <ul className="rollup__list">
            {progress.perChild.map((child) => (
              <li key={child.childId} className="rollup__row">
                <span className="rollup__label">{child.label}</span>
                <PhaseChip
                  phase={child.phase}
                  label={ACTION_PHASE_LABELS[child.phase] ?? child.phase}
                  tone={actionPhaseTone(child.phase)}
                  progressPct={child.phase === 'downloading' ? child.progressPct : undefined}
                  meter={!isTerminalActionPhase(child.phase)}
                  pulse={!isTerminalActionPhase(child.phase)}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
