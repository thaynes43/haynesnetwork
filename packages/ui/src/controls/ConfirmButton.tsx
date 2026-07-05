'use client';

// ADR-014 — inline two-step arm-to-confirm, ported from demo-console's mechanism
// (styled with haynesnetwork tokens by the app, not here). First click arms the
// button; a second click within CONFIRM_MS fires; otherwise it auto-reverts.
// Ships NO color — classes come from app.css (.confirm-btn / .confirming).
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export const CONFIRM_MS = 3000;

// Minimum time armed before a fire is honored. Blocks a rapid double-click (or held Enter,
// which auto-repeats) from arming-and-firing in one gesture — the second event lands too soon
// and is ignored (stays armed) rather than confirming the destructive action.
const MIN_ARM_MS = 300;

export type ConfirmOutcome = 'ok' | 'failed' | void;

export interface UseConfirmOptions {
  onConfirm: () => ConfirmOutcome | Promise<ConfirmOutcome>;
  confirmMs?: number;
  reArmOnFailure?: boolean;
}

export interface ConfirmController {
  readonly armed: boolean;
  trigger: () => void;
  disarm: () => void;
  dispose: () => void;
}

// Framework-agnostic arm-to-confirm state machine (ADR-014). Faithful to the donor: the ONLY
// reverts are the CONFIRM_MS timeout and firing (no blur/pointer-leave/Escape/outside-click).
// Disarm-before-fire + the single boolean prevent a double fire. Pure (no React, no DOM) so it
// is unit-tested directly; useConfirm is a thin React binding over it.
export function createConfirmController(
  opts: UseConfirmOptions & { onArmedChange?: (armed: boolean) => void },
): ConfirmController {
  let armed = false;
  let armedAt = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const set = (next: boolean) => {
    armed = next;
    opts.onArmedChange?.(next);
  };
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    set(false);
  };
  const arm = () => {
    if (timer) clearTimeout(timer);
    armedAt = Date.now();
    set(true);
    // confirmMs read fresh so a between-render change is honored.
    timer = setTimeout(disarm, opts.confirmMs ?? CONFIRM_MS);
  };
  const trigger = () => {
    if (!armed) {
      arm();
      return;
    }
    // Armed but too soon: a double-click/held-Enter reached here in <MIN_ARM_MS. Ignore it
    // (stay armed) so one gesture can't confirm.
    if (Date.now() - armedAt < MIN_ARM_MS) return;
    disarm();
    const result = opts.onConfirm();
    // Re-arm only when an async onConfirm resolves the literal string 'failed'. reArmOnFailure
    // read fresh; the .then no-ops after dispose so an unmounted button never re-arms.
    if (opts.reArmOnFailure && result instanceof Promise) {
      void result.then((r) => {
        if (!disposed && r === 'failed') arm();
      });
    }
  };

  return {
    get armed() {
      return armed;
    },
    trigger,
    disarm,
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// Headless React binding over the controller. onConfirm is read through a ref so the
// controller always calls the latest closure without being recreated.
export function useConfirm(opts: UseConfirmOptions): {
  armed: boolean;
  trigger: () => void;
  disarm: () => void;
} {
  const [armed, setArmed] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const ctrl = useRef<ConfirmController | null>(null);
  if (ctrl.current === null) {
    ctrl.current = createConfirmController({
      onConfirm: () => optsRef.current.onConfirm(),
      // Getters read the latest opts (same ref pattern as onConfirm) so confirmMs/reArmOnFailure
      // changes between renders are honored without recreating the controller.
      get confirmMs() {
        return optsRef.current.confirmMs;
      },
      get reArmOnFailure() {
        return optsRef.current.reArmOnFailure;
      },
      onArmedChange: setArmed,
    });
  }
  useEffect(() => () => ctrl.current?.dispose(), []);
  return { armed, trigger: ctrl.current.trigger, disarm: ctrl.current.disarm };
}

export interface ConfirmButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'type'> {
  onConfirm: UseConfirmOptions['onConfirm'];
  label: ReactNode;
  confirmLabel?: ReactNode;
  // MUST end with "— click twice to confirm".
  restingAriaLabel: string;
  confirmAriaLabel: string;
  confirmMs?: number;
  reArmOnFailure?: boolean;
}

// Thin wrapper — a single <button>. Always carries `confirm-btn`; when armed it also carries
// `confirming`, sets data-armed, swaps its accessible name, and shows confirmLabel.
// stopPropagation keeps a row's own click from firing.
export function ConfirmButton({
  onConfirm,
  label,
  confirmLabel = 'Confirm?',
  restingAriaLabel,
  confirmAriaLabel,
  confirmMs,
  reArmOnFailure,
  className,
  disabled,
  ...rest
}: ConfirmButtonProps) {
  const { armed, trigger } = useConfirm({ onConfirm, confirmMs, reArmOnFailure });
  return (
    <Fragment>
      <button
        type="button"
        data-armed={armed || undefined}
        aria-label={armed ? confirmAriaLabel : restingAriaLabel}
        className={['confirm-btn', className, armed ? 'confirming' : null]
          .filter(Boolean)
          .join(' ')}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          trigger();
        }}
        {...rest}
      >
        {armed ? confirmLabel : label}
      </button>
      {/* Visually-hidden live region announces the armed transition to screen readers. */}
      <span className="sr-only" role="status" aria-live="polite">
        {armed ? 'Click again to confirm.' : ''}
      </span>
    </Fragment>
  );
}
