// ADR-071 / DESIGN-004 D-24 — the ONE media-action button. A surface names an action TYPE (the
// registry key) and this renders the canonical label + variant off MEDIA_ACTIONS — the caller
// never types a label or a `btn` class, so a movie Fix, a book Fix, an episode Fix and a wanted
// Force Search are the same control BY CONSTRUCTION. Destructive specs render through the
// ConfirmButton two-step (ADR-014 / hard rule 8); non-destructive specs render a plain button that
// opens its own explanatory Modal/dialog (hard rule 8) via `onFire`.
//
// Structure only — variant → `.btn`/`.btn.primary`, size → `.btn.sm`; all color is app.css tokens
// (CLAUDE.md rule 2). Wrap in <ReservedActionSlot> to get the reflow-safe button ↔ live-chip swap.
import type { MouseEvent } from 'react';
import { ConfirmButton } from '../controls/ConfirmButton';
import {
  MEDIA_ACTIONS,
  composeActionLabel,
  type MediaActionType,
} from './action-registry';

export interface MediaActionProps {
  /** The canonical action — the registry KEY (e.g. "fix"). The component looks up label + variant
   *  internally; a caller cannot inject a literal label or `btn` class (the "one label per verb"
   *  lock). Use <ConsumeLink> for `consume`. */
  action: MediaActionType;
  /** Fired on click (open the Fix/Force-Search dialog, or — for a destructive spec — the confirmed
   *  action). Receives the click event so a caller can `preventDefault()` when the button sits
   *  inside an interactive container (e.g. a `<summary>`). Unused for the inert `notOnDisk` pill and
   *  the ConfirmButton (destructive) path. */
  onFire?: (event?: MouseEvent<HTMLButtonElement>) => void;
  /** Grain qualifier appended as " · {scopeLabel}" (e.g. "Season 2", "Whole show"). */
  scopeLabel?: string | null;
  disabled?: boolean;
  /** Layout only (NOT identity): `sm` = the compact `.btn.sm` used in dense rows. Default `md`. */
  size?: 'sm' | 'md';
  testId?: string;
  /** Screen-reader name override; defaults to the composed visible label. */
  ariaLabel?: string;
  /** ConfirmButton copy — only consulted when the spec is destructive. `confirmLabel` MUST arm to a
   *  clear "click twice to confirm"-style aria (enforced by ConfirmButton). */
  confirmLabel?: string;
  restingAriaLabel?: string;
  confirmAriaLabel?: string;
}

export function MediaAction({
  action,
  onFire,
  scopeLabel,
  disabled,
  size = 'md',
  testId,
  ariaLabel,
  confirmLabel,
  restingAriaLabel,
  confirmAriaLabel,
}: MediaActionProps) {
  const spec = MEDIA_ACTIONS[action];
  const label = composeActionLabel(spec, scopeLabel);

  // notOnDisk is an inert, disabled pill (the missing-state affordance) — neutral surface, muted
  // text, no accent (its `.btn--missing` look is themed by app.css). It never fires.
  if (action === 'notOnDisk') {
    return (
      <button
        type="button"
        className="btn btn--missing"
        disabled
        data-testid={testId}
        data-action-type={spec.type}
        aria-label={ariaLabel}
      >
        {label}
      </button>
    );
  }

  const btnClass = [
    'btn',
    spec.variant === 'primary' ? 'primary' : null,
    size === 'sm' ? 'sm' : null,
  ]
    .filter(Boolean)
    .join(' ');

  // Destructive ⇒ the inline two-step ConfirmButton (ADR-014, hard rule 8). ConfirmButton itself
  // carries `.confirm-btn`; the variant class rides alongside so a destructive primary still reads
  // green until armed. (No registry action is destructive today — Fix/Force-Search open Modals —
  // but the path exists so a future direct action is confirm-gated by construction.)
  if (spec.destructive) {
    return (
      <ConfirmButton
        className={btnClass}
        label={label}
        confirmLabel={confirmLabel ?? 'Confirm?'}
        restingAriaLabel={restingAriaLabel ?? `${label} — click twice to confirm`}
        confirmAriaLabel={confirmAriaLabel ?? `Confirm: ${label}`}
        disabled={disabled}
        onConfirm={() => onFire?.()}
        data-testid={testId}
        data-action-type={spec.type}
      />
    );
  }

  return (
    <button
      type="button"
      className={btnClass}
      disabled={disabled}
      onClick={onFire}
      data-testid={testId}
      data-action-type={spec.type}
      aria-label={ariaLabel}
    >
      {label}
    </button>
  );
}
