'use client';

// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the cross-library Activity sub-tab. Reads
// `activity.list` LIVE (a short poll — ADR-059 Q-01) with placeholderData so progress ticks without the
// grid flashing (ADR-015 recolor-not-reflow), renders the Helpdesk-idiom stage + kind filter chips with
// server counts (D-02), and a PosterGrid of ActivityCards (D-05 — the card family, never a fork). A failed
// tile links to its failure detail page; the rest are inert (actions live on the detail page only).
import { useMemo, useState } from 'react';
import { PosterGrid, PosterGridSkeleton, ActivityCard, type CardActivityStage } from '@/components/cards';
import { trpc, type RouterOutputs } from '@/lib/trpc-client';

type ActivityItem = RouterOutputs['activity']['list']['items'][number];

const STAGE_ORDER: CardActivityStage[] = ['failed', 'importing', 'downloading', 'searching', 'completed'];
const STAGE_LABELS: Record<CardActivityStage, string> = {
  failed: 'Failed',
  importing: 'Importing',
  downloading: 'Downloading',
  searching: 'Searching',
  completed: 'Recently done',
};

const KIND_ORDER = ['movie', 'tv', 'music', 'book', 'audiobook', 'comic'] as const;
const KIND_LABELS: Record<string, string> = {
  movie: 'Movies',
  tv: 'TV',
  music: 'Music',
  book: 'Books',
  audiobook: 'Audiobooks',
  comic: 'Comics',
};

export function ActivityPanel() {
  // Live poll — queues change by the second (ADR-059). placeholderData keeps the grid rendered while a
  // refetch is in flight (ADR-015 — no collapse/flash).
  const query = trpc.activity.list.useQuery(undefined, {
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });

  const [stages, setStages] = useState<Set<CardActivityStage>>(new Set());
  const [kinds, setKinds] = useState<Set<string>>(new Set());

  const data = query.data;
  const items = useMemo<ActivityItem[]>(() => {
    const all = data?.items ?? [];
    return all.filter(
      (it) =>
        (stages.size === 0 || stages.has(it.stage as CardActivityStage)) &&
        (kinds.size === 0 || kinds.has(it.kind)),
    );
  }, [data, stages, kinds]);

  if (query.isLoading && !data) {
    return <PosterGridSkeleton testId="activity-skeleton" />;
  }

  const counts = data?.counts;
  const total = counts?.total ?? 0;

  const toggle = <T,>(set: Set<T>, value: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  };

  return (
    <div className="activity-panel" data-testid="activity-panel">
      <div className="library-filters admin-filterbar">
        <div className="seg" role="group" aria-label="Filter activity by stage">
          <button
            type="button"
            className={stages.size === 0 ? 'is-active' : undefined}
            aria-pressed={stages.size === 0}
            data-testid="activity-stage-all"
            onClick={() => setStages(new Set())}
          >
            All{` · ${total}`}
          </button>
          {STAGE_ORDER.map((stage) => {
            const on = stages.has(stage);
            const n = counts?.stages[stage] ?? 0;
            return (
              <button
                key={stage}
                type="button"
                className={on ? 'is-active' : undefined}
                aria-pressed={on}
                data-testid={`activity-stage-${stage}`}
                onClick={() => toggle(stages, stage, setStages)}
              >
                {STAGE_LABELS[stage]}
                {` · ${n}`}
              </button>
            );
          })}
        </div>
        {/* Kind chips are POPULATED-value-gated (a kind with no in-flight item grows no chip — D-02). */}
        {counts && Object.keys(counts.kinds).length > 1 ? (
          <div className="seg" role="group" aria-label="Filter activity by kind">
            {KIND_ORDER.filter((k) => counts.kinds[k] != null).map((kind) => {
              const on = kinds.has(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  className={on ? 'is-active' : undefined}
                  aria-pressed={on}
                  data-testid={`activity-kind-${kind}`}
                  onClick={() => toggle(kinds, kind, setKinds)}
                >
                  {KIND_LABELS[kind] ?? kind}
                  {` · ${counts.kinds[kind]}`}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p className="muted empty-note" data-testid="activity-empty">
          {total === 0
            ? 'Nothing is in flight right now — searches, downloads, and imports will appear here.'
            : 'No activity matches the current filters.'}
        </p>
      ) : (
        <PosterGrid testId="activity-grid">
          {items.map((it) => (
            <ActivityCard
              key={it.id}
              href={it.href}
              posterUrl={it.posterUrl}
              kind={it.kind}
              title={it.title}
              year={it.year}
              sourceApp={it.sourceApp}
              stage={it.stage as CardActivityStage}
              progress={it.progress}
              failureKind={it.failureKind}
              testId={`activity-item-${it.stage}`}
            />
          ))}
        </PosterGrid>
      )}
    </div>
  );
}
