'use client';

// Minimal token-styled modal (fix dialog, restore confirm). Esc and overlay-click
// close; focus jumps to the dialog on open. No portal — the app frame has no
// transformed ancestors, and z-index layering is enough at this scale.
import { useEffect, useRef, type ReactNode } from 'react';

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * Optional pinned alert/status slot rendered in an aria-live region BETWEEN the fixed
   * head and the scrolling body. Errors mounted here stay visible and get announced
   * without squeezing the body content (e.g. the fix-reason list) into a tiny scroll
   * region — the whole body scrolls as one instead. Pass `null` to keep the live region
   * mounted (so later errors are announced); omit entirely when a dialog has no banner.
   */
  banner?: ReactNode;
}

export function Modal({ open, title, onClose, children, banner }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the dialog ONCE per open, keyed on `open` alone. Keeping `onClose` out of
  // this effect's deps is load-bearing: parents pass a fresh onClose closure on every
  // render, so a combined effect re-ran on each keystroke and yanked focus back to the
  // dialog — the "Other box loses focus after one character" bug. (React remount-style
  // focus theft via an unstable-reference dependency.)
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  // Escape-to-close lives in its own effect; re-subscribing when onClose changes is
  // harmless (it only swaps a keydown listener — it never moves focus).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="modal-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
          <button
            type="button"
            className="iconbtn modal__close"
            aria-label="Close"
            onClick={onClose}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        {banner !== undefined ? (
          <div className="modal__banner" aria-live="assertive">
            {banner}
          </div>
        ) : null}
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}
