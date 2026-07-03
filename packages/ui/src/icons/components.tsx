// DESIGN-004 D-09 / DESIGN-003 D-10 — the inline-SVG components behind ICON_KEYS.
// Every glyph is a self-contained <svg> drawing with stroke/fill = currentColor so
// icons theme with the token seam (no icon fonts, no CDN, no <img>). Admins never
// upload markup: AppIcon maps a catalog `icon` key to one of these; null/unknown
// renders the generic tile glyph. Adding an icon is a code change — extend the
// ICON_KEYS tuple in registry.ts AND add the matching component here.
import type { ReactElement, SVGProps } from 'react';
import { isIconKey, type IconKey } from './registry';

type SvgProps = SVGProps<SVGSVGElement>;

/** Shared 24×24 stroke-drawn frame (donor chrome convention). */
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

/** seerr — request/discover: magnifier over a play spark. */
function SeerrIcon(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20 20-4.9-4.9" />
      <path d="M9 8.2v4.6l3.8-2.3z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** plex — the classic play chevron in a rounded tile. */
function PlexIcon(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M10 7h3.4l3.2 5-3.2 5H10l3.2-5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** immich — photos: mountain-and-sun picture glyph. */
function ImmichIcon(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m3.5 17 4.5-4.5 3.5 3.5 3-3L20.5 18" />
    </svg>
  );
}

/** open-webui — chat bubble with a spark. */
function OpenWebuiIcon(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <path d="M21 12a8 8 0 0 1-8 8H4l1.8-3A8 8 0 1 1 21 12Z" />
      <path d="M9 12h.01M13 12h.01M17 12h.01" />
    </svg>
  );
}

/** paperless — document with fold and text lines. */
function PaperlessIcon(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <path d="M6 2.5h8L19 7.5V21a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" />
      <path d="M14 2.5v5h5" />
      <path d="M8.5 12h7M8.5 15.5h7M8.5 19h4.5" />
    </svg>
  );
}

/** tautulli — monitoring: pulse line on a screen. */
function TautulliIcon(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M6.5 11h2.4l1.6-3.5 2.6 6 1.6-2.5h2.8" />
      <path d="M9 21h6" />
    </svg>
  );
}

/** Fallback tile glyph for null/unknown keys (DESIGN-003 D-10). */
export function GenericAppIcon(props: SvgProps): ReactElement {
  return (
    <svg {...frame(props)}>
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="2" />
      <rect x="13" y="3.5" width="7.5" height="7.5" rx="2" />
      <rect x="3.5" y="13" width="7.5" height="7.5" rx="2" />
      <rect x="13" y="13" width="7.5" height="7.5" rx="2" />
    </svg>
  );
}

export const ICON_COMPONENTS: Record<IconKey, (props: SvgProps) => ReactElement> = {
  seerr: SeerrIcon,
  plex: PlexIcon,
  immich: ImmichIcon,
  'open-webui': OpenWebuiIcon,
  paperless: PaperlessIcon,
  tautulli: TautulliIcon,
};

/**
 * Render the icon for a catalog entry's `icon` key. Unknown/null keys fall back to
 * the generic glyph — the value is DB data validated against ICON_KEYS at write
 * time, but read-side stays defensive (D-10).
 */
export function AppIcon({
  icon,
  ...props
}: { icon: string | null | undefined } & SvgProps): ReactElement {
  const Component = isIconKey(icon) ? ICON_COMPONENTS[icon] : GenericAppIcon;
  return <Component {...props} />;
}
