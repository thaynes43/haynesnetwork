// ADR-071 / DESIGN-004 D-24 — the ordered media-action cluster. It OWNS the `.detail-head__actions`
// layout token (the guard forbids that class anywhere else), so the Fix/Force-Search action row
// can't be re-hand-rolled per surface. Children are the ordered action controls (canonically:
// Fix then Force Search — consume lives in the hero's play row, not here); the bar guarantees the
// spacing and, in `head` placement, that the cluster sits as its own flex child that wraps under
// the title on phones.
//
// Structure only — spacing/wrap come from app.css (`.detail-head__actions` / `.media-action-bar`);
// no color here (CLAUDE.md rule 2).
import type { ReactNode } from 'react';

export interface MediaActionBarProps {
  /** `head` = the detail-head action cluster (`.detail-head__actions`); `row` = an inline cluster
   *  inside a child/season row (`.media-action-bar`). */
  placement?: 'head' | 'row';
  /** Ordered action controls (MediaAction / ReservedActionSlot). */
  children: ReactNode;
  className?: string;
  testId?: string;
}

export function MediaActionBar({
  placement = 'head',
  children,
  className,
  testId,
}: MediaActionBarProps) {
  const base = placement === 'head' ? 'detail-head__actions' : 'media-action-bar';
  return (
    <div className={[base, className].filter(Boolean).join(' ')} data-testid={testId}>
      {children}
    </div>
  );
}
