// ADR-028 / DESIGN-005 D-21 — the action-feedback primitives: a single-line phase
// chip (with an optional inline mini-meter) and a block-level thin progress meter
// (the Seerr-style bar the fix/force-search dialogs render). Like ConfirmButton,
// these ship STRUCTURE only — every color comes from the app's stylesheet via the
// `phase-chip--<tone>` / `progress-meter--<tone>` classes, themed by the token
// palette (`--color-progress` et al.); no hex ever lives here (CLAUDE.md rule 2).
//
// ADR-015 (hard rule 9) is designed in, not bolted on:
// - the chip is one fixed-height line (same height as a `.btn.sm`) whose percent
//   span reserves tabular-numeral width, so 7% → 100% never shifts the label;
// - the meter's track always renders (indeterminate shimmer when there is no
//   percent yet), so searching → downloading → done recolors and fills without
//   ever adding or removing an element mid-poll.
import type { ReactNode } from 'react';

/** The tone seam between phase semantics and the app stylesheet. */
export type PhaseTone =
  | 'neutral'
  | 'info'
  | 'progress'
  | 'success'
  | 'muted'
  | 'warning'
  | 'danger';

export interface PhaseChipProps {
  /** Machine-readable phase (rides as data-phase for tests/automation). */
  phase: string;
  label: ReactNode;
  tone: PhaseTone;
  /** 0–100; renders the inline mini-meter + reserved percent readout. */
  progressPct?: number;
  /**
   * Render the mini-meter track even without a percent (indeterminate shimmer).
   * Keeps the chip width stable across searching → downloading transitions.
   */
  meter?: boolean;
  /** Animate the status dot (non-terminal "alive" cue); terminal chips hold still. */
  pulse?: boolean;
  title?: string;
  className?: string;
}

/**
 * One-line live status chip: pulsing dot + label + (optional) mini track + percent.
 * Toned entirely by `phase-chip--<tone>`.
 */
export function PhaseChip({
  phase,
  label,
  tone,
  progressPct,
  meter = false,
  pulse = false,
  title,
  className,
}: PhaseChipProps) {
  const showMeter = meter || progressPct !== undefined;
  return (
    <span
      className={['phase-chip', `phase-chip--${tone}`, pulse ? 'phase-chip--pulse' : null, className]
        .filter(Boolean)
        .join(' ')}
      data-phase={phase}
      title={title}
    >
      <span className="phase-chip__dot" aria-hidden="true" />
      <span className="phase-chip__label">{label}</span>
      {showMeter ? (
        <span
          className={[
            'phase-chip__track',
            progressPct === undefined ? 'phase-chip__track--indeterminate' : null,
          ]
            .filter(Boolean)
            .join(' ')}
          aria-hidden="true"
        >
          <span
            className="phase-chip__fill"
            style={progressPct !== undefined ? { width: `${clamp(progressPct)}%` } : undefined}
          />
        </span>
      ) : null}
      {progressPct !== undefined ? (
        <span className="phase-chip__pct">{clamp(progressPct)}%</span>
      ) : null}
    </span>
  );
}

export interface ProgressMeterProps {
  /** 0–100; omitted ⇒ indeterminate shimmer (searching/queued — no bytes yet). */
  pct?: number;
  tone: PhaseTone;
  /** Right-aligned readout under the bar (e.g. "62% · ~4 min left"). */
  detail?: ReactNode;
  /** Accessible name for the progressbar. */
  label?: string;
  className?: string;
}

/**
 * Block-level thin progress bar (dialog-size). The detail line is ALWAYS rendered
 * (empty when there is nothing to say) so phase transitions never change the
 * block's height (ADR-015).
 */
export function ProgressMeter({ pct, tone, detail, label, className }: ProgressMeterProps) {
  return (
    <span className={['progress-meter', `progress-meter--${tone}`, className].filter(Boolean).join(' ')}>
      <span
        className={[
          'progress-meter__track',
          pct === undefined ? 'progress-meter__track--indeterminate' : null,
        ]
          .filter(Boolean)
          .join(' ')}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct !== undefined ? clamp(pct) : undefined}
      >
        <span
          className="progress-meter__fill"
          style={pct !== undefined ? { width: `${clamp(pct)}%` } : undefined}
        />
      </span>
      <span className="progress-meter__detail">{detail ?? ' '}</span>
    </span>
  );
}

function clamp(pct: number): number {
  return Math.max(0, Math.min(100, Math.round(pct)));
}
