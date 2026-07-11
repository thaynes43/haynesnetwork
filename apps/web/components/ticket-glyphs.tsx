// ADR-050 / DESIGN-012 D-12 (PLAN-034 Helpdesk) — the ticket glyph set. All inline SVG on the
// 24-grid, stroked in currentColor (token-inherited — never a hex, never an asset), mirroring the
// KindIcon convention. Two families:
//
//   • TicketCategoryIcon — the INTAKE-DRIVEN icon set (owner requirement 8): a non-media ticket's
//     poster tile renders its category icon large where a poster would be, and the compose Modal's
//     category picker uses the same marks — so the wall stays one visual grammar.
//   • TicketStatusGlyph — the small state mark baked onto every tile's corner puck (the Trash-wall
//     `bwall-overlay` idiom): open = the issue dot, in_progress = a half-filled ring, complete = a
//     check, rejected = a slashed ring. Color comes from the puck's per-state CSS, not here.

import type { TicketCategoryName, TicketStatusName } from '@/lib/bulletin';

export function TicketCategoryIcon({
  category,
  className,
}: {
  category: TicketCategoryName;
  className?: string;
}) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className,
  };
  switch (category) {
    case 'playback':
      // A play triangle in a ring — "it won't play".
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M10 8.5 16 12l-6 3.5z" />
        </svg>
      );
    case 'audio':
      // A speaker with sound waves — "no sound / wrong language".
      return (
        <svg {...common}>
          <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z" />
          <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
          <path d="M18 7a7 7 0 0 1 0 10" />
        </svg>
      );
    case 'subtitles':
      // A caption box with two text lines.
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M6.5 12.5h5M14 12.5h3.5M6.5 15.5h2.5M11.5 15.5h6" />
        </svg>
      );
    case 'quality':
      // A screen with an artifact zigzag — "bad quality / wrong version".
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="13" rx="2" />
          <path d="M6 12.5l2.5-2 2.5 2.5 2.5-3.5 2.5 3 2-1.5" />
          <path d="M9.5 21h5" />
        </svg>
      );
    case 'missing':
      // A dashed slot with a question mark — "should be here, isn't".
      return (
        <svg {...common}>
          <path d="M5 4h-.5A1.5 1.5 0 0 0 3 5.5V7M9 4h3M16 4h3.5A1.5 1.5 0 0 1 21 5.5V7M21 11v3M21 18v.5a1.5 1.5 0 0 1-1.5 1.5H16M12 20H9M5 20h-.5A1.5 1.5 0 0 1 3 18.5V18M3 14v-3" />
          <path d="M10 10a2 2 0 1 1 2.7 1.9c-.5.2-.7.6-.7 1.1v.4" />
          <circle cx="12" cy="16" r="0.4" fill="currentColor" />
        </svg>
      );
    case 'other':
      // A speech bubble with an ellipsis — "something else".
      return (
        <svg {...common}>
          <path d="M21 12a8 8 0 0 1-8 8H4l1.7-2.6A8 8 0 1 1 21 12z" />
          <circle cx="8.5" cy="12" r="0.5" fill="currentColor" />
          <circle cx="12.5" cy="12" r="0.5" fill="currentColor" />
          <circle cx="16.5" cy="12" r="0.5" fill="currentColor" />
        </svg>
      );
  }
}

export function TicketStatusGlyph({ status }: { status: TicketStatusName }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (status) {
    case 'open':
      // The issue dot — filed and waiting for eyes.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'in_progress':
      // A half-filled ring — someone's on it.
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'complete':
      return (
        <svg {...common}>
          <path d="M4.5 12.5 10 18 19.5 7" />
        </svg>
      );
    case 'rejected':
      // A slashed ring — dismissed (re-openable, never destroyed).
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M6.2 6.2l11.6 11.6" />
        </svg>
      );
  }
}

/** A small speech-bubble mark for the tile's reply count. */
export function ReplyGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M21 12a8 8 0 0 1-8 8H4l1.7-2.6A8 8 0 1 1 21 12z" />
    </svg>
  );
}
