// DESIGN-006 D-01 — THE haynesnetwork brand mark: a hub-and-spoke network glyph.
// A ringed central hub (the front door) with three connected satellite nodes
// (echoing the three Plex servers: k8plex, plexops, haynestower). Single
// currentColor SVG so it themes through the token seam like every other glyph
// (ADR-005); drawn on a 32-grid, legible from 20px up, designed for 28px
// (topbar) and 64px (login). Replaces the donor four-square placeholder
// (DESIGN-004 Q-01 → resolved by DESIGN-006).
import type { ReactElement, SVGProps } from 'react';

export function BrandMark(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      {/* Spokes: hub ring → each satellite (ends tucked under the node fills). */}
      <path
        d="M16 13.9V7.3M20.4 21.5 26 24.8M11.6 21.5 6 24.8"
        stroke="currentColor"
        strokeWidth="2"
      />
      {/* Hub: filled core inside an open ring. */}
      <circle cx="16" cy="19" r="3.1" fill="currentColor" />
      <circle cx="16" cy="19" r="5.9" stroke="currentColor" strokeWidth="1.8" />
      {/* Satellites. */}
      <circle cx="16" cy="7" r="2.8" fill="currentColor" />
      <circle cx="26.4" cy="25" r="2.8" fill="currentColor" />
      <circle cx="5.6" cy="25" r="2.8" fill="currentColor" />
    </svg>
  );
}
