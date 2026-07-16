// ADR-068 / DESIGN-040 D-05/D-06 — the estate play scoreboard: a slim GitHub-readme-badge
// row between the greeting and the About tile. Server component, numbers baked at SSR (zero
// client fetch, no post-load shift — ADR-015); static (no links, no hover). Each badge is a
// two-segment shields pill: muted label (play glyph + text) + accent value. When the
// aggregate is unavailable the component renders NOTHING (D-07 — no empty chrome).
import { scoreboardBadges, type ScoreboardTotals } from '@/lib/scoreboard';

/** The shields "logo" flourish — a tiny play triangle in the label segment (D-05). */
function PlayGlyph() {
  return (
    <svg className="scoreboard__glyph" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M2 1.2 8.8 5 2 8.8Z" fill="currentColor" />
    </svg>
  );
}

export function Scoreboard({ totals }: { totals: ScoreboardTotals }) {
  const badges = scoreboardBadges(totals);
  if (badges === null) return null;
  return (
    <div className="scoreboard" role="group" aria-label="Estate lifetime plays">
      {badges.map((badge) => (
        <span key={badge.label} className="scoreboard__badge">
          <span className="scoreboard__label">
            <PlayGlyph />
            {badge.label}
          </span>
          <span className="scoreboard__value">{badge.value}</span>
        </span>
      ))}
    </div>
  );
}
