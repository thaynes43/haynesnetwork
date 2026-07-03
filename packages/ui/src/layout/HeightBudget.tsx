// A height-budgeted CSS-grid region (ADR-005 / DESIGN-004 D-05; ported from
// demo-console). The caller passes `rows` as a `grid-template-rows` value using
// minmax(0,1fr)-style tracks (e.g. "auto minmax(0,1fr)"); direct children get
// `min-height:0` (via .hb-grid) so panes can shrink-to-scroll instead of
// overflowing the page. Structural only.

import type { ReactElement, ReactNode } from 'react';

export interface HeightBudgetProps {
  /** A `grid-template-rows` value, e.g. "auto minmax(0,1fr)". */
  rows: string;
  children: ReactNode;
}

export function HeightBudget({ rows, children }: HeightBudgetProps): ReactElement {
  return (
    <div className="hb-grid" style={{ gridTemplateRows: rows }}>
      {children}
    </div>
  );
}
