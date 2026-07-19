'use client';

// DESIGN-044 D-05 (owner REDESIGN ruling 2026-07-18 — "gotta catch em all") — the gamified in-library/total
// read that replaces the retired cap meter, shared by the builder preview header AND the /collections list
// rows so the two can never drift. Modeled on the Trash surfaces' gamification idiom: an inline currentColor
// glyph (the icon convention — 24-grid SVG, no emoji, no per-theme asset) plus a token-toned pill. A COMPLETE
// collection (held === total) earns the celebratory gold-star "Caught em all" badge; an incomplete one shows
// the held/total pair with the missing count in the wall's existing "missing" chip typeface (`badge--warn`).
// The width is content-sized and the states only recolor/swap text, never reflow neighbors (ADR-015). The cap
// is never named here — over-cap is the server error + ticket flow, not chrome.
import type { CollectionProgress } from '@/lib/collections';

/** The gold achievement STAR — a filled 5-point star in the app's icon idiom (currentColor, 24-grid). */
export function StarGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.3l-5.81 3.08 1.11-6.47-4.7-4.58 6.5-.95L12 2.5Z" />
    </svg>
  );
}

/**
 * The gamified held/total read. Renders nothing until the membership resolves (an empty preview shows no
 * count, no celebration — the honest edge). `testId` overrides the default per-state test id.
 */
export function CollectionCatch({
  progress,
  testId,
}: {
  progress: CollectionProgress;
  testId?: string;
}) {
  if (progress.empty) return null;
  if (progress.complete) {
    return (
      <span
        className="catch catch--complete"
        data-testid={testId ?? 'collection-caught'}
        data-complete
        title="Caught em all — your library holds every title in this collection."
      >
        <StarGlyph className="catch__star" />
        <span className="catch__count">
          {progress.held} / {progress.total}
        </span>
        <span className="catch__caught">Caught em all</span>
      </span>
    );
  }
  return (
    <span className="catch" data-testid={testId ?? 'collection-progress'}>
      <span className="catch__count">
        {progress.held} / {progress.total}
      </span>
      {progress.missing > 0 ? (
        <span className="badge badge--warn catch__missing">{progress.missing} missing</span>
      ) : null}
    </span>
  );
}
