// ADR-063 / DESIGN-034 — the About surface's inline stroke glyphs: the dashboard entry
// card's info mark (D-01) and one small glyph per help section header (D-04). Deliberately
// LOCAL to the About page — the @hnet/ui icon registry is a CLOSED tuple for admin-curated
// catalog tiles and is not extended for app chrome (DESIGN-003 D-10). Same 24×24
// stroke-drawn frame convention as the registry components so the glyphs theme with
// currentColor.
import type { ReactElement, SVGProps } from 'react';

type SvgProps = SVGProps<SVGSVGElement>;

/** Shared 24×24 stroke-drawn frame (mirrors @hnet/ui's donor chrome convention). */
function frame(props: SvgProps) {
  return {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...props,
  } as const;
}

/** The dashboard About card's mark: a plain info circle. */
export function InfoGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

/** #plex-servers — a two-shelf server rack. */
export function ServersGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01" />
      <path d="M7 16.5h.01" />
    </svg>
  );
}

/** #fix — a wrench. */
export function FixGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

/** #tickets — a perforated ticket stub. */
export function TicketGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" />
      <path d="M13 11v2" />
      <path d="M13 17v2" />
    </svg>
  );
}

/** #trash — the can. */
export function TrashGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

/** #requests — a plus circle. */
export function RequestGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8" />
      <path d="M8 12h8" />
    </svg>
  );
}

/** #goodreads — a closed book. */
export function GoodreadsGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </svg>
  );
}

/** #reading — an open book. */
export function ReadingGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

/** #audiobooks — headphones. */
export function AudiobooksGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

/** #watching — a screen with a play mark. */
export function WatchingGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M10 9.5v5l4-2.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** #music — a note. */
export function MusicGlyph(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}
