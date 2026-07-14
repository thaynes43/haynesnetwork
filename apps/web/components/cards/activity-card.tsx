'use client';

// PLAN-048 / ADR-059 / DESIGN-030 D-05 — the ACTIVITY grid tile: the cross-library Activity sub-tab renders
// one of these per in-flight item. A thin, prop-typed BaseCard extension (never a fork — ADR-058): the
// shared 2:3 poster box (cover-proxy or the KindIcon fallback), title (year), a muted subtitle of the
// SOURCE APP, and the ONE badge row carrying the stage badge (+ progress) and, for a failure, the
// failure-class badge (≤ 2 badges, well under MAX_CARD_BADGES). Whole-face click-through: a failure links
// to its detail page; a non-failure links to the library item (or is inert). No buttons on the card face —
// actions live only on the detail page (ADR-058 anatomy).
import { BaseCard } from './base-card';
import { activityStageBadge, activityFailureBadge, type CardActivityStage } from './activity-badge';

const SOURCE_APP_LABELS: Record<string, string> = {
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  lidarr: 'Lidarr',
  lazylibrarian: 'LazyLibrarian',
  sabnzbd: 'SABnzbd',
  qbittorrent: 'qBittorrent',
  kapowarr: 'Kapowarr',
};

export function ActivityCard({
  href,
  posterUrl,
  kind,
  title,
  year,
  sourceApp,
  stage,
  progress,
  failureKind,
  justCompleted,
  testId,
}: {
  href: string | null;
  posterUrl: string | null;
  /** KindIcon fallback kind (the ActivityItem kind: 'book'|'audiobook'|'movie'|…). */
  kind: string;
  title: string;
  year?: number | null;
  /** The source app the stage came from (the muted subtitle). */
  sourceApp: string;
  stage: CardActivityStage;
  progress?: number | null;
  /** Present only for a failed item — the second (failure-class) badge. */
  failureKind?: string | null;
  /** PLAN-048 / ADR-059 D-10 — this tile JUST transitioned to `completed` on this poll: a one-shot accent
   *  ring plays (recolor-only, ADR-015) so the landing is SEEN before the item ages out — it never just
   *  vanishes between polls. Rides a `data-*` attr (typed passthrough), never a class fork. */
  justCompleted?: boolean;
  testId?: string;
}) {
  const failure = stage === 'failed' ? activityFailureBadge(failureKind) : null;
  const badges = [activityStageBadge({ stage, progress }), failure];
  return (
    <BaseCard
      href={href}
      art={{ type: 'poster', posterUrl, kind }}
      title={title}
      year={year}
      subtitle={SOURCE_APP_LABELS[sourceApp] ?? sourceApp}
      badges={badges}
      testId={testId}
      data={justCompleted ? { 'data-just-completed': 'true' } : undefined}
    />
  );
}
