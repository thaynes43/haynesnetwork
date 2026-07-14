'use client';

// PLAN-047 / ADR-058 — the wall GRID containers + their skeletons, owned by the card package so
// grid geometry (auto-fill 132px columns; 3-up under 480px) and the loading/refresh idioms
// (skeleton tiles that hold the exact geometry; dim-in-place on refetch — ADR-015) can never be
// re-invented per surface. These are the only components that may take children — the cards
// themselves are closed, typed compositions.
import type { ReactNode } from 'react';

/** The poster-card grid (`.media-list.poster-grid`). `refreshing` undefined = a static wall (no
 *  busy semantics); boolean = the dim-in-place refetch idiom (aria-busy mirrors it). */
export function PosterGrid({
  refreshing,
  testId,
  children,
}: {
  refreshing?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return refreshing === undefined ? (
    <div className="media-list poster-grid" data-testid={testId}>
      {children}
    </div>
  ) : (
    <div
      className={`media-list poster-grid${refreshing ? ' is-refreshing' : ''}`}
      aria-busy={refreshing}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/** Skeleton poster cards holding the exact grid geometry (never a spinner that collapses). */
export function PosterGridSkeleton({ count = 12, testId }: { count?: number; testId?: string }) {
  return (
    <div className="media-list poster-grid" aria-hidden="true" data-testid={testId}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="poster-card poster-card--skeleton">
          <div className="poster-box" />
          <span className="poster-card__body">
            <span className="skeleton-line" />
            <span className="skeleton-line skeleton-line--short" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The Helpdesk ticket wall (`ul.twall` — DESIGN-012 D-12). */
export function TicketWall({
  refreshing,
  testId,
  children,
}: {
  refreshing: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <ul
      className={`twall${refreshing ? ' is-refreshing' : ''}`}
      aria-busy={refreshing}
      data-testid={testId}
    >
      {children}
    </ul>
  );
}

/** Skeleton ticket tiles (fixed 2:3 boxes + caption lines — the twall loading idiom). */
export function TicketWallSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul className="twall" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="twall-tile twall-tile--skeleton">
          <span className="poster-box" />
          <span className="skeleton-line" />
          <span className="skeleton-line skeleton-line--short" />
        </li>
      ))}
    </ul>
  );
}

/** The Trash poster wall (`ul.bwall`, plus the pending walls' `.pwall` refresh marker). */
export function TrashWall({
  pwall = false,
  refreshing,
  label,
  testId,
  children,
}: {
  pwall?: boolean;
  refreshing?: boolean;
  /** aria-label (the pending walls name themselves; the batch wall doesn't). */
  label?: string;
  testId?: string;
  children: ReactNode;
}) {
  return refreshing === undefined ? (
    <ul className={`bwall${pwall ? ' pwall' : ''}`} aria-label={label} data-testid={testId}>
      {children}
    </ul>
  ) : (
    <ul
      className={`bwall${pwall ? ' pwall' : ''}${refreshing ? ' is-refreshing' : ''}`}
      aria-busy={refreshing}
      aria-label={label}
      data-testid={testId}
    >
      {children}
    </ul>
  );
}

/** Skeleton trash tiles that hold the exact bwall geometry (ADR-015 — no collapsing spinner). */
export function TrashWallSkeleton({ count = 8, testId }: { count?: number; testId?: string }) {
  return (
    <ul className="bwall" aria-hidden="true" data-testid={testId}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="bwall-tile">
          <span className="bwall-tap">
            <div className="poster-box" />
          </span>
          <span className="bwall-caption">
            <span className="skeleton-line" />
          </span>
          <span className="bwall-meta">
            <span className="skeleton-line skeleton-line--short" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The bare reserved 2:3 box — detail-head loading placeholders only (never a card face). */
export function PosterBox() {
  return <span className="poster-box" />;
}
