// ADR-057 / DESIGN-029 (PLAN-045) — the book-request PHASE glyph set: the small state mark baked
// onto a Goodreads items-wall / Library-Wanted tile's corner puck (the Trash-wall `bwall-overlay` /
// Helpdesk `twall-overlay` idiom). All inline SVG on the 24-grid, stroked in currentColor — the
// COLOR comes from the puck's per-phase CSS (`.gwall-overlay[data-phase=…]`), never from here
// (tokens-only, hard rule 2). have = a check, searching = a magnifier, missing = an alert mark,
// parked = a pause (a comic waiting on its ComicVine route).

import type { RequestPhaseName } from '@/lib/goodreads-shelf-wall';

export function RequestPhaseGlyph({
  phase,
  className,
}: {
  phase: RequestPhaseName;
  className?: string;
}) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className,
  };
  switch (phase) {
    case 'have':
      // A check — the want is in the library (or a format landed).
      return (
        <svg {...common}>
          <path d="m5.5 12.5 4 4 9-9" />
        </svg>
      );
    case 'searching':
      // A magnifier — monitored + actively searching (the *arr wanted analog).
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="m14.7 14.7 4.8 4.8" />
        </svg>
      );
    case 'missing':
      // An alert mark — every live format dead-ended (offers Search again).
      return (
        <svg {...common}>
          <path d="M12 5.5v8" />
          <circle cx="12" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'parked':
      // A pause — a comic parked out of the route (waiting on a ComicVine match).
      return (
        <svg {...common}>
          <path d="M9 6.5v11" />
          <path d="M15 6.5v11" />
        </svg>
      );
  }
}
