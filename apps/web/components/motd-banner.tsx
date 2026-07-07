'use client';

// ADR-027 / DESIGN-004 D-15 (PLAN-010) — the dashboard Message-of-the-Day banner. Server-fetched in
// page.tsx (no loading flash) and passed in as a prop; this client component owns only the per-user
// dismiss. Severity drives the token palette (`--color-info` / `--color-warning`, via color-mix — no
// raw hex, hard rule 2) and the ARIA role (info→status, warning→alert). Dismiss is a per-user,
// localStorage-versioned removal keyed to the MOTD's `version`: it hides ONLY when the stored version
// matches the current one, so an admin edit/re-enable (new version) re-shows the banner. Collapsing on
// dismiss is a SANCTIONED deliberate removal (ADR-015 / hard rule 9) — the tile grid simply reclaims
// the space; nothing reflows on hover/arm.
//
// The dismissed state is CLIENT-ONLY (localStorage). It is read via useSyncExternalStore with a neutral
// server snapshot (null ⇒ "show") so SSR and the first client paint agree (no hydration mismatch,
// mirroring greeting.tsx); the real dismissal lands right after hydration.

import { useState, useSyncExternalStore } from 'react';

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
    <div
      className={`motd motd--${motd.severity}`}
      role={motd.severity === 'warning' ? 'alert' : 'status'}
      data-testid="motd-banner"
      data-severity={motd.severity}
    >
      <span className="motd__icon" aria-hidden="true">
        {motd.severity === 'warning' ? '⚠' : 'ℹ'}
      </span>
      <p className="motd__message">{motd.message}</p>
      <button
        type="button"
        className="motd__dismiss"
        data-testid="motd-dismiss"
        aria-label="Dismiss this message"
        onClick={dismiss}
      >
        ✕
      </button>
    </div>
  );
}
