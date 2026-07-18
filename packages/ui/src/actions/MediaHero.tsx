// ADR-071 / DESIGN-004 D-24 — the ONE detail-page hero. Every detail surface (movie/TV, book/
// audiobook/comic, wanted, activity-failure, ytdl-sub) hand-rolled its own
// `<section className="card detail-head">` + poster + title + badge-row + play/actions rows, so
// they drifted. This renders that scaffold once: the app fills the app-specific slots (the
// <MediaPoster> node, the consume/missing row, the action bar) and the structure is identical by
// construction. It OWNS the `.detail-head__play` layout token (the guard forbids it elsewhere).
//
// Structure only — every class is themed by app.css; no color here (CLAUDE.md rule 2). The layout
// is static (ADR-015): nothing here re-orients on interaction.
import type { ReactNode } from 'react';

/** A hero badge — tone maps to the app's `.badge--<tone>` palette; omit for a plain `.badge`. */
export interface MediaHeroBadge {
  label: ReactNode;
  tone?: 'muted' | 'ok' | 'warn' | 'info' | 'danger' | 'shield';
  testId?: string;
}

export interface MediaHeroProps {
  /** The poster node — an app <MediaPoster> (app-specific, so a slot). */
  poster: ReactNode;
  title: ReactNode;
  /** Appended as a muted " (year)" after the title when present. */
  year?: number | null;
  badges?: MediaHeroBadge[];
  /** The muted "runtime · resolution" style sub-line under the badges. */
  meta?: ReactNode;
  /** The consume / missing-state row (ConsumeLink(s) or the Not-on-Disk pill). Rendered in
   *  `.detail-head__play` inside the body. */
  consume?: ReactNode;
  /** A secondary body row under the consume row (e.g. the books pairing affordance). */
  secondary?: ReactNode;
  /** The Fix/Force-Search cluster (a <MediaActionBar placement="head">). Rendered as the hero's
   *  trailing flex child (`.detail-head__actions` is owned by the bar). */
  actions?: ReactNode;
  testId?: string;
}

export function MediaHero({
  poster,
  title,
  year,
  badges,
  meta,
  consume,
  secondary,
  actions,
  testId,
}: MediaHeroProps) {
  return (
    <section className="card detail-head" data-testid={testId}>
      <span className="detail-head__poster">{poster}</span>
      <div className="detail-head__body">
        <h1 className="detail-head__title">
          {title}
          {year != null ? <span className="muted"> ({year})</span> : null}
        </h1>
        {badges != null && badges.length > 0 ? (
          <div className="media-card__badges">
            {badges.map((badge, i) => (
              <span
                key={i}
                className={['badge', badge.tone ? `badge--${badge.tone}` : null]
                  .filter(Boolean)
                  .join(' ')}
                data-testid={badge.testId}
              >
                {badge.label}
              </span>
            ))}
          </div>
        ) : null}
        {meta != null ? <p className="detail-head__meta muted">{meta}</p> : null}
        {consume != null ? <p className="detail-head__play">{consume}</p> : null}
        {secondary}
      </div>
      {actions}
    </section>
  );
}
