// A pane that claims its grid slot and scrolls internally rather than growing the
// page (ADR-005 / DESIGN-004 D-05; ported from demo-console). `min-height:0` lets
// it shrink below content size inside a grid track; `overflow:auto` (default)
// surfaces overflow as a pane-level scroll.
// Structural only — no colors (NORMATIVE: layout primitives carry no theme).

import type { ReactElement, ReactNode } from 'react';

export interface ReservedPaneProps {
  children: ReactNode;
  scroll?: boolean;
}

export function ReservedPane({ children, scroll = true }: ReservedPaneProps): ReactElement {
  return (
    // min-height:0 inline guarantees the shrink-to-scroll behaviour even if the
    // stylesheet hasn't loaded; the class carries height:100% + the overflow rule.
    <div className="rp-pane" data-scroll={scroll} style={{ minHeight: 0 }}>
      {children}
    </div>
  );
}
