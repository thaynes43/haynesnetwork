'use client';

// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the cross-library Activity sub-tab. Reads
// `activity.list` LIVE (a short poll — ADR-059 Q-01) with placeholderData so progress ticks without the
// grid flashing (ADR-015 recolor-not-reflow), renders the Helpdesk-idiom stage + kind filter chips with
// server counts (D-02), and a PosterGrid of ActivityCards (D-05 — the card family, never a fork). A failed
// tile links to its failure detail page; the rest are inert (actions live on the detail page only).
//
// STATE MACHINE (the honest-states fix): the skeleton shows ONLY on the first load (`isPending` — no data,
// no error yet); a resolved-but-empty list shows the designed "Nothing in flight" empty state; a fully-failed
// read shows an error state with a retry affordance; and a background poll refetch mutates the grid IN PLACE
// — it NEVER flips the view back to skeletons (react-query keeps the last data while refetching). Per-SOURCE
// degrade (a missing env / down upstream) never blanks the read: the aggregator returns the reachable items
// plus an `unavailable` marker, surfaced here as a small non-blocking notice (never a total error).
//
// PLAN-048 CLICKABILITY + LIVE-PROGRESS pass (owner directive 2026-07-14):
//   • every tile CLICKS THROUGH — the aggregator fills `href` for every item (failed → failure detail; *arr →
//     its ledger detail; a book/comic want → its Wanted detail), all `?from=activity` so Back restores this tab;
//   • the poll is ADAPTIVE — fast (2.5s) while any item is downloading so the % animates, relaxed (5s) otherwise;
//   • the in-flight badge PROGRESSES in place (the Fix PhaseChip feel — pulsing dot + filling meter), and a
//     just-landed item flashes a one-shot accent before it ages out (it never vanishes mid-poll);
//   • the stage/kind filters live in the URL, so Back from a detail restores the tab AND its filters.
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PosterGrid, PosterGridSkeleton, ActivityCard, type CardActivityStage } from '@/components/cards';
import { activityPollIntervalMs } from '@/lib/activity-progress';
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Live poll — queues change by the second (ADR-059). placeholderData keeps the grid rendered while a
  // refetch is in flight (ADR-015 — no collapse/flash). The interval is ADAPTIVE: fast (2.5s) while ANY item
  // is downloading so the % animates, relaxed (5s) otherwise — derived from the freshest data each tick.
  // `refetchIntervalInBackground` is left at its FALSE default so the poll PAUSES while the tab is hidden (no
  // runaway polling); it resumes on return and `refetchOnWindowFocus` catches the view up.
  const query = trpc.activity.list.useQuery(undefined, {
    refetchInterval: (q) => {
      const d = q.state.data as RouterOutputs['activity']['list'] | undefined;
      const hasDownloading = (d?.items ?? []).some((it) => it.stage === 'downloading');
      return activityPollIntervalMs({ hasDownloading });
    },
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });

  // The stage/kind filters live in the URL (repeated `?stage=` / `?kind=` params) so a soft nav into a detail
  // and Back restores the tab AND its filters (D-19). Switching INTO Activity drops them (a fresh tab).
  const stages = useMemo<Set<CardActivityStage>>(
    () =>
      new Set(
        searchParams.getAll('stage').filter((s): s is CardActivityStage =>
          (STAGE_ORDER as string[]).includes(s),
        ),
      ),
    [searchParams],
  );
  const kinds = useMemo<Set<string>>(
    () => new Set(searchParams.getAll('kind').filter((k) => k !== '')),
    [searchParams],
  );

  // Refinements REPLACE (never a history entry per chip) and preserve `tab=activity` — read the LIVE location
  // so two quick toggles never clobber each other (the Library patchParams convention).
  const patchParams = (patch: Record<string, string[] | null>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      params.delete(k);
      if (v === null) continue;
      for (const val of v) params.append(k, val);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const toggleParam = (key: 'stage' | 'kind', value: string, current: Set<string>) => {
    const next = new Set(current);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    patchParams({ [key]: next.size > 0 ? [...next] : null });
  };

  const data = query.data;
  const items = useMemo<ActivityItem[]>(() => {
    const all = data?.items ?? [];
    return all.filter(
      (it) =>
        (stages.size === 0 || stages.has(it.stage as CardActivityStage)) &&
        (kinds.size === 0 || kinds.has(it.kind)),
    );
  }, [data, stages, kinds]);

  // The just-landed accent (D-10): diff each poll's stages against the last snapshot; an item that JUST
  // reached `completed` flashes a one-shot ring (recolor-only, ADR-015) for a few seconds so the landing is
  // seen before it ages out — it never just disappears between polls.
  const prevStagesRef = useRef<Map<string, string>>(new Map());
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const all = data?.items ?? [];
    const prev = prevStagesRef.current;
    const landed: string[] = [];
    const next = new Map<string, string>();
    for (const it of all) {
      const before = prev.get(it.id);
      if (it.stage === 'completed' && before !== undefined && before !== 'completed') landed.push(it.id);
      next.set(it.id, it.stage);
    }
    prevStagesRef.current = next;
    if (landed.length === 0) return;
    // Both state updates are deferred OUT of the synchronous effect body (react-hooks/set-state-in-effect):
    // arm the flash on a macrotask, then disarm it after the accent animation window.
    const armT = setTimeout(() => setFlashIds((cur) => new Set([...cur, ...landed])), 0);
    const clearT = setTimeout(() => {
      setFlashIds((cur) => {
        const s = new Set(cur);
        for (const id of landed) s.delete(id);
        return s;
      });
    }, 3500);
    return () => {
      clearTimeout(armT);
      clearTimeout(clearT);
    };
  }, [data]);

  // Initial load ONLY (no data, no error yet) → skeleton. A poll refetch keeps status 'success'/'error' and
  // the last data on screen, so this branch can never re-fire mid-session (the flicker fix).
  if (query.isPending) {
    return (
      <div className="activity-panel" data-testid="activity-panel">
        <PosterGridSkeleton testId="activity-skeleton" />
      </div>
    );
  }

  // A TOTAL read failure with nothing to show (the tRPC call itself failed — DB down, network) → an honest
  // error state with retry. A per-SOURCE degrade never lands here: the aggregator returns the reachable
  // items + an `unavailable` marker, so `data` is present and we fall through to the normal render.
  if (query.isError && !data) {
    return (
      <div className="activity-panel" data-testid="activity-panel">
        <section className="card empty-state" data-testid="activity-error">
          <p>
            <strong>Activity couldn’t load</strong>
          </p>
          <p className="muted">Something went wrong reaching the activity read.</p>
          <button
            type="button"
            className="btn"
            onClick={() => void query.refetch()}
            data-testid="activity-retry-load"
          >
            Try again
          </button>
        </section>
      </div>
    );
  }

  const counts = data?.counts;
  const total = counts?.total ?? 0;
  const unavailable = data?.unavailable ?? [];

  return (
    <div className="activity-panel" data-testid="activity-panel">
      <div className="library-filters admin-filterbar">
        <div className="seg" role="group" aria-label="Filter activity by stage">
          <button
            type="button"
            className={stages.size === 0 ? 'is-active' : undefined}
            aria-pressed={stages.size === 0}
            data-testid="activity-stage-all"
            onClick={() => patchParams({ stage: null })}
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
                onClick={() => toggleParam('stage', stage, stages)}
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
                  onClick={() => toggleParam('kind', kind, kinds)}
                >
                  {KIND_LABELS[kind] ?? kind}
                  {` · ${counts.kinds[kind]}`}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Per-source degrade notice (non-blocking): the reachable sources render normally above/below; a
          down/unconfigured source shows a small token-styled chip naming the family. ADR-015: a fixed-height
          scroll row that only RECOLORS between polls — the `unavailable` set is stable per read, so the grid
          below never jumps. Never a total error — a single source down never blanks the tab (the prod fix). */}
      {unavailable.length > 0 ? (
        <div className="activity-notice" role="status" data-testid="activity-unavailable">
          {unavailable.map((u) => (
            <span
              key={u.source}
              className="activity-notice__chip"
              title={u.reason}
              data-testid={`activity-unavailable-${u.source}`}
            >
              <span className="activity-notice__dot" aria-hidden="true" />
              {u.label} unavailable
            </span>
          ))}
        </div>
      ) : null}

      {items.length === 0 ? (
        total === 0 && unavailable.length === 0 ? (
          // The designed empty state — a resolved, reachable, genuinely-idle pipeline (D-01 "nothing in flight").
          <section className="card empty-state" data-testid="activity-empty">
            <p>
              <strong>Nothing in flight</strong>
            </p>
            <p className="muted">Searches, downloads, and imports will appear here as they happen.</p>
          </section>
        ) : (
          <p className="muted empty-note" data-testid="activity-empty">
            {total === 0
              ? 'No other activity is in flight right now.'
              : 'No activity matches the current filters.'}
          </p>
        )
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
              justCompleted={flashIds.has(it.id)}
              testId={`activity-item-${it.stage}`}
            />
          ))}
        </PosterGrid>
      )}
    </div>
  );
}
