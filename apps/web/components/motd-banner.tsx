'use client';

// ADR-027 / DESIGN-004 D-15 + D-17 (PLAN-010) — the dashboard Message-of-the-Day banner.
// Server-fetched in page.tsx (no loading flash) and passed in as a prop; this client component owns
// only the per-user dismiss. Severity drives the token palette (`--color-info` / `--color-warning`,
// via color-mix — no raw hex, hard rule 2) and the ARIA role (info→status, warning→alert).
//
// D-17: the severity glyph is a THEMED INLINE SVG (the @hnet/ui icon idiom — stroke=currentColor on
// a 24×24 frame; never an OS emoji, which renders jarringly platform-colored, worst on mobile), the
// message body renders through <MotdMarkdown> (sanitized markdown subset — links/bold/italic/code/
// breaks, React elements only, no HTML), and the presentational surface is extracted as
// <MotdSurface> so the /admin/motd live preview IS the real rendering.
//
// Dismiss is a per-user, localStorage-versioned removal keyed to the MOTD's `version`: it hides ONLY
// when the stored version matches the current one, so an admin edit/re-enable (new version) re-shows
// the banner. Collapsing on dismiss is a SANCTIONED deliberate removal (ADR-015 / hard rule 9) — the
// tile grid simply reclaims the space; nothing reflows on hover/arm.
//
// The dismissed state is CLIENT-ONLY (localStorage). It is read via useSyncExternalStore with a
// neutral server snapshot (null ⇒ "show") so SSR and the first client paint agree (no hydration
// mismatch, mirroring greeting.tsx); the real dismissal lands right after hydration.

import { useState, useSyncExternalStore, type AriaRole, type ReactElement } from 'react';
import { MotdMarkdown } from '@/lib/motd-markdown';

export interface MotdBannerData {
  message: string;
  severity: 'info' | 'warning';
  startsAt: string | null;
  endsAt: string | null;
  version: string;
}

const DISMISS_KEY = 'hnet-motd-dismissed';
const emptySubscribe = () => () => {};

/** The version the user last dismissed, or null (also null when storage is blocked / SSR). */
function readDismissedVersion(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/* ---- Severity + dismiss glyphs — inline SVG per the @hnet/ui icon idiom (DESIGN-004 D-09):
   stroke = currentColor on a 24×24 round-capped frame, so the glyph takes the severity tone from
   the CSS token cascade and re-themes with `data-theme`. NO emoji (D-17). ---- */

function glyphFrame() {
  return {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  } as const;
}

/** info — a stroked circle with an i (dot + stem). */
function InfoGlyph(): ReactElement {
  return (
    <svg {...glyphFrame()}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11.4V16" />
      <path d="M12 8h.01" />
    </svg>
  );
}

/** warning — a rounded triangle with an ! (stem + dot). */
function WarningGlyph(): ReactElement {
  return (
    <svg {...glyphFrame()}>
      <path d="M11.1 4.3 2.6 18.9a1.55 1.55 0 0 0 1.35 2.35h16.1a1.55 1.55 0 0 0 1.35-2.35L12.9 4.3a1.05 1.05 0 0 0-1.8 0Z" />
      <path d="M12 9.6v4.4" />
      <path d="M12 17.4h.01" />
    </svg>
  );
}

/** dismiss — a crisp stroked ✕ (SVG, not a font glyph, so it renders identically everywhere). */
function DismissGlyph(): ReactElement {
  return (
    <svg {...glyphFrame()}>
      <path d="m6.5 6.5 11 11" />
      <path d="m17.5 6.5-11 11" />
    </svg>
  );
}

export interface MotdSurfaceProps {
  message: string;
  severity: 'info' | 'warning';
  /** Interactive dismiss (the live banner). Absent ⇒ an inert placeholder occupies the same box, so
   *  the /admin/motd preview is geometry-identical to the real banner. */
  onDismiss?: () => void;
  role?: AriaRole;
  'data-testid'?: string;
}

/**
 * The presentational MOTD surface (D-17): themed SVG severity glyph · markdown-rendered message ·
 * dismiss control, on a severity-tinted card. Shared by the dashboard banner and the /admin/motd
 * live preview so the two can never drift.
 */
export function MotdSurface({
  message,
  severity,
  onDismiss,
  role,
  'data-testid': testId,
}: MotdSurfaceProps): ReactElement {
  return (
    <div
      className={`motd motd--${severity}`}
      role={role}
      data-testid={testId}
      data-severity={severity}
    >
      <span className="motd__icon" aria-hidden="true">
        {severity === 'warning' ? <WarningGlyph /> : <InfoGlyph />}
      </span>
      <div className="motd__message">
        <MotdMarkdown message={message} />
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="motd__dismiss"
          data-testid="motd-dismiss"
          aria-label="Dismiss this message"
          onClick={onDismiss}
        >
          <DismissGlyph />
        </button>
      ) : (
        <span className="motd__dismiss motd__dismiss--inert" role="presentation" aria-hidden="true">
          <DismissGlyph />
        </span>
      )}
    </div>
  );
}

export function MotdBanner({ motd }: { motd: MotdBannerData | null }) {
  // Click-driven dismissal (this view) is separate from the stored version so a dismiss takes effect
  // without a storage-event round trip.
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const storedVersion = useSyncExternalStore(emptySubscribe, readDismissedVersion, () => null);

  if (!motd) return null;
  if (locallyDismissed || storedVersion === motd.version) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, motd.version);
    } catch {
      /* storage blocked — dismissal is best-effort; still hide for this view */
    }
    setLocallyDismissed(true);
  };

  return (
    <MotdSurface
      message={motd.message}
      severity={motd.severity}
      onDismiss={dismiss}
      role={motd.severity === 'warning' ? 'alert' : 'status'}
      data-testid="motd-banner"
    />
  );
}
