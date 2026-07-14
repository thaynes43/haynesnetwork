'use client';

// PLAN-048 / ADR-059 / DESIGN-030 D-10 — the LIVE-PROGRESS PARITY harness: the owner judges "does Activity
// feel like Fix?" against THIS side-by-side. Left: the Activity/wall in-flight badge (the tile idiom this
// pass added — a pulsing dot + a filling mini-meter + a stage that swaps in place). Right: the reference the
// consistency is measured against — the ledger Fix / Force-Search feedback (PhaseChip + ProgressMeter,
// PLAN-015). Pure fixtures, no network — a clean-room capture surface (dev-only route).
import { PhaseChip, ProgressMeter } from '@hnet/ui';
import { ActivityCard, BookCard, MediaCard, PosterGrid } from '@/components/cards';

function svgPoster(bg: string, fg: string, text: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300">` +
    `<rect width="200" height="300" fill="${bg}"/>` +
    `<circle cx="100" cy="118" r="58" fill="${fg}"/>` +
    `<text x="100" y="268" font-family="sans-serif" font-size="26" fill="${fg}" text-anchor="middle">${text}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
const POSTER = svgPoster('#25313a', '#79d297', 'A');

export function ActivityProgressParity() {
  return (
    <div className="gallery" data-testid="activity-progress-parity">
      <h1 className="page-title">Live-progress parity — Activity ↔ Fix (PLAN-048 D-10)</h1>
      <p className="muted gallery__note">
        The Activity / wall in-flight badge (left) reads as the SAME idiom as the ledger Fix feedback (right):
        a pulsing dot, a filling meter, and a stage that swaps in place — recolor, never reflow (ADR-015).
      </p>

      <div className="parity">
        <section className="gallery__section parity__col" data-testid="parity-activity">
          <h2 className="gallery__heading">Activity — the tile (this pass)</h2>
          <PosterGrid testId="parity-activity-grid">
            <ActivityCard
              href="#"
              posterUrl={POSTER}
              kind="movie"
              title="Downloading Now"
              year={2026}
              sourceApp="radarr"
              stage="downloading"
              progress={62}
            />
            <ActivityCard
              href="#"
              posterUrl={POSTER}
              kind="movie"
              title="Then Importing"
              year={2026}
              sourceApp="radarr"
              stage="importing"
            />
            <ActivityCard
              href="#"
              posterUrl={POSTER}
              kind="movie"
              title="Just Landed"
              year={2026}
              sourceApp="radarr"
              stage="completed"
              justCompleted
            />
          </PosterGrid>
          <p className="muted gallery__note">…and the wall poster wears the same badge:</p>
          <PosterGrid testId="parity-wall-grid">
            <MediaCard
              href="#"
              posterUrl={POSTER}
              kind="radarr"
              title="A Grabbing Movie"
              year={2026}
              inFlight={{ stage: 'downloading', progress: 62 }}
              badges={[{ label: '★ 7.4', tone: 'rating' }]}
            />
            <BookCard
              href="#"
              posterUrl={null}
              mediaKind="book"
              title="A Wanted Book"
              author="An Author"
              inFlight={{ stage: 'downloading', progress: 62 }}
              badges={[{ label: 'Wanted', tone: 'warn' }]}
            />
          </PosterGrid>
        </section>

        <section className="gallery__section parity__col" data-testid="parity-fix">
          <h2 className="gallery__heading">The reference — Fix / Force-Search feedback</h2>
          <div className="action-progress" data-live-phase="downloading">
            <div className="action-progress__head">
              <PhaseChip phase="searching" label="Searching" tone="neutral" pulse meter />
            </div>
            <div className="action-progress__head">
              <PhaseChip phase="downloading" label="Downloading" tone="info" progressPct={62} pulse meter />
            </div>
            <div className="action-progress__head">
              <PhaseChip phase="importing" label="Importing" tone="info" pulse meter />
            </div>
            <ProgressMeter pct={62} tone="progress" detail="62% · ~4 min left" label="Download progress" />
            <div className="action-progress__head">
              <PhaseChip phase="completed" label="Completed" tone="success" />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
