// PLAN-045 owner-correction (DESIGN-029 amendment) — the ONE poster-card caption shared by every
// Library-idiom wall: the Movies/TV wall, the Books/Audiobooks/Comics walls (on-disk AND composed
// Wanted tiles), and the Goodreads items wall. Extracting the Movies caption markup here makes the
// card anatomy identical BY CONSTRUCTION — a cohesive poster block: title (year), an optional muted
// author/subtitle line, and one compact badge row — never a per-surface fork. Tokens-only; the badge
// tone maps to the shared `.badge--*` classes (hard rule 2). ADR-015: the caption rows are the same
// fixed-height idiom as the rest of the grid, so a badge swap recolors, never reflows.
import type { ReactNode } from 'react';

/** A caption badge tone → the shared `.badge--<tone>` class (`rating` = the ★ accent pill). */
export type PosterBadgeTone = 'ok' | 'warn' | 'danger' | 'muted' | 'info' | 'rating';

export interface PosterBadge {
  label: ReactNode;
  /** Omit for the neutral base `.badge`; otherwise one of the shared tone classes. */
  tone?: PosterBadgeTone;
  /** Optional hover/tooltip detail (per-format status, rating source, full shelf list). */
  title?: string;
}

/**
 * The poster-card body: title (+ optional year), an optional subtitle line, and a compact badge row.
 * `badges` accepts falsy entries so callers can inline conditionals (`cond && {…}`) without filtering.
 */
export function PosterCardBody({
  title,
  year,
  subtitle,
  badges,
}: {
  title: string;
  year?: number | null;
  subtitle?: ReactNode;
  badges?: ReadonlyArray<PosterBadge | null | false | undefined>;
}) {
  const shown = (badges ?? []).filter((b): b is PosterBadge => Boolean(b));
  const hasSubtitle = subtitle !== undefined && subtitle !== null && subtitle !== '';
  return (
    <span className="poster-card__body">
      <span className="media-card__title">
        {title}
        {year != null ? <span className="muted"> ({year})</span> : null}
      </span>
      {hasSubtitle ? <span className="media-card__subtitle">{subtitle}</span> : null}
      {shown.length > 0 ? (
        <span className="media-card__badges">
          {shown.map((b, i) => (
            <span key={i} className={`badge${b.tone ? ` badge--${b.tone}` : ''}`} title={b.title}>
              {b.label}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
